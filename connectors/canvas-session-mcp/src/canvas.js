import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, downloadDir, CMD } from './config.js';

const MAX_DOWNLOAD = 60 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

const TYPES = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
  '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.py': 'text/x-python', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++', '.sql': 'application/sql',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ipynb': 'application/x-ipynb+json', '.r': 'text/plain', '.m': 'text/plain',
};
const contentTypeOf = (name) => TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';

const parseJson = (text) => JSON.parse(text.replace(/^while\(1\);/, ''));   // Canvas's anti-XSSI prefix

function nextLink(header) {
  const part = String(header || '').split(',').find((s) => s.includes('rel="next"'));
  return part ? part.slice(part.indexOf('<') + 1, part.indexOf('>')) : null;
}

export function query(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(k.endsWith('[]') ? k : `${k}[]`, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}

// The session's CSRF token. Canvas requires it on every cookie-authenticated non-GET API call.
export function csrfToken(cookieHeader) {
  const pair = String(cookieHeader || '').split(/;\s*/).find((p) => p.startsWith('_csrf_token='));
  if (!pair) return null;
  try { return decodeURIComponent(pair.slice('_csrf_token='.length)); } catch { return null; }
}

// A write that may have reached Canvas. It is never retried automatically.
export class UncertainWriteError extends Error {
  constructor(what, cause) {
    super(`${what}: the outcome is unknown (${cause}). Check Canvas before trying again; do not repeat blindly.`);
    this.uncertain = true;
  }
}

// Canvas client. GETs go through request(); writes (POST/PUT/DELETE) go through send(), which
// adds the CSRF token, only ever talks to the Canvas origin, never follows redirects and never
// retries once a request may have been processed.
// `session()` returns { cookieHeader } and is called again (fresh=true) once if Canvas says 401.
export class CanvasClient {
  constructor({ base, session, fetchImpl = fetch }) {
    this.base = base;
    this.session = session;
    this.fetch = fetchImpl;
    this.cookie = null;
    this.courseFolders = new Map();   // course id → folder name (course code)
    this.fileCourse = new Map();      // file id → course id, noted whenever a tool sees the file inside a course
  }

  noteFiles(courseId, ids) { for (const id of ids || []) if (id) this.fileCourse.set(String(id), String(courseId)); }

  async courseCode(courseId) {
    if (!this.courseFolders.has(String(courseId))) {
      const c = await this.get(`courses/${courseId}`).catch(() => ({}));
      this.courseFolders.set(String(courseId), c.course_code || c.name || null);
    }
    return this.courseFolders.get(String(courseId));
  }

  async request(url, { raw = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie || attempt === 1) this.cookie = (await this.session({ fresh: attempt === 1 })).cookieHeader;
      // Laplace modification: keep Canvas session cookies on their origin.
      let current = new URL(url);
      let res;
      for (let redirects = 0; ; redirects++) {
        if (current.protocol !== 'https:' && current.origin !== new URL(this.base).origin) {
          throw new Error('External Canvas downloads must use HTTPS.');
        }
        const headers = { Accept: raw ? '*/*' : 'application/json' };
        if (current.origin === new URL(this.base).origin) headers.Cookie = this.cookie;
        res = await this.fetch(current.href, { method: 'GET', headers, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = res.headers.get('location');
        await res.body?.cancel?.();
        if (!location || redirects >= 9) throw new Error('Invalid Canvas download redirect.');
        current = new URL(location, current);
      }
      if (res.status === 401 && attempt === 0) { await res.body?.cancel?.(); continue; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text.slice(0, 200);
        try { const j = parseJson(text); msg = j.errors?.[0]?.message || j.message || msg; } catch { /* not JSON */ }
        const err = new Error(`Canvas ${res.status}${msg ? `: ${msg}` : ''}`);
        err.status = res.status;
        throw err;
      }
      return res;
    }
    throw new Error(`Canvas keeps answering 401. Run: ${CMD} login`);
  }

  url(p, params) {
    const rel = p.startsWith('/') ? p : `/api/v1/${p}`;
    const q = query(params);
    return `${this.base}${rel}${q ? (rel.includes('?') ? '&' : '?') + q : ''}`;
  }

  async get(p, params = {}) {
    const res = await this.request(this.url(p, params));
    return parseJson(await res.text());
  }

  // POST/PUT/DELETE a Canvas API path with a JSON body. A 401 means Canvas rejected the request
  // before acting on it, so the session is renewed and the call made once more. Anything else
  // that leaves the outcome open (network failure, timeout, 5xx) is reported, not retried.
  async send(method, p, body, { what = `${method} ${p}` } = {}) {
    const url = this.url(p);
    if (new URL(url).origin !== new URL(this.base).origin) throw new Error('Canvas writes must stay on the Canvas origin.');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie || attempt === 1) this.cookie = (await this.session({ fresh: attempt === 1 })).cookieHeader;
      const token = csrfToken(this.cookie);
      if (!token) throw new Error(`The saved Canvas session has no CSRF token, so Canvas would refuse this change. Run: ${CMD} login`);
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: this.cookie, 'X-CSRF-Token': token },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
        });
      } catch (e) {
        throw new UncertainWriteError(what, e.message);
      }
      if (res.status === 401 && attempt === 0) { await res.body?.cancel?.(); continue; }
      const text = await res.text().catch(() => '');
      if (res.status >= 500) throw new UncertainWriteError(what, `Canvas ${res.status}`);
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = parseJson(text);
          msg = j.errors?.[0]?.message || (j.errors && typeof j.errors === 'object' ? JSON.stringify(j.errors) : null) || j.message || msg;
        } catch { /* not JSON */ }
        if (res.status === 422 && /authenticity|csrf/i.test(msg)) msg = `Canvas rejected the session's security token. Run: ${CMD} login`;
        const err = new Error(`Canvas ${res.status}${msg ? `: ${msg}` : ''}`);
        err.status = res.status;
        throw err;
      }
      try { return text ? parseJson(text) : {}; } catch { return {}; }
    }
    throw new Error(`Canvas keeps answering 401. Run: ${CMD} login`);
  }

  // Uploads a local file through Canvas's three-step file API: ask Canvas for an upload slot
  // (`slotPath`), send the bytes there, then confirm. Session cookies only go to the Canvas
  // origin; any other upload host must be HTTPS and receives only Canvas's upload parameters.
  async uploadFile(slotPath, filePath, { what = 'Upload' } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error(`Give an absolute path: ${filePath}`);
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (stat.size > MAX_UPLOAD) throw new Error(`${path.basename(filePath)} is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD / 1048576} MB.`);
    const name = path.basename(filePath);
    const slot = await this.send('POST', slotPath, { name, size: stat.size, content_type: contentTypeOf(name) }, { what: `${what} (requesting upload slot)` });
    if (!slot.upload_url) throw new Error('Canvas did not return an upload URL.');
    const target = new URL(slot.upload_url, this.base);
    const sameOrigin = target.origin === new URL(this.base).origin;
    if (!sameOrigin && target.protocol !== 'https:') throw new Error('External Canvas uploads must use HTTPS.');
    const form = new FormData();
    for (const [k, v] of Object.entries(slot.upload_params || {})) form.append(k, String(v));
    form.append('file', new Blob([fs.readFileSync(filePath)]), name);   // the file must be the last field
    const headers = { Accept: 'application/json' };
    if (sameOrigin) Object.assign(headers, { Cookie: this.cookie, 'X-CSRF-Token': csrfToken(this.cookie) });
    let res;
    try {
      res = await this.fetch(target.href, { method: 'POST', headers, body: form, redirect: 'manual' });
    } catch (e) {
      throw new UncertainWriteError(`${what} (sending ${name})`, e.message);
    }
    if (res.status >= 500) throw new UncertainWriteError(`${what} (sending ${name})`, `upload host ${res.status}`);
    let info = {};
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel?.();
      info = { location: res.headers.get('location') };
    } else {
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`Upload of ${name} failed (${res.status}): ${text.slice(0, 200)}`);
      try { info = parseJson(text); } catch { info = {}; }
    }
    if (info.id) return { id: info.id, name: info.display_name || name, size: stat.size };
    if (!info.location) throw new Error(`Canvas did not confirm the upload of ${name}.`);
    const confirm = new URL(info.location, this.base);
    if (confirm.origin !== new URL(this.base).origin) throw new Error('Canvas upload confirmation must come from the Canvas origin.');
    const done = parseJson(await (await this.request(confirm.href)).text());
    if (!done.id) throw new Error(`Canvas did not confirm the upload of ${name}.`);
    return { id: done.id, name: done.display_name || name, size: stat.size };
  }

  // Follows Canvas's Link: rel="next" pagination.
  async list(p, params = {}, { maxPages = 10 } = {}) {
    let url = this.url(p, { per_page: 100, ...params });
    const out = [];
    for (let i = 0; url && i < maxPages; i++) {
      const res = await this.request(url);
      const data = parseJson(await res.text());
      out.push(...(Array.isArray(data) ? data : [data]));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }

  // Course folder for a file: from where a tool saw it, else from its Canvas folder
  // (students often may not read folders, hence the first). Null if unknown.
  async courseFolderOf(fileId, meta) {
    if (this.fileCourse.has(String(fileId))) return this.courseCode(this.fileCourse.get(String(fileId)));
    try {
      const folder = await this.get(`folders/${meta.folder_id}`);
      return folder.context_type === 'Course' ? this.courseCode(folder.context_id) : null;
    } catch { return null; }
  }

  // Saves a course file under your download folder (by default in a subfolder named after the
  // course) and returns its path and contents. A small index remembers which Canvas file went
  // where, so the same file is not downloaded twice and two different files that share a name
  // never overwrite each other.

  async download(fileId, { subdir } = {}) {
    const meta = await this.get(`files/${fileId}`);
    if (!meta.url) throw new Error(`File ${fileId} (${meta.display_name || 'unknown'}) is locked or not available to you yet.`);
    if (meta.size > MAX_DOWNLOAD) throw new Error(`File is ${(meta.size / 1048576).toFixed(1)} MB; the limit is ${MAX_DOWNLOAD / 1048576} MB.`);
    const info = { name: meta.display_name, contentType: meta['content-type'], updatedAt: meta.updated_at };
    const dir = path.join(downloadDir(), ...String(subdir ?? (await this.courseFolderOf(fileId, meta)) ?? '').split('/').filter(Boolean).map(safeName));
    const index = readIndex();
    let known = index[fileId];
    if (known && !fs.existsSync(known.path)) known = null;
    // Saved before under another folder (e.g. read first, then the whole course saved): move it,
    // unless that copy also stands in for an identical upload (then it stays where it is).
    const shared = known && Object.entries(index).some(([k, v]) => k !== String(fileId) && v.path === known.path);
    if (known && !shared && path.dirname(known.path) !== dir) {
      const to = freePath(path.join(dir, path.basename(known.path)));
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(known.path, to);
      known = { ...known, path: to };
      index[fileId] = known;
      writeIndex(index);
    }
    if (known && known.updatedAt === meta.updated_at && fs.statSync(known.path).size === meta.size) {
      return { ...info, path: known.path, buffer: fs.readFileSync(known.path), size: meta.size, cached: true };
    }
    const res = await this.request(meta.url, { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    // Teachers often upload the same PDF twice (an announcement and the assignment page):
    // identical content is kept once.
    const twin = !known && Object.values(index).find((v) => v.sha === sha && fs.existsSync(v.path));
    if (twin) {
      index[fileId] = { path: twin.path, updatedAt: meta.updated_at, sha };
      writeIndex(index);
      return { ...info, path: twin.path, buffer: buf, size: buf.length, cached: true, duplicate: true };
    }
    const file = known?.path || freePath(path.join(dir, safeName(meta.display_name || meta.filename || `file-${fileId}`)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    index[fileId] = { path: file, updatedAt: meta.updated_at, sha };
    writeIndex(index);
    return { ...info, path: file, buffer: buf, size: buf.length, cached: false };
  }
}

const INDEX_FILE = path.join(HOME, 'downloads.json');
function readIndex() { try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return {}; } }
function writeIndex(index) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 1)); }
export const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 150);
function freePath(file) {
  if (!fs.existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 2; ; i++) { const f = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(f)) return f; }
}
