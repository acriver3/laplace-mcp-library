import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  ProfileLock,
  DEFAULT_CDP_URL,
  DEFAULT_STATE,
  DEFAULT_PROFILE,
  DEFAULT_DOWNLOADS,
} from "../dist/browser.js";
import {
  createCliRuntime,
  parseCliArgs,
  runCli,
  VERSION,
} from "../dist/cli.js";
import { CmsService } from "../dist/core.js";
import { CmsError } from "../dist/types.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cms-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, "profile"),
    downloads = join(dir, "downloads"),
    calls = [],
    out = [],
    err = [];
  let lockHeld = false;
  const adapter = {
    async identity() {
      calls.push("identity");
      assert.equal(lockHeld, true);
      return { key: "secret", name: "Fixture Student", account_id: "42" };
    },
    async prepare(change) {
      return { identity: "secret", preview: { fields: change.fields } };
    },
    async submit() {
      throw new Error("simulated lost response");
    },
    async close() {
      calls.push("close");
      lockHeld = false;
    },
  };
  const browser = {
    profile,
    lock: {
      async acquire() {
        calls.push("acquire");
        lockHeld = true;
      },
      async releaseStale() {
        calls.push("release-stale");
      },
    },
    async login(timeout) {
      calls.push(["login", timeout]);
      return { key: "secret", name: "Fixture Student", account_id: "42" };
    },
  };
  const dependencies = {
    createRuntime(config) {
      calls.push(["runtime", config]);
      return { browser, adapter };
    },
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  };
  const args = ["--state-dir", profile, "--downloads-dir", downloads];
  return {
    dir,
    profile,
    downloads,
    calls,
    out,
    err,
    adapter,
    browser,
    dependencies,
    args,
  };
}
test("CLI defaults tether to local Chrome and keep connector state separate from downloads", () => {
  const c = parseCliArgs([]);
  assert.equal(c.command, "serve");
  assert.equal(c.cdpUrl, DEFAULT_CDP_URL);
  assert.equal(c.stateDir, DEFAULT_STATE);
  assert.equal(DEFAULT_PROFILE, DEFAULT_STATE);
  assert.equal(c.downloadsDir, DEFAULT_DOWNLOADS);
  assert.equal(c.loginTimeoutMs, 1800000);
});
test("CLI help and version do not construct or authenticate a browser", async (t) => {
  const f = await fixture(t);
  assert.equal(await runCli(["--help"], f.dependencies), 0);
  assert.equal(await runCli(["--version"], f.dependencies), 0);
  assert.deepEqual(f.calls, []);
  assert.match(f.out[0], /Attach to visible Chrome/);
  assert.match(f.out[0], /closes only the connector.s CMS tab/);
  assert.match(f.out[0], /does not launch\nChrome or copy cookies/);
  assert.doesNotMatch(f.out[0], /headless|background-browser/);
  assert.equal(f.out[1], VERSION);
});
test("CLI rejects unsupported browsers, launch flags, relative folders, and unsafe recovery options", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["other"],
    ["serve", "extra"],
    ["serve", "--browser", "firefox"],
    ["serve", "--browser", "msedge"],
    ["serve", "--state-dir", "relative"],
    ["serve", "--state-dir", f.profile, "--profile-dir", f.profile],
    ["serve", "--headless"],
    ["serve", "--headed"],
    ["serve", "--cdp", "9222"],
    ["serve", "--profile-dir", "relative"],
    ["serve", "--downloads-dir", "relative"],
    [
      "serve",
      "--profile-dir",
      f.profile,
      "--downloads-dir",
      join(f.profile, "downloads"),
    ],
    ["serve", "--acknowledge-uncertain", "--note", "I inspected CMS"],
    ["login", "--release-stale-lock"],
    ["status", "--note", "I inspected CMS"],
    ["status", "--acknowledge-uncertain"],
    ["status", "--acknowledge-uncertain", "--note", "ok"],
    ["status", "--login-timeout", "10"],
    ["login", "--login-timeout", "NaN"],
    ["login", "--login-timeout", "0"],
    ["login", "--login-timeout", "3601"],
    ["login", "--login-timeout", "1.5"],
  ]) {
    assert.throws(
      () => parseCliArgs(args),
      (e) => e.code === "invalid_arguments",
      JSON.stringify(args),
    );
  }
});
test("manual login passes only the bounded timeout and prints sanitized identity", async (t) => {
  const f = await fixture(t),
    before = process.listenerCount("SIGINT");
  const code = await runCli(
    [
      "login",
      ...f.args,
      "--browser",
      "chrome",
      "--cdp-url",
      "ws://localhost:9223/devtools/browser/example-id",
      "--login-timeout",
      "60",
    ],
    f.dependencies,
  );
  assert.equal(code, 0);
  assert.deepEqual(
    f.calls.find((x) => Array.isArray(x) && x[0] === "login"),
    ["login", 60000],
  );
  const configuration = f.calls.find(
    (x) => Array.isArray(x) && x[0] === "runtime",
  )[1];
  assert.equal(configuration.command, "login");
  assert.equal(
    configuration.cdpUrl,
    "ws://localhost:9223/devtools/browser/example-id",
  );
  assert.equal(configuration.stateDir, f.profile);
  assert.equal(Object.hasOwn(configuration, "browser"), false);
  assert.match(f.err[0], /existing visible Chrome/);
  assert.equal(JSON.parse(f.out[0]).account, "Fixture Student");
  assert.equal(f.out[0].includes("secret"), false);
  assert.equal(process.listenerCount("SIGINT"), before);
});
test("status acquires the connector state lock before reading account and recovery state", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await runCli(["status", ...f.args, "--release-stale-lock"], f.dependencies),
    0,
  );
  assert.ok(f.calls.indexOf("release-stale") < f.calls.indexOf("acquire"));
  assert.ok(f.calls.indexOf("acquire") < f.calls.indexOf("identity"));
  const status = JSON.parse(f.out[0]);
  assert.equal(status.authenticated, true);
  assert.equal(status.recovery.blocked, false);
  assert.ok(f.calls.includes("close"));
});
test("explicit status acknowledgment records the inspected outcome without replay", async (t) => {
  const f = await fixture(t),
    service = new CmsService(f.adapter, { profileDir: f.profile });
  const p = await service.prepare({
    operation: "task_create",
    area: "tasks",
    fields: { subject: "Fixture" },
  });
  await assert.rejects(() => service.commit(p.draft_id, true), {
    code: "submission_uncertain",
  });
  let submits = 0;
  f.adapter.submit = async () => {
    submits++;
    throw new Error("must not retry");
  };
  assert.equal(
    await runCli(
      [
        "status",
        ...f.args,
        "--acknowledge-uncertain",
        "--note",
        "Inspected CMS: the task exists.",
      ],
      f.dependencies,
    ),
    0,
  );
  const status = JSON.parse(f.out[0]);
  assert.equal(status.acknowledgement.acknowledged, true);
  assert.equal(status.acknowledgement.replayed, false);
  assert.equal(status.recovery.blocked, false);
  assert.equal(submits, 0);
  const journal = JSON.parse(
    await readFile(f.profile + ".cms-journal.json", "utf8"),
  );
  assert.equal(journal.status, "acknowledged");
  assert.equal(journal.acknowledgement, "Inspected CMS: the task exists.");
});
test("failed authentication cannot erase or acknowledge an uncertain receipt", async (t) => {
  const f = await fixture(t),
    service = new CmsService(f.adapter, { profileDir: f.profile });
  const p = await service.prepare({ operation: "task_create", area: "tasks" });
  await assert.rejects(() => service.commit(p.draft_id, true), {
    code: "submission_uncertain",
  });
  f.adapter.identity = async () => {
    throw new CmsError("auth_required", "Sign in again.");
  };
  const code = await runCli(
    [
      "status",
      ...f.args,
      "--acknowledge-uncertain",
      "--note",
      "Inspected CMS in my account.",
    ],
    f.dependencies,
  );
  assert.equal(code, 1);
  assert.equal(f.out.length, 0);
  assert.equal(JSON.parse(f.err[0]).code, "auth_required");
  assert.equal(
    JSON.parse(await readFile(f.profile + ".cms-journal.json", "utf8")).status,
    "uncertain",
  );
});
test("status recovery cannot release a live owner's lock", async (t) => {
  const f = await fixture(t),
    owner = new ProfileLock(f.profile);
  await owner.acquire();
  t.after(() => owner.release());
  f.browser.lock = new ProfileLock(f.profile);
  const code = await runCli(
    ["status", ...f.args, "--release-stale-lock"],
    f.dependencies,
  );
  assert.equal(code, 1);
  assert.equal(f.out.length, 0);
  assert.equal(JSON.parse(f.err[0]).code, "profile_busy");
  assert.equal(f.calls.includes("identity"), false);
});
test("invalid command exits nonzero with structured stderr and clean stdout", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "serve", "--browser", "unsupported"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).code, "invalid_arguments");
});
test("the actual CLI serves stdio discovery without attaching to Chrome and exits on input close", async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: "cli-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("dist/cli.js"),
      "serve",
      ...f.args,
      "--cdp-url",
      "ws://127.0.0.1:1/devtools/browser",
    ],
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === "cms_session_status"));
  assert.ok(tools.some((x) => x.name === "cms_get_dashboard"));
  await client.close();
});
test("manifest identity and setup arguments match CLI and keep downloads separate", async () => {
  const manifest = JSON.parse(await readFile(resolve("manifest.json"), "utf8"));
  assert.equal(manifest.name, "yale-som-cms-mcp");
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.display_name, "Yale SOM CMS [Tethered]");
  assert.deepEqual(manifest.compatibility.platforms, ["win32"]);
  assert.deepEqual(manifest._meta["com.withlaplace.catalog"].platforms, [
    "win32-x64",
  ]);
  const args = manifest.server.mcp_config.args;
  assert.ok(args.includes("--state-dir"));
  assert.ok(args.includes("--cdp-url"));
  assert.ok(!args.includes("--profile-dir"));
  assert.ok(!args.includes("--browser"));
  assert.ok(args.includes("--downloads-dir"));
  assert.equal(manifest.user_config.cdp_url.default, DEFAULT_CDP_URL);
  assert.ok(!JSON.stringify(manifest).includes("yale-som-ems"));
});

test("bounded status closes only its owned tab and explains challenge recovery without claiming expiry", async (t) => {
  const f = await fixture(t);
  f.adapter.identity = async () => {
    throw new CmsError(
      "browser_challenge",
      "The saved login may still be valid.",
      { provider: "cloudflare", saved_login_status: "unknown" },
    );
  };
  assert.equal(await runCli(["status", ...f.args], f.dependencies), 1);
  assert.equal(f.out.length, 0);
  assert.equal(f.err.length, 1);
  const result = JSON.parse(f.err[0]);
  assert.equal(result.code, "browser_challenge");
  assert.equal(result.details.saved_login_status, "unknown");
  assert.match(result.message, /saved login may still be valid/);
  assert.match(result.message, /closes only its CMS tab/);
  assert.match(result.message, /Chrome and your other tabs remain open/);
  assert.match(result.message, /Run login to complete checks manually/);
  assert.ok(f.calls.includes("close"));
});

test("deprecated profile-dir names connector state only and chrome compatibility does not select a launch channel", async (t) => {
  const f = await fixture(t);
  const c = parseCliArgs([
    "status",
    "--profile-dir",
    f.profile,
    "--browser",
    "chrome",
    "--downloads-dir",
    f.downloads,
  ]);
  assert.equal(c.stateDir, f.profile);
  assert.equal(c.cdpUrl, DEFAULT_CDP_URL);
  assert.equal(Object.hasOwn(c, "profileDir"), false);
  assert.equal(Object.hasOwn(c, "browser"), false);
});

test("CLI accepts only explicit-port loopback Chrome browser WebSocket endpoints", () => {
  for (const endpoint of [
    "ws://127.0.0.1:9222/devtools/browser",
    "ws://localhost:80/devtools/browser",
    "ws://localhost:9223/devtools/browser/example-id_123",
    "ws://[::1]:65535/devtools/browser/123-456",
  ]) {
    assert.equal(parseCliArgs(["--cdp-url", endpoint]).cdpUrl, endpoint);
  }
  for (const endpoint of [
    "ws://example.com:9222/devtools/browser",
    "ws://localhost.example.com:9222/devtools/browser",
    "ws://127.0.0.2:9222/devtools/browser",
    "ws://2130706433:9222/devtools/browser",
    "ws://0x7f000001:9222/devtools/browser",
    "ws://127.1:9222/devtools/browser",
    "ws://0177.0.0.1:9222/devtools/browser",
    "ws://[::ffff:127.0.0.1]:9222/devtools/browser",
    "ws://localhost/devtools/browser",
    "ws://localhost:0/devtools/browser",
    "ws://localhost:65536/devtools/browser",
    "ws://localhost.:9222/devtools/browser",
    "ws://user:secret@localhost:9222/devtools/browser",
    "ws://localhost:9222/devtools/browser?",
    "ws://localhost:9222/devtools/browser?token=secret",
    "ws://localhost:9222/devtools/browser#",
    "ws://localhost:9222/devtools/browser#secret",
    "ws://localhost:9222/devtools/browser/",
    "ws://localhost:9222/devtools/browser/../browser",
    "ws://localhost:9222/devtools/browser/%69d",
    "ws://localhost:9222/devtools/page/id",
    "wss://localhost:9222/devtools/browser",
    "http://localhost:9222/devtools/browser",
    " ws://localhost:9222/devtools/browser",
    "ws://localhost:9222/devtools/browser\n",
  ]) {
    assert.throws(
      () => parseCliArgs(["--cdp-url", endpoint]),
      (e) => e.code === "invalid_arguments" && !e.message.includes("secret"),
      endpoint,
    );
  }
});

test("runtime wires state, endpoint and login permission without connecting or launching Chrome", async (t) => {
  const f = await fixture(t);
  for (const command of ["login", "status", "serve"]) {
    const c = parseCliArgs([
      command,
      ...f.args,
      "--cdp-url",
      "ws://127.0.0.1:1/devtools/browser",
    ]);
    const runtime = createCliRuntime(c);
    assert.equal(runtime.browser.stateDir, f.profile);
    assert.equal(runtime.browser.profile, f.profile);
    assert.equal(runtime.browser.cdpUrl, c.cdpUrl);
    assert.equal(runtime.browser.interactiveLogin, command === "login");
    assert.equal(runtime.browser.downloadsDir, f.downloads);
    await runtime.adapter.close();
  }
});
