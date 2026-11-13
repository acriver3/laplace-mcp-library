import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { CmsBrowser, DEFAULT_CDP_URL } from "../dist/browser.js";
import { CMS_ORIGIN } from "../dist/types.js";

async function fixture(t, interactiveLogin) {
  const dir = await mkdtemp(join(tmpdir(), "cms-tether-mode-")),
    routes = [];
  let closed = false,
    connections = 0;
  t.mock.method(chromium, "launch", () => {
    throw new Error("Production must not launch Chrome");
  });
  t.mock.method(chromium, "launchPersistentContext", () => {
    throw new Error("Production must not launch Chrome");
  });
  const page = {
    isClosed: () => closed,
    on: () => {},
    route: async (pattern, handler) => {
      routes.push({ pattern, handler });
    },
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    addInitScript: async () => {},
    exposeBinding: async () => {},
    routeWebSocket: async () => {},
  };
  class StubTether extends CmsBrowser {
    async connectOwnedPage() {
      connections++;
      return {
        page,
        close: async () => {
          closed = true;
        },
      };
    }
  }
  const browser = new StubTether(
    join(dir, "state"),
    DEFAULT_CDP_URL,
    interactiveLogin,
    join(dir, "downloads"),
  );
  t.after(async () => {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { browser, routes, isClosed: () => closed, connections: () => connections };
}
async function request(handler, method, path) {
  let outcome;
  await handler({
    request: () => ({ method: () => method, url: () => CMS_ORIGIN + path }),
    fallback: async () => {
      outcome = "allowed";
    },
    abort: async () => {
      outcome = "blocked";
    },
  });
  return outcome;
}
test("normal tethered operations guard the owned page and never launch Chrome", async (t) => {
  const f = await fixture(t, false);
  await f.browser.page();
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0].pattern, "**/*");
  assert.equal(await request(f.routes[0].handler, "GET", "/dashboard/"), "allowed");
  assert.equal(await request(f.routes[0].handler, "POST", "/api/v2/tasks"), "blocked");
  assert.throws(() => f.browser.assertReadRequests(), { code: "read_request_unreviewed" });
  await assert.rejects(() => f.browser.login(), { code: "interactive_login_required" });
  assert.equal(f.isClosed(), false);
  await f.browser.page();
  assert.equal(f.connections(), 1, "reuses its own visible tab");
});
test("only explicit manual login omits the owned-page student-write guard", async (t) => {
  const f = await fixture(t, true);
  await f.browser.page();
  assert.equal(f.routes.length, 0);
  await assert.rejects(() => f.browser.login(0), { code: "invalid_timeout" });
});
