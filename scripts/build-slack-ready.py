"""Build platform-specific Slack MCPBs with Go, Node and locked JS dependencies."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'scripts/slack-runtime-lock.json').read_text())
version = sys.argv[1] if len(sys.argv) > 1 else ''
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version), 'Supply a new semantic version'
catalog = json.loads((ROOT / 'catalog/local-mcp-bundles.json').read_text())
assert version != next(e['version'] for e in catalog if e['id'] == 'slack-mcp-server'), 'Use a new version'
targets = sys.argv[2:] or list(LOCK['targets'])
assert all(t in LOCK['targets'] for t in targets), 'Unsupported target'
env = {k: v for k, v in os.environ.items() if re.fullmatch(r'PATH|Path|HOME|USERPROFILE|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR', k)}
go = os.environ.get('GO_BINARY', 'go')

def run(args, cwd=ROOT, capture=False, extra=None):
    return subprocess.run(args, cwd=cwd, env={**env, **(extra or {})}, check=True, stdout=subprocess.PIPE if capture else None).stdout

assert run([go, 'version'], capture=True).decode().split()[2] == LOCK['goVersion'], 'Go toolchain does not match runtime lock'
commit = run(['git', 'rev-parse', 'HEAD'], capture=True).decode().strip()
spec = importlib.util.spec_from_file_location('archive', ROOT / 'scripts/bundle-archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
cache = ROOT / '.build/toolchains'
cache.mkdir(parents=True, exist_ok=True)
output = ROOT / '.artifacts'
output.mkdir(exist_ok=True)
cli = ROOT / 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js'
assert cli.is_file(), 'Run npm ci first'
results = []
for target in targets:
    config = LOCK['targets'][target]
    artifact = output / f'slack-mcp-server-{version}-{target}.mcpb'
    assert not artifact.exists(), f'Refusing to replace {artifact.name}'
    stage = pathlib.Path(tempfile.mkdtemp(prefix=f'slack-ready-{target}-', dir=ROOT / '.build'))
    archive.extract_source(run(['git', 'archive', f'{commit}:connectors/slack-mcp-server'], capture=True), stage)
    run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=stage / 'browser')
    runtime_archive = cache / config['archive']
    if not runtime_archive.exists():
        run(['curl', '--fail', '--silent', '--show-error', '--location', f'https://nodejs.org/dist/v{LOCK["nodeVersion"]}/{config["archive"]}', '--output', str(runtime_archive)])
    assert hashlib.sha256(runtime_archive.read_bytes()).hexdigest() == config['sha256'], 'Node runtime checksum mismatch'
    windows = config['goos'] == 'windows'
    node_name = 'node.exe' if windows else 'node'
    runtime = stage / 'runtime'
    runtime.mkdir()
    if windows:
        prefix = config['archive'].removesuffix('.zip')
        with zipfile.ZipFile(runtime_archive) as z:
            (runtime / node_name).write_bytes(z.read(f'{prefix}/node.exe'))
            (runtime / 'LICENSE').write_bytes(z.read(f'{prefix}/LICENSE'))
    else:
        prefix = config['archive'].removesuffix('.tar.gz')
        with tarfile.open(runtime_archive) as tf:
            (runtime / node_name).write_bytes(tf.extractfile(f'{prefix}/bin/node').read())
            (runtime / 'LICENSE').write_bytes(tf.extractfile(f'{prefix}/LICENSE').read())
    (runtime / node_name).chmod(0o755)
    (stage / 'build').mkdir()
    binary = stage / 'build' / ('slack-mcp-server.exe' if windows else 'slack-mcp-server')
    run([go, 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', str(binary), './cmd/slack-mcp-server'], cwd=stage, extra={'CGO_ENABLED':'0', 'GOOS':config['goos'], 'GOARCH':config['goarch']})
    if windows:
        (stage / 'slack.cmd').write_bytes(b'@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0browser\\cli.mjs" %*\r\n')
    else:
        (stage / 'slack').write_text('#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/runtime/node" "$root/browser/cli.mjs" "$@"\n')
        (stage / 'slack').chmod(0o755)
    manifest = json.loads((stage / 'manifest.json').read_text())
    manifest['version'] = version
    manifest['description'] = 'Precompiled Slack MCP with bundled Node and dependencies. First login downloads Chromium; no compiler or npm needed.'
    manifest['server']['type'] = 'binary'
    manifest['server']['entry_point'] = f'runtime/{node_name}'
    manifest['server']['mcp_config']['command'] = '${__dirname}/runtime/' + node_name
    manifest['compatibility'] = {'platforms': [target.split('-')[0]]}
    manifest['_meta'] = {'com.withlaplace.runtime': {'platform':target, 'nodeVersion':LOCK['nodeVersion'], 'goVersion':LOCK['goVersion']}}
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    provenance = {'id':'slack-mcp-server', 'version':version, 'libraryCommit':commit, 'platform':target, 'nodeArchive':config['archive'], 'nodeSha256':config['sha256'], 'goVersion':LOCK['goVersion'], 'cgoEnabled':False, 'authenticationAcceptance':'not performed'}
    (stage / 'LAPLACE-LIBRARY-PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n')
    run(['node', str(cli), 'validate', str(stage / 'manifest.json')])
    run(['node', str(cli), 'pack', str(stage), str(artifact)])
    archive.normalize(artifact, stage)
    files = archive.zip_entries(artifact.read_bytes())
    for name in [f'runtime/{node_name}', 'runtime/LICENSE', str(binary.relative_to(stage)), 'browser/node_modules/patchright/package.json', 'browser/node_modules/patchright-core/package.json', 'browser/package-lock.json']:
        assert name in files, f'Missing bundled runtime: {name}'
    data = artifact.read_bytes()
    results.append({'name':artifact.name, 'sha256':hashlib.sha256(data).hexdigest(), 'size':len(data), 'platforms':[target], 'published':False, 'candidate':True, 'acceptance':[]})
    print(json.dumps({'built':results[-1], 'stage':str(stage)}), flush=True)
(ROOT / '.artifacts' / f'slack-ready-{version}.json').write_text(json.dumps(results, indent=2) + '\n')
