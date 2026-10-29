import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { ensureBrowser, SetupError } from './runtime.mjs';
import { browserSession, sessionEnvironment, workspaceURL } from './session.mjs';

async function main() {
  const { values, positionals } = parseArgs({ options: {
    workspace: { type: 'string' }, 'profile-dir': { type: 'string' },
    binary: { type: 'string' }, help: { type: 'boolean' },
  }, allowPositionals: true });
  const mode = positionals[0] || 'serve';
  if (values.help) {
    process.stderr.write('Usage: node browser/cli.mjs login|serve --workspace https://your-team.slack.com [--profile-dir PATH] [--binary PATH]\n');
    return;
  }
  if (!['login', 'serve'].includes(mode) || positionals.length > 1) throw new Error('Choose login or serve.');
  if (process.env.SLACK_MCP_XOXP_TOKEN || process.env.SLACK_MCP_XOXB_TOKEN) {
    throw new Error('OAuth tokens are disabled. Remove the OAuth token environment variables.');
  }
  const workspace = workspaceURL(values.workspace);
  const workspaceKey = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  const profile = resolve(values['profile-dir'] || resolve(homedir(), '.laplace-local', 'sessions', 'slack-patchright', workspaceKey));
  if (mode === 'login') process.stderr.write('Complete Slack sign-in and MFA in the dedicated browser window.\n');
  await ensureBrowser(mode);
  const session = await browserSession({ workspace, profile, interactive: mode === 'login' });
  if (mode === 'login') {
    process.stderr.write('Browser session is ready. Tokens were not exported to a credentials file.\n');
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const binary = resolve(values.binary || resolve(root, 'build', process.platform === 'win32' ? 'slack-mcp-server.exe' : 'slack-mcp-server'));
  const child = spawn(binary, ['--transport', 'stdio'], {
    env: sessionEnvironment(session, { ...process.env, SLACK_MCP_ENABLED_TOOLS: process.env.SLACK_MCP_ENABLED_TOOLS || 'channels_list,conversations_history,conversations_replies,conversations_search_messages' }), stdio: 'inherit', cwd: root,
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', () => { process.stderr.write('Unable to start the bundled server. Download the bundle for your operating system and extract it completely.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  if (error instanceof SetupError) { process.stderr.write(error.message + '\n'); process.exitCode = 1; return; }
  // Browser exceptions may contain page content or credential-bearing URLs.
  process.stderr.write('Slack Patchright startup failed. Check your workspace URL, then run the bundled slack launcher with login before serve. On Linux, Chromium also requires its OS shared libraries. OAuth tokens are not supported.\n');
  process.exitCode = 1;
});
