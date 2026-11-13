import assert from "node:assert/strict";
import { test } from "node:test";
import { errors } from "playwright-core";
import { CmsReads } from "../dist/reads.js";
import { CmsError, CMS_ORIGIN } from "../dist/types.js";

function fixture({
  mainError,
  loadingError,
  identityError,
  closed = false,
} = {}) {
  const calls = [];
  const page = {
    isClosed: () => closed,
    url: () => CMS_ORIGIN + "/dashboard/",
    locator: () => ({
      first() {
        return this;
      },
      async waitFor() {
        calls.push("content");
        if (mainError) throw mainError;
      },
      async innerText() {
        return "Dashboard";
      },
    }),
    async waitForFunction() {
      calls.push("loading");
      if (loadingError) throw loadingError;
    },
  };
  const browser = {
    async identity() {
      calls.push("identity");
      if (identityError) throw identityError;
      return { key: "fixture", name: "Fixture student" };
    },
  };
  return { reads: new CmsReads(browser), page, calls };
}

test("successful readiness does not start an early authentication check", async () => {
  const f = fixture();
  await f.reads.settled(f.page);
  assert.deepEqual(f.calls, ["content", "loading"]);
});
test("only actual loading timeouts are reported as page_not_ready", async () => {
  const f = fixture({
    loadingError: new errors.TimeoutError("Timed out after20seconds"),
  });
  await assert.rejects(() => f.reads.settled(f.page), {
    code: "page_not_ready",
  });
  assert.deepEqual(f.calls, ["content", "loading", "identity"]);
});
test("predicate exceptions retain a useful diagnostic instead of masquerading as timeout", async () => {
  const f = fixture({
    loadingError: new TypeError("injector.has is not a function"),
  });
  await assert.rejects(
    () => f.reads.settled(f.page),
    (e) =>
      e.code === "page_changed" &&
      e.details.phase === "loading_state" &&
      e.details.cause === "injector.has is not a function",
  );
});
test("a challenged content wait preserves browser_challenge after its normal readiness window", async () => {
  const f = fixture({
    mainError: new errors.TimeoutError("No main"),
    identityError: new CmsError(
      "browser_challenge",
      "Observed Cloudflare challenge",
    ),
  });
  await assert.rejects(() => f.reads.settled(f.page), {
    code: "browser_challenge",
  });
  assert.deepEqual(f.calls, ["content", "identity"]);
});
test("known session and account errors survive failed loading checks", async () => {
  for (const code of ["auth_required", "account_not_student"]) {
    const f = fixture({
      loadingError: new errors.TimeoutError("Still loading"),
      identityError: new CmsError(code, "Fixture"),
    });
    await assert.rejects(() => f.reads.settled(f.page), { code });
  }
});
test("closed pages do not trigger a browser restart and diagnostics exclude URLs and credentials", async () => {
  const f = fixture({
    closed: true,
    loadingError: new Error(
      "Unexpected API https://tenant.invalid/path?token=private token=private Authorization=private Bearer private-value",
    ),
  });
  await assert.rejects(
    () => f.reads.settled(f.page),
    (e) =>
      e.code === "page_changed" &&
      !e.details.cause.includes("private") &&
      !e.details.cause.includes("tenant.invalid"),
  );
  assert.deepEqual(f.calls, ["content", "loading"]);
});
