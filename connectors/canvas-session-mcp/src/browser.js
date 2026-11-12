import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { PROFILE_DIR, CMD } from './config.js';
import { canvasCookies, loadCookies, saveCookies } from './session-cookies.js';

export function signInRequired(message = 'Sign in required. Reconnect Canvas in Laplace or run login with the existing Canvas URL and session directory.') {
  return Object.assign(new Error(message), { code: 'sign_in_required' });
}

export function savedSession(base) {
  const cookies = canvasCookies(base, loadCookies());
  return cookies.header(new URL('/api/v1/users/self', base)) ? { cookies } : null;
}

// Many schools switched off "New Access Token" for students. Canvas's own web app calls
// /api/v1 with your session cookie, so we do the same: a real Chrome/Edge window (with its
// own profile, separate from your everyday browser) where you sign in once through your
// school's SSO. Later runs reuse that profile headlessly; your identity provider's
// "stay signed in" cookie usually signs you back in without any prompt.
export async function launch({ headless }) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const errors = [];
  const channels = process.env.CANVAS_MCP_BROWSER ? [process.env.CANVAS_MCP_BROWSER] : ['chrome', 'msedge', 'chromium'];
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless, viewport: headless ? undefined : null });
    } catch (e) { errors.push(`${channel}: ${e.message.split('\n')[0]}`); }
  }
  throw new Error(`Could not start Chrome or Edge. Install one of them, or set CANVAS_MCP_BROWSER.\n${errors.join('\n')}`);
}

// Asks Canvas who we are from inside the page, so the request carries the browser's cookies.
async function whoAmI(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch('/api/v1/users/self', {
        credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000),
      });
      if (!r.ok) return null;
      return JSON.parse((await r.text()).replace(/^while\(1\);/, ''));
    } catch { return null; }
  }).catch(() => null);
}

const sameOrigin = (url, base) => { try { return new URL(url).origin === base; } catch { return false; } };

// Canvas's own sign-in entry points (/login/saml, /login/openid_connect, ...). The one you
// used at login is remembered so a renewal can go straight to your school's SSO.
const LOGIN_PATH = /^\/login\/(?!canvas\b)[a-z_]+(\/\d+)?$/;

// Opens Canvas and waits until the page is on Canvas and /users/self answers.
//   startPath  where to start (default "/"; renewals use the remembered SSO entry)
//   onLoginPath(path)  called with the SSO entry point the browser went through
// Headless gives the SSO redirects a little time to bounce back on their own; a visible
// window waits for you to finish signing in, MFA included.
export async function openSession(base, { headless = true, startPath = '/', timeoutMs = headless ? 20000 : 600000, onLoginPath, expectedId } = {}) {
  const ctx = await launch({ headless });
  try {
    const saved = loadCookies();
    if (saved.length) await ctx.addCookies(saved).catch(() => {});
    const first = ctx.pages()[0] || await ctx.newPage();
    let loginPath = null;
    ctx.on('page', (p) => watch(p));
    const watch = (p) => p.on('framenavigated', (f) => {
      if (f !== p.mainFrame() || !sameOrigin(f.url(), base)) return;
      const pathname = new URL(f.url()).pathname;
      if (LOGIN_PATH.test(pathname)) loginPath = pathname;
    });
    watch(first);
    await first.goto(base + (LOGIN_PATH.test(startPath) ? startPath : '/'), { waitUntil: 'domcontentloaded', timeout: Math.min(30000, timeoutMs) }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // SSO sometimes continues in another tab; watch whichever Canvas tab is still open.
      const open = ctx.pages().filter((p) => !p.isClosed());
      if (!open.length) throw new Error('The browser window was closed before sign-in finished.');
      const page = open.find((p) => sameOrigin(p.url(), base)) || open[0];
      if (sameOrigin(page.url(), base) && !/\/login/.test(new URL(page.url()).pathname)) {
        const me = await whoAmI(page);
        if (me?.id) {
          if (expectedId !== undefined && String(me.id) !== String(expectedId))
            throw Object.assign(new Error('Canvas returned a different account. Sign in to the original account or reconnect explicitly.'), { code: 'identity_mismatch' });
          const all = await ctx.cookies();   // Canvas and the SSO provider, so SSO can renew later
          saveCookies(all);
          if (loginPath && onLoginPath) onLoginPath(loginPath);
          return { me, cookies: canvasCookies(base, all) };
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(headless ? 'Canvas did not sign in silently.' : 'Timed out waiting for you to sign in to Canvas.');
  } finally {
    await ctx.close().catch(() => {});
  }
}

// What the server does when Canvas rejects the saved cookies:
//  1. a hidden browser, for schools whose SSO bounces straight back;
//  2. otherwise a visible window opened at your school's SSO entry. While the SSO still
//     remembers you it signs in and closes by itself in a second or two; if the SSO session
//     has ended too, the window waits for you to sign in (bot checks are left to you, never automated).
// CANVAS_MCP_RENEW=hidden skips step 2 (then run `login` yourself when the session expires).
//  A tool call waits at most `waitMs` for the window (AI apps time out around 60 s). If you are
//  still typing your password, the call reports that and the window stays open; once you finish,
//  the session is saved and the next request just works. Only one window is ever open at a time.
let signInWindow = null;
const SIGN_IN_HINT = 'A Canvas sign-in window is open. Sign in there, then ask again.';

export async function renewSession(base, { loginPath, onLoginPath, expectedId, log = () => {}, waitMs = 40000 } = {}) {
  if (expectedId === undefined) throw signInRequired(`Not signed in to Canvas yet. Run: ${CMD} setup or reconnect the existing connector.`);
  if (signInWindow) return waitFor(signInWindow, waitMs);
  try { return await openSession(base, { headless: true, startPath: loginPath, onLoginPath, expectedId }); }
  catch (error) { if (error.code === 'identity_mismatch') throw error; }
  if (process.env.CANVAS_MCP_RENEW === 'hidden') {
    throw signInRequired();
  }
  log('Canvas session expired; opening a sign-in window…');
  signInWindow = openSession(base, { headless: false, startPath: loginPath || '/', timeoutMs: 600000, onLoginPath, expectedId })
    .finally(() => { signInWindow = null; });
  signInWindow.catch(() => {});   // the outcome is reported by waitFor, or by the next call
  return waitFor(signInWindow, waitMs);
}

async function waitFor(win, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(SIGN_IN_HINT)), ms); });
  try {
    return await Promise.race([win, late]);
  } catch (e) {
    if (e.code) throw e;
    throw signInRequired();
  } finally { clearTimeout(timer); }
}
