import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBrowser, SetupError } from './runtime.mjs';

test('existing browser is reused without installing', async () => {
  await ensureBrowser('login', { exists: () => true, install: () => assert.fail('unexpected installation') });
});
test('MCP startup never downloads or opens a sign-in flow', async () => {
  await assert.rejects(ensureBrowser('serve', { exists: () => false, install: () => assert.fail('unexpected installation') }), /Run the bundled slack launcher/);
});
test('login installs once and checks the executable before proceeding', async () => {
  let ready = false, installs = 0;
  const options = { exists: () => ready, install: async () => { installs++; ready = true; }, report: () => {} };
  await ensureBrowser('login', options);
  await ensureBrowser('login', options);
  assert.equal(installs, 1);
});
test('failed or incomplete installation cannot proceed to login', async () => {
  await assert.rejects(ensureBrowser('login', { exists: () => false, install: async () => {}, report: () => {} }), SetupError);
  await assert.rejects(ensureBrowser('login', { exists: () => false, install: async () => { throw new SetupError('download failed'); }, report: () => {} }), /download failed/);
});
