import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { SessionBinding } from "../dist/session-binding.js";
import { ReadRequestGuard } from "../dist/browser.js";
import { CmsService } from "../dist/core.js";
import { CMS_ORIGIN } from "../dist/types.js";

async function fixture(t) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const dir = await mkdtemp(join(tmpdir(), "cms-session-binding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const setAccount = async (value) =>
    context.addCookies([
      {
        name: ".ASPXAUTH.Shared",
        value,
        domain: "som-yale.12twenty.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  await setAccount("fixture-A");
  let providerWrites = 0;
  await page.route(CMS_ORIGIN + "/**", async (route) => {
    if (route.request().method() === "POST") providerWrites++;
    await route.fulfill({
      contentType: "text/html",
      body: "<main>Fixture</main>",
    });
  });
  const binding = new SessionBinding(async () => page);
  const guard = new ReadRequestGuard((request) =>
    binding.assertRequest(request),
  );
  await page.route("**/*", (route) => guard.handle(route));
  await page.goto(CMS_ORIGIN + "/dashboard/");
  let duringJournal;
  const adapter = {
    async close() {
      binding.clear();
    },
    async prepare() {
      return {
        identity: await binding.identityKey("fixture-student"),
        preview: { subject: "Fixture task" },
      };
    },
    async submit(change, recordEffect) {
      await binding.begin();
      try {
        return await guard.runMutation(async () => {
          await recordEffect({ name: "task_create", status: "intended" });
          await duringJournal?.();
          const result = await page.evaluate(async () => {
            try {
              return (
                await fetch("/api/v2/tasks", {
                  method: "POST",
                  body: "fixture",
                })
              ).status;
            } catch {
              return "blocked";
            }
          });
          return {
            status: result === 200 ? "verified" : "uncertain",
            effects: [
              {
                name: "task_create",
                status: result === 200 ? "verified" : "uncertain",
              },
            ],
          };
        });
      } finally {
        binding.end();
      }
    },
  };
  const service = new CmsService(adapter, { profileDir: join(dir, "state") });
  t.after(() => service.close());
  return {
    binding,
    guard,
    page,
    setAccount,
    service,
    providerWrites: () => providerWrites,
    setDuringJournal: (fn) => {
      duringJournal = fn;
    },
  };
}

test("an unchanged session passes the actual paused Cookie header check before the fixture provider", async (t) => {
  const f = await fixture(t);
  const preview = await f.service.prepare({
    operation: "task_create",
    area: "tasks",
    fields: { subject: "Fixture task" },
  });
  const result = await f.service.commit(preview.draft_id, true);
  assert.equal(result.status, "verified");
  assert.equal(f.providerWrites(), 1);
});

test("a Chrome session switch after prepare invalidates the draft before provider submission", async (t) => {
  const f = await fixture(t);
  const preview = await f.service.prepare({
    operation: "task_create",
    area: "tasks",
    fields: { subject: "Fixture task" },
  });
  await f.setAccount("fixture-B");
  await assert.rejects(() => f.service.commit(preview.draft_id, true), {
    code: "account_changed",
  });
  assert.equal(f.providerWrites(), 0);
});

test("a session switch during journal work aborts the actual paused POST and preserves uncertain recovery", async (t) => {
  const f = await fixture(t);
  const preview = await f.service.prepare({
    operation: "task_create",
    area: "tasks",
    fields: { subject: "Fixture task" },
  });
  f.setDuringJournal(() => f.setAccount("fixture-B"));
  await assert.rejects(() => f.service.commit(preview.draft_id, true), {
    code: "submission_uncertain",
  });
  assert.equal(f.providerWrites(), 0);
  assert.equal((await f.service.recoveryStatus()).blocked, true);
});
