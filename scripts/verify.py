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
def check_native(data, target):
    if target == 'linux-x64':
        assert data[:4] == b'\x7fELF' and data[4] == 2 and int.from_bytes(data[18:20], 'little') == 62, 'Expected x64 ELF'
    elif target == 'win32-x64':
        assert data[:2] == b'MZ', 'Expected PE executable'
        offset = int.from_bytes(data[60:64], 'little')
        assert data[offset:offset+4] == b'PE\0\0' and int.from_bytes(data[offset+4:offset+6], 'little') == 0x8664, 'Expected x64 PE'
    else:
        assert data[:4] == b'\xcf\xfa\xed\xfe', 'Expected 64-bit Mach-O'
        assert int.from_bytes(data[4:8], 'little') == {'darwin-x64':0x01000007, 'darwin-arm64':0x0100000c}[target], 'Wrong Mach-O CPU'

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
        if entry['recipe'] == 'slack-ready':
            assert len(artifact['platforms']) == 1
            target = artifact['platforms'][0]
            node = 'runtime/node.exe' if target.startswith('win32') else 'runtime/node'
            server = 'build/slack-mcp-server.exe' if target.startswith('win32') else 'build/slack-mcp-server'
            assert packaged['server']['type'] == 'binary'
            assert packaged['server']['entry_point'] == node
            assert packaged['server']['mcp_config']['command'] == '${__dirname}/' + node
            assert packaged['compatibility']['platforms'] == [target.split('-')[0]]
            assert packaged['_meta']['com.withlaplace.runtime']['platform'] == target
            provenance = json.loads(files['LAPLACE-LIBRARY-PROVENANCE.json'][0])
            assert provenance['platform'] == target and provenance['version'] == entry['version']
            for executable in [node, server]:
                check_native(files[executable][0], target)
                assert files[executable][1] & 0o111, 'Executable permissions missing'
            required = {'runtime/LICENSE', 'licenses/Go-LICENSE', 'licenses/go-modules/index.json', 'licenses/Patchright-Apache-2.0.txt', 'browser/node_modules/patchright/package.json', 'browser/node_modules/patchright-core/package.json', 'browser/runtime.mjs', 'browser/package-lock.json'}
            assert required <= files.keys(), 'Ready bundle is missing runtime dependencies or licenses'
            assert json.loads(files['browser/node_modules/patchright/package.json'][0])['version'] == '1.63.0'
            assert ('slack.cmd' if target.startswith('win32') else 'slack') in files
        elif entry['recipe'] != 'slack-source':
            archive.inspect(entry, path)
        else:
            assert {'browser/cli.mjs', 'browser/package-lock.json', 'go.mod', 'go.sum', 'LICENSE'} <= files.keys()
            assert not any('node_modules' in pathlib.PurePosixPath(name).parts for name in files)
        print(f'{entry["id"]}: {path.name} verified')
