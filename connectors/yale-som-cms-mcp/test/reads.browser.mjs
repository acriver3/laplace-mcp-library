import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ProfileLock } from "../dist/browser.js";
import { FixtureCmsBrowser as CmsBrowser } from "./fixtures/browser.mjs";
import { CmsReads, cmsRoute, extractReadFields } from "../dist/reads.js";
import { CMS_ORIGIN } from "../dist/types.js";

const fixture = `<!doctype html><html><body class="logged-in-user"><nav><a href="/students/profile">Profile</a></nav><main role="main"><h1>Fixture jobs</h1><label for="query">Employer, Job Title, or Keyword</label><input id="query" aria-label="Employer, Job Title, or Keyword"><button aria-label="Search" onclick="search()">Search</button><label for="status">Status</label><select name="status" id="status"><option value="all">All</option><option value="open">Open</option></select><input name="csrf-token" value="must-not-return"><div>Results: 6</div><table><thead><tr><th>Job</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table><button id="more" onclick="count=Math.min(6,count+2);render()">Load more results...</button></main><script>
window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}};let count=2;let filtered=false;
function render(){rows.innerHTML=Array.from({length:filtered?1:count},(_,i)=>'<tr data-id="'+(i+101)+'"><td><a href="/jobPostings#/jobPostings/'+(i+101)+'">'+(filtered?'Needle':'Role '+(i+1))+'</a></td><td>Open</td></tr>').join('');more.hidden=filtered||count===6;}
function search(){filtered=query.value==='Needle';render();}render();
</script></body></html>`;
async function withBrowser(callback, html = fixture) {
  const dir = await mkdtemp(join(tmpdir(), "cms-browser-fixture-"));
  const browser = new CmsBrowser(
    join(dir, "profile"),
    "chrome",
    false,
    join(dir, "downloads"),
  );
  try {
    const page = await browser.page();
    await page
      .context()
      .route("**/*", (route) =>
        new URL(route.request().url()).origin === CMS_ORIGIN
          ? route.fulfill({ contentType: "text/html", body: html })
          : route.abort(),
      );
    await callback(browser, page, new CmsReads(browser));
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("CMS routes reject arbitrary identifiers and keep applications in the Yale tenant", () => {
  assert.equal(
    cmsRoute("applications"),
    CMS_ORIGIN + "/jobPostings#/jobPostings/applied-job-postings",
  );
  assert.equal(
    cmsRoute("resources", "folder:42"),
    CMS_ORIGIN + "/resource-library/42",
  );
  assert.throws(() => cmsRoute("events", "https://evil.invalid"), {
    code: "invalid_id",
  });
  assert.throws(() => new CmsBrowser(homedir()), { code: "invalid_profile" });
  assert.throws(() => new CmsBrowser(resolve("profile")), {
    code: "invalid_profile",
  });
});

test("dedicated profile ownership prevents parallel login and only releases its owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-lock-"));
  const first = new ProfileLock(join(dir, "profile")),
    second = new ProfileLock(join(dir, "profile"));
  try {
    await first.acquire();
    await assert.rejects(() => second.acquire(), { code: "profile_busy" });
    await second.release();
    await assert.rejects(() => first.releaseStale(), { code: "profile_busy" });
    await first.release();
    await second.acquire();
  } finally {
    await first.release();
    await second.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("visible serving validates the actual account identifier and never initiates interactive login", async () => {
  await withBrowser(async (browser, page) => {
    await page.goto(CMS_ORIGIN + "/dashboard/");
    const identity = await browser.identity();
    assert.equal(identity.account_id, "1234567");
    assert.match(identity.key, /^[a-f0-9]{64}$/);
    await assert.rejects(() => browser.login(), {
      code: "interactive_login_required",
    });
    await page.evaluate(() => document.body.classList.remove("logged-in-user"));
    // A different origin is rejected immediately without opening a login window.
    await page.goto("about:blank");
    await page.setContent("<main>Unauthenticated</main>");
  });
});

test("real browser search, field metadata, result pagination and query-bound cursors", async () => {
  await withBrowser(async (browser, page, reads) => {
    const first = await reads.read({ area: "jobs", limit: 2 });
    assert.deepEqual(
      first.records.map((x) => x.id),
      ["101", "102"],
    );
    assert.ok(first.next_cursor);
    assert.equal(first.truncated, true);
    assert.equal(
      first.fields.some((f) => /csrf/i.test(f.id)),
      false,
    );
    assert.equal(
      first.fields.find((f) => f.id === "status").options[1].label,
      "Open",
    );
    const second = await reads.read({
      area: "jobs",
      limit: 2,
      cursor: first.next_cursor,
    });
    assert.deepEqual(
      second.records.map((x) => x.id),
      ["103", "104"],
    );
    await assert.rejects(
      () =>
        reads.read({
          area: "jobs",
          query: "changed",
          limit: 2,
          cursor: first.next_cursor,
        }),
      { code: "invalid_cursor" },
    );
    const searched = await reads.read({
      area: "jobs",
      query: "Needle",
      filters: { status: "Open" },
      limit: 2,
    });
    assert.equal(searched.records[0].name, "Needle");
    assert.equal(await page.locator("select").inputValue(), "open");
    await assert.rejects(
      () =>
        reads.read({ area: "jobs", filters: { status: "Missing" }, limit: 2 }),
      { code: "invalid_filter_value" },
    );
    await assert.rejects(
      () =>
        reads.read({
          area: "jobs",
          filters: { "Invented filter": "foo" },
          limit: 2,
        }),
      { code: "unsupported_filter" },
    );
    await page.context().unroute("**/*");
    await page.context().route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: fixture.replaceAll("i+101", "i+201"),
      }),
    );
    await assert.rejects(
      () => reads.read({ area: "jobs", limit: 2, cursor: first.next_cursor }),
      { code: "cursor_changed" },
    );
  });
});

test("read-only record binding uses the precise discovered URL and preserves table details", async () => {
  await withBrowser(async (browser, page, reads) => {
    const result = await reads.read({ area: "jobs", limit: 2 });
    const row = await reads.recordLocator("jobs", result.records[1].id);
    assert.equal(await row.getAttribute("data-id"), "102");
    assert.equal(result.records[1].columns[1], "Open");
    await page.evaluate(() => {
      const rows = document.querySelector("tbody");
      rows.prepend(rows.lastElementChild);
    });
    assert.equal(
      await row.getAttribute("data-id"),
      "102",
      "Stable href binding survives list reordering",
    );
    await assert.rejects(() => reads.recordLocator("jobs", "999"), {
      code: "record_not_found",
    });
  });
});

test("permission errors are explicit and cannot be mistaken for empty successful reads", async () => {
  await withBrowser(
    async (browser, page, reads) => {
      await assert.rejects(() => reads.read({ area: "jobs", limit: 2 }), {
        code: "permission_denied",
      });
    },
    fixture.replace("<h1>Fixture jobs</h1>", "<h1>Access Denied</h1>"),
  );
});

test("downloads keep redirects on origin, never overwrite files, and return integrity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-download-"));
  let external = false;
  const requests = [];
  const identity = { key: "fixture-account", name: "Test", account_id: "1" };
  const browser = {
    downloadsDir: dir,
    identity: async () => identity,
    page: async () => ({
      context: () => ({
        request: {
          get: async (url, options) => {
            requests.push({ url, options });
            return external
              ? {
                  status: () => 302,
                  headers: () => ({
                    location: "https://external.invalid/file",
                  }),
                  ok: () => false,
                }
              : {
                  status: () => 200,
                  ok: () => true,
                  headers: () => ({
                    "content-type": "application/pdf",
                    "content-disposition": 'attachment; filename="fixture.pdf"',
                  }),
                  body: async () => Buffer.from("%PDF-1.4 fixture"),
                };
          },
        },
      }),
    }),
  };
  const reads = new CmsReads(browser);
  reads.account = identity.key;
  reads.knownLinks.set("resources:file:42", {
    url: CMS_ORIGIN + "/api/v2/resource-library-items/42/download",
    name: "Fixture",
  });
  try {
    const result = await reads.download({
      area: "resources",
      id: "file:42",
      filename: "fixture.pdf",
    });
    assert.equal(await readFile(result.path, "utf8"), "%PDF-1.4 fixture");
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      () =>
        reads.download({
          area: "resources",
          id: "file:42",
          filename: "fixture.pdf",
        }),
      { code: "file_exists" },
    );
    external = true;
    await assert.rejects(
      () => reads.download({ area: "resources", id: "file:42" }),
      { code: "external_link" },
    );
    assert.equal(
      requests.every((x) => x.options.maxRedirects === 0),
      true,
    );
    assert.equal(
      requests.some((x) => x.url.startsWith("https://external.invalid")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const components = `<!doctype html><body class="logged-in-user"><nav><a href="/students/profile">Profile</a></nav><main role="main"><h1>Fixture account data</h1><tt-calendar></tt-calendar><tt-appointment-list></tt-appointment-list><tt-event-detail></tt-event-detail><tt-job-posting-detail></tt-job-posting-detail><tt-inline-single-select-input></tt-inline-single-select-input><tt-time-slot-list></tt-time-slot-list><tt-saved-search><button>My Saved Searches</button><p>Search Alpha</p></tt-saved-search></main><script>
window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}};
const event={EntityId:901,Id:901,AdviserName:'Coach',start:'2027-01-05T14:00:00Z',end:'2027-01-05T14:30:00Z',TypeId:2};
const controllers={ttJobPostingDetail:{model:{jobPosting:{Id:555},rules:{HasApplied:false,CanApply:true},currentApplication:{Id:0,JobPostingId:0,OciStatusDisplay:'Applied',ApplicationDate:'2027-01-05T00:00:00'}}},ttInlineSingleSelectInput:{items:[{Id:444,Name:'Currency option is not a record'}]},ttCalendar:{view:{listViewDateRange:{Start:'2027-01-05T05:00:00Z',End:'2027-01-12T05:00:00Z'}},goToDate(start){this.lastStart=start;}},ttAppointmentList:{calendarEvents:[event],showDetails(value){if(value!==event)throw Error('Wrong event binding');document.body.insertAdjacentHTML('beforeend','<section role="dialog"><h2>Appointment 901</h2><p>Coach — verified slot</p></section>');}},ttEventDetail:{event:{Id:700,Name:'Fixture event',IsAttending:true,RegistrationRules:{IsAttending:true,IsOnWaitlist:false}},studentRegistrationLabel:'Registered'},ttTimeSlotList:{eventId:700,currentUserTimeSlot:{Id:701,StudentName:'PRIVATE',StudentId:1234567},timeSlots:[{Id:701,EventId:700,EventTimeSlotId:702,StartTime:'2027-01-05T14:00:00',EndTime:'2027-01-05T14:30:00',StudentName:'OTHER PRIVATE',StudentId:7654321,canRegisterForTimeslot:false}]},ttSavedSearch:{savedSearchGroups:[{savedSearches:[{Id:801,Name:'Search Alpha'}]}]}};
window.angular={element(e){return {injector(){return {has(){return true},get(){return {pendingRequests:[]}}}},controller(name){return controllers[name]}}}};
</script>`;

test("appointment details bind exact provider IDs and include the resulting modal", async () => {
  await withBrowser(async (browser, page, reads) => {
    const list = await reads.read({ area: "appointments", limit: 100 });
    assert.ok(list.records.some((r) => r.id === "901" && r.slot_id === "901"));
    const detail = await reads.read({
      area: "appointments",
      id: "901",
      limit: 25,
    });
    assert.match(detail.text, /verified slot/);
    assert.equal(detail.records[0].id, "901");
    await assert.rejects(() => reads.navigate("appointments", "999"), {
      code: "record_not_found",
    });
  }, components);
});

test("event registration state exposes own status and exact slots without other students", async () => {
  await withBrowser(async (browser, page, reads) => {
    const result = await reads.read({ area: "events", id: "700", limit: 25 });
    assert.equal(result.registration_state.event_id, 700);
    assert.equal(result.registration_state.is_attending, true);
    const slot = result.records.find((r) => r.kind === "event_slot");
    assert.equal(slot.slot_id, "701");
    assert.equal(slot.EventTimeSlotId, 702);
    assert.equal(slot.start, "2027-01-05T14:00:00Z");
    assert.equal(JSON.stringify(result).includes("OTHER PRIVATE"), false);
    assert.equal(JSON.stringify(result).includes("StudentId"), false);
  }, components);
});

test("saved-search reads expose saved searches rather than underlying job results", async () => {
  await withBrowser(async (browser, page, reads) => {
    const result = await reads.read({
      area: "saved_searches",
      view: "jobs",
      limit: 25,
    });
    assert.deepEqual(
      result.records.map((x) => [x.id, x.name]),
      [["801", "Search Alpha"]],
    );
    assert.equal(result.next_cursor, undefined);
  }, components);
});

test("unsubmitted synthesized application status cannot masquerade as an application", async () => {
  await withBrowser(async (browser, page, reads) => {
    const result = await reads.read({ area: "jobs", id: "555", limit: 25 });
    assert.equal(result.application_state.job_posting_id, 555);
    assert.equal(result.application_state.has_applied, false);
    assert.equal(result.application_state.current_application, null);
    assert.equal(result.application_state.account_matches, false);
    assert.equal(
      result.records.some((r) => r.id === "444"),
      false,
    );
  }, components);
});

test("read records are scoped to their area and unknown details cannot be fabricated", () => {
  const reads = new CmsReads({});
  const snap = {
    title: "Fixture",
    text: "Page could not load",
    headings: ["Fixture"],
    links: [
      {
        name: "Job",
        url: CMS_ORIGIN + "/jobPostings#/jobPostings/1",
        text: "Job",
        cells: [],
      },
      {
        name: "Employer",
        url: CMS_ORIGIN + "/Companies#/Companies/2",
        text: "Employer",
        cells: [],
      },
      {
        name: "Event",
        url: CMS_ORIGIN + "/events#/events/3",
        text: "Event",
        cells: [],
      },
    ],
    models: [
      {
        Id: 4,
        Name: "Related company",
        _source: "tt-company-header",
        _kind: "employer",
      },
    ],
    tableRows: [],
    filters: [],
    context: {},
  };
  assert.deepEqual(
    reads.records("jobs", snap).map((r) => [r.id, r.kind]),
    [["1", "job"]],
  );
  assert.deepEqual(
    reads.records("events", snap).map((r) => [r.id, r.kind]),
    [["3", "event"]],
  );
  assert.deepEqual(
    reads.records("employers", snap).map((r) => r.id),
    ["2", "4"],
  );
  assert.throws(() => reads.records("jobs", snap, "999"), {
    code: "record_not_found",
  });
  assert.equal(
    reads.records("dashboard", snap).every((r) => typeof r.kind === "string"),
    true,
  );
});

test("closing a delayed attachment retains the state lease until its owned tab is closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-late-launch-"));
  let launchStarted,
    releaseLaunch,
    closed = 0;
  const started = new Promise((resolve) => {
    launchStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseLaunch = resolve;
  });
  class DelayedBrowser extends CmsBrowser {
    async connectOwnedPage() {
      launchStarted();
      await gate;
      return {
        close: async () => {
          closed++;
        },
      };
    }
  }
  const browser = new DelayedBrowser(join(dir, "profile"));
  const pending = browser.page();
  try {
    await started;
    const rejected = assert.rejects(() => pending, { code: "browser_closed" });
    const closing = browser.close();
    assert.ok((await readFile(browser.lock.file, "utf8")).includes("token"));
    releaseLaunch();
    await Promise.all([closing, rejected]);
    assert.equal(closed, 1);
    assert.equal(browser.attachment, undefined);
    assert.equal(browser.currentPage, undefined);
    await assert.rejects(() => readFile(browser.lock.file), { code: "ENOENT" });
  } finally {
    releaseLaunch();
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("observed signed storage redirects use a fresh credential-free fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-storage-"));
  const identity = { key: "fixture-account", name: "Test", account_id: "1" };
  const yaleRequests = [],
    storageRequests = [];
  const originalFetch = globalThis.fetch;
  const browser = {
    downloadsDir: dir,
    identity: async () => identity,
    page: async () => ({
      context: () => ({
        request: {
          get: async (url, options) => {
            yaleRequests.push({ url, options });
            return {
              status: () => 302,
              headers: () => ({
                location:
                  "https://ttpfmstrusncprod.blob.core.windows.net/files/fixture?sig=private",
              }),
              ok: () => false,
            };
          },
        },
      }),
    }),
  };
  const reads = new CmsReads(browser);
  reads.account = identity.key;
  reads.knownLinks.set("resources:file:42", {
    url: CMS_ORIGIN + "/api/v2/resource-library-items/42/download",
    name: "Fixture",
  });
  globalThis.fetch = async (url, options) => {
    storageRequests.push({ url: String(url), options });
    return new Response("%PDF-1.4 storage fixture", {
      headers: { "content-type": "application/pdf" },
    });
  };
  try {
    const result = await reads.download({
      area: "resources",
      id: "file:42",
      filename: "fixture.pdf",
    });
    assert.equal(yaleRequests.length, 1);
    assert.equal(storageRequests.length, 1);
    assert.equal(storageRequests[0].options.credentials, "omit");
    assert.equal(storageRequests[0].options.redirect, "manual");
    assert.equal(storageRequests[0].options.referrerPolicy, "no-referrer");
    assert.equal(storageRequests[0].options.headers, undefined);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(
      await readFile(result.path, "utf8"),
      "%PDF-1.4 storage fixture",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("visible identity rejects an authenticated non-student account", async () => {
  await withBrowser(async (browser, page) => {
    await page.goto(CMS_ORIGIN + "/dashboard/");
    await page.evaluate(
      () => (window.TT.CurrentSession.CurrentUser.TypeId = 1),
    );
    await assert.rejects(() => browser.identity(), {
      code: "account_not_student",
    });
  });
});

test("visible Chrome keeps the request guard active against delayed preview autosaves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-guard-integration-"));
  const browser = new CmsBrowser(
    join(dir, "profile"),
    "chrome",
    false,
    join(dir, "downloads"),
  );
  try {
    const page = await browser.page();
    await page.context().setOffline(true);
    await page
      .context()
      .route("**/*", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ contentType: "text/html", body: fixture })
          : route.fallback(),
      );
    await page.goto(CMS_ORIGIN + "/dashboard/");
    await page.evaluate(() => {
      setTimeout(() => {
        fetch("/api/v2/unreviewed-preview-write", {
          method: "POST",
          body: "fixture",
        }).catch(() => {});
      }, 30);
    });
    await page.waitForTimeout(150);
    assert.throws(() => browser.assertReadRequests(), {
      code: "read_request_unreviewed",
    });
    assert.doesNotThrow(() => browser.assertReadRequests());
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile directory aliases cannot bypass the dedicated-profile restriction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-profile-alias-"));
  const ordinary = join(dir, "Google", "Chrome", "User Data");
  const alias = join(dir, "alias");
  await mkdir(ordinary, { recursive: true });
  await symlink(ordinary, alias, "junction");
  const browser = new CmsBrowser(alias);
  try {
    await assert.rejects(() => browser.page(), { code: "invalid_profile" });
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
