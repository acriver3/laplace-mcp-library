"""Verify stored release archives and source metadata; never execute bundle code."""
import hashlib
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bundle_archive', ROOT / 'scripts/bundle-archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
entries = json.loads((ROOT / 'catalog/local-mcp-bundles.json').read_text())
seen = set()
for entry in entries:
    assert entry['id'] not in seen, 'Duplicate connector ID'
    seen.add(entry['id'])
    source = ROOT / entry['sourceDirectory']
    assert source.is_relative_to(ROOT / 'connectors')
    for name in ['README.md', 'LICENSE', 'manifest.json', 'LAPLACE-PROVENANCE.json']:
        assert (source / name).is_file(), f'{entry["id"]}: missing {name}'
    manifest = json.loads((source / 'manifest.json').read_text())
    assert manifest['name'] == entry['id']
    for evidence in entry['reviewEvidence']:
        assert (ROOT / evidence).is_file(), f'Missing evidence: {evidence}'
    assert entry['artifacts'], f'{entry["id"]}: no stored MCPB'
    for artifact in entry['artifacts']:
        path = ROOT / artifact['path']
        assert path.resolve().is_relative_to((ROOT / 'bundles').resolve()), 'Archive must be in bundles/'
        data = path.read_bytes()
        assert len(data) == artifact['size'], f'{path.name}: wrong size'
        assert hashlib.sha256(data).hexdigest() == artifact['sha256'], f'{path.name}: wrong checksum'
        files = archive.zip_entries(data)
        packaged = json.loads(files['manifest.json'][0])
        assert packaged['name'] == entry['id'] and packaged['version'] == entry['version']
        if entry['recipe'] != 'slack-source':
            archive.inspect(entry, path)
        else:
            assert {'browser/cli.mjs', 'browser/package-lock.json', 'go.mod', 'go.sum', 'LICENSE'} <= files.keys()
            assert not any('node_modules' in pathlib.PurePosixPath(name).parts for name in files)
        print(f'{entry["id"]}: {path.name} verified')
