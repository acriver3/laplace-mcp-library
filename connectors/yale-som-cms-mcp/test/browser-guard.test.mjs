import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadRequestGuard } from "../dist/browser.js";
import { CMS_ORIGIN } from "../dist/types.js";

async function request(guard, method, path, origin = CMS_ORIGIN) {
  let result;
  await guard.handle({
    request: () => ({ method: () => method, url: () => origin + path }),
    fallback: async () => {
      result = "allowed";
    },
    abort: async () => {
      result = "blocked";
    },
  });
  return result;
}

test("read guard permits observed query contracts and blocks unreviewed autosaves", async () => {
  const guard = new ReadRequestGuard();
  assert.equal(await request(guard, "GET", "/dashboard/"), "allowed");
  assert.equal(
    await request(guard, "POST", "/Api/V2/job-postings/post-query"),
    "allowed",
  );
  assert.equal(
    await request(guard, "POST", "/api/v2/resume-books/7597/items/query"),
    "allowed",
  );
  assert.equal(
    await request(guard, "POST", "/api/v2/invented/post-query?token=secret"),
    "blocked",
  );
  assert.equal(
    await request(guard, "PUT", "/api/v2/students/42?token=secret"),
    "blocked",
  );
  assert.throws(
    () => guard.assertReadRequests(),
    (error) =>
      error.code === "read_request_unreviewed" &&
      JSON.stringify(error.details) ===
        '{"requests":[{"method":"POST","path":"/api/v2/invented/post-query"},{"method":"PUT","path":"/api/v2/students/42"}]}',
  );
  assert.doesNotThrow(() => guard.assertReadRequests());
});

test("mutation permission is awaited, tenant scoped, and always resets", async () => {
  const guard = new ReadRequestGuard();
  const result = await guard.runMutation(async () => {
    assert.equal(await request(guard, "POST", "/api/v2/tasks"), "allowed");
    assert.equal(
      await request(guard, "POST", "/apply", "https://employer.invalid"),
      "blocked",
    );
    await assert.rejects(() => guard.runMutation(async () => {}), {
      code: "mutation_in_progress",
    });
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(await request(guard, "POST", "/api/v2/tasks"), "blocked");
  assert.throws(() => guard.assertReadRequests(), {
    code: "read_request_unreviewed",
  });
  await assert.rejects(
    () =>
      guard.runMutation(async () => {
        throw Error("Fixture failure");
      }),
    /Fixture failure/,
  );
  assert.equal(await request(guard, "DELETE", "/api/v2/tasks/42"), "blocked");
  assert.throws(() => guard.assertReadRequests(), {
    code: "read_request_unreviewed",
  });
});

test("external analytics POST is blocked without poisoning a later CMS read", async () => {
  const guard = new ReadRequestGuard();
  assert.equal(
    await request(
      guard,
      "POST",
      "/g/collect?secret=value",
      "https://analytics.invalid",
    ),
    "blocked",
  );
  assert.doesNotThrow(() => guard.assertReadRequests());
  assert.equal(
    await request(guard, "POST", "/api/internal/auth-cookie-sessions/42"),
    "blocked",
  );
  await assert.rejects(
    () =>
      guard.runMutation(async () =>
        assert.fail("Must reject stale unreviewed activity first"),
      ),
    { code: "read_request_unreviewed" },
  );
  assert.doesNotThrow(() => guard.assertReadRequests());
});
