import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'patchright';

export class SetupError extends Error {}

export function installChromium() {
  // patchright is a regular npm dependency; its package.json is exported, cli.js is not.
  const cli = join(dirname(createRequire(import.meta.url).resolve('patchright/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    // Use the Node running this launcher. Installer output must never enter MCP stdout.
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 2, 2],
    });
    child.once('error', () => reject(new SetupError('Could not start the browser installer. Reinstall the Slack connector.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new SetupError('Chromium download failed. Check your network connection and run login again.')));
  });
}

export async function ensureBrowser(mode, {
  executable = chromium.executablePath(), exists = existsSync, install = installChromium,
  report = (text) => process.stderr.write(text + '\n'),
} = {}) {
  if (exists(executable)) return;
  if (mode !== 'login') throw new SetupError('Slack browser setup is missing. Run slack-mcp-server login --workspace <your Slack HTTPS URL> first.');
  report('Downloading the matching Chromium browser for Slack sign-in (first run only).');
  await install();
  if (!exists(executable)) throw new SetupError('Chromium installation did not complete. Run login again.');
}
