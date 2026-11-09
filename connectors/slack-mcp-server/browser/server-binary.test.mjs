import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SetupError } from './runtime.mjs';
import { binaryPath, platformPackage, serverBinary, SUPPORTED_TARGETS } from './server-binary.mjs';

test('each supported target maps to its platform package binary', () => {
  for (const target of SUPPORTED_TARGETS) {
    const [platform, arch] = target.split('-');
    const resolved = [];
    const file = serverBinary({
      platform, arch, exists: () => true,
      resolve: (request) => { resolved.push(request); return join('/pkgs', request); },
    });
    assert.deepEqual(resolved, [`${platformPackage(target)}/package.json`]);
    assert.equal(file, join('/pkgs', platformPackage(target), binaryPath(target)));
    assert.equal(file.endsWith('.exe'), platform === 'win32');
  }
});

test('unsupported, missing or incomplete platform packages explain the problem', () => {
  const missing = () => { throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' }); };
  assert.throws(() => serverBinary({ platform: 'linux', arch: 'arm64', resolve: missing }), /does not provide a server for linux-arm64/);
  assert.throws(() => serverBinary({ platform: 'darwin', arch: 'arm64', resolve: missing }), (error) => error instanceof SetupError && /slack-mcp-server-darwin-arm64 is not installed/.test(error.message));
  assert.throws(() => serverBinary({ platform: 'linux', arch: 'x64', resolve: (r) => join('/pkgs', r), exists: () => false }), /incomplete/);
});
