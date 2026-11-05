import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { readPageSession } from './session.mjs';

test('Patchright reads and reopens a dedicated persistent profile', {
  skip: process.env.RUN_PATCHRIGHT_SMOKE !== '1', timeout: 60000,
}, async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Local browser fixture</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}/client/TTEST/C123`;
  const profile = await mkdtemp(join(tmpdir(), 'slack-patchright-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, viewport: null });
    let page = context.pages()[0];
    await page.goto(target);
    await page.evaluate(() => localStorage.setItem('localConfig_v2', JSON.stringify({ teams: { TTEST: { token: 'xoxc-fixture' } } })));
    assert.equal((await page.evaluate(readPageSession)).token, 'xoxc-fixture');
    await context.close(); context = null;
    context = await chromium.launchPersistentContext(profile, { headless: true, viewport: null });
    page = context.pages()[0];
    await page.goto(target);
    assert.equal((await page.evaluate(readPageSession)).teamID, 'TTEST');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
