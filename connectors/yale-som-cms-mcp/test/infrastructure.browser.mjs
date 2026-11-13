import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";

import { ReadRequestGuard } from "../dist/browser.js";
import { observeCompletion } from "../dist/completion.js";
import { CMS_ORIGIN } from "../dist/types.js";
const challenge = "/cdn-cgi/challenge-platform/h/b/fo/sanitized-fixture";
let browser;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});
async function fixture(t, responder) {
  const context = await browser.newContext(),
    page = await context.newPage();
  const reached = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.ok(
      [CMS_ORIGIN, "https://challenges.cloudflare.com"].includes(url.origin),
      "offline fixtures only use known mocked origins",
    );
    if (route.request().isNavigationRequest())
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><form id="editor"><button type="button">Save</button></form>',
      });
    reached.push(url.pathname);
    return responder ? responder(route) : route.fulfill({ status: 200, body: "{}" });
  });
  const guard = new ReadRequestGuard();
  await page.route("**/*", (route) => guard.handle(route));
  await page.goto(CMS_ORIGIN + "/dashboard/");
  t.after(() => context.close());
  return { page, guard, reached };
}
test("browser-generated delayed infrastructure remains allowed while CMS autosaves stay blocked", async (t) => {
  const { page, guard, reached } = await fixture(t);
  await page.evaluate((path) => {
    setTimeout(() => {
      void fetch(path, { method: "POST" }).then(() => {
        window.challengeDone = true;
      });
    }, 20);
  }, challenge);
  await page.waitForFunction(() => window.challengeDone === true);
  assert.deepEqual(reached, [challenge]);
  assert.doesNotThrow(() => guard.assertReadRequests());
  await page.evaluate(() =>
    fetch("/api/v2/unreviewed-autosave", { method: "POST" }).catch(() => {}),
  );
  assert.deepEqual(reached, [challenge]);
  assert.throws(() => guard.assertReadRequests(), { code: "read_request_unreviewed" });
});
test("a completed infrastructure POST cannot establish business-write completion", async (t) => {
  const { page } = await fixture(t);
  await assert.rejects(
    observeCompletion(
      page,
      () => page.evaluate((path) => fetch(path, { method: "POST" }), challenge),
      { form: page.locator("#editor"), timeoutMs: 250, settleMs: 30 },
    ),
    (error) =>
      error.code === "submission_uncertain" &&
      error.details.reason === "completion_timeout" &&
      error.details.pending_requests === 0,
  );
});
test("pending challenge traffic cannot delay positive business-form completion", async (t) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const { page, guard } = await fixture(t, async (route) => {
    await waiting;
    await route.fulfill({ status: 200, body: "{}" }).catch(() => {});
  });
  try {
    const result = await observeCompletion(
      page,
      () =>
        page.evaluate((path) => {
          void fetch(path, { method: "POST" }).catch(() => {});
          document.querySelector("#editor").remove();
          return "submitted once";
        }, challenge),
      { form: page.locator("#editor"), timeoutMs: 500, settleMs: 30 },
    );
    assert.equal(result, "submitted once");
    assert.doesNotThrow(() => guard.assertReadRequests());
  } finally {
    release();
  }
});
test("failed infrastructure traffic cannot mark a completed business form uncertain", async (t) => {
  const { page } = await fixture(t, (route) => route.abort("failed"));
  const result = await observeCompletion(
    page,
    () =>
      page.evaluate(async (path) => {
        await fetch(path, { method: "POST" }).catch(() => {});
        document.querySelector("#editor").remove();
        return "completed";
      }, challenge),
    { form: page.locator("#editor"), timeoutMs: 500, settleMs: 30 },
  );
  assert.equal(result, "completed");
});

test("hosted challenge POST uses browser origin isolation and never forwards the Yale cookie", async (t) => {
  let hostedCookie;
  const { page, guard, reached } = await fixture(t, async (route) => {
    hostedCookie = await route.request().headerValue("cookie");
    return route.fulfill({ status: 200, body: "{}" });
  });
  await page
    .context()
    .addCookies([
      {
        name: "yale_fixture_session",
        value: "private-fixture",
        domain: "som-yale.12twenty.com",
        path: "/",
        secure: true,
      },
    ]);
  await page.evaluate(
    (url) => fetch(url, { method: "POST", mode: "no-cors", credentials: "include" }),
    "https://challenges.cloudflare.com" + challenge,
  );
  assert.deepEqual(reached, [challenge]);
  assert.ok(!hostedCookie?.includes("yale_fixture_session"));
  assert.doesNotThrow(() => guard.assertReadRequests());
});
