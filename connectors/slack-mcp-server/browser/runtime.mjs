import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

export class SetupError extends Error {}

export function installChromium() {
  const cli = fileURLToPath(new URL('./node_modules/patchright/cli.js', import.meta.url));
  return new Promise((resolve, reject) => {
    // Use the bundled Node runtime. Installer output must never enter MCP stdout.
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 2, 2],
    });
    child.once('error', () => reject(new SetupError('Could not start the browser installer. Download and extract the complete Slack bundle again.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new SetupError('Chromium download failed. Check your network connection and run login again.')));
  });
}

export async function ensureBrowser(mode, {
  executable = chromium.executablePath(), exists = existsSync, install = installChromium,
  report = (text) => process.stderr.write(text + '\n'),
} = {}) {
  if (exists(executable)) return;
  if (mode !== 'login') throw new SetupError('Slack browser setup is missing. Run the bundled slack launcher with login --workspace <your Slack HTTPS URL> first.');
  report('Downloading the matching Chromium browser for Slack sign-in (first run only).');
  await install();
  if (!exists(executable)) throw new SetupError('Chromium installation did not complete. Run login again.');
}
