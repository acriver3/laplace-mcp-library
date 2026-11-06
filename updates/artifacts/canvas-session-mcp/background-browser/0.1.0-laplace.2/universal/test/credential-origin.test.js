// Laplace regression test for the cookie-origin modification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient } from '../src/canvas.js';

test('Canvas credentials stay on their origin across external downloads and redirects', async () => {
  const calls = [];
  const client = new CanvasClient({
    base: 'https://canvas.example',
    session: async () => ({ cookieHeader: 'test-session=private' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://files.example/file.pdf' } })
        : new Response('file');
    },
  });
  await client.request('https://canvas.example/download', { raw: true });
  assert.equal(calls[0].headers.Cookie, 'test-session=private');
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[0].redirect, 'manual');
  calls.length = 0;
  await client.request('https://files.example/direct.pdf', { raw: true });
  assert.equal(calls[0].headers.Cookie, undefined);
});
