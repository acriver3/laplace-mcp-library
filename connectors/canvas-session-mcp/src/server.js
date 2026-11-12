import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { baseUrl, readConfig, writeConfig } from './config.js';
import { renewSession, savedSession } from './browser.js';
import { CanvasClient } from './canvas.js';
import { registerTools } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json');

// The browser is only started to get (or refresh) the session cookie; API calls then go
// straight from Node. One refresh at a time even if the model calls several tools at once.
// Saved cookies are tried first (no browser at all); the browser only opens when Canvas rejects them.
const renewWithConfig = (base) => renewSession(base, {
  loginPath: readConfig().loginPath,
  onLoginPath: (p) => writeConfig({ loginPath: p }),
  expectedId: readConfig().sessionOrigin === base ? readConfig().sessionUserId : undefined,
  log: (m) => process.stderr.write(m + '\n'),
});

export function sessionProvider(base, open = renewWithConfig, saved = savedSession) {
  let pending = null;
  let cached = null;
  return async ({ fresh = false } = {}) => {
    if (pending) return pending;
    if (!cached && !fresh) cached = saved(base);
    if (cached && !fresh) return cached;
    if (!pending) pending = open(base).then((s) => { cached = s; return s; }).finally(() => { pending = null; });
    return pending;
  };
}

export function connectCanvas(base, { session = sessionProvider(base) } = {}) {
  return new CanvasClient({
    base, session,
    verifyAccount(me) {
      const config = readConfig();
      if (config.sessionOrigin === base && config.sessionUserId !== undefined) {
        if (String(me.id) !== String(config.sessionUserId))
          throw Object.assign(new Error('Canvas returned a different account. Reconnect to choose an account.'), { code: 'identity_mismatch' });
      } else {
        writeConfig({ sessionOrigin: base, sessionUserId: String(me.id) });
      }
    },
  });
}

export function backgroundInterval(base, env = process.env) {
  const minutes = Number(env.CANVAS_MCP_VERIFIED_CHECK_MINUTES);
  return env.LAPLACE_BACKGROUND_SESSION_CHECKS === 'on' &&
    env.CANVAS_MCP_VERIFIED_CHECK_ORIGIN === base && [15, 30, 60].includes(minutes)
    ? minutes * 60_000 : 0;
}

export async function startServer() {
  const server = new McpServer({ name: 'canvas-session-mcp', version });
  let client;
  let timer;
  let active = 0;
  let stopped = false;
  let checking;
  const schedule = () => {
    clearTimeout(timer);
    if (stopped || active || !client?.current) return;
    const interval = backgroundInterval(client.base);
    if (!interval) return;
    timer = setTimeout(async () => {
      const controller = new AbortController();
      checking = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      let blocked = false;
      try {
        if (Date.now() >= client.rateLimitedUntil) await client.probe(client.current, signal);
      } catch (error) {
        blocked = ['sign_in_required', 'identity_mismatch'].includes(error.code);
      } finally {
        if (checking === controller) {
          checking = undefined;
          if (!blocked) schedule();
        }
      }
    }, Math.min(Math.max(interval, client.rateLimitedUntil - Date.now()), 2_147_483_647));
    timer.unref();
  };
  registerTools(server, async (run) => {
    clearTimeout(timer);
    checking?.abort();
    checking = undefined;
    active++;
    let authFailed = false;
    try {
      client ??= connectCanvas(baseUrl());
      return await run(client);
    } catch (error) {
      authFailed = ['sign_in_required', 'identity_mismatch'].includes(error.code);
      throw error;
    } finally {
      active--;
      if (!authFailed) schedule();
    }
  });
  const transport = new StdioServerTransport();
  process.stdin.once('end', () => {
    stopped = true;
    clearTimeout(timer);
    checking?.abort();
    void server.close();
  });
  await server.connect(transport);
}
