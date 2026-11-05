"""Package only the source needed for the Laplace Patchright edition."""
import hashlib
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
output = root / "dist"
output.mkdir(exist_ok=True)
name = "slack-mcp-server-laplace-patchright-1.0.0-source"
files = [root / p for p in ("README.md", "LICENSE", "go.mod", "go.sum", "LAPLACE-PROVENANCE.json", ".env.dist")]
for directory in ("browser", "cmd", "pkg", "docs", "scripts"):
    for file in (root / directory).rglob("*"):
        if not file.is_file() or file.is_symlink():
            continue
        relative = file.relative_to(root)
        if "node_modules" in relative.parts or "__pycache__" in relative.parts:
            continue
        if directory == "scripts" and relative.as_posix() != "scripts/package-source.py":
            continue
        if directory == "browser" and file.suffix not in (".json", ".mjs"):
            continue
        files.append(file)
with zipfile.ZipFile(output / f"{name}.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(set(files)):
        info = zipfile.ZipInfo(f"{name}/{file.relative_to(root).as_posix()}", (2026, 10, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, file.read_bytes())
archive_path = output / f"{name}.zip"
digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
(output / f"{name}.zip.sha256").write_text(f"{digest}  {archive_path.name}\n")
print(archive_path)
print(f"SHA256 {digest}")
