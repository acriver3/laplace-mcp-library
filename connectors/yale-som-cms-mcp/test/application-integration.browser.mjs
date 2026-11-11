import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";

import { chromium } from "playwright-core";

import { CmsService } from "../dist/core.js";
import { CmsMutations } from "../dist/mutations.js";
import { CMS_ORIGIN, TIMEZONE } from "../dist/types.js";
import { installApplicationForm } from "./fixtures/application-form.mjs";

let browser;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cms-application-integration-"));
  const file = join(directory, "resume.pdf");
  await writeFile(file, "%PDF-1.7 sanitized resume");
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(CMS_ORIGIN + "/jobPostings")
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><main></main>",
        })
      : route.abort(),
  );
  const page = await context.newPage();
  const state = { applied: false, pending: false, earlyReads: 0, payloads: [], journal: [] };
  await page.exposeFunction("fixtureApply", async (payload) => {
    assert.ok(
      state.journal.some((e) => e.name === "application_submit" && e.status === "intended"),
    );
    state.pending = true;
    state.payloads.push(payload);
    await new Promise((resolve) => setTimeout(resolve, 40));
    state.applied = true;
    state.pending = false;
  });
  const navigate = page.goto.bind(page);
  page.goto = async (url, navigationOptions) => {
    if (state.pending) {
      state.earlyReads++;
      throw new Error("verification interrupted pending native application");
    }
    const result = await navigate(url, navigationOptions);
    if (new URL(url).hash.includes("/application")) {
      await page.setContent("<!doctype html><main><tt-jp-apply></tt-jp-apply></main>");
      await page.evaluate(installApplicationForm, {
        docs: options.withFile ? [{ id: "101", title: "Resume", required: true }] : [],
      });
      if (options.external)
        await page.evaluate(() => {
          const c = window.controller;
          c.jobPosting.ShouldApplyViaSite = false;
          c.jobPosting.ShouldApplyExternally = true;
          c.jobPosting.Url = "https://employer.example/application/123";
          c.needConfirmationPage = true;
          c.isConfirmationStep = true;
          document.querySelector("[tt-click]").textContent = "Mark as Applied";
        });
      await page.evaluate(() => {
        document.querySelector("[tt-click]").addEventListener("click", async () => {
          await window.fixtureApply(window.requests.at(-1));
          history.replaceState(null, "", "/jobPostings#/jobPostings/123");
          document.querySelector("main").innerHTML = "<tt-jp-detail>Applied</tt-jp-detail>";
        });
      });
    } else {
      await page.setContent(
        '<!doctype html><main><h1>Fixture posting</h1><span>Applied</span><a href="#/jobPostings/123/application?r=&p=false">Apply Now</a></main>',
      );
    }
    return result;
  };
  const fakeBrowser = {
    page: async () => page,
    identity: async () => ({ key: "student-7", name: "Fixture student", account_id: "7" }),
  };
  const reads = {
    read: async (input) => {
      await page.goto(CMS_ORIGIN + "/jobPostings#/jobPostings/" + (input.id || "123"));
      return {
        area: "jobs",
        url: page.url(),
        title: "Fixture posting",
        timezone: TIMEZONE,
        text: "Applied",
        records: [{ id: "123", name: "Fixture posting" }],
        application_state: {
          job_posting_id: "123",
          has_applied: state.applied,
          account_matches: !options.otherApplicant,
          rules: { CanApply: !state.applied },
          current_application: {
            Id: state.applied && !options.placeholderAfter ? 55 : 0,
            JobPostingId: state.applied ? 123 : 0,
            ApplicantId: options.otherApplicant ? 8 : 7,
          },
        },
      };
    },
    navigate: async (area, id) => {
      await reads.read({ area, id });
      return page;
    },
  };
  const mutations = new CmsMutations(fakeBrowser, reads);
  const recordEffect = async (effect) => {
    state.journal.push(structuredClone(effect));
  };
  const adapter = {
    ...fakeBrowser,
    read: reads.read,
    form: (change) => mutations.form(change),
    prepare: (change) => mutations.prepare(change),
    submit: (change, record) =>
      mutations.submit(change, async (effect) => {
        await recordEffect(effect);
        await record(effect);
      }),
    capabilities: async () => ({}),
    download: async () => ({}),
    close: async () => {},
  };
  const service = new CmsService(adapter, { profileDir: join(directory, "profile") });
  t.after(async () => {
    await service.close();
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = {
    operation: "application_submit",
    area: "jobs",
    target_id: "123",
    fields: {},
    files: [],
  };
  return { page, service, mutations, recordEffect, request, state, file };
}

test("native application pipeline verifies a positive application ID for this applicant and posting once", async (t) => {
  const { service, request, state } = await fixture(t);
  const draft = await service.prepare(request);
  assert.deepEqual(state.payloads, []);
  const result = await service.commit(draft.draft_id, true);
  assert.equal(result.status, "verified");
  assert.equal(result.result.target_id, "123");
  assert.equal(state.payloads.length, 1);
  assert.equal(state.payloads[0].JobPostingId, 123);
  assert.equal(state.payloads[0].ApplicantId, 7);
  assert.equal(state.earlyReads, 0);
  assert.equal((await service.recoveryStatus()).blocked, false);
  await assert.rejects(service.commit(draft.draft_id, true), (e) => e.code === "draft_expired");
  assert.equal(state.payloads.length, 1);
});

test("application with an acknowledged upload stays partial until attachment linkage is proven", async (t) => {
  const { service, request, state, file } = await fixture(t, { withFile: true });
  request.files.push({ field: "document:101:file", path: file });
  const draft = await service.prepare(request);
  assert.deepEqual(state.payloads, []);
  let failure;
  await assert.rejects(service.commit(draft.draft_id, true), (e) => {
    failure = e;
    return e.code === "submission_partial";
  });
  const result = failure.details.result;
  assert.equal(
    result.effects.find((e) => e.name === "application_document_upload:101").status,
    "verified",
  );
  assert.equal(
    result.effects.find((e) => e.name === "application_document_attachment:101").status,
    "intended",
  );
  assert.equal(result.effects.find((e) => e.name === "application_submit").status, "verified");
  assert.deepEqual(
    state.payloads[0].ApplicationDocumentInfoList.map((d) => [d.DocumentTypeId, d.UploadedFileId]),
    [[101, "file-101"]],
  );
  assert.equal(state.earlyReads, 0);
  assert.equal((await service.recoveryStatus()).blocked, true);
  await assert.rejects(service.commit(draft.draft_id, true), (e) => e.code === "draft_expired");
  assert.equal(state.payloads.length, 1);
});

test("external Mark as Applied forms return the employer handoff without invoking any mutation", async (t) => {
  const { mutations, request, state } = await fixture(t, { external: true });
  const form = await mutations.form(request);
  assert.equal(form.supported, false);
  assert.equal(form.context.code, "external_application");
  assert.equal(form.context.details.url, "https://employer.example/application/123");
  await assert.rejects(mutations.prepare(request), (e) => e.code === "external_application");
  assert.deepEqual(state.payloads, []);
  assert.deepEqual(state.journal, []);
});

test("Applied display text and a zero-ID placeholder cannot verify application success", async (t) => {
  const { mutations, request, state, recordEffect } = await fixture(t, { placeholderAfter: true });
  await mutations.prepare(request);
  const result = await mutations.submit(request, recordEffect);
  assert.equal(result.status, "uncertain");
  assert.equal(result.effects.find((e) => e.name === "application_submit").status, "intended");
  assert.equal(state.payloads.length, 1);
});

test("a positive application ID belonging to another applicant cannot verify success", async (t) => {
  const { mutations, request, state, recordEffect } = await fixture(t, { otherApplicant: true });
  await mutations.prepare(request);
  const result = await mutations.submit(request, recordEffect);
  assert.equal(result.status, "uncertain");
  assert.equal(result.effects.find((e) => e.name === "application_submit").status, "intended");
  assert.equal(state.payloads.length, 1);
});

test("changed application deadline after prepare prevents final Apply even with unchanged fields", async (t) => {
  const { mutations, request, page, state, recordEffect } = await fixture(t);
  await mutations.prepare(request);
  await page.evaluate(() => {
    window.controller.jobPosting.ApplicationDeadlineDate = "2029-01-01T00:00:00";
  });
  await assert.rejects(
    mutations.submit(request, recordEffect),
    (e) => e.code === "preview_changed",
  );
  assert.deepEqual(state.payloads, []);
  assert.deepEqual(state.journal, []);
});
