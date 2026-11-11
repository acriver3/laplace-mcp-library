import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";

import {
  inspectEventWorkflow,
  validateEventWorkflow,
  fillEventWorkflow,
} from "../dist/event-workflow.js";

let browser, directory, file;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  directory = await mkdtemp(join(tmpdir(), "cms-event-fixture-"));
  file = join(directory, "fixture.pdf");
  await writeFile(file, "%PDF-1.7 sanitized fixture");
});
after(async () => {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(t, options = {}) {
  const context = await browser.newContext();
  // Every request is locally fulfilled or aborted; no Yale request reaches a server.
  await context.route("**/*", (route) =>
    route.request().url().startsWith("https://som-yale.12twenty.com/events")
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><tt-edit-registration></tt-edit-registration></body></html>",
        })
      : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(
    "https://som-yale.12twenty.com/events#/events/123/registration" +
      (options.slot ? "?timeSlotId=" + options.slot : ""),
  );
  t.after(() => context.close());
  await page.evaluate((options) => {
    const docs = (options.docs || [{ id: "101", title: "Resume", required: true }]).map((input) => {
      const d = {
        eventRegistrationDocumentTypeId: Number(input.id),
        registrationDocumentTypeCoreId: 1,
        displayTitle: input.title,
        isRequired: input.required,
        isNew: true,
        type: "upload",
        Name: input.title,
        ExistingApplicationDocumentId: null,
        existing: input.existing || [],
        saveToApplicationMaterialsLibrary: false,
      };
      const service = {
        files: [],
        isUploading: false,
        error: false,
        AllowedExtensions: ["pdf"],
        attachmentSizeLimitInBytes: 10000,
        hasFiles() {
          return this.files.length > 0;
        },
        hasError() {
          return this.error;
        },
      };
      d.fileService = service;
      return d;
    });
    const c = {
      eventId: "123",
      event: {
        Id: 123,
        RegistrationInstructions: null,
        RegistrationRules: {
          CanRegister: true,
          CanRegisterForWaitlist: false,
          IsAttending: false,
          IsOnWaitlist: false,
        },
      },
      studentId: 7,
      currentUser: { Id: 7, IsStudent: true },
      timeSlotId: options.slot,
      isReady: true,
      isNew: true,
      isTimeSlotExpired: false,
      isRegistrationBeingSubmitted: false,
      docsStepId: "docs",
      confirmationStepId: "confirm",
      enabledStepIds: options.confirmOnly ? ["confirm"] : ["docs", "confirm"],
      stepIndex: 0,
      preSurveyResponse: {},
      registrationDocuments: docs,
      goToStep: function (n) {
        this.stepIndex = n;
      },
      continue: function () {
        this.stepIndex++;
        this.stepIndex >= this.enabledStepIds.length &&
          (this.stepIndex = this.enabledStepIds.length - 1);
      },
    };
    Object.defineProperty(c, "currentStepId", {
      get() {
        return this.enabledStepIds[this.stepIndex];
      },
    });
    const host = document.querySelector("tt-edit-registration");
    const escape = (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
      );
    window.events = [];
    window.controller = c;
    const render = () => {
      if (c.currentStepId === "docs") {
        host.innerHTML =
          '<section ng-if="$ctrl.currentStepId == $ctrl.docsStepId">' +
          docs
            .map(
              (d) =>
                '<div class="registration-file" ng-repeat="requirement in $ctrl.registrationDocuments">' +
                "<h4>" +
                escape(d.displayTitle) +
                (d.isRequired ? " (required)" : " (optional)") +
                "</h4><form>" +
                '<label style="display:none"><input type="radio" name="uploadType" data-ng-model="model.type" value="current">Current</label>' +
                '<label><input type="radio" name="uploadType" data-ng-model="model.type" value="upload">Upload New</label>' +
                '<label style="' +
                (d.existing.length ? "" : "display:none") +
                '"><input type="radio" name="uploadType" data-ng-model="model.type" value="existing">Existing</label>' +
                '<div data-upload><input id="documentName" ng-model="model.Name"><label><input type="checkbox" name="saveToApplicationMaterialsLibrary" data-ng-model="model.saveToApplicationMaterialsLibrary">Save to library</label>' +
                '<input type="file" uploader="service" hidden></div>' +
                '<div data-existing><select ng-model="model.ExistingApplicationDocumentId"><option value="">Choose</option>' +
                d.existing
                  .map((x) => '<option value="number:' + x.Id + '">' + escape(x.Name) + "</option>")
                  .join("") +
                "</select></div></form></div>",
            )
            .join("") +
          '<a role="button" ng-click="$ctrl.continue()" href="#">Continue</a></section>';
        for (let i = 0; i < docs.length; i++) {
          const row = host.querySelectorAll(".registration-file")[i],
            d = docs[i];
          row.requirement = d;
          const visibility = () => {
            row.querySelector("[data-upload]").style.display =
              d.type === "upload" ? "block" : "none";
            row.querySelector("[data-existing]").style.display =
              d.type === "existing" ? "block" : "none";
          };
          for (const radio of row.querySelectorAll('input[type="radio"]')) {
            radio.checked = radio.value === d.type;
            radio.addEventListener("change", () => {
              d.type = radio.value;
              window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
              visibility();
            });
          }
          const name = row.querySelector("#documentName");
          name.value = d.Name;
          name.addEventListener("input", () => {
            d.Name = name.value;
            window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
          });
          row.querySelector('input[type="checkbox"]').checked = d.saveToApplicationMaterialsLibrary;
          row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
            d.saveToApplicationMaterialsLibrary = e.target.checked;
            window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
          });
          row.querySelector("select").value = d.ExistingApplicationDocumentId
            ? "number:" + d.ExistingApplicationDocumentId
            : "";
          row.querySelector("select").addEventListener("change", (e) => {
            d.ExistingApplicationDocumentId = Number(e.target.value.replace("number:", ""));
            window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
          });
          row.querySelector('input[type="file"]').addEventListener("change", () => {
            window.events.push("upload:" + d.eventRegistrationDocumentTypeId);
            if (options.failUpload === String(d.eventRegistrationDocumentTypeId))
              d.fileService.error = true;
            else d.fileService.files = [{ FileId: "file-" + d.eventRegistrationDocumentTypeId }];
          });
          visibility();
        }
        host.querySelector('[ng-click="$ctrl.continue()"]').addEventListener("click", (e) => {
          e.preventDefault();
          c.continue();
          render();
        });
      } else {
        host.innerHTML =
          '<section ng-if="$ctrl.currentStepId == $ctrl.confirmationStepId"><div>Are you sure you want to register for this event?</div><a role="button" tt-click="$ctrl.save()" href="#">Register</a></section>';
        host.querySelector('[tt-click="$ctrl.save()"]').addEventListener("click", (e) => {
          e.preventDefault();
          window.events.push("submit");
          c.isRegistrationBeingSubmitted = true;
        });
      }
    };
    window.angular = {
      element: (el) => ({
        controller: (name) => (name === "ttEditRegistration" ? c : undefined),
        scope: () => ({ requirement: el.requirement }),
        isolateScope: () => ({
          $root: {},
          $apply: (fn) => {
            fn();
            render();
          },
        }),
      }),
    };
    render();
  }, options);
  return page;
}
const change = (extra = {}) => ({
  operation: "event_register",
  area: "events",
  target_id: "123",
  fields: {},
  files: [],
  ...extra,
});
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const recorder =
  (page, effects = [], action) =>
  async (effect) => {
    effects.push(structuredClone(effect));
    await page.evaluate(
      (effect) => window.events.push("journal:" + effect.status + ":" + effect.name),
      effect,
    );
    await action?.(effect);
  };

test("preview inspects every stage with stable prefixed duplicate-control fields and no writes", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: false },
    ],
  });
  const result = await inspectEventWorkflow(page);
  assert.equal(result.fields.length, 8);
  assert.equal(new Set(result.fields.map((f) => f.id)).size, 8);
  assert.ok(result.fields.some((f) => f.id === "document:102:name"));
  assert.deepEqual(result.context.steps, ["docs", "confirm"]);
  assert.deepEqual(await page.evaluate(() => window.events), []);
  assert.equal(await page.evaluate(() => window.controller.currentStepId), "docs");
});

test("required uploads, mutually exclusive choices, exact slots, extensions, and unknown fields validate before edits", async (t) => {
  const page = await fixture(t);
  const workflow = await inspectEventWorkflow(page);
  assert.throws(
    () => validateEventWorkflow(workflow, change()),
    (e) => e.code === "required_file",
  );
  assert.throws(
    () => validateEventWorkflow(workflow, change({ slot_id: "other" })),
    (e) => e.code === "record_changed",
  );
  assert.throws(
    () => validateEventWorkflow(workflow, change({ fields: { unknown: true } })),
    (e) => e.code === "invalid_field",
  );
  assert.throws(
    () =>
      validateEventWorkflow(
        workflow,
        change({ files: [{ field: "document:101:file", path: "/tmp/no.exe" }] }),
      ),
    (e) => e.code === "invalid_file",
  );
  assert.deepEqual(await page.evaluate(() => window.events), []);
});

test("multiple uploads journal each effect before starting and submit once; library effects remain unverified", async (t) => {
  const page = await fixture(t, {
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: true },
    ],
  });
  const result = await fillEventWorkflow(
    page,
    change({
      fields: { "document:102:name": "My cover", "document:102:save_to_library": true },
      files: [
        { field: "document:101:file", path: file },
        { field: "document:102:file", path: file },
      ],
    }),
    recorder(page),
  );
  assert.deepEqual(result.uploads, [
    { document_type_id: "101", uploaded_file_id: "file-101" },
    { document_type_id: "102", uploaded_file_id: "file-102" },
  ]);
  assert.equal(result.effects.find((e) => e.name === "event_register").status, "intended");
  assert.equal(
    result.effects.find((e) => e.name === "event_document_library:102").status,
    "intended",
  );
  assert.equal(
    result.effects.find((e) => e.name === "event_document_upload:101").status,
    "verified",
  );
  const log = await page.evaluate(() => window.events);
  for (const id of ["101", "102"])
    assert.ok(
      log.indexOf("journal:intended:event_document_upload:" + id) < log.indexOf("upload:" + id),
    );
  assert.ok(log.indexOf("journal:intended:event_register") < log.indexOf("submit"));
  assert.equal(log.filter((x) => x === "submit").length, 1);
  assert.equal(
    await page.evaluate(() => window.controller.registrationDocuments[0].Name),
    "Resume",
  );
  assert.equal(
    await page.evaluate(() => window.controller.registrationDocuments[1].Name),
    "My cover",
  );
  await rejects(fillEventWorkflow(page, change(), recorder(page)), "action_unavailable");
});

test("existing library documents are selected by an exact available ID without uploads", async (t) => {
  const page = await fixture(t, {
    docs: [
      {
        id: "101",
        title: "Resume",
        required: true,
        existing: [{ Id: 55, Name: "Existing Resume" }],
      },
    ],
  });
  const request = change({
    fields: { "document:101:type": "Existing", "document:101:existing": "55" },
  });
  validateEventWorkflow(await inspectEventWorkflow(page), request);
  const result = await fillEventWorkflow(page, request, recorder(page));
  assert.deepEqual(result.uploads, []);
  assert.equal(
    await page.evaluate(
      () => window.controller.registrationDocuments[0].ExistingApplicationDocumentId,
    ),
    55,
  );
  assert.equal(
    (await page.evaluate(() => window.events)).filter((x) => x.startsWith("upload:")).length,
    0,
  );
});

test("failed later upload preserves acknowledged first effect and never submits or retries", async (t) => {
  const page = await fixture(t, {
    failUpload: "102",
    docs: [
      { id: "101", title: "Resume", required: true },
      { id: "102", title: "Cover Letter", required: true },
    ],
  });
  const journal = [];
  await rejects(
    fillEventWorkflow(
      page,
      change({
        files: [
          { field: "document:101:file", path: file },
          { field: "document:102:file", path: file },
        ],
      }),
      recorder(page, journal),
    ),
    "upload_uncertain",
  );
  assert.ok(journal.some((e) => e.name === "event_document_upload:101" && e.status === "verified"));
  assert.equal(
    journal.some((e) => e.name === "event_document_upload:102" && e.status === "verified"),
    false,
  );
  assert.equal((await page.evaluate(() => window.events)).includes("submit"), false);
  assert.equal(
    (await page.evaluate(() => window.events)).filter((x) => x === "upload:102").length,
    1,
  );
});

test("eligibility changes during final journaling prevent the final click", async (t) => {
  const page = await fixture(t);
  const record = recorder(page, [], async (effect) => {
    if (effect.name === "event_register")
      await page.evaluate(() => {
        window.controller.event.RegistrationRules.CanRegister = false;
      });
  });
  await rejects(
    fillEventWorkflow(
      page,
      change({ files: [{ field: "document:101:file", path: file }] }),
      record,
    ),
    "record_changed",
  );
  assert.equal((await page.evaluate(() => window.events)).includes("submit"), false);
});

test("uploaded-file identity changes during final journaling prevent the final click", async (t) => {
  const page = await fixture(t);
  const record = recorder(page, [], async (effect) => {
    if (effect.name === "event_register")
      await page.evaluate(() => {
        window.controller.registrationDocuments[0].fileService.files[0].FileId = "different";
      });
  });
  await rejects(
    fillEventWorkflow(
      page,
      change({ files: [{ field: "document:101:file", path: file }] }),
      record,
    ),
    "record_changed",
  );
  assert.equal((await page.evaluate(() => window.events)).includes("submit"), false);
});

test("journal failure before upload prevents file input and final submission", async (t) => {
  const page = await fixture(t);
  await assert.rejects(
    fillEventWorkflow(
      page,
      change({ files: [{ field: "document:101:file", path: file }] }),
      async () => {
        throw new Error("disk full");
      },
    ),
    /disk full/,
  );
  assert.deepEqual(await page.evaluate(() => window.events), []);
});

test("surveys, external instructions, URL documents, external consent, core reservations, and other students fail closed", async (t) => {
  for (const mutation of ["survey", "instructions", "url", "consent", "core", "other_student"]) {
    const page = await fixture(t);
    await page.evaluate((mutation) => {
      const c = window.controller;
      if (mutation === "survey") c.preSurveyMetadata = { fields: [] };
      if (mutation === "instructions") c.event.RegistrationInstructions = "Complete another site.";
      if (mutation === "url") c.registrationDocuments[0].registrationDocumentTypeCoreId = 7;
      if (mutation === "consent") c.registrationDocuments[0].sendToTopResume = true;
      if (mutation === "core") c.coreEventId = 77;
      if (mutation === "other_student") c.studentId = 9;
    }, mutation);
    await rejects(inspectEventWorkflow(page), "action_unavailable");
    assert.deepEqual(await page.evaluate(() => window.events), []);
  }
});

test("unreviewed step navigation is never executed", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.controller.goToStep = function (n) {
      window.events.push("unsafe");
      this.stepIndex = n;
    };
  });
  await rejects(inspectEventWorkflow(page), "action_unavailable");
  assert.deepEqual(await page.evaluate(() => window.events), []);
});

test("duplicate existing-document names are unavailable rather than guessed", async (t) => {
  const page = await fixture(t, {
    docs: [
      {
        id: "101",
        title: "Resume",
        required: true,
        existing: [
          { Id: 1, Name: "Same" },
          { Id: 2, Name: "Same" },
        ],
      },
    ],
  });
  await rejects(inspectEventWorkflow(page), "action_unavailable");
  assert.deepEqual(await page.evaluate(() => window.events), []);
});

test("a missing document control or mismatched heading fails before edits", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const old = window.angular.element;
    window.angular.element = (el) => {
      const result = old(el);
      if (el?.tagName === "TT-EDIT-REGISTRATION") {
        result.isolateScope = () => ({
          $root: {},
          $apply: (fn) => {
            const source = old(el).isolateScope();
            source.$apply(fn);
            el.querySelector("h4")?.remove();
          },
        });
      }
      return result;
    };
  });
  await rejects(inspectEventWorkflow(page), "action_unavailable");
  assert.deepEqual(await page.evaluate(() => window.events), []);
});

test("confirmation-only flow submits once with a journal and exact slot binding", async (t) => {
  const page = await fixture(t, { docs: [], confirmOnly: true, slot: "88" });
  const workflow = await inspectEventWorkflow(page);
  assert.equal(workflow.slot_id, "88");
  const result = await fillEventWorkflow(page, change({ slot_id: "88" }), recorder(page));
  assert.deepEqual(result.uploads, []);
  assert.deepEqual(await page.evaluate(() => window.events), [
    "journal:intended:event_register",
    "submit",
  ]);
});

test("controller and URL slot mismatch is unavailable before inspection changes", async (t) => {
  const page = await fixture(t, { slot: "88" });
  await page.evaluate(() => {
    window.controller.timeSlotId = "89";
  });
  await rejects(inspectEventWorkflow(page), "action_unavailable");
  assert.deepEqual(await page.evaluate(() => window.events), []);
});
