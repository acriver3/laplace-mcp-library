"""Publish GitHub release notes for immutable, repository-stored MCPBs."""
import hashlib
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = 'acriver3/laplace-mcp-library'
subprocess.run(['python3', str(ROOT / 'scripts/verify.py')], check=True)
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT), 'Commit all changes before publishing'
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
remote = subprocess.check_output(['gh', 'api', f'repos/{REPO}/git/ref/heads/main', '--jq', '.object.sha'], text=True).strip()
assert remote == commit, 'Push the reviewed commit to main before publishing'
entries = json.loads((ROOT / 'catalog/local-mcp-bundles.json').read_text())
for entry in entries:
    tag = f'{entry["id"]}-v{entry["version"]}'
    # A failed lookup is not assumed to mean absent: enumerate releases through a
    # successful API call so auth/network errors stop publication.
    releases = subprocess.check_output(['gh', 'api', '--paginate', f'repos/{REPO}/releases', '--jq', '.[].tag_name'], text=True).splitlines()
    if tag not in releases:
        candidate = any(a.get('candidate', False) for a in entry['artifacts'])
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md') as notes:
            notes.write(f'# {entry["name"]} {entry["version"]}\n\n')
            if entry['recipe'] == 'slack-ready':
                notes.write('Precompiled Slack MCPBs include the Go server, Node runtime and locked dependencies. No Go, npm or local compilation is needed. First login downloads Chromium and opens Slack sign-in. Real Slack authentication and native Windows/macOS acceptance remain pending. Linux runtime and local-browser checks are recorded in the review. Choose the artifact for your operating system and CPU.\n\n')
            elif candidate:
                notes.write('Source MCPB candidate; follow its documented local build prerequisites. Authenticated platform acceptance remains pending.\n\n')
            else:
                notes.write('Byte-for-byte mirror of the existing Laplace MCPB release. Original provenance and acceptance limitations are retained in the catalog and review records.\n\n')
            notes.write(f'Setup: https://github.com/{REPO}/blob/{commit}/README.md\n\n')
            for a in entry['artifacts']:
                notes.write(f'- [{a["name"]}]({a["url"]}): {a["size"]} bytes; SHA-256 `{a["sha256"]}`\n')
            notes.flush()
            args = ['gh', 'release', 'create', tag, '--repo', REPO, '--target', commit, '--title', f'{entry["name"]} {entry["version"]}', '--notes-file', notes.name, '--latest=false']
            if candidate:
                args.append('--prerelease')
            subprocess.run(args, check=True)
    # Never clobber existing releases. Verify their actual downloadable bytes.
    with tempfile.TemporaryDirectory() as directory:
        for a in entry['artifacts']:
            destination = pathlib.Path(directory) / a['name']
            subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', a['url'], '--output', str(destination)], check=True)
            data = destination.read_bytes()
            assert len(data) == a['size'] and hashlib.sha256(data).hexdigest() == a['sha256'], f'{tag}: published bytes differ; do not overwrite'
    print(f'{tag}: published download verified', flush=True)
