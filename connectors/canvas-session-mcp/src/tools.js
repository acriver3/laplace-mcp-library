import { z } from 'zod';
import { htmlToText, fileIdsIn, extractText, window } from './text.js';
import { downloadDir } from './config.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
// Laplace modification: write tools. Anything graded or seen by other people needs confirm:true.
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const confirm = z.literal(true).describe('Set true only after the user has seen and approved exactly what will be sent to Canvas');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Canvas stores rich text as HTML. Plain text is wrapped in paragraphs; HTML is sent as given.
const asHtml = (s) => (/<\/?[a-z][^>]*>/i.test(s) ? s : String(s).split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''));
const id = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String);
const days = (d) => new Date(Date.now() + d * 86400000).toISOString();

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 1));
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));

function submissionSummary(s) {
  if (!s) return undefined;
  return drop({
    state: s.workflow_state, submitted_at: s.submitted_at, late: s.late || undefined, missing: s.missing || undefined,
    excused: s.excused || undefined, score: s.score, grade: s.grade,
  });
}

// All files of a course. Uses the Files tab when students may see it; many courses hide it,
// and then assignment sheets and slides are scattered over modules, announcement attachments
// and links in assignment descriptions, so we collect them from there (`where` = subfolder).
async function courseFiles(c, courseId, search) {
  const q = String(search || '').toLowerCase();
  const keep = (name) => !q || String(name || '').toLowerCase().includes(q);
  try {
    const files = await c.list(`courses/${courseId}/files`, { sort: 'updated_at', order: 'desc', search_term: search });
    c.noteFiles(courseId, files.map((f) => f.id));
    return { hidden: false, files: files.map((f) => ({ id: f.id, name: f.display_name, size: f.size, updated: f.updated_at, locked: !f.url || undefined })) };
  } catch (e) {
    if (e.status !== 401 && e.status !== 403 && e.status !== 404) throw e;
  }
  const found = new Map();
  const add = (fid, name, where) => { if (fid && !found.has(String(fid))) found.set(String(fid), { id: Number(fid), name, where }); };
  const [mods, anns, assigns] = await Promise.all([
    c.list(`courses/${courseId}/modules`, { include: ['items'] }).catch(() => []),
    // Canvas returns nothing unless both ends of the range are given
    c.list('announcements', { context_codes: [`course_${courseId}`], start_date: days(-400), end_date: days(1) }).catch(() => []),
    c.list(`courses/${courseId}/assignments`).catch(() => []),
  ]);
  for (const m of mods) for (const it of m.items || []) if (it.type === 'File') add(it.content_id, it.title, m.name);
  for (const a of anns) {
    for (const f of a.attachments || []) add(f.id, f.display_name, 'Announcements');
    for (const fid of fileIdsIn(a.message)) add(fid, null, 'Announcements');
  }
  for (const a of assigns) for (const fid of fileIdsIn(a.description)) add(fid, null, 'Assignments');
  c.noteFiles(courseId, [...found.keys()]);
  return { hidden: true, files: [...found.values()].filter((f) => (f.name === null ? !q : keep(f.name))) };
}

// Each tool is { name, title, description, input, run(client, args) }. Kept as plain data so
// tests can call run() directly with a fake client.
export const TOOLS = [
  {
    name: 'canvas_whoami',
    title: 'Who am I on Canvas',
    description: 'Check the Canvas connection and return the signed-in user and Canvas URL.',
    input: {},
    async run(c) {
      const me = await c.get('users/self');
      return json({ canvas: c.base, id: me.id, name: me.name, short_name: me.short_name });
    },
  },
  {
    name: 'canvas_list_courses',
    title: 'List courses',
    description: 'List your Canvas courses (current ones by default) with ids, codes and terms. Most other tools need a course_id from here.',
    input: { include_past: z.boolean().optional().describe('Also include completed/past courses') },
    async run(c, { include_past }) {
      const courses = (await c.list('courses', { include: ['term'], ...(include_past ? {} : { enrollment_state: 'active' }) })).filter((x) => x.id && x.name);
      // Schools often leave last semester's courses "active" for months, so "current" means the
      // term that started most recently. Courses without a dated term are clubs/orientation sites.
      const now = new Date().toISOString();
      const starts = courses.map((x) => x.term?.start_at).filter((s) => s && s <= now).sort();
      const latest = starts[starts.length - 1];
      const rank = (x) => (x.term?.start_at === latest ? 0 : x.term?.start_at ? 1 : 2);
      return json(courses.sort((a, b) => rank(a) - rank(b)).map((x) => drop({
        id: x.id, code: x.course_code, name: x.name, term: x.term?.name,
        current_term: rank(x) === 0 || undefined, kind: rank(x) === 2 ? 'non-term site (community, orientation, etc.)' : undefined,
      })));
    },
  },
  {
    name: 'canvas_upcoming',
    title: 'Upcoming work',
    description: 'Everything due or scheduled across all courses in the next N days (assignments, quizzes, discussions, events), with whether you have submitted. Best first call for "what is due".',
    input: {
      days: z.number().int().min(1).max(120).optional().describe('How many days ahead (default 14)'),
      past_days: z.number().int().min(0).max(60).optional().describe('Also include items from this many days ago, e.g. to find overdue work (default 0)'),
      include_events: z.boolean().optional().describe('Also list calendar events such as timetabled classes (default false: only things you have to do)'),
    },
    async run(c, { days: ahead = 14, past_days = 0, include_events = false }) {
      const items = (await c.list('planner/items', { start_date: days(-past_days), end_date: days(ahead) }))
        .filter((it) => include_events || it.plannable_type !== 'calendar_event');
      return json(items.map((it) => drop({
        course: it.context_name, type: it.plannable_type, title: it.plannable?.title,
        due: it.plannable_date, points: it.plannable?.points_possible,
        submitted: it.submissions ? !!it.submissions.submitted : undefined,
        missing: it.submissions?.missing || undefined, graded: it.submissions?.graded || undefined,
        marked_done: it.planner_override?.marked_complete || undefined,
        course_id: it.course_id, id: it.plannable_id,
        url: it.html_url ? new URL(it.html_url, c.base).href : undefined,
      })));
    },
  },
  {
    name: 'canvas_list_assignments',
    title: 'List assignments',
    description: 'Assignments in a course with due dates, points and your submission status/score.',
    input: {
      course_id: id,
      bucket: z.enum(['past', 'overdue', 'undated', 'ungraded', 'unsubmitted', 'upcoming', 'future']).optional(),
    },
    async run(c, { course_id, bucket }) {
      const list = await c.list(`courses/${course_id}/assignments`, { include: ['submission'], order_by: 'due_at', bucket });
      return json(list.map((a) => drop({
        id: a.id, name: a.name, due: a.due_at, lock: a.lock_at, points: a.points_possible,
        types: a.submission_types, submission: submissionSummary(a.submission),
      })));
    },
  },
  {
    name: 'canvas_get_assignment',
    title: 'Assignment details',
    description: 'Full assignment instructions as text, rubric, your submission, and ids of attached files (read them with canvas_read_file).',
    input: { course_id: id, assignment_id: id },
    async run(c, { course_id, assignment_id }) {
      const a = await c.get(`courses/${course_id}/assignments/${assignment_id}`, { include: ['submission'] });
      c.noteFiles(course_id, fileIdsIn(a.description));
      const rubric = (a.rubric || []).map((r) => drop({
        criterion: r.description, points: r.points, details: r.long_description,
        ratings: (r.ratings || []).map((x) => `${x.points}: ${x.description}`),
      }));
      return json(drop({
        name: a.name, due: a.due_at, lock: a.lock_at, points: a.points_possible, types: a.submission_types,
        url: a.html_url, submission: submissionSummary(a.submission),
        instructions: htmlToText(a.description), file_ids: fileIdsIn(a.description), rubric,
      }));
    },
  },
  {
    name: 'canvas_list_announcements',
    title: 'Announcements',
    description: 'Recent announcements, newest first, as text. Defaults to all current courses.',
    input: {
      course_ids: z.array(id).optional().describe('Limit to these courses'),
      days: z.number().int().min(1).max(365).optional().describe('How far back (default 30)'),
    },
    async run(c, { course_ids, days: back = 30 }) {
      let courses = course_ids;
      const names = new Map();
      if (!courses?.length) {
        const all = await c.list('courses', { enrollment_state: 'active' });
        courses = all.filter((x) => x.id).map((x) => String(x.id));
        for (const x of all) names.set(String(x.id), x.course_code || x.name);
      }
      if (!courses.length) return text('No current courses.');
      const list = await c.list('announcements', { context_codes: courses.map((x) => `course_${x}`), start_date: days(-back), end_date: days(1) });
      for (const a of list) c.noteFiles(String(a.context_code).replace('course_', ''), [...fileIdsIn(a.message), ...(a.attachments || []).map((f) => f.id)]);
      return json(list.map((a) => drop({
        id: a.id, course: names.get(String(a.context_code).replace('course_', '')) || a.context_code,
        title: a.title, posted: a.posted_at, author: a.author?.display_name,
        text: htmlToText(a.message).slice(0, 4000), file_ids: fileIdsIn(a.message),
        attachments: (a.attachments || []).map((f) => ({ file_id: f.id, name: f.display_name })),
      })));
    },
  },
  {
    name: 'canvas_list_modules',
    title: 'Course modules',
    description: 'The course structure: modules and their items (pages, files, assignments, links). File items give a file id for canvas_read_file; page items give a page_url for canvas_get_page.',
    input: { course_id: id },
    async run(c, { course_id }) {
      const mods = await c.list(`courses/${course_id}/modules`, { include: ['items'] });
      c.noteFiles(course_id, mods.flatMap((m) => (m.items || []).filter((it) => it.type === 'File').map((it) => it.content_id)));
      return json(mods.map((m) => drop({
        module: m.name,
        items: (m.items || []).map((it) => drop({
          type: it.type, title: it.title,
          file_id: it.type === 'File' ? it.content_id : undefined,
          assignment_id: ['Assignment', 'Quiz', 'Discussion'].includes(it.type) ? it.content_id : undefined,
          page_url: it.page_url, link: it.external_url,
        })),
      })));
    },
  },
  {
    name: 'canvas_get_page',
    title: 'Read a page',
    description: 'Read a course page (wiki page) as text. Use page_url from canvas_list_modules, or "front_page".',
    input: {
      course_id: id,
      page_url: z.string().describe('Page slug, e.g. "week-1-overview", or "front_page"'),
      offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(500).max(100000).optional(),
    },
    async run(c, { course_id, page_url, offset, max_chars }) {
      const p = page_url === 'front_page'
        ? await c.get(`courses/${course_id}/front_page`)
        : await c.get(`courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
      const ids = fileIdsIn(p.body);
      c.noteFiles(course_id, ids);
      const head = `# ${p.title}\nupdated: ${p.updated_at}${ids.length ? `\nlinked file ids: ${ids.join(', ')}` : ''}\n\n`;
      return text(head + window(htmlToText(p.body), { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_list_files',
    title: 'List course files',
    description: 'Files in a course (newest first), optionally filtered by name. Many courses hide the Files tab from students; then this falls back to the files linked in modules.',
    input: { course_id: id, search: z.string().min(2).optional().describe('Part of the file name') },
    async run(c, { course_id, search }) {
      const r = await courseFiles(c, course_id, search);
      if (!r.hidden) return json(r.files.map((f) => drop({ id: f.id, name: f.name, size: f.size, updated: f.updated, locked: f.locked })));
      return json({ note: 'The Files tab is hidden in this course; these are the files found in modules, announcements and assignments.', files: r.files.map(({ id: fid, name, where }) => drop({ id: fid, name, where })) });
    },
  },
  {
    name: 'canvas_read_file',
    title: 'Read a course file',
    description: 'Download a course file (lecture slides, assignment PDF, handout) and return its text. Supports PDF, DOCX, HTML and plain-text files; other formats are saved locally and the path is returned.',
    input: {
      file_id: id,
      course_id: id.optional().describe('The course it belongs to, so it is saved in that course folder'),
      offset: z.number().int().min(0).optional().describe('Character offset for long files'),
      max_chars: z.number().int().min(500).max(100000).optional().describe('Characters to return (default 20000)'),
    },
    async run(c, { file_id, course_id, offset, max_chars }) {
      if (course_id) c.noteFiles(course_id, [file_id]);
      const f = await c.download(file_id);
      const head = `# ${f.name}\nsaved to: ${f.path}\nsize: ${f.size} bytes, updated ${f.updatedAt}\n\n`;
      const body = await extractText(f.buffer, f).catch((e) => `(could not extract text: ${e.message})`);
      if (body === null) return text(head + `This file type (${f.contentType || 'unknown'}) cannot be read as text here. Open it from the saved path.`);
      if (!body.trim()) return text(head + '(No text layer, e.g. a scanned PDF. Open it from the saved path.)');
      return text(head + window(body, { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_save_course_files',
    title: 'Save course files to your computer',
    description: 'Download a course\'s files (slides, readings, assignment PDFs) into your chosen folder, one subfolder per course. Files already saved and unchanged are skipped, so it is safe to run again to pick up new material.',
    input: {
      course_id: id,
      search: z.string().min(2).optional().describe('Only files whose name contains this'),
      max: z.number().int().min(1).max(500).optional().describe('At most this many files (default 150)'),
    },
    async run(c, { course_id, search, max = 150 }) {
      const course = await c.get(`courses/${course_id}`);
      const folder = course.course_code || course.name || `course-${course_id}`;
      const files = (await courseFiles(c, course_id, search)).files.filter((f) => !f.locked).slice(0, max);
      const saved = []; const unchanged = []; const failed = [];
      for (const f of files) {
        try {
          const r = await c.download(f.id, { subdir: f.where ? `${folder}/${f.where}` : folder });
          (r.cached ? unchanged : saved).push(r.path);
        } catch (e) { failed.push(`${f.name}: ${e.message}`); }
      }
      return json(drop({ folder: `${downloadDir()}/${folder}`, saved, unchanged: unchanged.length, failed }));
    },
  },
  {
    name: 'canvas_list_discussions',
    title: 'Discussion topics',
    description: 'Discussion topics in a course with reply counts and unread counts.',
    input: { course_id: id },
    async run(c, { course_id }) {
      const list = await c.list(`courses/${course_id}/discussion_topics`, { order_by: 'recent_activity' }, { maxPages: 3 });
      return json(list.map((d) => drop({
        id: d.id, title: d.title, posted: d.posted_at, last_reply: d.last_reply_at,
        replies: d.discussion_subentry_count, unread: d.unread_count || undefined,
      })));
    },
  },
  {
    name: 'canvas_get_discussion',
    title: 'Read a discussion',
    description: 'A discussion topic and all its replies as text.',
    input: { course_id: id, topic_id: id, offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(500).max(100000).optional() },
    async run(c, { course_id, topic_id, offset, max_chars }) {
      const t = await c.get(`courses/${course_id}/discussion_topics/${topic_id}`);
      const v = await c.get(`courses/${course_id}/discussion_topics/${topic_id}/view`).catch(() => ({ view: [], participants: [] }));
      const who = new Map((v.participants || []).map((p) => [p.id, p.display_name]));
      const lines = [`# ${t.title}`, `${t.author?.display_name || ''} · ${t.posted_at || ''}`, '', htmlToText(t.message), ''];
      const walk = (entries, depth) => {
        for (const e of entries || []) {
          if (e.deleted) continue;
          const pad = '  '.repeat(depth);
          lines.push(`${pad}— ${who.get(e.user_id) || 'someone'} · ${e.created_at} · entry ${e.id}`);
          lines.push(htmlToText(e.message).split('\n').map((l) => pad + l).join('\n'), '');
          walk(e.replies, depth + 1);
        }
      };
      walk(v.view, 0);
      return text(window(lines.join('\n'), { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_grades',
    title: 'Grades',
    description: 'Without course_id: your current overall grade in each course. With course_id: every graded item with score and teacher comments.',
    input: { course_id: id.optional() },
    async run(c, { course_id }) {
      if (!course_id) {
        const enr = await c.list('users/self/enrollments', { type: ['StudentEnrollment'], state: ['active'] });
        const courses = new Map((await c.list('courses', { enrollment_state: 'active' })).map((x) => [x.id, x.course_code || x.name]));
        return json(enr.map((e) => drop({
          course_id: e.course_id, course: courses.get(e.course_id),
          current_score: e.grades?.current_score, current_grade: e.grades?.current_grade, final_score: e.grades?.final_score,
        })));
      }
      const subs = await c.list(`courses/${course_id}/students/submissions`, { include: ['assignment', 'submission_comments'] });
      return json(subs.filter((s) => s.assignment).map((s) => drop({
        assignment: s.assignment.name, due: s.assignment.due_at, points: s.assignment.points_possible,
        score: s.score, grade: s.grade, state: s.workflow_state, late: s.late || undefined, missing: s.missing || undefined,
        comments: (s.submission_comments || []).map((x) => `${x.author_name}: ${x.comment}`),
      })));
    },
  },
  {
    name: 'canvas_inbox',
    title: 'Canvas inbox',
    description: 'Canvas Inbox conversations (messages from teachers and classmates). Pass conversation_id to read one thread in full.',
    input: { conversation_id: id.optional(), max: z.number().int().min(1).max(100).optional().describe('How many conversations to list (default 20)') },
    async run(c, { conversation_id, max = 20 }) {
      if (conversation_id) {
        const cv = await c.get(`conversations/${conversation_id}`);
        const who = new Map((cv.participants || []).map((p) => [p.id, p.name]));
        return text([`# ${cv.subject || '(no subject)'}`, ...(cv.messages || []).slice().reverse()
          .map((m) => `— ${who.get(m.author_id) || m.author_id} · ${m.created_at}\n${m.body}`)].join('\n\n'));
      }
      const list = await c.list('conversations', { scope: 'inbox', per_page: Math.min(max, 100) }, { maxPages: 1 });
      return json(list.slice(0, max).map((cv) => drop({
        id: cv.id, subject: cv.subject, course: cv.context_name, with: (cv.participants || []).map((p) => p.name).join(', '),
        last: cv.last_message_at, unread: cv.workflow_state === 'unread' || undefined, preview: String(cv.last_message || '').slice(0, 300),
      })));
    },
  },
  {
    name: 'canvas_calendar',
    title: 'Calendar events',
    description: 'Calendar events (classes, exams, consultation times) in the next N days. Defaults to all current courses.',
    input: { days: z.number().int().min(1).max(180).optional().describe('Days ahead (default 30)'), course_ids: z.array(id).optional() },
    async run(c, { days: ahead = 30, course_ids }) {
      let courses = course_ids;
      if (!courses?.length) courses = (await c.list('courses', { enrollment_state: 'active' })).filter((x) => x.id).map((x) => String(x.id));
      const codes = courses.slice(0, 10).map((x) => `course_${x}`);   // Canvas accepts at most 10 contexts per call
      const list = await c.list('calendar_events', { type: 'event', context_codes: codes, start_date: days(0), end_date: days(ahead) });
      return json(list.map((e) => drop({
        title: e.title, start: e.start_at, end: e.end_at, where: e.location_name, course: e.context_name,
        details: htmlToText(e.description).slice(0, 1000),
      })));
    },
  },
  {
    name: 'canvas_api_get',
    title: 'Raw Canvas API GET',
    description: 'Escape hatch: GET any Canvas REST endpoint (https://canvas.instructure.com/doc/api/) with your session, e.g. "courses/123/quizzes". Read-only.',
    input: {
      path: z.string().describe('Path after /api/v1/, e.g. "courses/123/quizzes"'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional(),
      all_pages: z.boolean().optional().describe('Follow pagination (lists only)'),
    },
    async run(c, { path: p, params = {}, all_pages }) {
      const clean = p.replace(/^\/?(api\/v1\/)?/, '');
      if (/^https?:|\.\./.test(clean)) throw new Error('Give a path relative to /api/v1/.');
      const data = all_pages ? await c.list(clean, params) : await c.get(clean, params);
      return text(window(JSON.stringify(data, null, 1), { maxChars: 40000 }));
    },
  },
  {
    name: 'canvas_find_recipients',
    title: 'Find message recipients',
    description: 'Look up people you can message on Canvas (teachers, TAs, classmates) by name. Returns user ids for canvas_send_message.',
    input: {
      search: z.string().min(2).describe('Part of the person\'s name'),
      course_id: id.optional().describe('Only people in this course'),
    },
    async run(c, { search, course_id }) {
      const list = await c.list('search/recipients', { search, types: ['user'], context: course_id ? `course_${course_id}` : undefined, per_page: 20 }, { maxPages: 1 });
      return json(list.map((r) => drop({
        id: r.id, name: r.name,
        roles: course_id ? r.common_courses?.[course_id] : undefined,
      })));
    },
  },

  {
    name: 'canvas_list_groups',
    title: 'Course groups',
    description: 'Groups in a course (project teams, sign-up groups) with member counts, whether you are in each, and whether its group set lets students sign themselves up. Without course_id: the groups you are in.',
    input: { course_id: id.optional() },
    async run(c, { course_id }) {
      const mine = await c.list('users/self/groups');
      const mineIds = new Set(mine.map((g) => String(g.id)));
      if (!course_id) return json(mine.map((g) => drop({ id: g.id, name: g.name, course_id: g.course_id, group_set_id: g.group_category_id, members: g.members_count })));
      const [groups, sets] = await Promise.all([
        c.list(`courses/${course_id}/groups`),
        c.list(`courses/${course_id}/group_categories`).catch(() => []),
      ]);
      const setOf = new Map(sets.map((s) => [String(s.id), s]));
      return json(groups.map((g) => {
        const set = setOf.get(String(g.group_category_id));
        return drop({
          id: g.id, name: g.name, members: g.members_count, max_members: g.max_membership,
          group_set: set?.name, group_set_id: g.group_category_id, mine: mineIds.has(String(g.id)) || undefined,
          self_signup: set ? set.self_signup || 'off' : undefined, join_level: g.join_level,
        });
      }));
    },
  },

  // ---- Write tools (Laplace modification). They act as you on Canvas. ----
  {
    name: 'canvas_join_group',
    title: 'Join a group',
    annotations: WRITE,
    description: 'Join a course group as you (groups from canvas_list_groups whose group set allows self sign-up, or open community groups). In a sign-up group set you can only be in one group, so Canvas moves you out of your current group in that set; the result reports it as moved_from. Some groups only accept a request that a teacher approves. Tell the user which group they will join (and leave, if any) and get approval first.',
    input: { group_id: id, confirm },
    async run(c, { group_id }) {
      const g = await c.get(`groups/${group_id}`);
      const mine = await c.list('users/self/groups');
      if (mine.some((x) => String(x.id) === group_id)) return json({ joined: true, group: g.name, already_member: true });
      const previous = g.group_category_id && mine.find((x) => String(x.group_category_id) === String(g.group_category_id));
      const m = await c.send('POST', `groups/${group_id}/memberships`, { user_id: 'self' }, { what: `Joining "${g.name}"` });
      return json(drop({
        joined: m.workflow_state === 'accepted', requested: m.workflow_state === 'requested' || undefined,
        group: g.name, group_id: g.id, state: m.workflow_state,
        moved_from: previous ? { id: previous.id, name: previous.name } : undefined,
      }));
    },
  },
  {
    name: 'canvas_leave_group',
    title: 'Leave a group',
    annotations: WRITE,
    description: 'Leave a group you belong to. Groups that teachers assign cannot be left, and rejoining a sign-up group may be impossible if it fills up. Get the user\'s approval first.',
    input: { group_id: id, confirm },
    async run(c, { group_id }) {
      const g = await c.get(`groups/${group_id}`);
      await c.send('DELETE', `groups/${group_id}/memberships/self`, undefined, { what: `Leaving "${g.name}"` });
      return json({ left: true, group: g.name, group_id: g.id });
    },
  },
  {
    name: 'canvas_submit_assignment',
    title: 'Submit an assignment',
    annotations: { ...WRITE, destructiveHint: true },
    description: 'Submit your work for an assignment as you: text entry, a website URL, or files from this computer. Each call creates a new attempt, and the latest attempt is the one graded. Before calling, show the user the assignment name, submission type, and the exact text/URL/file paths, and get their explicit approval. Never retry automatically: if the outcome is uncertain, check with canvas_get_assignment first.',
    input: {
      course_id: id,
      assignment_id: id,
      type: z.enum(['online_text_entry', 'online_url', 'online_upload']).describe('Must be one of the assignment\'s allowed submission types (see canvas_get_assignment)'),
      text: z.string().min(1).max(500000).optional().describe('online_text_entry: the answer. Plain text (paragraphs kept) or HTML'),
      url: z.string().url().optional().describe('online_url: the address to submit'),
      file_paths: z.array(z.string().min(1)).min(1).max(20).optional().describe('online_upload: absolute paths of local files'),
      comment: z.string().min(1).max(10000).optional().describe('Optional comment to the grader sent with the submission'),
      confirm,
    },
    async run(c, { course_id, assignment_id, type, text: answer, url, file_paths, comment }) {
      const a = await c.get(`courses/${course_id}/assignments/${assignment_id}`, { include: ['submission'] });
      if (a.locked_for_user) throw new Error(`"${a.name}" is locked: ${htmlToText(a.lock_explanation || '') || 'not open for submissions'}`);
      const allowed = a.submission_types || [];
      if (!allowed.includes(type)) throw new Error(`"${a.name}" does not accept ${type}. Allowed: ${allowed.join(', ') || 'none'}.`);
      const need = { online_text_entry: ['text', answer], online_url: ['url', url], online_upload: ['file_paths', file_paths] }[type];
      if (!need[1]) throw new Error(`${type} needs ${need[0]}.`);
      if (type === 'online_upload' && a.allowed_extensions?.length) {
        const bad = file_paths.filter((f) => !a.allowed_extensions.includes(f.split('.').pop().toLowerCase()));
        if (bad.length) throw new Error(`"${a.name}" only accepts ${a.allowed_extensions.join(', ')} files: ${bad.join(', ')}`);
      }
      const submission = { submission_type: type };
      let files;
      if (type === 'online_text_entry') submission.body = asHtml(answer);
      if (type === 'online_url') submission.url = url;
      if (type === 'online_upload') {
        files = [];
        for (const f of file_paths) files.push(await c.uploadFile(`courses/${course_id}/assignments/${assignment_id}/submissions/self/files`, f, { what: `Submitting "${a.name}"` }));
        submission.file_ids = files.map((f) => f.id);
      }
      const s = await c.send('POST', `courses/${course_id}/assignments/${assignment_id}/submissions`,
        drop({ submission, comment: comment ? { text_comment: comment } : undefined }), { what: `Submitting "${a.name}"` });
      return json(drop({
        submitted: true, assignment: a.name, type, attempt: s.attempt, submitted_at: s.submitted_at,
        state: s.workflow_state, late: s.late || undefined, files: files?.map((f) => f.name),
        replaced_attempt: a.submission?.attempt || undefined, url: a.html_url,
      }));
    },
  },
  {
    name: 'canvas_comment_on_submission',
    title: 'Comment on your submission',
    annotations: WRITE,
    description: 'Add a comment to your own submission for an assignment (visible to the teacher/grader). Show the user the exact comment and get approval first.',
    input: { course_id: id, assignment_id: id, comment: z.string().min(1).max(10000), confirm },
    async run(c, { course_id, assignment_id, comment }) {
      const s = await c.send('PUT', `courses/${course_id}/assignments/${assignment_id}/submissions/self`,
        { comment: { text_comment: comment } }, { what: 'Adding a submission comment' });
      const last = (s.submission_comments || []).at(-1);
      return json(drop({ commented: true, at: last?.created_at, comment: last?.comment || comment }));
    },
  },
  {
    name: 'canvas_post_discussion_reply',
    title: 'Reply in a discussion',
    annotations: WRITE,
    description: 'Post a reply to a course discussion topic as you, or reply to a specific entry (entry ids are shown by canvas_get_discussion). Classmates and teachers will see it. Show the user the exact message and get approval first.',
    input: {
      course_id: id, topic_id: id,
      message: z.string().min(1).max(100000).describe('Plain text (paragraphs kept) or HTML'),
      reply_to_entry_id: id.optional().describe('Reply under this entry instead of to the topic'),
      confirm,
    },
    async run(c, { course_id, topic_id, message, reply_to_entry_id }) {
      const base = `courses/${course_id}/discussion_topics/${topic_id}/entries`;
      const e = await c.send('POST', reply_to_entry_id ? `${base}/${reply_to_entry_id}/replies` : `${base}`,
        { message: asHtml(message) }, { what: 'Posting a discussion reply' });
      return json(drop({ posted: true, entry_id: e.id, parent_id: e.parent_id, created_at: e.created_at }));
    },
  },
  {
    name: 'canvas_send_message',
    title: 'Send a Canvas Inbox message',
    annotations: WRITE,
    description: 'Send a Canvas Inbox message as you: reply in an existing conversation (conversation_id from canvas_inbox), or start a new one with recipient ids from canvas_find_recipients. Several recipients share one group conversation. Show the user the recipients, subject and exact text and get approval first.',
    input: {
      body: z.string().min(1).max(50000).describe('Message text'),
      conversation_id: id.optional().describe('Reply in this conversation'),
      recipient_ids: z.array(id).min(1).max(50).optional().describe('New conversation: user ids'),
      subject: z.string().max(255).optional().describe('New conversation: subject'),
      course_id: id.optional().describe('New conversation: the course it concerns'),
      confirm,
    },
    async run(c, { body: msg, conversation_id, recipient_ids, subject, course_id }) {
      if (conversation_id && recipient_ids) throw new Error('Give either conversation_id (reply) or recipient_ids (new conversation), not both.');
      if (conversation_id) {
        const cv = await c.send('POST', `conversations/${conversation_id}/add_message`, { body: msg }, { what: 'Sending a Canvas message' });
        return json(drop({ sent: true, conversation_id: cv.id || conversation_id, subject: cv.subject }));
      }
      if (!recipient_ids) throw new Error('Give recipient_ids for a new conversation (see canvas_find_recipients), or conversation_id to reply.');
      const r = await c.send('POST', 'conversations', drop({
        recipients: recipient_ids, subject, body: msg, group_conversation: true,
        context_code: course_id ? `course_${course_id}` : undefined,
      }), { what: 'Sending a Canvas message' });
      const list = Array.isArray(r) ? r : [r];
      return json(drop({ sent: true, conversation_ids: list.map((x) => x.id).filter(Boolean), subject }));
    },
  },
  {
    name: 'canvas_planner_mark_done',
    title: 'Mark a to-do done',
    annotations: { ...WRITE, idempotentHint: true },
    description: 'Mark an item in your Canvas planner/to-do list as done (or not done). Use type and id from canvas_upcoming. This only affects your own planner, not submissions.',
    input: {
      plannable_type: z.enum(['assignment', 'quiz', 'discussion_topic', 'wiki_page', 'planner_note', 'calendar_event', 'announcement', 'sub_assignment']),
      plannable_id: id,
      done: z.boolean().optional().describe('Default true; false marks it not done'),
    },
    async run(c, { plannable_type, plannable_id, done = true }) {
      const existing = (await c.list('planner/overrides')).find((o) => o.plannable_type === plannable_type && String(o.plannable_id) === plannable_id);
      const o = existing
        ? await c.send('PUT', `planner/overrides/${existing.id}`, { marked_complete: done }, { what: 'Updating the planner' })
        : await c.send('POST', 'planner/overrides', { plannable_type, plannable_id, marked_complete: done }, { what: 'Updating the planner' });
      return json({ plannable_type, plannable_id, marked_done: o.marked_complete ?? done });
    },
  },
  {
    name: 'canvas_create_planner_note',
    title: 'Add a to-do note',
    annotations: WRITE,
    description: 'Add a private to-do note to your Canvas planner (only you see it), optionally tied to a course.',
    input: {
      title: z.string().min(1).max(255),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/).describe('When it is due: YYYY-MM-DD or an ISO date-time'),
      details: z.string().max(10000).optional(),
      course_id: id.optional(),
    },
    async run(c, { title, date, details, course_id }) {
      const n = await c.send('POST', 'planner_notes', drop({ title, details, todo_date: date, course_id }), { what: 'Adding a planner note' });
      return json(drop({ created: true, id: n.id, title: n.title, date: n.todo_date, course_id: n.course_id }));
    },
  },
  {
    name: 'canvas_delete_planner_note',
    title: 'Delete a to-do note',
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    description: 'Delete one of your private planner to-do notes (id from canvas_create_planner_note, or canvas_upcoming items of type planner_note).',
    input: { note_id: id },
    async run(c, { note_id }) {
      await c.send('DELETE', `planner_notes/${note_id}`, undefined, { what: 'Deleting a planner note' });
      return json({ deleted: true, id: note_id });
    },
  },
];

export function registerTools(server, withClient) {
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: { ...(t.annotations || READ_ONLY), title: t.title } },
      async (args) => {
        try { return await withClient((client) => t.run(client, args || {})); }
        catch (e) {
          const known = ['sign_in_required', 'identity_mismatch', 'rate_limited', 'transport_unavailable'].includes(e.code);
          return {
            isError: true, content: [{ type: 'text', text: e.message }],
            ...(known ? { structuredContent: {
              code: e.code,
              ...(e.retryAfterMs ? { details: { retryAfterMs: e.retryAfterMs } } : {}),
            } } : {}),
          };
        }
      });
  }
}
