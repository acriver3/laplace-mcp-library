import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { CmsMutations } from "../dist/mutations.js";
import { CmsService } from "../dist/core.js";
import { CmsError, CMS_ORIGIN, TIMEZONE } from "../dist/types.js";

const base = (body, script = "") =>
  '<!doctype html><main role="main">' +
  body +
  "</main><script>" +
  script +
  "</script>";
async function setup(render, callback) {
  const dir = await mkdtemp(join(tmpdir(), "cms-mutations-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const state = { subject: "Before", favorite: false, remote: [], effects: [] };
  await page.exposeFunction("remoteWrite", async (action, value) => {
    assert.ok(
      state.effects.some((e) => e.status === "intended"),
      "durable intent must precede provider effects",
    );
    state.remote.push(action);
    if (action === "save") state.subject = value;
    if (action === "document_submit")
      state.documents = [{ id: "99", name: "Approved resume", FileId: "501" }];
  });
  const fakeBrowser = {
    page: async () => page,
    identity: async () => ({ key: "fixture-account", name: "Fixture student" }),
  };
  const reads = {
    read: async (input) => {
      await page.goto(CMS_ORIGIN + "/tasks/");
      await page.setContent(render(state, input));
      return {
        area: input.area,
        url: page.url(),
        timezone: TIMEZONE,
        title: "Sanitized fixture",
        text: await page.locator("main").innerText(),
        records: state.documents || [{ id: "42", name: state.subject }],
      };
    },
    navigate: async (area, id) => {
      await reads.read({ area, id, limit: 100 });
      return page;
    },
    recordLocator: async (area, id) => {
      const exact = page.locator('[data-id="' + id + '"]');
      if ((await exact.count()) !== 1)
        throw new CmsError("record_not_found", "No exact record");
      return exact;
    },
  };
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: base("") }),
  );
  const mutations = new CmsMutations(fakeBrowser, reads);
  const adapter = {
    ...fakeBrowser,
    read: reads.read,
    form: (c) => mutations.form(c),
    prepare: (c) => mutations.prepare(c),
    submit: (c, e) =>
      mutations.submit(c, async (effect) => {
        state.effects.push(effect);
        await e(effect);
      }),
    close: async () => {},
    capabilities: async () => ({}),
    download: async () => ({}),
  };
  const service = new CmsService(adapter, { profileDir: join(dir, "profile") });
  try {
    await callback({ state, page, mutations, service, dir, reads });
  } finally {
    await service.close();
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const taskFixture = (s) => {
  const modal =
    '<div class="modal"><h2>Edit Task</h2><label>Subject<input name="subject" required value="' +
    s.subject +
    '"></label><button onclick="save()">Save Changes</button></div>';
  return base(
    '<div data-id="42"><span>' +
      s.subject +
      '</span><button onclick="edit()">Edit Task</button></div>',
    'function edit(){document.querySelector("main").insertAdjacentHTML("beforeend",' +
      JSON.stringify(modal) +
      ')} async function save(){await remoteWrite("save",document.querySelector("[name=subject]").value);document.querySelector(".modal").remove()}',
  );
};
test("task preview opens only the form; confirmed update changes the exact record once", async () => {
  await setup(taskFixture, async ({ state, service, page }) => {
    const draft = await service.prepare({
      operation: "task_update",
      area: "tasks",
      target_id: "42",
      fields: { subject: "Approved" },
    });
    assert.deepEqual(state.remote, []);
    assert.equal(await page.locator("[name=subject]").inputValue(), "Before");
    const result = await service.commit(draft.draft_id, true);
    assert.equal(result.status, "verified");
    assert.deepEqual(state.remote, ["save"]);
    assert.equal(state.subject, "Approved");
    await assert.rejects(() => service.commit(draft.draft_id, true), {
      code: "draft_expired",
    });
    assert.deepEqual(state.remote, ["save"]);
  });
});
test("immediate saved-search controls are never clicked during discovery or preview", async () => {
  await setup(
    () =>
      base(
        "<button onclick=\"remoteWrite('saved_search',true)\">Save this search</button>",
      ),
    async ({ mutations, state }) => {
      const change = {
        operation: "saved_search_create",
        area: "jobs",
        fields: {},
        files: [],
      };
      assert.equal((await mutations.form(change)).supported, false);
      await assert.rejects(() => mutations.prepare(change), {
        code: "action_unavailable",
      });
      assert.deepEqual(state.remote, []);
    },
  );
});
test("an unrelated record action cannot substitute for a missing target", async () => {
  await setup(taskFixture, async ({ mutations, state }) => {
    assert.equal(
      (
        await mutations.form({
          operation: "task_delete",
          area: "tasks",
          target_id: "99",
          fields: {},
          files: [],
        })
      ).supported,
      false,
    );
    assert.deepEqual(state.remote, []);
  });
});
test("task_complete requires an explicit Complete status in its preview", async () => {
  await setup(taskFixture, async ({ mutations, state }) => {
    await assert.rejects(
      () =>
        mutations.prepare({
          operation: "task_complete",
          area: "tasks",
          target_id: "42",
          fields: {},
          files: [],
        }),
      { code: "required_field" },
    );
    assert.deepEqual(state.remote, []);
  });
});
test("ambiguous final actions fail before editing autosaving inputs", async () => {
  const modal =
    '<div class="modal"><input name="subject" value="Before" onchange="remoteWrite(&quot;autosave&quot;,this.value)"><button>Save</button><button>Submit</button></div>';
  const fixture = () =>
    base(
      '<div data-id="42"><button onclick="edit()">Edit</button></div>',
      'function edit(){document.querySelector("main").insertAdjacentHTML("beforeend",' +
        JSON.stringify(modal) +
        ")}",
    );
  await setup(fixture, async ({ mutations, state }) => {
    await assert.rejects(
      () =>
        mutations.prepare({
          operation: "task_update",
          area: "tasks",
          target_id: "42",
          fields: { subject: "Changed" },
          files: [],
        }),
      { code: "action_unavailable" },
    );
    assert.deepEqual(state.remote, []);
  });
});

test("unavailable event slots fail before registration is opened or changed", async () => {
  const fixture = () =>
    base(
      "<tt-event-detail><button>Register Now</button></tt-event-detail>",
      'window.angular={element:()=>({controller:()=>({event:{Id:42,IsAttending:false,RegistrationRules:{CanRegister:false,CannotRegisterReason:"Registration closed"}},getCurrentUserTimeSlot:()=>null})})};',
    );
  await setup(fixture, async ({ mutations, state }) => {
    await assert.rejects(
      () =>
        mutations.prepare({
          operation: "event_register",
          area: "events",
          target_id: "42",
          slot_id: "777",
          fields: {},
          files: [],
        }),
      { code: "action_unavailable" },
    );
    assert.deepEqual(state.remote, []);
  });
});

test("document upload waits for positive file acknowledgement and verifies its exact saved FileId", async () => {
  const modal =
    '<div class="modal"><label>Name<input name="documentName" required></label><div class="file-upload-control"><input type="file" name="file" required onchange="upload()"></div><button onclick="saveDocument()">Submit</button></div>';
  const render = () =>
    base(
      '<a onclick="editDocument()"><i aria-label="\'Add New Resumes\'"></i></a>',
      'window.fs={isUploading:false,files:[],AllowedExtensions:[".pdf"],hasError:()=>false,hasFiles(){return this.files.length>0}};window.angular={element:()=>({scope:()=>({service:fs})})};' +
        'function editDocument(){document.querySelector("main").insertAdjacentHTML("beforeend",' +
        JSON.stringify(modal) +
        ")}" +
        'async function upload(){await remoteWrite("upload",true);fs.isUploading=true;setTimeout(()=>{fs.files=[{FileId:501}];fs.isUploading=false},150)}' +
        'async function saveDocument(){if(fs.isUploading||!fs.hasFiles())throw Error("premature submit");await remoteWrite("document_submit",true);document.querySelector(".modal").remove()}',
    );
  await setup(render, async ({ state, service, dir }) => {
    state.documents = [];
    const file = join(dir, "resume.pdf");
    await writeFile(file, "%PDF-1.7 fixture");
    const draft = await service.prepare({
      operation: "document_upload",
      area: "documents",
      fields: { documentName: "Approved resume" },
      files: [{ field: "file", path: file }],
    });
    assert.deepEqual(state.remote, []);
    const result = await service.commit(draft.draft_id, true);
    assert.equal(result.status, "verified");
    assert.deepEqual(state.remote, ["upload", "document_submit"]);
    assert.equal(state.documents[0].FileId, "501");
  });
});

test("a detached unrelated action menu cannot substitute for the approved record menu", async () => {
  await setup(
    () =>
      base(
        '<div data-id="42"><button onclick="document.querySelector(\'#other\').hidden=false">Options</button></div><section id="other" hidden><button onclick="remoteWrite(\'delete_wrong\',true)">Delete Task</button></section>',
      ),
    async ({ mutations, state }) => {
      const result = await mutations.form({
        operation: "task_delete",
        area: "tasks",
        target_id: "42",
        fields: {},
        files: [],
      });
      assert.equal(result.supported, false);
      assert.deepEqual(state.remote, []);
    },
  );
});
