import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CANVAS_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
process.env.CANVAS_MCP_DOWNLOADS = path.join(process.env.CANVAS_MCP_HOME, 'downloads');
const { CanvasClient, query, csrfToken } = await import('../src/canvas.js');
const { TOOLS } = await import('../src/tools.js');
const { sessionProvider } = await import('../src/server.js');
const { htmlToText, fileIdsIn, window } = await import('../src/text.js');

// A tiny fake Canvas: checks the session cookie, paginates, and refuses anything but GET.
let server;
let base;
const seen = [];
const CSRF = 'abc+/=';
const signedIn = (req) => String(req.headers.cookie || '').split(/;\s*/).includes('canvas_session=good');
const writes = [];   // { method, path, body, csrf }
async function handleWrite(req, res, send) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  const u = new URL(req.url, base);
  if (u.pathname === '/upload') {   // the upload host: takes no cookies, answers with a redirect to confirm
    writes.push({ method: req.method, path: u.pathname, body: raw, cookie: req.headers.cookie });
    if (!raw.includes('slot-key') || !raw.includes('my answer')) return send(400, { message: 'bad upload' });
    res.writeHead(303, { Location: `${base}/api/v1/files/900/create_success?uuid=x` });
    return res.end();
  }
  if (!signedIn(req)) return send(401, { errors: [{ message: 'Invalid access token.' }] });
  if (req.headers['x-csrf-token'] !== CSRF) return send(422, { errors: [{ message: 'Invalid authenticity token' }] });
  const body = raw ? JSON.parse(raw) : {};
  writes.push({ method: req.method, path: u.pathname, body });
  const key = `${req.method} ${u.pathname}`;
  switch (key) {
    case 'POST /api/v1/courses/1/assignments/9/submissions':
      if (body.submission?.submission_type === 'online_url') return send(400, { errors: { submission_type: 'not allowed' } });
      return send(201, { attempt: 2, submitted_at: '2026-09-19T10:00:00Z', workflow_state: 'submitted' });
    case 'POST /api/v1/courses/1/assignments/9/submissions/self/files':
      return send(200, { upload_url: body.name === 'external.txt' ? 'http://evil.example/upload' : `${base}/upload`, upload_params: { key: 'slot-key' } });
    case 'PUT /api/v1/courses/1/assignments/9/submissions/self':
      return send(200, { submission_comments: [{ comment: body.comment.text_comment, created_at: '2026-09-19T10:05:00Z' }] });
    case 'POST /api/v1/courses/1/discussion_topics/5/entries':
      return send(201, { id: 70, created_at: '2026-09-19T11:00:00Z' });
    case 'POST /api/v1/courses/1/discussion_topics/5/entries/70/replies':
      return send(201, { id: 71, parent_id: 70, created_at: '2026-09-19T11:01:00Z' });
    case 'POST /api/v1/conversations':
      return send(201, [{ id: 300, subject: body.subject }]);
    case 'POST /api/v1/conversations/300/add_message':
      return send(201, { id: 300, subject: 'Extension' });
    case 'PUT /api/v1/planner/overrides/31':
      return send(200, { id: 31, marked_complete: body.marked_complete });
    case 'POST /api/v1/planner/overrides':
      return send(200, { id: 32, marked_complete: body.marked_complete });
    case 'POST /api/v1/planner_notes':
      return send(200, { id: 8, title: body.title, todo_date: body.todo_date });
    case 'POST /api/v1/groups/61/memberships':
      return send(200, { id: 900, group_id: 61, user_id: 7, workflow_state: body.user_id === 'self' ? 'accepted' : 'invalid' });
    case 'DELETE /api/v1/groups/61/memberships/self':
      return send(200, { ok: true });
    case 'DELETE /api/v1/planner_notes/8':
      return send(200, { id: 8, workflow_state: 'deleted' });
    case 'POST /api/v1/courses/1/discussion_topics/6/entries':
      return send(503, 'down');
    default: return send(404, { errors: [{ message: 'not found' }] });
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.method !== 'GET') return handleWrite(req, res, send);
    if (req.url.startsWith('/dl/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(req.url === '/dl/558' ? 'Assignment 3: Q1 ...' : req.url === '/dl/559' ? 'Week 1 notes: vectors and matrices' : 'Week 1 notes: vectors and matrices');
    }
    if (!signedIn(req)) return send(401, { errors: [{ message: 'Invalid access token.' }] });
    const u = new URL(req.url, base);
    switch (u.pathname) {
      case '/api/v1/users/self': return send(200, 'while(1);{"id":7,"name":"Test Student"}');
      case '/api/v1/courses':
        if (u.searchParams.get('page') === '2') return send(200, [{ id: 2, name: 'Databases', course_code: 'COMP2400' }]);
        return send(200, [{ id: 1, name: 'Linear Algebra', course_code: 'MATH1012', term: { name: 'Sem 2' } }],
          { Link: `<${base}/api/v1/courses?page=2>; rel="next"` });
      case '/api/v1/courses/1': return send(200, { id: 1, name: 'Linear Algebra', course_code: 'MATH1012' });
      case '/api/v1/courses/1/assignments/9':
        return send(200, { name: 'Assignment 3', due_at: '2026-09-20T13:59:00Z', points_possible: 10, html_url: `${base}/courses/1/assignments/9`,
          submission_types: ['online_text_entry', 'online_upload'], allowed_extensions: ['pdf', 'txt'],
          description: '<p>Show <b>all</b> working.</p><a href="/courses/1/files/555/download">Assign3.pdf</a>',
          rubric: [{ description: 'Q1', points: 4, ratings: [{ points: 4, description: 'Full' }] }],
          submission: { workflow_state: 'unsubmitted', missing: true } });
      case '/api/v1/courses/1/files': return send(403, { status: 'unauthorized' });
      case '/api/v1/courses/1/modules':
        return send(200, [{ name: 'Week 1', items: [{ type: 'File', title: 'notes.txt', content_id: 555 }, { type: 'Page', title: 'Intro', page_url: 'intro' }] }]);
      case '/api/v1/folders/77': return send(200, { id: 77, context_type: 'Course', context_id: 1 });
      case '/api/v1/files/555': return send(200, { id: 555, folder_id: 77, display_name: 'notes.txt', 'content-type': 'text/plain', size: 34, url: `${base}/dl/555` });
      case '/api/v1/announcements': return send(200, [{ context_code: 'course_1', title: 'Assignment 3', message: '<p>See attached</p>', attachments: [{ id: 558, display_name: 'Assing3.pdf' }] }]);
      case '/api/v1/courses/1/assignments': return send(200, [{ id: 9, name: 'A3', description: '<a href="/courses/1/files/555">notes</a>' }]);
      case '/api/v1/files/558': return send(200, { id: 558, display_name: 'Assing3.pdf', 'content-type': 'text/plain', size: 20, url: `${base}/dl/558` });
      case '/api/v1/files/559': return send(200, { id: 559, display_name: 'notes-copy.txt', 'content-type': 'text/plain', size: 34, url: `${base}/dl/559` });
      case '/api/v1/files/556': return send(200, { id: 556, display_name: 'locked.pdf', url: '' });
      case '/api/v1/courses/1/assignments/11': return send(200, { name: 'Closed', locked_for_user: true, lock_explanation: '<p>This assignment was locked Sep 1.</p>', submission_types: ['online_text_entry'] });
      case '/api/v1/files/900/create_success': return send(200, { id: 900, display_name: 'answer.txt' });
      case '/api/v1/planner/overrides': return send(200, [{ id: 31, plannable_type: 'assignment', plannable_id: 10, marked_complete: false }]);
      case '/api/v1/search/recipients': return send(200, [{ id: 42, name: 'Dr Tutor', common_courses: { 1: ['TeacherEnrollment'] } }]);
      case '/api/v1/users/self/groups': return send(200, [{ id: 60, name: 'Team A', group_category_id: 4, course_id: 1, members_count: 3 }]);
      case '/api/v1/courses/1/groups': return send(200, [{ id: 60, name: 'Team A', group_category_id: 4, members_count: 3, max_membership: 4 }, { id: 61, name: 'Team B', group_category_id: 4, members_count: 2, max_membership: 4 }]);
      case '/api/v1/courses/1/group_categories': return send(200, [{ id: 4, name: 'Project teams', self_signup: 'enabled' }]);
      case '/api/v1/groups/60': return send(200, { id: 60, name: 'Team A', group_category_id: 4 });
      case '/api/v1/groups/61': return send(200, { id: 61, name: 'Team B', group_category_id: 4 });
      case '/api/v1/planner/items':
        return send(200, [{ context_name: 'MATH1012', plannable_type: 'assignment', plannable: { title: 'Assignment 4', points_possible: 10 },
          plannable_date: '2026-10-11T12:59:00Z', submissions: { submitted: false }, course_id: 1, plannable_id: 10, html_url: '/courses/1/assignments/10' }]);
      default: return send(404, { errors: [{ message: 'not found' }] });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const tool = (name) => TOOLS.find((t) => t.name === name);
const client = (cookies = ['canvas_session=good']) => {
  let i = 0;
  return new CanvasClient({ base, session: async () => ({ cookieHeader: cookies[Math.min(i++, cookies.length - 1)] }) });
};
const body = (r) => r.content[0].text;

test('query encodes arrays the way Canvas expects', () => {
  assert.equal(query({ include: ['term', 'teachers'], per_page: 100, skip: undefined }), 'include%5B%5D=term&include%5B%5D=teachers&per_page=100');
});

test('list follows Link pagination and strips the while(1) prefix', async () => {
  const r = JSON.parse(body(await tool('canvas_list_courses').run(client(), {})));
  assert.deepEqual(r.map((c) => c.code), ['MATH1012', 'COMP2400']);
  assert.equal(r[0].term, 'Sem 2');
  assert.equal(JSON.parse(body(await tool('canvas_whoami').run(client(), {}))).name, 'Test Student');
});

test('an expired cookie is refreshed once, then the call succeeds', async () => {
  const r = await tool('canvas_whoami').run(client(['canvas_session=old', 'canvas_session=good']), {});
  assert.match(body(r), /Test Student/);
});

test('assignment details: HTML → text, linked file ids, rubric, submission', async () => {
  const a = JSON.parse(body(await tool('canvas_get_assignment').run(client(), { course_id: '1', assignment_id: '9' })));
  assert.match(a.instructions, /Show ALL working|Show all working/i);
  assert.deepEqual(a.file_ids, ['555']);
  assert.equal(a.rubric[0].criterion, 'Q1');
  assert.equal(a.submission.missing, true);
});

test('hidden Files tab falls back to files linked in modules', async () => {
  const r = JSON.parse(body(await tool('canvas_list_files').run(client(), { course_id: '1' })));
  assert.match(r.note, /hidden/);
  // modules + announcement attachments (a misspelt assignment sheet, as happened in real life)
  assert.deepEqual(r.files, [{ id: 555, name: 'notes.txt', where: 'Week 1' }, { id: 558, name: 'Assing3.pdf', where: 'Announcements' }]);
});

test('read_file downloads, saves locally and returns the text', async () => {
  const r = body(await tool('canvas_read_file').run(client(), { file_id: '555' }));
  assert.match(r, /Week 1 notes: vectors and matrices/);
  const saved = r.match(/saved to: (.*)/)[1];
  assert.ok(fs.existsSync(saved));
  assert.ok(saved.includes(path.join('downloads', 'MATH1012')), saved);   // filed under its course
  await assert.rejects(tool('canvas_read_file').run(client(), { file_id: '556' }), /locked/);
});

test('save_course_files puts files under <folder>/<course>/<module> and skips unchanged ones', async () => {
  // notes.txt was already read (and saved) by the read_file test: it is moved, not downloaded again
  const first = JSON.parse(body(await tool('canvas_save_course_files').run(client(), { course_id: '1' })));
  assert.equal(first.unchanged, 1);
  assert.ok(first.saved[0].endsWith(path.join('MATH1012', 'Announcements', 'Assing3.pdf')));
  const saved = path.join(process.env.CANVAS_MCP_DOWNLOADS, 'MATH1012', 'Week 1', 'notes.txt');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'Week 1 notes: vectors and matrices');
  const again = JSON.parse(body(await tool('canvas_save_course_files').run(client(), { course_id: '1' })));
  assert.equal(again.unchanged, 2);
  assert.equal(again.saved, undefined);
});

test('identical uploads are stored once', async () => {
  const r = await client().download('559');   // same bytes as 555, uploaded again under another name
  assert.equal(r.duplicate, true);
  assert.ok(r.path.endsWith('notes.txt'));
});

test('upcoming gives absolute links and submission state', async () => {
  const [it] = JSON.parse(body(await tool('canvas_upcoming').run(client(), {})));
  assert.equal(it.title, 'Assignment 4');
  assert.equal(it.submitted, false);
  assert.equal(it.url, `${base}/courses/1/assignments/10`);
});

test('raw API GET refuses absolute URLs and never sends anything but GET', async () => {
  const from = seen.length;
  await assert.rejects(tool('canvas_api_get').run(client(), { path: 'https://evil.example/x' }), /relative/);
  await tool('canvas_api_get').run(client(), { path: 'courses/1' });
  assert.ok(seen.slice(from).every((l) => l.startsWith('GET ')));
});

test('read tools never send anything but GET', () => {
  // every test above this one only used read tools
  assert.ok(writes.length === 0 && seen.every((l) => l.startsWith('GET ')));
});

test('session provider opens the browser once for concurrent calls', async () => {
  let opens = 0;
  const get = sessionProvider(base, async () => { opens++; await new Promise((r) => setTimeout(r, 20)); return { cookieHeader: 'x' }; }, () => null);
  await Promise.all([get(), get(), get()]);
  assert.equal(opens, 1);
  await get({ fresh: true });
  assert.equal(opens, 2);
});

test('saved cookies are used without opening a browser', async () => {
  let opens = 0;
  const get = sessionProvider(base, async () => { opens++; return { cookieHeader: 'fresh' }; }, () => ({ cookieHeader: 'saved' }));
  assert.equal((await get()).cookieHeader, 'saved');
  assert.equal(opens, 0);
  assert.equal((await get({ fresh: true })).cookieHeader, 'fresh');
  assert.equal(opens, 1);
});

test('never signed in: fails at once with a hint instead of opening windows', async () => {
  const { renewSession } = await import('../src/browser.js');
  const t0 = Date.now();
  await assert.rejects(renewSession('https://canvas.example.edu'), /setup/);
  assert.ok(Date.now() - t0 < 1000);
});

test('text helpers', () => {
  assert.equal(htmlToText('<p>a</p><img src="x"><p>b</p>'), 'a\n\nb');
  assert.deepEqual(fileIdsIn('<a href="/courses/1/files/12?wrap=1">x</a><a href="/files/12/download">y</a>'), ['12']);
  assert.match(window('abcdef', { maxChars: 4 }), /^abcd\n\n\[\.\.\. 2 more characters\. Call again with offset=4\.\]$/);
});

// ---- Write tools (Laplace modification) ----
const writer = (cookie = `canvas_session=good; _csrf_token=${encodeURIComponent(CSRF)}`) => client([cookie]);
const lastWrite = () => writes.at(-1);

test('csrfToken reads and decodes the _csrf_token cookie', () => {
  assert.equal(csrfToken(`a=1; _csrf_token=${encodeURIComponent(CSRF)}; b=2`), CSRF);
  assert.equal(csrfToken('canvas_session=good'), null);
});

test('writes refuse to run without a CSRF token and nothing is sent', async () => {
  const from = writes.length;
  await assert.rejects(tool('canvas_comment_on_submission').run(client(), { course_id: '1', assignment_id: '9', comment: 'hi' }), /CSRF token.*login/s);
  assert.equal(writes.length, from);
});

test('submit text: plain text becomes escaped HTML paragraphs and the attempt is reported', async () => {
  const r = JSON.parse(body(await tool('canvas_submit_assignment').run(writer(), {
    course_id: '1', assignment_id: '9', type: 'online_text_entry', text: 'Q1: x < 3\n\nQ2: done', comment: 'thanks',
  })));
  assert.equal(r.submitted, true);
  assert.equal(r.attempt, 2);
  assert.equal(r.assignment, 'Assignment 3');
  const w = lastWrite();
  assert.equal(w.path, '/api/v1/courses/1/assignments/9/submissions');
  assert.deepEqual(w.body, { submission: { submission_type: 'online_text_entry', body: '<p>Q1: x &lt; 3</p><p>Q2: done</p>' }, comment: { text_comment: 'thanks' } });
});

test('submit checks allowed types, required fields, extensions and locks before sending', async () => {
  const from = writes.length;
  const submit = (args) => tool('canvas_submit_assignment').run(writer(), { course_id: '1', assignment_id: '9', ...args });
  await assert.rejects(submit({ type: 'online_url', url: 'https://x.example' }), /does not accept online_url/);
  await assert.rejects(submit({ type: 'online_text_entry' }), /needs text/);
  await assert.rejects(submit({ type: 'online_upload', file_paths: ['/tmp/a.docx'] }), /only accepts pdf, txt/);
  await assert.rejects(tool('canvas_submit_assignment').run(writer(), { course_id: '1', assignment_id: '11', type: 'online_text_entry', text: 'x' }), /locked: This assignment was locked/);
  assert.equal(writes.length, from);
});

test('submit files: upload slot, upload, confirm, then submission with file ids', async () => {
  const file = path.join(process.env.CANVAS_MCP_HOME, 'answer.txt');
  fs.writeFileSync(file, 'my answer');
  const r = JSON.parse(body(await tool('canvas_submit_assignment').run(writer(), { course_id: '1', assignment_id: '9', type: 'online_upload', file_paths: [file] })));
  assert.deepEqual(r.files, ['answer.txt']);
  const [slot, upload, sub] = writes.slice(-3);
  assert.deepEqual(slot.body, { name: 'answer.txt', size: 9, content_type: 'text/plain' });
  assert.equal(upload.path, '/upload');
  assert.deepEqual(sub.body.submission, { submission_type: 'online_upload', file_ids: [900] });
  await assert.rejects(tool('canvas_submit_assignment').run(writer(), { course_id: '1', assignment_id: '9', type: 'online_upload', file_paths: ['answer.txt'] }), /absolute path/);
});

test('uploads to a non-HTTPS external host are refused before any bytes are sent', async () => {
  const file = path.join(process.env.CANVAS_MCP_HOME, 'external.txt');
  fs.writeFileSync(file, 'secret');
  await assert.rejects(writer().uploadFile('courses/1/assignments/9/submissions/self/files', file), /must use HTTPS/);
});

test('comment, discussion replies, messages', async () => {
  const cm = JSON.parse(body(await tool('canvas_comment_on_submission').run(writer(), { course_id: '1', assignment_id: '9', comment: 'Resubmitted Q2' })));
  assert.equal(cm.comment, 'Resubmitted Q2');
  assert.equal(lastWrite().method, 'PUT');

  const top = JSON.parse(body(await tool('canvas_post_discussion_reply').run(writer(), { course_id: '1', topic_id: '5', message: 'I agree' })));
  assert.equal(top.entry_id, 70);
  assert.deepEqual(lastWrite().body, { message: '<p>I agree</p>' });
  const nested = JSON.parse(body(await tool('canvas_post_discussion_reply').run(writer(), { course_id: '1', topic_id: '5', reply_to_entry_id: '70', message: '<b>Yes</b>' })));
  assert.equal(nested.parent_id, 70);
  assert.deepEqual(lastWrite().body, { message: '<b>Yes</b>' });

  const found = JSON.parse(body(await tool('canvas_find_recipients').run(client(), { search: 'Tutor', course_id: '1' })));
  assert.deepEqual(found, [{ id: 42, name: 'Dr Tutor', roles: ['TeacherEnrollment'] }]);
  const sent = JSON.parse(body(await tool('canvas_send_message').run(writer(), { recipient_ids: ['42'], subject: 'Extension', body: 'May I have one more day?', course_id: '1' })));
  assert.deepEqual(sent.conversation_ids, [300]);
  assert.deepEqual(lastWrite().body, { recipients: ['42'], subject: 'Extension', body: 'May I have one more day?', group_conversation: true, context_code: 'course_1' });
  const reply = JSON.parse(body(await tool('canvas_send_message').run(writer(), { conversation_id: '300', body: 'Thanks!' })));
  assert.equal(reply.conversation_id, 300);
  await assert.rejects(tool('canvas_send_message').run(writer(), { body: 'x' }), /recipient_ids/);
});

test('planner: updates an existing override, creates a new one, adds notes', async () => {
  let r = JSON.parse(body(await tool('canvas_planner_mark_done').run(writer(), { plannable_type: 'assignment', plannable_id: '10' })));
  assert.equal(r.marked_done, true);
  assert.equal(lastWrite().path, '/api/v1/planner/overrides/31');
  r = JSON.parse(body(await tool('canvas_planner_mark_done').run(writer(), { plannable_type: 'quiz', plannable_id: '12', done: false })));
  assert.equal(r.marked_done, false);
  assert.deepEqual(lastWrite().body, { plannable_type: 'quiz', plannable_id: '12', marked_complete: false });
  const n = JSON.parse(body(await tool('canvas_create_planner_note').run(writer(), { title: 'Start A4', date: '2026-10-01' })));
  assert.equal(n.id, 8);
});

test('a 5xx on a write is reported as uncertain and not retried', async () => {
  const from = writes.length;
  await assert.rejects(tool('canvas_post_discussion_reply').run(writer(), { course_id: '1', topic_id: '6', message: 'x' }), (e) => e.uncertain && /Check Canvas before trying again/.test(e.message));
  assert.equal(writes.length, from + 1);
});

test('a rejected session on a write is renewed once, then the write succeeds', async () => {
  const good = `canvas_session=good; _csrf_token=${encodeURIComponent(CSRF)}`;
  const c = client([`canvas_session=old; _csrf_token=${encodeURIComponent(CSRF)}`, good]);
  const r = JSON.parse(body(await tool('canvas_create_planner_note').run(c, { title: 'Renewed', date: '2026-10-02' })));
  assert.equal(r.title, 'Renewed');
});

test('groups: list with sign-up info, join (reporting the group left), leave, and no-op when already a member', async () => {
  const groups = JSON.parse(body(await tool('canvas_list_groups').run(client(), { course_id: '1' })));
  assert.deepEqual(groups[0], { id: 60, name: 'Team A', members: 3, max_members: 4, group_set: 'Project teams', group_set_id: 4, mine: true, self_signup: 'enabled' });
  assert.equal(groups[1].mine, undefined);
  const mine = JSON.parse(body(await tool('canvas_list_groups').run(client(), {})));
  assert.equal(mine[0].name, 'Team A');

  const joined = JSON.parse(body(await tool('canvas_join_group').run(writer(), { group_id: '61' })));
  assert.equal(joined.joined, true);
  assert.deepEqual(joined.moved_from, { id: 60, name: 'Team A' });
  assert.deepEqual(lastWrite(), { method: 'POST', path: '/api/v1/groups/61/memberships', body: { user_id: 'self' } });

  const from = writes.length;
  const already = JSON.parse(body(await tool('canvas_join_group').run(writer(), { group_id: '60' })));
  assert.equal(already.already_member, true);
  assert.equal(writes.length, from);

  const left = JSON.parse(body(await tool('canvas_leave_group').run(writer(), { group_id: '61' })));
  assert.equal(left.left, true);
  assert.equal(lastWrite().method, 'DELETE');
});

test('planner notes can be deleted again', async () => {
  const r = JSON.parse(body(await tool('canvas_delete_planner_note').run(writer(), { note_id: '8' })));
  assert.equal(r.deleted, true);
  assert.deepEqual(lastWrite(), { method: 'DELETE', path: '/api/v1/planner_notes/8', body: {} });
});
