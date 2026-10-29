import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const [id, version] = process.argv.slice(2);
assert(/^[a-z0-9-]+$/.test(id ?? ''), 'Usage: npm run build:bundle -- <connector-id> <new-version>');
assert(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version ?? ''), 'Supply an explicit semantic version');
const catalog = JSON.parse(readFileSync(join(root, 'catalog/local-mcp-bundles.json')));
const entry = catalog.find(item => item.id === id);
assert(entry, 'Unknown connector');
assert(version !== entry.version, 'Use a new version; published or recorded versions are immutable');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|HOME|USERPROFILE|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/.test(key)));
function run(command, args, cwd = root, options = {}) {
  return execFileSync(command, args, { cwd, env, stdio: 'inherit', ...options });
}
const python = process.platform === 'win32' ? 'python' : 'python3';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
mkdirSync(join(root, '.build'), { recursive: true });
const stage = mkdtempSync(join(root, '.build', `${id}-`));
const commit = run('git', ['rev-parse', 'HEAD'], root, { encoding: 'utf8', stdio: 'pipe' }).trim();
const source = run('git', ['archive', `${commit}:connectors/${id}`], root, { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
run(python, [join(root, 'scripts/bundle-archive.py'), 'extract', stage], root, { input: source, stdio: 'pipe' });
function npmRun(args, cwd = stage) { run(npm, args, cwd, { shell: process.platform === 'win32' }); }
if (id === 'canvas-session-mcp') {
  npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(process.execPath, ['--test'], stage);
} else if (id === 'yale-som-ems-mcp' || id === 'msoutlook-mcp') {
  npmRun(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']);
  npmRun(['run', id === 'yale-som-ems-mcp' ? 'type-check' : 'build']);
  npmRun(['test']);
  npmRun(['prune', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']);
  rmSync(join(stage, 'node_modules/.vite'), { recursive: true, force: true });
} else if (id === 'slack-mcp-server') {
  // Source bundle: the user installs locked Patchright and builds Go on their OS.
  run(process.execPath, ['--test'], join(stage, 'browser'));
} else assert.equal(id, 'linkedin-mcp-server');
const manifestPath = join(stage, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath));
manifest.version = version;
manifest.repository = { type: 'git', url: 'https://github.com/acriver3/laplace-mcp-library' };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(stage, 'LAPLACE-LIBRARY-PROVENANCE.json'), JSON.stringify({ id, version, libraryCommit: commit, sourceDirectory: `connectors/${id}`, acceptance: 'candidate; authenticated platform acceptance required' }, null, 2) + '\n');
const mcpb = join(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js');
assert(existsSync(mcpb), 'Run npm ci first');
run(process.execPath, [mcpb, 'validate', manifestPath]);
const file = join(root, '.artifacts', `${id}-${version}-universal.mcpb`);
mkdirSync(join(root, '.artifacts'), { recursive: true });
assert(!existsSync(file), 'Refusing to replace an existing artifact');
run(process.execPath, [mcpb, 'pack', stage, file]);
run(python, [join(root, 'scripts/bundle-archive.py'), 'normalize', file, stage]);
const bytes = readFileSync(file);
console.log(JSON.stringify({ id, version, file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, candidate: true }));
