import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";

import { chromium } from "playwright-core";

import {
  inspectApplicationWorkflow,
  validateApplicationWorkflow,
  fillApplicationWorkflow,
} from "../dist/application-workflow.js";
import { installApplicationForm } from "./fixtures/application-form.mjs";

let browser, directory, file;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  directory = await mkdtemp(join(tmpdir(), "cms-application-fixture-"));
  file = join(directory, "resume.pdf");
  await writeFile(file, "%PDF-1.7 sanitized fixture");
});
after(async () => {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(t, options = {}) {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.request().url().startsWith("https://som-yale.12twenty.com/jobPostings")
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><main><tt-jp-apply></tt-jp-apply></main>",
        })
      : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(
    "https://som-yale.12twenty.com/jobPostings#/jobPostings/123/application?r=&p=false",
  );
  await page.evaluate(installApplicationForm, options);
  t.after(() => context.close());
  return page;
}
const request = (extra) => ({
  operation: "application_submit",
  area: "jobs",
  target_id: "123",
  fields: {},
  files: [],
  ...extra,
});
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const recorder =
  (page, entries = [], hook) =>
  async (effect) => {
    entries.push(structuredClone(effect));
    await page.evaluate(
      (effect) => window.effects.push("journal:" + effect.status + ":" + effect.name),
      effect,
    );
    await hook?.(effect);
  };

test("new zero-ID placeholder exposes all scoped document fields without changing inputs or uploading", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: false },
    ],
  });
  const form = await inspectApplicationWorkflow(page);
  assert.equal(form.posting_id, "123");
  assert.equal(form.applicant_id, "7");
  assert.equal(form.fields.length, 8);
  assert.equal(new Set(form.fields.map((f) => f.id)).size, 8);
  assert.deepEqual(await page.evaluate(() => window.effects), []);
  assert.equal(await page.evaluate(() => window.controller.isNew), false);
  assert.equal(await page.evaluate(() => window.controller.application.Id), 0);
});

test("required file, unknown fields, conflicting sources, invalid extension and duplicate file bindings are rejected", async (t) => {
  const page = await fixture(t);
  const form = await inspectApplicationWorkflow(page);
  assert.throws(
    () => validateApplicationWorkflow(form, request()),
    (e) => e.code === "required_file",
  );
  assert.throws(
    () => validateApplicationWorkflow(form, request({ fields: { arbitrary: true } })),
    (e) => e.code === "invalid_field",
  );
  assert.throws(
    () =>
      validateApplicationWorkflow(
        form,
        request({ files: [{ field: "document:101:file", path: "/tmp/resume.exe" }] }),
      ),
    (e) => e.code === "invalid_file",
  );
  assert.throws(
    () =>
      validateApplicationWorkflow(
        form,
        request({
          files: [
            { field: "document:101:file", path: file },
            { field: "document:101:file", path: file },
          ],
        }),
      ),
    (e) => e.code === "invalid_file_field",
  );
  assert.deepEqual(await page.evaluate(() => window.effects), []);
});

test("duplicate native document IDs stay scoped; uploads are journaled before input and final Apply runs once", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: true },
    ],
  });
  const result = await fillApplicationWorkflow(
    page,
    request({
      fields: { "document:102:name": "Approved Cover", "document:102:save_to_library": true },
      files: [
        { field: "document:101:file", path: file },
        { field: "document:102:file", path: file },
      ],
    }),
    recorder(page),
  );
  const requests = await page.evaluate(() => window.requests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].JobPostingId, 123);
  assert.equal(requests[0].ApplicantId, 7);
  assert.deepEqual(
    requests[0].ApplicationDocumentInfoList.map((d) => [
      d.DocumentTypeId,
      d.UploadedFileId,
      d.Name,
    ]),
    [
      [101, "file-101", "Resume"],
      [102, "file-102", "Approved Cover"],
    ],
  );
  for (const id of ["101", "102"]) {
    assert.equal(
      result.effects.find((e) => e.name === "application_document_upload:" + id).status,
      "verified",
    );
    assert.equal(
      result.effects.find((e) => e.name === "application_document_attachment:" + id).status,
      "intended",
    );
  }
  assert.equal(
    result.effects.find((e) => e.name === "application_document_library:102").status,
    "intended",
  );
  assert.equal(result.effects.find((e) => e.name === "application_submit").status, "intended");
  const log = await page.evaluate(() => window.effects);
  for (const id of ["101", "102"])
    assert.ok(
      log.indexOf("journal:intended:application_document_upload:" + id) <
        log.indexOf("upload:" + id),
    );
  assert.ok(log.indexOf("journal:intended:application_submit") < log.indexOf("apply"));
  await rejects(fillApplicationWorkflow(page, request(), recorder(page)), "action_unavailable");
  assert.equal((await page.evaluate(() => window.requests)).length, 1);
});

test("existing document selection retains exact ID and requires separate attachment proof", async (t) => {
  const page = await fixture(t, {
    docs: [
      {
        id: "101",
        title: "Resume",
        required: true,
        existing: [{ Id: 44, Name: "Approved Resume" }],
      },
    ],
  });
  const result = await fillApplicationWorkflow(
    page,
    request({ fields: { "document:101:type": "Existing", "document:101:existing": "44" } }),
    recorder(page),
  );
  assert.deepEqual(result.uploads, []);
  assert.equal(
    result.effects.find((e) => e.name === "application_document_attachment:101").details
      .existing_document_id,
    "44",
  );
  const payload = (await page.evaluate(() => window.requests))[0];
  assert.equal(payload.ApplicationDocumentInfoList[0].ExistingApplicationDocumentId, 44);
  assert.equal(payload.ApplicationDocumentInfoList[0].UploadedFileId, undefined);
});

test("external application returns its real handoff without changing the completion checkbox or marking applied", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.controller.jobPosting.ShouldApplyViaSite = false;
    window.controller.jobPosting.ShouldApplyExternally = true;
    window.controller.jobPosting.Url = "https://employer.example/apply/123";
    window.controller.needConfirmationPage = true;
  });
  await assert.rejects(
    inspectApplicationWorkflow(page),
    (e) =>
      e.code === "external_application" && e.details.url === "https://employer.example/apply/123",
  );
  assert.deepEqual(await page.evaluate(() => window.effects), []);
});

test("another applicant, already submitted application, questions, bidding, rankings, approved-resume-only, URL and external consent fail closed", async (t) => {
  for (const scenario of [
    "applicant",
    "submitted",
    "questions",
    "bidding",
    "ranking",
    "approved",
    "url",
    "consent",
  ]) {
    const page = await fixture(t);
    await page.evaluate((scenario) => {
      const c = window.controller;
      if (scenario === "applicant") c.application.ApplicantId = 8;
      if (scenario === "submitted") c.application.Id = 55;
      if (scenario === "questions") window.questions.attributeGroups.push({ Id: 1 });
      if (scenario === "bidding") c.jobPosting.Rules.CanBid = true;
      if (scenario === "ranking") c.hasMultipleLocations = true;
      if (scenario === "approved") c.allowApprovedResumesOnly = true;
      if (scenario === "url") c.applicationFiles[0].jobCoreApplicationDocumentTypeId = 7;
      if (scenario === "consent") c.applicationFiles[0].sendToTopResume = "yes";
    }, scenario);
    await rejects(inspectApplicationWorkflow(page), "action_unavailable");
    assert.deepEqual(await page.evaluate(() => window.effects), []);
  }
});

test("failed later upload retains first acknowledgment and never applies or repeats upload", async (t) => {
  const page = await fixture(t, {
    failUpload: "102",
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: true },
    ],
  });
  const journal = [];
  await rejects(
    fillApplicationWorkflow(
      page,
      request({
        files: [
          { field: "document:101:file", path: file },
          { field: "document:102:file", path: file },
        ],
      }),
      recorder(page, journal),
    ),
    "upload_uncertain",
  );
  assert.ok(
    journal.some((e) => e.name === "application_document_upload:101" && e.status === "verified"),
  );
  assert.equal(
    journal.some((e) => e.name === "application_document_upload:102" && e.status === "verified"),
    false,
  );
  assert.deepEqual(await page.evaluate(() => window.requests), []);
});

test("journal failure prevents an upload from starting", async (t) => {
  const page = await fixture(t);
  await assert.rejects(
    fillApplicationWorkflow(
      page,
      request({ files: [{ field: "document:101:file", path: file }] }),
      async () => {
        throw new Error("journal disk failure");
      },
    ),
    /journal disk failure/,
  );
  assert.deepEqual(await page.evaluate(() => window.effects), []);
});

test("eligibility or exact uploaded-file identity changing after final intent prevents Apply", async (t) => {
  for (const scenario of ["rules", "file", "applicant", "session", "questions"]) {
    const page = await fixture(t);
    const record = recorder(page, [], async (effect) => {
      if (effect.name === "application_submit")
        await page.evaluate((scenario) => {
          if (scenario === "rules") window.controller.jobPosting.Rules.CanApply = false;
          if (scenario === "file")
            window.controller.applicationFiles[0].fileService.files[0].FileId = "different";
          if (scenario === "applicant") window.controller.currentUser.Id = 8;
          if (scenario === "session") window.TT.CurrentSession.CurrentUser.Id = 8;
          if (scenario === "questions") window.questions.attributeGroups.push({ Id: 1 });
        }, scenario);
    });
    await rejects(
      fillApplicationWorkflow(
        page,
        request({ files: [{ field: "document:101:file", path: file }] }),
        record,
      ),
      "record_changed",
    );
    assert.deepEqual(await page.evaluate(() => window.requests), []);
  }
});

test("missing and duplicate controls, unrecognized fields and duplicate document IDs fail before edits", async (t) => {
  for (const scenario of ["missing", "duplicate", "extra", "id"]) {
    const page = await fixture(t);
    await page.evaluate((scenario) => {
      const row = document.querySelector("[ng-repeat]");
      if (scenario === "missing") row.querySelector("#documentName").remove();
      if (scenario === "duplicate") row.append(row.querySelector("#documentName").cloneNode());
      if (scenario === "extra")
        document.querySelector("tt-jp-apply").append(document.createElement("input"));
      if (scenario === "id")
        window.controller.applicationFiles.push(window.controller.applicationFiles[0]);
    }, scenario);
    await rejects(inspectApplicationWorkflow(page), "action_unavailable");
    assert.deepEqual(await page.evaluate(() => window.effects), []);
  }
});

test("a document row reorder during journaling cannot redirect an approved file to another requirement", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: true },
    ],
  });
  let reordered = false;
  const record = recorder(page, [], async (effect) => {
    if (
      !reordered &&
      effect.name === "application_document_upload:101" &&
      effect.status === "intended"
    ) {
      reordered = true;
      await page.evaluate(() => {
        const row = document.querySelector('[data-laplace-application-document="101"]');
        const other = [...document.querySelectorAll("[ng-repeat]")].find(
          (el) => el.requirement.jobApplicationDocumentTypeId === 102,
        );
        other.querySelector("input[type=file]").addEventListener("change", () => {
          const first = window.controller.applicationFiles[0];
          if (!first.fileService.hasFiles()) first.fileService.error = true;
        });
        row.parentElement.append(row);
      });
    }
  });
  const result = await fillApplicationWorkflow(
    page,
    request({
      files: [
        { field: "document:101:file", path: file },
        { field: "document:102:file", path: file },
      ],
    }),
    record,
  );
  assert.deepEqual(result.uploads, [
    { document_type_id: "101", uploaded_file_id: "file-101" },
    { document_type_id: "102", uploaded_file_id: "file-102" },
  ]);
  const payload = (await page.evaluate(() => window.requests))[0];
  assert.deepEqual(
    payload.ApplicationDocumentInfoList.map((x) => [x.DocumentTypeId, x.UploadedFileId]),
    [
      [101, "file-101"],
      [102, "file-102"],
    ],
  );
});

test("a scoped requirement replaced during journaling is rejected before uploading", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: false },
    ],
  });
  const record = recorder(page, [], async (effect) => {
    if (effect.name === "application_document_upload:101")
      await page.evaluate(() => {
        document.querySelector('[data-laplace-application-document="101"]').requirement =
          window.controller.applicationFiles[1];
      });
  });
  await rejects(
    fillApplicationWorkflow(
      page,
      request({ files: [{ field: "document:101:file", path: file }] }),
      record,
    ),
    "record_changed",
  );
  assert.equal(
    (await page.evaluate(() => window.effects)).some((x) => x.startsWith("upload:")),
    false,
  );
  assert.deepEqual(await page.evaluate(() => window.requests), []);
});
