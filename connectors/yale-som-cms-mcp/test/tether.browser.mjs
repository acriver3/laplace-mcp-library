import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "playwright-core";
import WebSocket, { WebSocketServer } from "ws";

import { CmsBrowser } from "../dist/browser.js";
import { OwnedTargetGateway, connectOwnedPage, validateCdpUrl } from "../dist/tether.js";
import { CMS_ORIGIN } from "../dist/types.js";
import { fixtureChrome, rpcClient } from "./fixtures/chrome-cdp.mjs";

test("owned-target gateway attaches one new tab without modifying or closing existing tabs", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const existing = await control.send("Target.createTarget", {
    url: "data:text/html,<title>Existing fixture</title><main>Untouched</main>",
  });
  const original = await control.send("Target.getTargets");
  const connection = await connectOwnedPage(endpoint);
  t.after(() => connection.close());
  const page = connection.page;
  assert.equal(page.url(), "about:blank");
  assert.equal(page.context().pages().length, 1);
  await page.setContent(
    "<main><label>Name<input></label><button onclick=\"document.querySelector('main').dataset.saved='yes'\">Save</button></main>",
  );
  await page.getByLabel("Name").fill("Sanitized fixture");
  await page.getByRole("button", { name: "Save" }).click();
  assert.equal(await page.locator("main").getAttribute("data-saved"), "yes");
  const all = await control.send("Target.getTargets");
  assert.equal(
    all.targetInfos.filter((x) => x.type === "page").length,
    original.targetInfos.filter((x) => x.type === "page").length + 1,
  );
  await connection.close();
  const remaining = await control.send("Target.getTargets");
  assert.deepEqual(
    remaining.targetInfos
      .filter((x) => x.type === "page")
      .map((x) => x.targetId)
      .sort(),
    original.targetInfos
      .filter((x) => x.type === "page")
      .map((x) => x.targetId)
      .sort(),
  );
  const unchanged = await control.send("Target.getTargetInfo", { targetId: existing.targetId });
  assert.equal(unchanged.targetInfo.title, "Existing fixture");
  assert.ok((await control.send("Browser.getVersion")).product.startsWith("Chrome/"));
});
test("gateway filters discovery, cookies and session ownership and denies browser-wide mutations", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const existing = (await control.send("Target.getTargets")).targetInfos.find(
    (x) => x.type === "page",
  );
  const { sessionId: existingSession } = await control.send("Target.attachToTarget", {
    targetId: existing.targetId,
    flatten: true,
  });
  await control.send(
    "Network.setCookie",
    { name: "cms_fixture", value: "owned", url: CMS_ORIGIN },
    existingSession,
  );
  await control.send(
    "Network.setCookie",
    { name: "unrelated_fixture", value: "private", url: "https://unrelated.example" },
    existingSession,
  );
  const gateway = await OwnedTargetGateway.open(endpoint);
  t.after(() => gateway.close());
  const client = await rpcClient(gateway.endpointURL);
  t.after(() => client.close());
  const discovered = await client.send("Target.getTargets");
  assert.equal(discovered.targetInfos.length, 1);
  assert.equal(discovered.targetInfos[0].targetId, gateway.targetId);
  await client.send("Target.setAutoAttach", {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: true,
  });
  const attached = client.events.find((event) => event.method === "Target.attachedToTarget");
  assert.ok(attached);
  const session = attached.params.sessionId;
  assert.deepEqual((await client.send("Storage.getCookies")).cookies.map((x) => x.name).sort(), [
    ".ASPXAUTH.Shared",
    "cms_fixture",
  ]);
  for (const [method, params, sessionId] of [
    ["Browser.close", {}],
    ["Target.closeTarget", { targetId: existing.targetId }],
    ["Target.attachToTarget", { targetId: existing.targetId, flatten: true }],
    ["Target.createTarget", { url: "https://unrelated.example" }],
    ["Target.createBrowserContext", {}],
    ["Target.disposeBrowserContext", { browserContextId: "default" }],
    ["Storage.clearCookies", {}],
    ["Storage.setCookies", { cookies: [] }],
    ["Browser.grantPermissions", { permissions: ["clipboardReadWrite"] }],
    ["Network.clearBrowserCookies", {}, session],
    ["Network.clearBrowserCache", {}, session],
    ["Network.setCookie", { name: "bad", value: "bad", url: CMS_ORIGIN }, session],
    ["Network.getCookies", { urls: ["https://unrelated.example"] }, session],
    ["Runtime.evaluate", { expression: "1" }, "unowned-session"],
    ["Browser.close", {}, session],
    ["Target.closeTarget", { targetId: existing.targetId }, session],
    ["Network.setUserAgentOverride", { userAgent: "changed" }, session],
  ])
    await assert.rejects(
      () => client.send(method, params, sessionId),
      /outside the owned CMS tab scope/,
    );
  assert.deepEqual(await client.send("Browser.setDownloadBehavior", { behavior: "deny" }), {});
  await client.close();
  await gateway.close();
  assert.ok(
    (await control.send("Target.getTargetInfo", { targetId: existing.targetId })).targetInfo,
  );
});
test("CDP endpoints require exact explicit loopback WebSocket authority and preserve port 80", () => {
  for (const endpoint of [
    "ws://127.0.0.1:9222/devtools/browser",
    "ws://localhost:80/devtools/browser/fixture-A_9",
    "ws://[::1]:9222/devtools/browser",
  ])
    assert.equal(validateCdpUrl(endpoint), endpoint);
  for (const endpoint of [
    "ws://127.0.0.1:9222/devtools/browser\n",
    "http://127.0.0.1:9222",
    "wss://127.0.0.1:9222/devtools/browser",
    "ws://127.1:9222/devtools/browser",
    "ws://2130706433:9222/devtools/browser",
    "ws://0x7f000001:9222/devtools/browser",
    "ws://localhost.evil:9222/devtools/browser",
    "ws://localhost/devtools/browser",
    "ws://localhost:0/devtools/browser",
    "ws://localhost:65536/devtools/browser",
    "ws://user@localhost:9222/devtools/browser",
    "ws://localhost:9222/devtools/browser?token=secret",
    "ws://localhost:9222/devtools/browser#fragment",
    "ws://localhost:9222/devtools/browser/../../private",
    "ws://localhost:9222/devtools/browser/%2e",
  ])
    assert.throws(() => validateCdpUrl(endpoint), { code: "invalid_cdp_url" });
});

test("production tether guards its page and dedicated-worker writes before navigation", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const original = await control.send("Target.getTargets");
  const dir = await mkdtemp(join(tmpdir(), "cms-real-tether-"));
  const cms = new CmsBrowser(join(dir, "state"), endpoint);
  t.after(async () => {
    await cms.close();
    await rm(dir, { recursive: true, force: true });
  });
  const page = await cms.page();
  let writes = 0;
  await page.context().route("**/*", (route) => {
    const request = route.request();
    assert.equal(new URL(request.url()).origin, CMS_ORIGIN);
    if (request.method() === "POST") {
      writes++;
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<body class="logged-in-user"><a href="/students/profile">Profile</a><script>window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}}</script></body>',
    });
  });
  await page.goto(CMS_ORIGIN + "/dashboard/");
  assert.equal((await cms.identity()).account_id, "1234567");
  await page.evaluate(() => fetch("/api/v2/unreviewed-write", { method: "POST" }).catch(() => {}));
  assert.equal(writes, 0);
  assert.throws(() => cms.assertReadRequests(), { code: "read_request_unreviewed" });
  await page.evaluate(
    (origin) =>
      new Promise((resolve) => {
        const worker = new Worker(
          URL.createObjectURL(
            new Blob(
              [
                'fetch("' +
                  origin +
                  '/api/v2/worker-write",{method:"POST"}).catch(()=>{}).finally(()=>postMessage("done"));',
              ],
              { type: "text/javascript" },
            ),
          ),
        );
        worker.onmessage = () => {
          worker.terminate();
          resolve();
        };
      }),
    CMS_ORIGIN,
  );
  assert.equal(writes, 0);
  assert.throws(() => cms.assertReadRequests(), { code: "read_request_unreviewed" });
  await cms.runMutation(() =>
    page.evaluate(() => fetch("/api/v2/confirmed-fixture", { method: "POST" })),
  );
  assert.equal(writes, 1);
  await cms.close();
  const remaining = await control.send("Target.getTargets");
  assert.deepEqual(
    remaining.targetInfos
      .filter((x) => x.type === "page")
      .map((x) => x.targetId)
      .sort(),
    original.targetInfos
      .filter((x) => x.type === "page")
      .map((x) => x.targetId)
      .sort(),
  );
});

test("private gateway rejects browser-origin and wrong-token clients without changing Chrome", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const gateway = await OwnedTargetGateway.open(endpoint);
  t.after(() => gateway.close());
  for (const [url, options] of [
    [gateway.endpointURL.replace(/[^/]+$/, "wrong-token"), {}],
    [gateway.endpointURL, { origin: "https://unrelated.example" }],
  ]) {
    const client = new WebSocket(url, options);
    client.on("error", () => {});
    await assert.rejects(() => once(client, "open"));
    client.terminate();
  }
  assert.ok((await control.send("Browser.getVersion")).product);
  const client = await rpcClient(gateway.endpointURL);
  t.after(() => client.close());
  assert.equal((await client.send("Target.getTargets")).targetInfos.length, 1);
});

test("guarded owned tabs block shared transports while optional external telemetry does not fail reads", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const original = (await control.send("Target.getTargets")).targetInfos.find(
    (x) => x.type === "page",
  );
  const { sessionId: originalSession } = await control.send("Target.attachToTarget", {
    targetId: original.targetId,
    flatten: true,
  });
  const dir = await mkdtemp(join(tmpdir(), "cms-transport-guard-"));
  const cms = new CmsBrowser(join(dir, "state"), endpoint);
  t.after(async () => {
    await cms.close();
    await rm(dir, { recursive: true, force: true });
  });
  const page = await cms.page();
  const requests = [];
  await page.context().route("**/*", (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body: '<body class="logged-in-user"><a href="/students/profile">Profile</a><script>window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}}</script></body>',
    });
  });
  await page.goto(CMS_ORIGIN + "/dashboard/");
  await page.evaluate(() => {
    globalThis.fixtureSocket = new WebSocket("wss://optional-notifications.example/socket");
  });
  await page.waitForFunction(
    () => globalThis.fixtureSocket.readyState === WebSocket.CLOSED,
    undefined,
    { timeout: 3000 },
  );
  assert.doesNotThrow(() => cms.assertSupportedTransports());
  assert.equal((await cms.identity()).account_id, "1234567");
  const failed = await page.evaluate(async () => {
    const rejected = [];
    for (const [name, run] of [
      ["SharedWorker", () => new SharedWorker("/shared-worker.js")],
      ["WebTransport", () => new WebTransport("https://som-yale.12twenty.com/transport")],
      ["ServiceWorker", () => navigator.serviceWorker.register("/service-worker.js")],
    ]) {
      try {
        await run();
      } catch {
        rejected.push(name);
      }
    }
    await new Promise((resolve) => {
      const socket = new WebSocket("wss://som-yale.12twenty.com/unreviewed-channel");
      socket.onclose = () => resolve();
    });
    return rejected;
  });
  assert.deepEqual(failed, ["SharedWorker", "WebTransport", "ServiceWorker"]);
  assert.equal(
    requests.some((url) => /worker\.js|transport|unreviewed-channel/.test(url)),
    false,
  );
  assert.throws(
    () => cms.assertSupportedTransports(),
    (error) => {
      assert.equal(error.code, "unsupported_transport");
      assert.deepEqual(error.details.transports, [
        "ServiceWorker",
        "SharedWorker",
        "WebSocket",
        "WebTransport",
      ]);
      return true;
    },
  );
  // Successful HTTP-backed identity is still usable even when a page optionally
  // tried a blocked channel. Its existing user tabs retain native APIs.
  assert.equal((await cms.identity()).account_id, "1234567");
  const native = await control.send(
    "Runtime.evaluate",
    { expression: "SharedWorker.toString().includes('[native code]')", returnByValue: true },
    originalSession,
  );
  assert.equal(native.result.value, true);
});

test("changing Chrome sign-in after a request pauses aborts it before the provider and preserves other tabs", async (t) => {
  const { control, endpoint } = await fixtureChrome(t);
  const original = (await control.send("Target.getTargets")).targetInfos.find(
    (x) => x.type === "page",
  );
  const { sessionId } = await control.send("Target.attachToTarget", {
    targetId: original.targetId,
    flatten: true,
  });
  const dir = await mkdtemp(join(tmpdir(), "cms-request-race-"));
  const cms = new CmsBrowser(join(dir, "state"), endpoint);
  t.after(async () => {
    await cms.close();
    await rm(dir, { recursive: true, force: true });
  });
  const page = await cms.page();
  let providerWrites = 0;
  await page.context().route("**/*", (route) => {
    if (route.request().method() === "POST") providerWrites++;
    return route.fulfill({
      contentType: "text/html",
      body: '<body class="logged-in-user"><a href="/students/profile">Profile</a><script>window.TT={CurrentSession:{CurrentUser:{Id:1234567,TypeId:2}}}</script></body>',
    });
  });
  await page.goto(CMS_ORIGIN + "/dashboard/");
  const prepared = await cms.identity();
  await page.route("**/api/v2/paused-fixture", async (route) => {
    // The request already carries the old cookie at this interception point.
    // Another user-owned tab changes the browser session before our guard runs.
    await control.send(
      "Network.setCookie",
      {
        name: ".ASPXAUTH.Shared",
        value: "different-fixture-session",
        url: CMS_ORIGIN + "/",
        httpOnly: true,
        secure: true,
      },
      sessionId,
    );
    await route.fallback();
  });
  await assert.rejects(
    () =>
      cms.runMutation(() =>
        page.evaluate(() => fetch("/api/v2/paused-fixture", { method: "POST" }).catch(() => {})),
      ),
    { code: "account_changed" },
  );
  assert.equal(providerWrites, 0);
  const next = await cms.identity();
  assert.notEqual(
    prepared.key,
    next.key,
    "same stale DOM account cannot reuse an approved sign-in binding",
  );
  assert.equal(
    (await control.send("Target.getTargetInfo", { targetId: original.targetId })).targetInfo
      .targetId,
    original.targetId,
  );
});

test(
  "worker channel guard prevents local WebSocket connections before startup; manual login remains unrestricted",
  { timeout: 15000 },
  async (t) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<main>Offline worker fixture</main>");
    });
    const sockets = new WebSocketServer({ server });
    let connections = 0;
    sockets.on("connection", (socket) => {
      connections++;
      socket.on("message", () => socket.send("ack"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const port = server.address().port,
      url = "http://127.0.0.1:" + port,
      websocket = "ws://127.0.0.1:" + port;
    const { endpoint } = await fixtureChrome(t);
    const dir = await mkdtemp(join(tmpdir(), "cms-worker-channels-"));
    const manual = new CmsBrowser(join(dir, "manual"), endpoint, true),
      guarded = new CmsBrowser(join(dir, "guarded"), endpoint);
    t.after(async () => {
      await manual.close();
      await guarded.close();
      await rm(dir, { recursive: true, force: true });
    });
    const manualPage = await manual.page();
    await manualPage.goto(url);
    await manualPage.evaluate(
      (endpoint) =>
        new Promise((resolve) => {
          const code =
            "const s=new WebSocket(" +
            JSON.stringify(endpoint) +
            ');s.onopen=()=>s.send("probe");s.onmessage=()=>{s.close();postMessage("connected");};';
          const worker = new Worker(
            URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
          );
          worker.onmessage = () => {
            worker.terminate();
            resolve();
          };
        }),
      websocket,
    );
    assert.equal(connections, 1, "positive control proves the local worker endpoint is reachable");
    const page = await guarded.page();
    await page.goto(url);
    const blocked = await page.evaluate(
      (endpoint) =>
        new Promise((resolve) => {
          const code =
            'const blocked=[];for(const [name,run] of [["WebSocket",()=>new WebSocket(' +
            JSON.stringify(endpoint) +
            ')],["WebTransport",()=>new WebTransport("https://127.0.0.1:1/fixture")]]){try{run();}catch{blocked.push(name);}}postMessage(blocked);';
          const worker = new Worker(
            URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
          );
          worker.onmessage = (event) => {
            worker.terminate();
            resolve(event.data);
          };
        }),
      websocket,
    );
    assert.deepEqual(blocked, ["WebSocket", "WebTransport"]);
    assert.equal(connections, 1, "guarded worker never opened a network connection");
  },
);
