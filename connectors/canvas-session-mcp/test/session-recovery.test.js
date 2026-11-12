import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasClient } from '../src/canvas.js';
import { canvasCookies } from '../src/session-cookies.js';
import { backgroundInterval } from '../src/server.js';

const base = 'https://canvas.example.edu';
const sessionCookie = (name, value, extra = {}) => ({
  name, value, path: '/', domain: 'canvas.example.edu', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax', ...extra,
});

test('retains rotated and deleted cookies across restart and keeps provider cookies scoped', () => {
  const sso = sessionCookie('sso', 'private', { domain: 'login.example.edu' });
  let saved;
  const jar = canvasCookies(base, [sso, sessionCookie('session', 'old'), sessionCookie('remove', 'yes')],
    (cookies) => { saved = cookies; });
  const headers = new Headers();
  headers.append('Set-Cookie', 'session=new; Secure; HttpOnly; Path=/; SameSite=Lax');
  headers.append('Set-Cookie', 'remove=gone; Max-Age=0; Path=/');
  headers.append('Set-Cookie', 'scoped=yes; Path=/courses');
  headers.append('Set-Cookie', 'foreign=no; Domain=elsewhere.example; Path=/');
  jar.update(base + '/api/v1/users/self', headers);
  assert.equal(jar.header(base + '/api/v1/users/self'), 'session=new');
  assert.equal(jar.header('https://login.example.edu'), '');
  assert.deepEqual(saved[0], sso);
  const restored = canvasCookies(base, saved, () => {});
  assert.equal(restored.header(base + '/courses/1'), 'scoped=yes; session=new');
  restored.update('https://storage.example.edu/', new Headers({ 'Set-Cookie': 'session=injected; Path=/' }));
  assert.equal(restored.header(base + '/api/v1/users/self'), 'session=new');
});

test('permission and storage errors do not open Canvas sign-in', async () => {
  const client = new CanvasClient({
    base,
    session: async ({ fresh } = {}) => {
      assert.ok(!fresh);
      return { cookieHeader: 'session=good' };
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/users/self')) return Response.json({ id: 1 });
      if (url.endsWith('/private')) return new Response('{}', { status: 401 });
      if (url.endsWith('/download')) return Response.redirect('https://storage.example.edu/object');
      return new Response('', { status: 401 });
    },
  });
  await assert.rejects(client.get('private'), (error) => error.status === 401);
  await assert.rejects(client.request(base + '/download', { raw: true }), (error) => error.status === 401);
});

test('concurrent expiry causes one renewal and rejects an account mismatch', async () => {
  let renewals = 0;
  let user = 1;
  let dispatched = 0;
  const client = new CanvasClient({
    base,
    verifyAccount: (identity) => assert.equal(identity.id, 1),
    session: async ({ fresh } = {}) => {
      if (fresh) {
        renewals++;
        await new Promise((resolve) => setImmediate(resolve));
        return { cookieHeader: 'session=fresh' };
      }
      return { cookieHeader: 'session=expired' };
    },
    fetchImpl: async (url, options) => {
      if (options.headers.Cookie === 'session=expired') return new Response('{}', { status: 401 });
      if (url.endsWith('/courses')) dispatched++;
      return Response.json({ id: user });
    },
  });
  assert.equal((await Promise.all([client.get('courses'), client.get('courses')])).length, 2);
  assert.equal(renewals, 1);
  user = 2;
  client.current = { cookieHeader: 'session=expired' };
  await assert.rejects(client.get('courses'), { code: 'ERR_ASSERTION' });
  assert.equal(dispatched, 2);
});

test('Canvas checks before a write, and sends the write only once if the session expires during it', async () => {
  const requests = [];
  const client = new CanvasClient({
    base,
    session: async ({ fresh } = {}) => {
      assert.ok(!fresh);
      return { cookieHeader: 'session=good; _csrf_token=good' };
    },
    fetchImpl: async (url, options) => {
      requests.push(options.method);
      return url.endsWith('/users/self') ? Response.json({ id: 1 }) : new Response('{}', { status: 401 });
    },
  });
  await assert.rejects(client.send('POST', 'planner_notes', {}), { code: 'sign_in_required' });
  assert.deepEqual(requests, ['GET', 'POST']);
});

test('background checks require opt-in, the verified origin, and a verified interval', () => {
  const env = { CANVAS_MCP_VERIFIED_CHECK_ORIGIN: base, CANVAS_MCP_VERIFIED_CHECK_MINUTES: '30' };
  assert.equal(backgroundInterval(base, env), 0);
  env.LAPLACE_BACKGROUND_SESSION_CHECKS = 'on';
  assert.equal(backgroundInterval(base, env), 30 * 60_000);
  assert.equal(backgroundInterval('https://other.example.edu', env), 0);
  env.CANVAS_MCP_VERIFIED_CHECK_MINUTES = '1';
  assert.equal(backgroundInterval(base, env), 0);
});
