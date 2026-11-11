import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";

import { CmsService } from "../dist/core.js";
import { CmsMutations } from "../dist/mutations.js";
import { CMS_ORIGIN, TIMEZONE } from "../dist/types.js";
import { installEventForm } from "./fixtures/event-form.mjs";

let browser;
before(async () => {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cms-event-integration-"));
  const file = join(directory, "resume.pdf");
  await writeFile(file, "%PDF-1.7 sanitized event fixture");
  const context = await browser.newContext();
  // No live CMS requests: all navigation is locally fulfilled and external traffic aborted.
  await context.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(CMS_ORIGIN + "/events")
      ? route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><main></main>",
        })
      : route.abort(),
  );
  const page = await context.newPage();
  const state = {
    attending: false,
    pending: false,
    earlyReads: 0,
    submissions: [],
    uploads: [],
    journal: [],
  };
  await page.exposeFunction("fixtureUpload", (id) => {
    assert.ok(
      state.journal.some(
        (effect) =>
          effect.name === "event_document_upload:" + id &&
          effect.status === "intended",
      ),
      "upload requires its durable intent",
    );
    state.uploads.push(id);
  });
  await page.exposeFunction("fixtureSave", async (payload) => {
    assert.ok(
      state.journal.some(
        (effect) =>
          effect.name === "event_register" && effect.status === "intended",
      ),
      "final submit requires durable intent",
    );
    state.pending = true;
    state.submissions.push(payload);
    // Native save completes asynchronously and redirects only after acknowledgement.
    await new Promise((resolve) => setTimeout(resolve, 40));
    state.attending = true;
    state.pending = false;
    return {
      eventId: options.wrongTargetAfter ? "999" : "123",
      slot: options.slot || null,
    };
  });
  const navigate = page.goto.bind(page);
  page.goto = async (url, navigationOptions) => {
    if (state.pending) {
      state.earlyReads++;
      throw new Error("verification navigation interrupted pending save");
    }
    const result = await navigate(url, navigationOptions);
    if (new URL(url).hash.includes("/registration")) {
      await page.setContent(
        "<!doctype html><main><tt-edit-registration></tt-edit-registration></main>",
      );
      await page.evaluate(installEventForm, {
        docs: options.withFile
          ? [{ id: "101", title: "Resume", required: true }]
          : [],
        confirmOnly: !options.withFile,
        slot: options.slot,
      });
      await page.evaluate(() => {
        window.fixtureOnSubmit = async (c) => {
          const result = await window.fixtureSave({
            eventId: String(c.eventId),
            slot: c.timeSlotId || null,
            documents: c.registrationDocuments.map((d) => ({
              documentTypeId: String(d.eventRegistrationDocumentTypeId),
              fileId: d.fileService.files[0]?.FileId || null,
            })),
          });
          c.isRegistrationBeingSubmitted = false;
          history.replaceState(null, "", "/events#/events/" + result.eventId);
          document.querySelector("main").innerHTML =
            "<tt-event-detail>Registered</tt-event-detail>";
        };
      });
    } else {
      await page.evaluate(
        ({ attending, wrongTarget, slot }) => {
          document.querySelector("main").innerHTML =
            "<tt-event-detail><h1>Sanitized Event</h1><button>Register Now</button></tt-event-detail>";
          const controller = {
            event: {
              Id: attending && wrongTarget ? 999 : 123,
              IsAttending: attending,
              RegistrationRules: {
                CanRegister: !attending,
                CanRegisterForWaitlist: false,
                CanCancelRegistration: attending,
                IsAttending: attending,
                IsOnWaitlist: false,
              },
            },
            getCurrentUserTimeSlot: () =>
              attending && slot ? { Id: slot } : null,
          };
          window.angular = {
            element: () => ({
              controller: (name) =>
                name === "ttEventDetail" ? controller : undefined,
            }),
          };
        },
        {
          attending: state.attending,
          wrongTarget: options.wrongTargetAfter || false,
          slot: options.slot || null,
        },
      );
    }
    return result;
  };
  const browserAdapter = {
    page: async () => page,
    identity: async () => ({
      key: "student-7",
      name: "Fixture student",
      account_id: "7",
    }),
  };
  const reads = {
    read: async (input) => {
      await page.goto(CMS_ORIGIN + "/events#/events/" + (input.id || "123"));
      return {
        area: "events",
        url: page.url(),
        title: "Sanitized Event",
        timezone: TIMEZONE,
        text: "Sanitized event details",
        records: [
          { id: "123", name: "Sanitized Event" },
          ...(options.slot
            ? [
                {
                  id: options.slot,
                  name: "Exact slot",
                  canRegisterForTimeslot: true,
                },
              ]
            : []),
        ],
      };
    },
    navigate: async (area, id) => {
      await reads.read({ area, id });
      return page;
    },
  };
  const mutations = new CmsMutations(browserAdapter, reads);
  const recordEffect = async (effect) => {
    state.journal.push(structuredClone(effect));
  };
  const adapter = {
    ...browserAdapter,
    read: reads.read,
    prepare: (change) => mutations.prepare(change),
    submit: (change, record) =>
      mutations.submit(change, async (effect) => {
        await recordEffect(effect);
        await record(effect);
      }),
    form: (change) => mutations.form(change),
    capabilities: async () => ({}),
    download: async () => ({}),
    close: async () => {},
  };
  const service = new CmsService(adapter, {
    profileDir: join(directory, "profile"),
  });
  t.after(async () => {
    await service.close();
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = {
    operation: "event_register",
    area: "events",
    target_id: "123",
    fields: {},
    files: [],
    ...(options.slot ? { slot_id: options.slot } : {}),
  };
  return { page, mutations, service, request, recordEffect, state, file };
}

test("confirmed event registration completes through CmsService for the exact target and slot once", async (t) => {
  const { service, request, state } = await fixture(t, { slot: "88" });
  const draft = await service.prepare(request);
  assert.deepEqual(state.submissions, []);
  assert.deepEqual(state.uploads, []);
  const result = await service.commit(draft.draft_id, true);
  assert.equal(result.status, "verified");
  assert.equal(result.result.target_id, "123");
  assert.deepEqual(state.submissions, [
    { eventId: "123", slot: "88", documents: [] },
  ]);
  assert.equal(state.earlyReads, 0);
  assert.equal((await service.recoveryStatus()).blocked, false);
  await assert.rejects(
    service.commit(draft.draft_id, true),
    (error) => error.code === "draft_expired",
  );
  assert.equal(state.submissions.length, 1);
});

test("file registration remains partial until the exact registration attachment is independently observed", async (t) => {
  const { service, request, state, file } = await fixture(t, {
    withFile: true,
  });
  request.files.push({ field: "document:101:file", path: file });
  const draft = await service.prepare(request);
  assert.deepEqual(state.uploads, []);
  assert.deepEqual(state.submissions, []);
  let failure;
  await assert.rejects(service.commit(draft.draft_id, true), (error) => {
    failure = error;
    return error.code === "submission_partial";
  });
  const result = failure.details.result;
  assert.equal(result.status, "partial");
  assert.equal(
    result.effects.find((effect) => effect.name === "event_document_upload:101")
      .status,
    "verified",
  );
  assert.equal(
    result.effects.find(
      (effect) => effect.name === "event_document_attachment:101",
    ).status,
    "intended",
  );
  assert.equal(
    result.effects.find((effect) => effect.name === "event_register").status,
    "verified",
  );
  assert.deepEqual(state.uploads, ["101"]);
  assert.deepEqual(state.submissions, [
    {
      eventId: "123",
      slot: null,
      documents: [{ documentTypeId: "101", fileId: "file-101" }],
    },
  ]);
  assert.equal(state.earlyReads, 0);
  assert.equal((await service.recoveryStatus()).blocked, true);
  await assert.rejects(
    service.commit(draft.draft_id, true),
    (error) => error.code === "draft_expired",
  );
  assert.equal(state.submissions.length, 1);
});

test("workflow rules changing after prepare reject submission even when all field values are identical", async (t) => {
  const { mutations, request, page, state, recordEffect } = await fixture(t);
  await mutations.prepare(request);
  await page.evaluate(() => {
    window.controller.event.RegistrationRules.CanRegisterForWaitlist = true;
  });
  await assert.rejects(
    mutations.submit(request, recordEffect),
    (error) => error.code === "preview_changed",
  );
  assert.deepEqual(state.submissions, []);
  assert.deepEqual(state.uploads, []);
  assert.deepEqual(state.journal, []);
});

test("attendance for another event cannot verify the submitted target", async (t) => {
  const { mutations, request, state, recordEffect } = await fixture(t, {
    wrongTargetAfter: true,
  });
  await mutations.prepare(request);
  const result = await mutations.submit(request, recordEffect);
  assert.equal(result.status, "uncertain");
  assert.equal(
    result.effects.find((effect) => effect.name === "event_register").status,
    "intended",
  );
  assert.equal(state.submissions.length, 1);
});
