import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CmsService, DRAFT_TTL_MS, fingerprint } from "../dist/core.js";
import { CmsError } from "../dist/types.js";

const change = {
  operation: "task_create",
  area: "tasks",
  fields: { subject: "Prepare interview" },
  files: [],
};
const result = {
  status: "verified",
  url: "https://som-yale.12twenty.com/tasks/",
  effects: [{ name: "task_create", status: "verified", target: "42" }],
  result: { id: "42" },
};
async function fixture(t, overrides = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cms-core-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = {
    identity: "secret-session-key",
    version: 1,
    submits: 0,
    closes: 0,
    reads: 0,
  };
  const adapter = {
    async identity() {
      return {
        key: state.identity,
        name: "Fixture Student",
        account_id: "student-1",
      };
    },
    async read(input) {
      state.reads++;
      return {
        area: input.area,
        url: "https://som-yale.12twenty.com/tasks/",
        title: "Tasks",
        timezone: "America/New_York",
        text: "",
        records: [],
        ...input,
      };
    },
    async form(input) {
      return {
        operation: input.operation,
        area: input.area,
        supported: true,
        url: "https://som-yale.12twenty.com/tasks/",
        fields: [],
        actions: ["Save"],
        context: {},
      };
    },
    async capabilities() {
      return { areas: ["tasks"] };
    },
    async prepare(input) {
      return {
        identity: state.identity,
        preview: {
          target_id: input.target_id,
          state: state.version,
          fields: input.fields,
          account: "Fixture Student",
        },
      };
    },
    async submit(input, recordEffect) {
      state.submits++;
      await recordEffect({
        name: input.operation,
        status: "intended",
        target: "42",
      });
      await recordEffect({
        name: input.operation,
        status: "verified",
        target: "42",
      });
      return structuredClone(result);
    },
    async download(input) {
      return input;
    },
    async close() {
      state.closes++;
    },
    ...overrides,
  };
  const profile = join(dir, "profile"),
    service = new CmsService(adapter, { profileDir: profile, ...options });
  return {
    dir,
    profile,
    service,
    adapter,
    state,
    journal: profile + ".cms-journal.json",
  };
}
test("previews are local, immutable, complete, and have a ten-minute lifetime", async (t) => {
  let now = 100000;
  const f = await fixture(t, {}, { now: () => now });
  const input = structuredClone(change);
  const prepared = await f.service.prepare(input);
  assert.equal(f.state.submits, 0);
  assert.equal(Date.parse(prepared.expires_at), now + DRAFT_TTL_MS);
  assert.deepEqual(prepared.preview.requested_fields, input.fields);
  input.fields.subject = "different";
  prepared.preview.fields.subject = "different again";
  const receipt = await f.service.commit(prepared.draft_id, true);
  assert.equal(receipt.status, "verified");
  assert.equal(f.state.submits, 1);
  await assert.rejects(() => f.service.commit(prepared.draft_id, true), {
    code: "draft_expired",
  });
});
test("confirmation is mandatory, and concurrent confirmations cannot duplicate a change", async (t) => {
  const f = await fixture(t);
  const prepared = await f.service.prepare(change);
  await assert.rejects(() => f.service.commit(prepared.draft_id, false), {
    code: "confirmation_required",
  });
  const outcomes = await Promise.allSettled([
    f.service.commit(prepared.draft_id, true),
    f.service.commit(prepared.draft_id, true),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter((x) => x.status === "rejected")[0].reason.code,
    "draft_expired",
  );
  assert.equal(f.state.submits, 1);
});
test("expired previews are consumed before asynchronous work", async (t) => {
  let now = 100000;
  const f = await fixture(t, {}, { now: () => now });
  const prepared = await f.service.prepare(change);
  now += DRAFT_TTL_MS;
  await assert.rejects(() => f.service.commit(prepared.draft_id, true), {
    code: "draft_expired",
  });
  assert.equal(f.state.submits, 0);
});
test("a preview expiring during state revalidation does not submit", async (t) => {
  let now = 100000;
  const f = await fixture(t, {}, { now: () => now });
  const prepared = await f.service.prepare(change);
  const previous = f.adapter.prepare;
  f.adapter.prepare = async (input) => {
    const p = await previous(input);
    now += DRAFT_TTL_MS;
    return p;
  };
  await assert.rejects(() => f.service.commit(prepared.draft_id, true), {
    code: "draft_expired",
  });
  assert.equal(f.state.submits, 0);
});
for (const [label, mutate, code] of [
  [
    "changed eligibility",
    (s) => {
      s.version++;
    },
    "preview_changed",
  ],
  [
    "a changed account",
    (s) => {
      s.identity = "new-session";
    },
    "account_changed",
  ],
])
  test(label + " invalidates the exact preview", async (t) => {
    const f = await fixture(t),
      prepared = await f.service.prepare(change);
    mutate(f.state);
    await assert.rejects(() => f.service.commit(prepared.draft_id, true), {
      code,
    });
    assert.equal(f.state.submits, 0);
    await assert.rejects(() => f.service.commit(prepared.draft_id, true), {
      code: "draft_expired",
    });
  });
test("file bytes, resolved path, size, and hash appear in the approved preview", async (t) => {
  const f = await fixture(t),
    file = join(f.dir, "resume.pdf");
  await writeFile(file, "original resume bytes");
  const p = await f.service.prepare({
    operation: "application_submit",
    area: "applications",
    target_id: "job-1",
    files: [{ field: "resume", path: file }],
  });
  assert.equal(p.preview.files[0].name, "resume.pdf");
  assert.equal(p.preview.files[0].resolved_path, file);
  assert.equal(p.preview.files[0].size, 21);
  assert.match(p.preview.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.state.submits, 0);
});
test("changed uploads are rejected before submission", async (t) => {
  const f = await fixture(t),
    file = join(f.dir, "resume.pdf");
  await writeFile(file, "version a");
  const p = await f.service.prepare({
    operation: "document_upload",
    area: "documents",
    files: [{ field: "file", path: file }],
  });
  await writeFile(file, "version b");
  await assert.rejects(() => f.service.commit(p.draft_id, true), {
    code: "file_changed",
  });
  assert.equal(f.state.submits, 0);
});
test("a symlink changing targets invalidates the preview even with identical bytes", async (t) => {
  if (process.platform === "win32")
    return t.skip("Symlink privileges are platform-dependent");
  const f = await fixture(t),
    a = join(f.dir, "a.pdf"),
    b = join(f.dir, "b.pdf"),
    link = join(f.dir, "resume.pdf");
  await writeFile(a, "same");
  await writeFile(b, "same");
  await symlink(a, link);
  const p = await f.service.prepare({
    operation: "document_upload",
    area: "documents",
    files: [{ field: "file", path: link }],
  });
  await rm(link);
  await symlink(b, link);
  await assert.rejects(() => f.service.commit(p.draft_id, true), {
    code: "file_changed",
  });
  assert.equal(f.state.submits, 0);
});
test("confirmed uploads use a private immutable snapshot and clean it up", async (t) => {
  const f = await fixture(t),
    file = join(f.dir, "resume.pdf");
  await writeFile(file, "approved bytes");
  let uploaded;
  f.adapter.submit = async (input, effect) => {
    f.state.submits++;
    uploaded = input.files[0].path;
    await effect({ name: "upload", status: "intended" });
    await writeFile(file, "substituted after validation");
    assert.notEqual(uploaded, file);
    assert.equal(await readFile(uploaded, "utf8"), "approved bytes");
    return structuredClone(result);
  };
  const p = await f.service.prepare({
    operation: "document_upload",
    area: "documents",
    files: [{ field: "file", path: file }],
  });
  await f.service.commit(p.draft_id, true);
  await assert.rejects(() => access(uploaded), { code: "ENOENT" });
  assert.equal(await readFile(file, "utf8"), "substituted after validation");
});
test("upload policy rejects relative paths, duplicate fields, directories, empty and oversized files", async (t) => {
  const f = await fixture(t, {}, { maxUploadBytes: 10 });
  const file = join(f.dir, "large.pdf"),
    empty = join(f.dir, "empty.pdf");
  await writeFile(file, "01234567890");
  await writeFile(empty, "");
  for (const files of [
    [{ field: "f", path: "relative.pdf" }],
    [
      { field: "f", path: file },
      { field: "f", path: file },
    ],
    [{ field: "f", path: f.dir }],
    [{ field: "f", path: empty }],
    [{ field: "f", path: file }],
  ]) {
    await assert.rejects(() => f.service.prepare({ ...change, files }), {
      code: "invalid_file",
    });
  }
  assert.equal(f.state.submits, 0);
});
test("journal intent is durable before every remote effect and omits private answers and identity keys", async (t) => {
  const f = await fixture(t);
  f.adapter.submit = async (input, effect) => {
    const initial = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(initial.status, "pending");
    assert.equal(initial.effects[0].status, "intended");
    await effect({
      name: "upload",
      status: "intended",
      target: "doc-7",
      details: { secret: "omit-this" },
    });
    const journal = await readFile(f.journal, "utf8");
    assert.equal(JSON.parse(journal).effects.at(-1).name, "upload");
    assert.equal(journal.includes("secret-session-key"), false);
    assert.equal(journal.includes("Private salary answer"), false);
    assert.equal(journal.includes("omit-this"), false);
    return structuredClone(result);
  };
  const p = await f.service.prepare({
    ...change,
    fields: { subject: "Private salary answer" },
  });
  await f.service.commit(p.draft_id, true);
  assert.equal(
    JSON.parse(await readFile(f.journal, "utf8")).status,
    "complete",
  );
});
test("an uncertain submission blocks new writes across restart, while reads remain available", async (t) => {
  const f = await fixture(t);
  f.adapter.submit = async () => {
    f.state.submits++;
    throw new Error("do not leak response or cookies");
  };
  const p = await f.service.prepare(change);
  await assert.rejects(
    () => f.service.commit(p.draft_id, true),
    (e) =>
      e.code === "submission_uncertain" &&
      !JSON.stringify(e).includes("do not leak"),
  );
  const restarted = new CmsService(f.adapter, { profileDir: f.profile });
  await assert.rejects(() => restarted.prepare(change), {
    code: "reconciliation_required",
  });
  assert.equal((await restarted.read({ area: "tasks" })).area, "tasks");
  assert.equal((await restarted.sessionStatus()).recovery.blocked, true);
  assert.equal(f.state.submits, 1);
  await assert.rejects(
    () => restarted.acknowledgeUncertain({ acknowledge: true, note: "okay" }),
    {
      code: "acknowledgement_required",
    },
  );
  const recovery = await restarted.acknowledgeUncertain({
    acknowledge: true,
    note: "Inspected CMS tasks; the intended task was created.",
  });
  assert.equal(recovery.replayed, false);
  assert.equal(f.state.submits, 1);
  assert.equal((await restarted.recoveryStatus()).blocked, false);
});
test("verified partial completion is preserved and still blocks replay", async (t) => {
  const f = await fixture(t, {
    async submit() {
      return {
        status: "partial",
        url: result.url,
        effects: [
          { name: "upload", status: "verified", target: "doc-1" },
          { name: "apply", status: "uncertain" },
        ],
        result: { document_id: "doc-1" },
      };
    },
  });
  const p = await f.service.prepare(change);
  await assert.rejects(
    () => f.service.commit(p.draft_id, true),
    (e) =>
      e.code === "submission_partial" &&
      e.details.result.result.document_id === "doc-1",
  );
  const journal = JSON.parse(await readFile(f.journal, "utf8"));
  assert.equal(journal.status, "partial");
  assert.ok(
    journal.effects.some((e) => e.name === "upload" && e.status === "verified"),
  );
  await assert.rejects(() => f.service.prepare(change), {
    code: "reconciliation_required",
  });
});
test("pending server approval is a verified state, not falsely reported as completion", async (t) => {
  const f = await fixture(t, {
    async submit() {
      return {
        ...result,
        status: "pending",
        result: { registration_status: "waitlisted" },
      };
    },
  });
  const p = await f.service.prepare(change);
  const r = await f.service.commit(p.draft_id, true);
  assert.equal(r.status, "pending");
  assert.equal(r.result.registration_status, "waitlisted");
  assert.equal((await f.service.recoveryStatus()).blocked, false);
});
test("a pending journal from an interrupted process is never replayed", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  f.adapter.submit = async () => {
    entered();
    return new Promise((r) => {
      release = r;
    });
  };
  const p = await f.service.prepare(change),
    committing = f.service.commit(p.draft_id, true);
  await started;
  const second = new CmsService(f.adapter, { profileDir: f.profile });
  await assert.rejects(() => second.prepare(change), {
    code: "reconciliation_required",
  });
  release(result);
  await committing;
});
test("malformed or unavailable journals fail closed without deleting evidence", async (t) => {
  const f = await fixture(t);
  await writeFile(f.journal, "not valid JSON");
  await assert.rejects(() => f.service.prepare(change), {
    code: "journal_invalid",
  });
  assert.equal(await readFile(f.journal, "utf8"), "not valid JSON");
  await assert.rejects(
    () =>
      f.service.acknowledgeUncertain({
        acknowledge: true,
        note: "Inspected and understand outcome",
      }),
    { code: "journal_invalid" },
  );
  assert.equal(f.state.submits, 0);
});
test("writes require a configured journal but safe read discovery does not", async (t) => {
  const f = await fixture(t),
    s = new CmsService(f.adapter);
  assert.equal((await s.sessionStatus()).authenticated, true);
  await assert.rejects(() => s.prepare(change), {
    code: "journal_unconfigured",
  });
});
test("all service adapter operations are serialized and cancelled waiting calls do not close a running browser", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  f.adapter.read = async () => {
    entered();
    return new Promise((r) => {
      release = r;
    });
  };
  const first = f.service.read({ area: "tasks" });
  await started;
  const controller = new AbortController();
  const waiting = f.service.capabilities(controller.signal);
  controller.abort();
  assert.equal(f.state.closes, 0);
  release({ area: "tasks" });
  await first;
  await assert.rejects(() => waiting, { code: "cancelled" });
  assert.equal(f.state.closes, 0);
});
test("cancelling an active commit closes the adapter and preserves an uncertain journal", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  let entered, rejectSubmission;
  const started = new Promise((r) => {
    entered = r;
  });
  f.adapter.submit = async () => {
    entered();
    return new Promise((_r, reject) => {
      rejectSubmission = reject;
    });
  };
  f.adapter.close = async () => {
    f.state.closes++;
    rejectSubmission(new Error("browser closed"));
  };
  const p = await f.service.prepare(change),
    committing = f.service.commit(p.draft_id, true, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(() => committing, { code: "submission_uncertain" });
  assert.equal(f.state.closes, 1);
  assert.equal(
    JSON.parse(await readFile(f.journal, "utf8")).status,
    "uncertain",
  );
});
test("download names and areas cannot turn a document read into arbitrary file access", async (t) => {
  const f = await fixture(t);
  for (const filename of ["../resume.pdf", "../x", "a/b", "a\\b", ".."]) {
    await assert.rejects(
      () => f.service.download({ area: "resources", id: "1", filename }),
      {
        code: "invalid_filename",
      },
    );
  }
  await assert.rejects(() => f.service.download({ area: "settings", id: "1" }));
  assert.deepEqual(
    await f.service.download({
      area: "resources",
      id: "1",
      filename: "career.pdf",
    }),
    { area: "resources", id: "1", filename: "career.pdf" },
  );
});
test("fingerprints are key-order independent but bind exact slot, values and document order", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(fingerprint({ slot: "1" }), fingerprint({ slot: "2" }));
  assert.notEqual(fingerprint(["a", "b"]), fingerprint(["b", "a"]));
});

for (const effects of [
  [],
  [{ name: "apply", status: "intended" }],
  [{ name: "apply", status: "uncertain" }],
])
  test(
    "a claimed success without verified effects remains uncertain: " +
      JSON.stringify(effects),
    async (t) => {
      const f = await fixture(t, {
        async submit() {
          return { ...result, effects };
        },
      });
      const p = await f.service.prepare(change);
      await assert.rejects(() => f.service.commit(p.draft_id, true), {
        code: "submission_uncertain",
      });
      assert.equal((await f.service.recoveryStatus()).blocked, true);
    },
  );

test("a journal persistence failure prevents the first remote effect", async (t) => {
  const f = await fixture(t);
  const p = await f.service.prepare(change);
  const previous = f.adapter.prepare;
  f.adapter.prepare = async (input) => {
    const current = await previous(input);
    await mkdir(f.journal);
    return current;
  };
  await assert.rejects(() => f.service.commit(p.draft_id, true), {
    code: "journal_unavailable",
  });
  assert.equal(f.state.submits, 0);
});
