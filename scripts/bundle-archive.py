"""Source extraction and canonical MCPB inspection using Python's standard library."""
import hashlib
import io
import json
import pathlib
import stat
import sys
import tarfile
import zipfile

EXCLUDED = {".agents", ".canvas-session-mcp", ".claude", ".gemini", ".git", ".linkedin-mcp", ".macroscope", ".msoutlook-mcp-server", ".pytest_cache", ".venv", ".vite", ".vite-temp", ".yale-som-ems", "__pycache__", "browser-profile", "browser-profiles", "downloads", "msoutlook-mcp-server", "msoutlook-mcp-server-data", "profile", "profiles", "user-data", "venv"}
EXCLUDED_FILES = {".mcp.json", ".npmrc", "Cookies", "Local State", "Login Data", "config.enc", "cookies.json", "id_ed25519", "id_rsa", "session-state.json", "session.json", "token-cache.json", "upcoming-laplace-local.mjs", "verify-laplace-local.mjs", "verify-linkedin-local.mjs"}


def allowed(name):
    parts = pathlib.PurePosixPath(name).parts
    return bool(parts) and not name.startswith("/") and "\\" not in name and ":" not in name and all(part not in EXCLUDED and part != ".." for part in parts) and parts[-1] not in EXCLUDED_FILES and not parts[-1].endswith((".owner.json", ".uncertain.json")) and all(not part.startswith(".env") or part == ".env.example" for part in parts)


def extract_source(data, stage):
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for item in archive.getmembers():
            if not allowed(item.name) or "node_modules" in pathlib.PurePosixPath(item.name).parts or item.isdir():
                continue
            if not item.isfile() or item.name in seen:
                raise ValueError("Only unique regular source files are allowed")
            seen.add(item.name)
            target = stage / item.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(item).read())
            target.chmod(0o755 if item.mode & 0o111 else 0o644)


def zip_entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = {}
        for info in archive.infolist():
            if info.is_dir():
                continue
            mode = info.external_attr >> 16
            if not allowed(info.filename) or info.filename in entries or stat.S_ISLNK(mode):
                raise ValueError("Unexpected bundle path, duplicate or symbolic link: " + info.filename)
            entries[info.filename] = (archive.read(info), 0o755 if mode & 0o111 else 0o644)
        return entries


def normalize(bundle, stage):
    entries = zip_entries(bundle.read_bytes())
    # MCPB's default exclusions omit the npm lockfile; retain the reviewed lockfile too.
    for name in ["package-lock.json", "browser/package-lock.json", "uv.lock"]:
        if (stage / name).is_file():
            entries[name] = ((stage / name).read_bytes(), 0o644)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, (data, mode) in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=9)
    bundle.write_bytes(output.getvalue())


def inspect(entry, bundle):
    data = bundle.read_bytes()
    files = zip_entries(data)
    required = {"manifest.json", "LICENSE", "README.md", "LAPLACE-PROVENANCE.json", "LAPLACE-BUNDLE.md"}
    required |= {"laplace-patches/" + patch for patch in entry["patches"]}
    if entry["recipe"] == "canvas":
        required |= {"package.json", "package-lock.json", "bin/cli.js", "src/canvas.js", "test/credential-origin.test.js", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/playwright-core/package.json"}
        if any(name.endswith((".node", ".dll", ".so", ".dylib")) for name in files):
            raise ValueError("Native dependency requires a platform-specific artifact")
        if b"Laplace modification" not in files.get("src/canvas.js", (b"", 0))[0]:
            raise ValueError("Canvas cookie-origin patch missing")
    elif entry["recipe"] == "outlook":
        required |= {"package.json", "package-lock.json", "src/index.ts", "src/auth/session-store.test.ts", "dist/index.js", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/playwright-core/package.json", "node_modules/sql.js/dist/sql-wasm.wasm"}
        if any(name.endswith((".node", ".dll", ".so", ".dylib")) for name in files):
            raise ValueError("Native dependency requires a platform-specific artifact")
    elif entry["recipe"] == "linkedin":
        required |= {"NOTICE", "pyproject.toml", "uv.lock", "linkedin_mcp_server/__main__.py"}
        if any(name.startswith(("node_modules/", "server/lib/", "server/venv/")) for name in files):
            raise ValueError("UV bundles must not contain installed dependencies")
    elif entry["recipe"] == "yale-som-ems":
        required |= {"package.json", "package-lock.json", "dist/cli.js", "src/adapter.ts", "src/core.ts", "test/core.test.mjs", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/playwright-core/package.json", "node_modules/playwright-core/LICENSE"}
        if any(name.endswith((".node", ".dll", ".so", ".dylib")) for name in files):
            raise ValueError("Native dependency requires a platform-specific artifact")
    else:
        raise ValueError("Unsupported bundle recipe")
    if not required.issubset(files):
        raise ValueError("Bundle source/dependencies/lockfiles/attribution missing: " + ", ".join(sorted(required - files.keys())))
    provenance = json.loads(files["LAPLACE-PROVENANCE.json"][0])
    for key in ["id", "version", "repository", "upstreamCommit", "upstreamVersion", "patches"]:
        if provenance[key] != entry[key]:
            raise ValueError("Provenance mismatch: " + key)
    if provenance.get("sourceSubdirectory") != entry.get("sourceSubdirectory"):
        raise ValueError("Provenance source directory mismatch")
    manifest = json.loads(files["manifest.json"][0])
    if manifest["name"] != entry["id"] or manifest["version"] != entry["version"]:
        raise ValueError("Manifest identity mismatch")
    if manifest["server"]["type"] != {"canvas": "node", "linkedin": "uv", "yale-som-ems": "node", "outlook": "node"}[entry["recipe"]]:
        raise ValueError("Unexpected runtime type")
    if entry["recipe"] == "outlook":
        config = manifest["server"]["mcp_config"]
        if manifest["server"]["entry_point"] != "dist/index.js" or config["command"] != "node" or config["args"] != ["${__dirname}/dist/index.js"] or config["env"] != {"MSOUTLOOK_BROWSER": "${user_config.browser}", "MSOUTLOOK_SKIP_COOKIE_IMPORT": "false"}:
            raise ValueError("Unexpected Outlook launch configuration")
    expected = {"upstream_commit": entry["upstreamCommit"], "patches": entry["patches"]}
    if entry.get("sourceSubdirectory"):
        expected["source_subdirectory"] = entry["sourceSubdirectory"]
    if manifest["_meta"]["com.withlaplace.catalog"] != expected:
        raise ValueError("Manifest provenance mismatch")
    return {"name": bundle.name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "files": len(files)}


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "extract":
        extract_source(sys.stdin.buffer.read(), pathlib.Path(sys.argv[2]))
    elif action == "normalize":
        normalize(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    elif action == "inspect":
        print(json.dumps(inspect(json.load(sys.stdin), pathlib.Path(sys.argv[2]))))
    else:
        raise ValueError("Expected extract, normalize or inspect")
