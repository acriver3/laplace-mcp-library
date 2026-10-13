import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readPageSession, sessionEnvironment, workspaceURL } from './session.mjs';

test('workspace validation blocks non-Slack URLs, credentials and API hosts', () => {
  assert.equal(workspaceURL('https://example.slack.com/signin'), 'https://example.slack.com/');
  assert.equal(workspaceURL('https://agency.slack-gov.com'), 'https://agency.slack-gov.com/');
  for (const url of ['http://example.slack.com', 'https://slack.com.evil.test', 'https://example.slack.com:444', 'https://u:p@example.slack.com', 'https://api.slack.com']) {
    assert.throws(() => workspaceURL(url));
  }
});

test('session extraction selects current workspace, rejects OAuth and malformed storage', () => {
  const run = (path, data) => vm.runInNewContext(`(${readPageSession.toString()})()`, {
    location: { pathname: path }, navigator: { userAgent: 'test-browser' },
    localStorage: { getItem: () => data },
  });
  const data = JSON.stringify({ teams: { TOTHER: { token: 'xoxc-other' }, TCURRENT: { token: 'xoxc-current' } } });
  assert.equal(run('/client/TCURRENT/C123', data).token, 'xoxc-current');
  assert.equal(run('/client/TMISSING/C123', data), null);
  assert.equal(run('/signin', data), null);
  assert.equal(run('/client/TCURRENT', '{'), null);
  assert.equal(run('/client/TCURRENT', JSON.stringify({ teams: { TCURRENT: { token: 'xoxp-oauth' } } })), null);
});

test('launcher overwrites inherited manual tokens and rejects OAuth', () => {
  const session = { token: 'xoxc-session', cookie: 'xoxd-session', userAgent: 'test', govSlack: false };
  const env = sessionEnvironment(session, { SLACK_MCP_XOXC_TOKEN: 'xoxc-manual', PATH: '/test' });
  assert.equal(env.SLACK_MCP_XOXC_TOKEN, 'xoxc-session');
  assert.equal(env.PATH, '/test');
  for (const key of ['SLACK_MCP_XOXP_TOKEN', 'SLACK_MCP_XOXB_TOKEN']) assert.throws(() => sessionEnvironment(session, { [key]: 'forbidden' }));
  assert.throws(() => sessionEnvironment({ ...session, token: 'xoxp-oauth' }, {}));
});
