"""Validate the npm connector catalog (catalog/local-mcp-bundles.json) against connector sources.

Usage: python3 scripts/verify.py [--registry] [--strict]

Offline checks: unique ids, required fields and types, npm package @withlaplace/<id>, the bin
exists in the connector's package.json, args/env placeholders are ${package_dir} or
${user_config.<key>} for keys in the connector's manifest.json, acceptance platforms are
catalog platforms, and review evidence files exist.

--registry also checks that each npm.package@version is on registry.npmjs.org, provides the
bin, ships npm-shrinkwrap.json with the published integrity, and that its @withlaplace
optional dependencies exist. Registry findings are warnings unless --strict is given.
Never executes connector code.
"""
import base64
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'catalog/local-mcp-bundles.json'
REGISTRY = 'https://registry.npmjs.org'
PLATFORMS = {'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'}
SEMVER = re.compile(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?')
TIMESTAMP = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ')
PLACEHOLDER = re.compile(r'\$\{([^}]*)\}')
REQUIRED = {
    'id': str, 'name': str, 'version': str, 'license': str, 'sourceDirectory': str,
    'npm': dict, 'platforms': list, 'published': bool, 'acceptance': list, 'reviewEvidence': list,
}
OPTIONAL = {
    'candidate': bool, 'upstreamCommit': str, 'upstreamVersion': str,
    'sourceSubdirectory': str, 'repository': str, 'setupUrl': str,
}
errors, warnings = [], []


def bins(package):
    """Command names a package.json provides; a string bin is named after the package."""
    value = package.get('bin')
    if isinstance(value, str):
        return {package['name'].split('/')[-1]: value}
    return dict(value or {})


def inside(path, parent):
    return path.resolve().is_relative_to(parent.resolve())


def check_entry(entry):
    cid = entry.get('id', '?')
    fail = lambda message: errors.append(f'{cid}: {message}')
    invalid = [key for key, kind in REQUIRED.items() if not isinstance(entry.get(key), kind)]
    for key in invalid:
        fail(f'{key} must be a {REQUIRED[key].__name__}')
    for key, kind in OPTIONAL.items():
        if key in entry and not isinstance(entry[key], kind):
            fail(f'{key} must be a {kind.__name__}')
    for retired in ('artifacts', 'sourceArchiveSha256'):
        if retired in entry:
            fail(f'{retired} is retired; connectors ship on npm')
    if invalid:
        return
    if not SEMVER.fullmatch(entry['version']):
        fail(f'version {entry["version"]!r} is not an exact semantic version')

    source = ROOT / entry['sourceDirectory']
    if not inside(source, ROOT / 'connectors') or source == ROOT / 'connectors':
        return fail('sourceDirectory must be inside connectors/')
    for name in ['README.md', 'LICENSE', 'manifest.json', 'package.json']:
        if not (source / name).is_file():
            fail(f'missing {entry["sourceDirectory"]}/{name}')
    try:
        manifest = json.loads((source / 'manifest.json').read_text())
        package = json.loads((source / 'package.json').read_text())
    except (OSError, ValueError) as error:
        return fail(f'unreadable manifest.json or package.json: {error}')
    if manifest.get('name') != cid:
        fail(f'manifest.json name is {manifest.get("name")!r}')
    if manifest.get('version') != entry['version']:
        fail(f'manifest.json version {manifest.get("version")!r} differs from {entry["version"]}')

    npm = entry['npm']
    if npm.get('package') != f'@withlaplace/{cid}':
        fail(f'npm.package must be @withlaplace/{cid}')
    if not isinstance(npm.get('distTag'), str) or not npm['distTag']:
        fail('npm.distTag must be a non-empty string')
    # publish:npm renames the package to @withlaplace/<id>; a string bin takes that name.
    commands = bins({**package, 'name': f'@withlaplace/{cid}'})
    if npm.get('bin') not in commands:
        fail(f'npm.bin {npm.get("bin")!r} is not a bin in package.json ({", ".join(commands) or "none"})')
    elif not (source / commands[npm['bin']]).is_file() and not package.get('scripts', {}).get('build'):
        fail(f'bin target {commands[npm["bin"]]} does not exist')
    args, env = npm.get('args'), npm.get('env')
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        fail('npm.args must be a list of strings')
        args = []
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        fail('npm.env must map strings to strings')
        env = {}
    allowed = {'package_dir'} | {f'user_config.{key}' for key in manifest.get('user_config', {})}
    for value in [*args, *env.values()]:
        for placeholder in PLACEHOLDER.findall(value):
            if placeholder not in allowed:
                fail(f'unknown placeholder ${{{placeholder}}} (allowed: {", ".join(sorted(allowed))})')

    platforms = entry['platforms']
    if not platforms or len(set(platforms)) != len(platforms) or not set(platforms) <= PLATFORMS:
        fail(f'platforms must be unique values from {sorted(PLATFORMS)}')
    for record in entry['acceptance']:
        if not isinstance(record, dict):
            fail('acceptance records must be objects')
            continue
        if record.get('platform') not in platforms:
            fail(f'acceptance platform {record.get("platform")!r} is not a catalog platform')
        if not SEMVER.fullmatch(str(record.get('version', ''))):
            fail(f'acceptance version {record.get("version")!r} is not a semantic version')
        if not TIMESTAMP.fullmatch(str(record.get('acceptedAt', ''))):
            fail(f'acceptance acceptedAt {record.get("acceptedAt")!r} is not a UTC timestamp')
        if not isinstance(record.get('evidence'), str) or not record['evidence'].strip():
            fail('acceptance evidence must be non-empty text')
        if 'archiveSha256' in record:
            fail('acceptance archiveSha256 is retired; record the accepted version')
    for evidence in entry['reviewEvidence']:
        path = ROOT / evidence
        if not isinstance(evidence, str) or not inside(path, ROOT) or not path.is_file():
            fail(f'missing evidence: {evidence}')


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers={'accept': 'application/json', 'user-agent': 'laplace-mcp-library-verify'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    return data if binary else json.loads(data)


def check_registry(entry, report):
    package, version = entry['npm']['package'], entry['version']
    label = f'{package}@{version}'
    try:
        metadata = fetch(f'{REGISTRY}/{urllib.parse.quote(package, safe="@")}')
    except urllib.error.HTTPError as error:
        return report(f'{label}: package not on the registry (HTTP {error.code})')
    except (urllib.error.URLError, TimeoutError) as error:
        return report(f'{label}: registry unreachable ({error})')
    published = metadata.get('versions', {}).get(version)
    if not published:
        return report(f'{label}: version not published')
    tag = metadata.get('dist-tags', {}).get(entry['npm']['distTag'])
    if tag != version:
        report(f'{label}: dist-tag {entry["npm"]["distTag"]} points to {tag}')
    if entry['npm']['bin'] not in bins(published):
        report(f'{label}: published package lacks bin {entry["npm"]["bin"]}')
    dist = published.get('dist', {})
    try:
        tarball = fetch(dist['tarball'], binary=True)
    except (KeyError, urllib.error.URLError, TimeoutError) as error:
        return report(f'{label}: tarball unavailable ({error})')
    algorithm, _, digest = dist.get('integrity', '').partition('-')
    if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(tarball).digest()).decode() != digest:
        report(f'{label}: tarball does not match its sha512 integrity')
    with tarfile.open(fileobj=io.BytesIO(tarball), mode='r:gz') as archive:
        if 'package/npm-shrinkwrap.json' not in archive.getnames():
            report(f'{label}: does not ship npm-shrinkwrap.json')
    for dependency, wanted in published.get('optionalDependencies', {}).items():
        if dependency.startswith('@withlaplace/'):
            try:
                fetch(f'{REGISTRY}/{urllib.parse.quote(dependency, safe="@")}/{wanted}')
            except urllib.error.HTTPError:
                report(f'{label}: optional dependency {dependency}@{wanted} is not published')
            except (urllib.error.URLError, TimeoutError) as error:
                report(f'{label}: registry unreachable for {dependency} ({error})')


def main(argv):
    unknown = set(argv) - {'--registry', '--strict'}
    if unknown:
        sys.exit(f'Unknown option(s): {", ".join(sorted(unknown))}')
    entries = json.loads(CATALOG.read_text())
    if not isinstance(entries, list):
        sys.exit('Catalog must be a list')
    seen = set()
    for entry in entries:
        if entry.get('id') in seen:
            errors.append(f'{entry.get("id")}: duplicate connector id')
        seen.add(entry.get('id'))
        before = len(errors)
        check_entry(entry)
        if len(errors) == before:
            print(f'{entry["id"]}: {entry["npm"]["package"]}@{entry["version"]} catalog entry verified')
    if '--registry' in argv:
        findings = errors if '--strict' in argv else warnings
        for entry in entries:
            if isinstance(entry.get('npm'), dict) and isinstance(entry.get('version'), str):
                before = len(findings)
                check_registry(entry, findings.append)
                if len(findings) == before:
                    print(f'{entry["npm"]["package"]}@{entry["version"]}: published with npm-shrinkwrap.json')
    for warning in warnings:
        print(f'warning: {warning}', file=sys.stderr)
    for error in errors:
        print(f'error: {error}', file=sys.stderr)
    if errors:
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1:])
