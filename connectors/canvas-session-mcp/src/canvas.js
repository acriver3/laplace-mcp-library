import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, downloadDir } from './config.js';
import { signInRequired } from './browser.js';

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

const redirects = [301, 302, 303, 307, 308];
const authCandidate = (res) => res.status === 401 || res.status === 403 || redirects.includes(res.status);
const isIdentity = (value) => !!value?.id;

export class CanvasClient {
  constructor({ base, session, verifyAccount = () => {}, fetchImpl = fetch }) {
    this.base = new URL(base).origin;
    this.session = session;
    this.verifyAccount = verifyAccount;
    this.fetch = fetchImpl;
    this.current = null;
    this.recovery = null;
    this.rateLimitedUntil = 0;
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

  async credentials() {
    if (this.recovery) await this.recovery;
    this.current ??= await this.session();
    return this.current;
  }

  async fetchWithSession(url, options, credentials) {
    const sameOrigin = new URL(url).origin === this.base;
    const cookie = sameOrigin ? credentials?.cookies?.header(url) ?? credentials?.cookieHeader : '';
    const headers = { ...options.headers };
    if (cookie) headers.Cookie = cookie;
    if (sameOrigin && options.method !== 'GET') {
      const token = csrfToken(cookie);
      if (!token) throw signInRequired('The Canvas session is missing its CSRF token. Use the Canvas login command before making changes.');
      headers['X-CSRF-Token'] = token;
    }
    let res;
    try { res = await this.fetch(url, { ...options, headers, redirect: 'manual' }); }
    catch (error) {
      if (error.name === 'TypeError' || error.name === 'TimeoutError')
        throw Object.assign(new Error('The Canvas connection was interrupted.'), { code: 'transport_unavailable' });
      throw error;
    }
    if (sameOrigin && res.status === 429) {
      const value = res.headers.get('retry-after') ?? '';
      const retryAt = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Number.isFinite(retryAt) ? retryAt : Date.now() + 60_000);
    }
    // Late responses from a session that has been replaced must not overwrite the new session.
    if (sameOrigin && credentials === this.current) credentials?.cookies?.update(url, res.headers);
    return res;
  }

  async probe(credentials, signal, candidate = false) {
    const url = this.url('users/self');
    const res = await this.fetchWithSession(url, {
      method: 'GET', headers: { Accept: 'application/json' }, signal,
    }, credentials);
    if (authCandidate(res)) {
      await res.body?.cancel?.();
      throw signInRequired();
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      throw Object.assign(new Error(`Canvas identity check failed (${res.status}).`), {
        status: res.status,
        ...(res.status >= 500 ? { code: 'transport_unavailable' } : {}),
        ...(res.status === 429 ? {
          code: 'rate_limited', retryAfterMs: Math.max(0, this.rateLimitedUntil - Date.now()),
        } : {}),
      });
    }
    const text = await res.text();
    let identity;
    try { identity = parseJson(text); } catch {
      if (res.headers.get('content-type')?.includes('text/html') && /<form[^>]+(?:login|sign.in)/i.test(text))
        throw signInRequired();
    }
    if (!isIdentity(identity)) throw new Error('Canvas did not return a recognizable account.');
    this.verifyAccount(identity);
    if (candidate) credentials.cookies?.update(url, res.headers);
    return identity;
  }

  recover(previous, confirmed = false) {
    if (this.current !== previous) return Promise.resolve(this.current);
    if (!this.recovery) {
      this.recovery = (async () => {
        if (!confirmed) {
          try { await this.probe(previous); return null; }
          catch (error) { if (error.code !== 'sign_in_required') throw error; }
        }
        const renewed = await this.session({ fresh: true });
        await this.probe(renewed, undefined, true);
        this.current = renewed;
        return renewed;
      })().finally(() => { this.recovery = null; });
    }
    return this.recovery;
  }

  async request(url, { raw = false, allowRecovery = true } = {}) {
    const requested = new URL(url);
    for (let attempt = 0; attempt < 2; attempt++) {
      const credentials = requested.origin === this.base ? await this.credentials() : null;
      let current = requested;
      let res;
      let retry = false;
      for (let hop = 0; ; hop++) {
        if (current.protocol !== 'https:' && current.origin !== this.base)
          throw new Error('External Canvas downloads must use HTTPS.');
        res = await this.fetchWithSession(current.href, {
          method: 'GET', headers: { Accept: raw ? '*/*' : 'application/json' },
        }, credentials);
        const location = res.headers.get('location');
        const next = location && redirects.includes(res.status) ? new URL(location, current) : null;
        const loginRedirect = next && next.origin === this.base && /^\/login(?:\/|$)/.test(next.pathname);
        const authRedirect = next && (!raw || loginRedirect);
        if (credentials && current.origin === this.base &&
            (res.status === 401 || res.status === 403 || authRedirect)) {
          if (allowRecovery && attempt === 0 && await this.recover(credentials)) {
            await res.body?.cancel?.();
            retry = true;
            break;
          }
          if (loginRedirect || (!allowRecovery && res.status === 401)) {
            await res.body?.cancel?.();
            throw signInRequired();
          }
        }
        if (!redirects.includes(res.status)) break;
        await res.body?.cancel?.();
        if (!next || hop >= 9) throw new Error('Invalid Canvas download redirect.');
        current = next;
      }
      if (retry) continue;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text.slice(0, 200);
        try { const j = parseJson(text); msg = j.errors?.[0]?.message || j.message || msg; } catch { /* not JSON */ }
        throw Object.assign(new Error(`Canvas ${res.status}${msg ? `: ${msg}` : ''}`), {
          status: res.status, ...(res.status === 429 ? {
            code: 'rate_limited', retryAfterMs: Math.max(0, this.rateLimitedUntil - Date.now()),
          } : {}),
        });
      }
      return res;
    }
    throw signInRequired();
  }

  url(p, params) {
    const rel = p.startsWith('/') ? p : `/api/v1/${p}`;
    const q = query(params);
    return `${this.base}${rel}${q ? (rel.includes('?') ? '&' : '?') + q : ''}`;
  }

  async get(p, params = {}) {
    if (p === 'users/self' && Object.keys(params).length === 0) {
      const credentials = await this.credentials();
      try { return await this.probe(credentials); }
      catch (error) {
        if (error.code !== 'sign_in_required') throw error;
        return this.probe(await this.recover(credentials, true));
      }
    }
    const res = await this.request(this.url(p, params));
    return parseJson(await res.text());
  }

  async send(method, p, body, { what = `${method} ${p}` } = {}) {
    const url = this.url(p);
    if (new URL(url).origin !== this.base) throw new Error('Canvas writes must stay on the Canvas origin.');
    await this.get('users/self');
    const credentials = await this.credentials();
    let res;
    try {
      res = await this.fetchWithSession(url, {
        method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, credentials);
    } catch (error) {
      if (error.code === 'sign_in_required') throw error;
      throw new UncertainWriteError(what, error.message);
    }
    const text = await res.text().catch(() => '');
    if (res.status >= 500) throw new UncertainWriteError(what, `Canvas ${res.status}`);
    if (res.status === 401 || redirects.includes(res.status))
      throw signInRequired('Canvas rejected the write session. Check Canvas, reconnect, then decide whether to submit again.');
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = parseJson(text);
        msg = j.errors?.[0]?.message || (j.errors && typeof j.errors === 'object' ? JSON.stringify(j.errors) : null) || j.message || msg;
      } catch { /* not JSON */ }
      if (res.status === 422 && /authenticity|csrf/i.test(msg)) throw signInRequired();
      throw Object.assign(new Error(`Canvas ${res.status}${msg ? `: ${msg}` : ''}`), { status: res.status });
    }
    try { return text ? parseJson(text) : {}; } catch { return {}; }
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
    const credentials = sameOrigin ? await this.credentials() : null;
    let res;
    try {
      res = await this.fetchWithSession(target.href, { method: 'POST', headers, body: form }, credentials);
    } catch (e) {
      if (e.code === 'sign_in_required') throw e;
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
    const done = parseJson(await (await this.request(confirm.href, { allowRecovery: false })).text());
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
