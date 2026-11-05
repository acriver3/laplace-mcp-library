import { mkdir, chmod } from 'node:fs/promises';
import { chromium } from 'patchright';

export function workspaceURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Provide your Slack workspace HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^[a-z0-9-]+\.(slack\.com|slack-gov\.com)$/.test(url.hostname) ||
      /^(app|api|edgeapi)\./.test(url.hostname)) {
    throw new Error('Provide a workspace URL such as https://your-team.slack.com.');
  }
  return new URL('/', url).href;
}

export function sessionEnvironment(session, inherited = process.env) {
  if (inherited.SLACK_MCP_XOXP_TOKEN || inherited.SLACK_MCP_XOXB_TOKEN) {
    throw new Error('OAuth tokens are disabled; remove SLACK_MCP_XOXP_TOKEN and SLACK_MCP_XOXB_TOKEN.');
  }
  if (!session.token?.startsWith('xoxc-') || !session.cookie?.startsWith('xoxd-')) {
    throw new Error('A valid browser session is required.');
  }
  return { ...inherited, SLACK_MCP_XOXC_TOKEN: session.token,
    SLACK_MCP_XOXD_TOKEN: session.cookie, SLACK_MCP_USER_AGENT: session.userAgent,
    SLACK_MCP_GOVSLACK: String(session.govSlack) };
}

// Slack stores workspace session tokens in localConfig_v2. Read only the
// workspace displayed in the current tab; never choose the first saved team.
export function readPageSession() {
  const teamID = location.pathname.match(/^\/client\/([A-Z0-9]+)/)?.[1];
  if (!teamID) return null;
  try {
    const token = JSON.parse(localStorage.getItem('localConfig_v2') || '{}').teams?.[teamID]?.token;
    return token?.startsWith('xoxc-') ? { token, teamID, userAgent: navigator.userAgent } : null;
  } catch { return null; }
}

export async function browserSession({ workspace, profile, interactive = false, timeout = 300000 }) {
  const target = workspaceURL(workspace);
  const domain = new URL(target).hostname.endsWith('.slack-gov.com') ? 'slack-gov.com' : 'slack.com';
  await mkdir(profile, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(profile, 0o700);
  const context = await chromium.launchPersistentContext(profile, {
    headless: !interactive, viewport: null,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + (interactive ? timeout : 15000);
    while (Date.now() < deadline) {
      for (const tab of [page]) {
        let current;
        try { current = new URL(tab.url()); } catch { continue; }
        if (current.protocol !== 'https:' ||
            !(current.hostname === domain || current.hostname.endsWith(`.${domain}`))) continue;
        // Patchright defaults to an isolated world. Slack's localStorage is
        // shared with that world; no runtime injection or console capture needed.
        const state = await tab.evaluate(readPageSession).catch(() => null);
        if (!state) continue;
        const cookies = await context.cookies(`https://${domain}/`);
        const cookie = cookies.find(c => c.name === 'd')?.value;
        if (!cookie) continue;
        let decoded;
        try { decoded = decodeURIComponent(cookie); } catch { continue; }
        if (!decoded.startsWith('xoxd-')) continue;
        const response = await context.request.post(`https://${domain}/api/auth.test`, {
          form: { token: state.token }, timeout: 30000,
        });
        const identity = await response.json();
        await response.dispose();
        if (!identity.ok) throw new Error('Browser session is no longer valid. Run login again.');
        if (identity.team_id !== state.teamID ||
            new URL(identity.url).hostname !== new URL(target).hostname) {
          throw new Error('The signed-in workspace does not match the requested workspace.');
        }
        return { ...state, cookie: decoded, govSlack: domain === 'slack-gov.com' };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(interactive ? 'Sign-in timed out. Run login again.' : 'No active session. Run login first.');
  } finally { await context.close(); }
}
