import assert from "node:assert/strict";
import { test } from "node:test";

import { isReadRequest, isInfrastructureRequest, ReadRequestGuard } from "../dist/browser.js";
import { CMS_ORIGIN } from "../dist/types.js";
const challenge = "/cdn-cgi/challenge-platform/h/b/fo/sanitized-fixture-token";
async function send(guard, method, url) {
  let outcome;
  await guard.handle({
    request: () => ({ method: () => method, url: () => url }),
    fallback: async () => {
      outcome = "allowed";
    },
    abort: async () => {
      outcome = "blocked";
    },
  });
  return outcome;
}

test("approved-origin challenge POST is infrastructure, separately from CMS data reads", async () => {
  assert.equal(isInfrastructureRequest("POST", CMS_ORIGIN + challenge), true);
  assert.equal(isReadRequest("POST", CMS_ORIGIN + challenge), false);
  for (const origin of [CMS_ORIGIN, "https://challenges.cloudflare.com"])
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      assert.equal(isInfrastructureRequest(method, origin + challenge + "?ephemeral=hidden"), true);
    }
  assert.equal(
    isInfrastructureRequest(
      "POST",
      CMS_ORIGIN + "/cdn-cgi/challenge-platform/h/b/fo/token%3Afixture",
    ),
    true,
  );
  const guard = new ReadRequestGuard();
  assert.equal(await send(guard, "POST", CMS_ORIGIN + challenge), "allowed");
  assert.equal(
    await send(guard, "POST", "https://challenges.cloudflare.com" + challenge),
    "allowed",
  );
  assert.equal(
    await send(guard, "POST", "https://challenges.cloudflare.com/unrelated-endpoint"),
    "blocked",
  );
  assert.doesNotThrow(() => guard.assertReadRequests());
  // Infrastructure permission persists without creating a mutation window.
  assert.equal(await send(guard, "POST", CMS_ORIGIN + "/api/v2/tasks"), "blocked");
  assert.throws(() => guard.assertReadRequests(), { code: "read_request_unreviewed" });
});

test("the infrastructure exception rejects other origins, methods, endpoints and encoded escapes", () => {
  for (const url of [
    "https://employer.example" + challenge,
    "https://challenges.cloudflare.com.attacker.example" + challenge,
    "https://foo.challenges.cloudflare.com" + challenge,
    "http://challenges.cloudflare.com" + challenge,
    "https://challenges.cloudflare.com:444" + challenge,
    "https://name:secret@challenges.cloudflare.com" + challenge,
    "https://challenges.cloudflare.com/cdn-cgi/trace",
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform-impostor/write",
    "https://som-yale.12twenty.com.attacker.example" + challenge,
    "http://som-yale.12twenty.com" + challenge,
    "https://som-yale.12twenty.com:444" + challenge,
    "https://name:secret@som-yale.12twenty.com" + challenge,
    CMS_ORIGIN + "/cdn-cgi/trace",
    CMS_ORIGIN + "/cdn-cgi/other-write",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform-impostor/write",
    CMS_ORIGIN + "/api/v2/tasks?next=/cdn-cgi/challenge-platform/",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/../../../api/write",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/a/../b",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/a/%2e/b",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/a%2f..%2f..%2fapi/write",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/%252e%252e/api/write",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/a%5c..%5capi/write",
    CMS_ORIGIN + "/cdn-cgi/challenge-platform/%broken",
    "not a URL",
  ])
    assert.equal(isInfrastructureRequest("POST", url), false, url);
  for (const method of ["PUT", "PATCH", "DELETE", "CONNECT"])
    assert.equal(isInfrastructureRequest(method, CMS_ORIGIN + challenge), false);
});

test("denied challenge paths redact transient suffixes and query values in guard errors", async () => {
  const guard = new ReadRequestGuard();
  assert.equal(
    await send(guard, "DELETE", CMS_ORIGIN + challenge + "?clearance=secret"),
    "blocked",
  );
  assert.equal(
    await send(guard, "POST", CMS_ORIGIN + "/cdn-cgi/challenge-platform/%252e-token"),
    "blocked",
  );
  assert.throws(
    () => guard.assertReadRequests(),
    (error) => {
      assert.equal(error.code, "read_request_unreviewed");
      assert.deepEqual(error.details.requests, [
        { method: "DELETE", path: "/cdn-cgi/challenge-platform/[redacted]" },
        { method: "POST", path: "/cdn-cgi/challenge-platform/[redacted]" },
      ]);
      assert.equal(JSON.stringify(error).includes("fixture-token"), false);
      assert.equal(JSON.stringify(error).includes("clearance"), false);
      assert.equal(JSON.stringify(error).includes("%252e-token"), false);
      return true;
    },
  );
});
