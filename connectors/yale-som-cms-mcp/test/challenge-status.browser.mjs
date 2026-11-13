import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FixtureCmsBrowser as CmsBrowser } from "./fixtures/browser.mjs";
import { CMS_ORIGIN } from "../dist/types.js";

const student =
  '<!doctype html><body class="logged-in-user"><a href="/students/profile">Profile</a><script>window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}};</script></body>';
const challenge =
  "<!doctype html><title>Just a moment...</title><main>Browser check fixture</main>";
async function fixture(t, routes) {
  const dir = await mkdtemp(join(tmpdir(), "cms-challenge-fixture-"));
  const cms = new CmsBrowser(join(dir, "profile"), "chrome", false, join(dir, "downloads"));
  t.after(async () => {
    await cms.close();
    await rm(dir, { recursive: true, force: true });
  });
  const page = await cms.page();
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, CMS_ORIGIN, "fixtures never contact a remote service");
    const response = routes[url.pathname];
    if (!response) return route.abort();
    return route.fulfill({ contentType: "text/html", ...response });
  });
  return { cms, page };
}
function assertChallenge(error) {
  assert.equal(error.code, "browser_challenge");
  assert.deepEqual(error.details, { provider: "cloudflare", saved_login_status: "unknown" });
  assert.match(error.message, /saved login may still be valid/);
  assert.match(error.message, /visible connector browser/);
  assert.match(error.message, /then retry while that window is open/);
  assert.doesNotMatch(JSON.stringify(error), /opaque-fixture|fixture-clearance|fixture-ray/);
  return true;
}
test("a main-frame Cloudflare response reports browser_challenge after readiness, not expired login", async (t) => {
  const { cms, page } = await fixture(t, {
    "/dashboard/": {
      status: 403,
      headers: {
        "cf-mitigated": "challenge",
        "cf-ray": "fixture-ray",
        "set-cookie": "cf_clearance=fixture-clearance",
      },
      body: challenge,
    },
  });
  await page.goto(CMS_ORIGIN + "/dashboard/?token=opaque-fixture");
  await assert.rejects(() => cms.identity(), assertChallenge);
});
test("a nonchallenge main navigation clears the challenge and can verify the saved student", async (t) => {
  const { cms, page } = await fixture(t, {
    "/challenge": { status: 403, headers: { "cf-mitigated": "challenge" }, body: challenge },
    "/accepted": { body: student },
  });
  await page.goto(CMS_ORIGIN + "/challenge");
  // Clearing depends on the next main-document response, not a guessed title.
  await page.goto(CMS_ORIGIN + "/accepted");
  assert.equal((await cms.identity()).account_id, "1234567");
});
test("a challenge that resolves during the bounded readiness wait does not leave stale failure", async (t) => {
  const { cms, page } = await fixture(t, {
    "/challenge": {
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      body: challenge + '<script>setTimeout(()=>location.assign("/accepted"),150)</script>',
    },
    "/accepted": { body: student },
  });
  await page.goto(CMS_ORIGIN + "/challenge");
  assert.equal((await cms.identity()).account_id, "1234567");
});
test("challenged iframes and API responses do not label an authenticated main document challenged", async (t) => {
  const { cms, page } = await fixture(t, {
    "/dashboard/": { body: student + '<iframe src="/frame"></iframe>' },
    "/frame": { status: 403, headers: { "cf-mitigated": "challenge" }, body: challenge },
    "/api-fixture": { status: 403, headers: { "cf-mitigated": "challenge" }, body: challenge },
  });
  await page.goto(CMS_ORIGIN + "/dashboard/");
  await page.evaluate(() => fetch("/api-fixture"));
  assert.equal((await cms.identity()).account_id, "1234567");
});
test("a plain unauthenticated response after a challenge still reports auth_required", async (t) => {
  const { cms, page } = await fixture(t, {
    "/challenge": { status: 403, headers: { "cf-mitigated": "challenge" }, body: challenge },
    "/sign-in": { body: "<!doctype html><main>Sign in</main>" },
  });
  await page.goto(CMS_ORIGIN + "/challenge");
  await page.goto(CMS_ORIGIN + "/sign-in");
  await assert.rejects(() => cms.identity(), { code: "auth_required" });
});
test("Cloudflare-looking page text without the documented header does not assert a challenge", async (t) => {
  const { cms, page } = await fixture(t, {
    "/dashboard/": { body: student + challenge },
  });
  await page.goto(CMS_ORIGIN + "/dashboard/");
  assert.equal((await cms.identity()).account_id, "1234567");
});
