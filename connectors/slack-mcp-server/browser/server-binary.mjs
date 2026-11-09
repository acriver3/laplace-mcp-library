// Locates the Slack Go server shipped in the matching @withlaplace/slack-mcp-server-<os>-<cpu>
// optional dependency. npm installs only the package whose os/cpu fields match this machine.
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SetupError } from './runtime.mjs';

export const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];

export const platformPackage = (target) => `@withlaplace/slack-mcp-server-${target}`;
export const binaryPath = (target) => `bin/${target.startsWith('win32-') ? 'slack-mcp-server.exe' : 'slack-mcp-server'}`;

export function serverBinary({
  platform = process.platform, arch = process.arch,
  resolve = createRequire(import.meta.url).resolve, exists = existsSync,
} = {}) {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new SetupError(`Slack MCP does not provide a server for ${target}. Supported: ${SUPPORTED_TARGETS.join(', ')}.`);
  }
  const name = platformPackage(target);
  let manifest;
  try {
    manifest = resolve(`${name}/package.json`);
  } catch {
    throw new SetupError(`The Slack server package ${name} is not installed. Reinstall @withlaplace/slack-mcp-server without --omit=optional.`);
  }
  const file = join(dirname(manifest), binaryPath(target));
  if (!exists(file)) throw new SetupError(`${name} is incomplete. Reinstall the Slack connector.`);
  return file;
}

/** npm normally preserves the executable bit; restore it if an extractor dropped it. */
export function ensureExecutable(file, platform = process.platform) {
  if (platform === 'win32') return;
  try { accessSync(file, constants.X_OK); } catch { try { chmodSync(file, 0o755); } catch {} }
}
