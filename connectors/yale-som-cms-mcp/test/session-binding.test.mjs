import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionBinding } from "../dist/session-binding.js";
import { CMS_ORIGIN } from "../dist/types.js";
import { CmsMutations } from "../dist/mutations.js";

const auth = (value) => ({
  name: ".ASPXAUTH.Shared",
  value,
  domain: "som-yale.12twenty.com",
  path: "/",
  httpOnly: true,
  secure: true,
});
function fixture() {
  let cookies = [auth("fixture-account-A")];
  const binding = new SessionBinding(async () => ({
    context: () => ({
      cookies: async (url) => {
        assert.equal(url, CMS_ORIGIN);
        return cookies;
      },
    }),
  }));
  const request = (value = "fixture-account-A") => ({
    url: () => CMS_ORIGIN + "/api/v2/tasks",
    headerValue: async (name) => {
      assert.equal(name, "cookie");
      return ".ASPXAUTH.Shared=" + value + "; telemetry=volatile";
    },
  });
  return {
    binding,
    request,
    setCookies: (next) => {
      cookies = next;
    },
  };
}

test("identity binds the observed auth session and ignores unrelated telemetry rotations", async () => {
  const f = fixture();
  const first = await f.binding.identityKey("account-A");
  assert.doesNotMatch(first, /fixture-account/);
  f.setCookies([
    auth("fixture-account-A"),
    { name: "ai_session", value: "changed" },
  ]);
  assert.equal(await f.binding.identityKey("account-A"), first);
  f.setCookies([auth("fixture-account-B")]);
  assert.notEqual(await f.binding.identityKey("account-A"), first);
});

test("session changed after identity capture prevents entering the confirmed mutation lease", async () => {
  const f = fixture();
  await f.binding.identityKey("account-A");
  f.setCookies([auth("fixture-account-B")]);
  await assert.rejects(() => f.binding.begin(), { code: "account_changed" });
});

test("a changed actual request cookie or a later jar change is rejected before continuation", async () => {
  const f = fixture();
  await f.binding.identityKey("account-A");
  await f.binding.begin();
  await f.binding.assertRequest(f.request());
  await assert.rejects(
    () => f.binding.assertRequest(f.request("fixture-account-B")),
    { code: "account_changed" },
  );
  f.setCookies([auth("fixture-account-B")]);
  await assert.rejects(() => f.binding.assertRequest(f.request()), {
    code: "account_changed",
  });
  f.binding.end();
  await assert.rejects(() => f.binding.assertRequest(f.request()), {
    code: "session_binding_unavailable",
  });
});

test("unknown or ambiguous authentication layouts fail closed without exposing values", async () => {
  const f = fixture();
  for (const cookies of [
    [],
    [auth("")],
    [auth("secret-A"), auth("secret-B")],
    [{ ...auth("secret"), path: "/private" }],
    [{ ...auth("secret"), domain: "evil.example" }],
    [{ ...auth("secret"), httpOnly: false }],
    [{ ...auth("secret"), secure: false }],
  ]) {
    f.setCookies(cookies);
    await assert.rejects(
      () => f.binding.identityKey("account"),
      (e) =>
        e.code === "session_binding_unavailable" &&
        !JSON.stringify(e).includes("secret"),
    );
  }
});

test("missing or duplicate Cookie headers cannot authorize a write and clear forgets the lease", async () => {
  const f = fixture();
  await f.binding.identityKey("account-A");
  await f.binding.begin();
  for (const value of [
    null,
    "unrelated=secret",
    ".ASPXAUTH.Shared=secret; .ASPXAUTH.Shared=other",
  ]) {
    await assert.rejects(
      () =>
        f.binding.assertRequest({
          url: () => CMS_ORIGIN + "/api/v2/tasks",
          headerValue: async () => value,
        }),
      { code: "session_binding_unavailable" },
    );
  }
  f.binding.clear();
  await assert.rejects(() => f.binding.begin(), {
    code: "session_binding_unavailable",
  });
});

test("mutation previews capture the account after the fresh form navigation", async () => {
  let account = "stale-account";
  const calls = [];
  const mutations = new CmsMutations(
    {
      async identity() {
        calls.push("identity");
        return { key: account, name: account, account_id: account };
      },
    },
    {},
  );
  mutations.open = async (change) => {
    calls.push("open");
    account = "fresh-account";
    return {
      form: {
        operation: change.operation,
        area: change.area,
        supported: true,
        url: CMS_ORIGIN + "/tasks",
        fields: [],
        actions: [change.operation],
        context: {},
      },
    };
  };
  const prepared = await mutations.prepare({
    operation: "task_create",
    area: "tasks",
    fields: {},
    files: [],
  });
  assert.deepEqual(calls, ["open", "identity"]);
  assert.equal(prepared.identity, "fresh-account");
  assert.equal(prepared.preview.account_id, "fresh-account");
});
