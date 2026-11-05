import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
// Local release tooling only. Never executed by Desktop or a downloaded connector.
import { mkdir, readdir, readFile, writeFile, lstat, copyFile, chmod } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
const [sourceArgument, destinationArgument, inventoryArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || !inventoryArgument)
  throw Error(
    "Usage: prepare-update-artifact <reviewed-unpacked-bundle> <new-artifact-directory> <new-inventory.json>",
  );
const source = resolve(sourceArgument),
  destination = resolve(destinationArgument);
if (source === destination || destination.startsWith(source + sep))
  throw Error("Stage artifacts outside the source bundle");
await mkdir(destination, { recursive: false, mode: 0o700 });
const files = [];
async function walk(directory) {
  for (const item of (await readdir(directory)).sort()) {
    if (
      !item ||
      /[\\:\x00-\x1f]/.test(item) ||
      /[ .]$/.test(item) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(item)
    )
      throw Error("Unsupported artifact filename");
    const path = join(directory, item),
      stat = await lstat(path);
    const name = relative(source, path).split(sep).join("/");
    if (stat.isSymbolicLink())
      throw Error("Resolve and review links before preparing immutable artifacts");
    if (stat.isDirectory()) {
      await mkdir(join(destination, name), { mode: 0o700 });
      await walk(path);
    } else {
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw Error("Unsupported artifact file");
      const bytes = await readFile(path),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      const executable = !!(stat.mode & 0o111);
      // Copy the bytes hashed above, not a second read that may have changed.
      const packed = bytes.length > 64 * 1024 * 1024 ? gzipSync(bytes, { level: 9 }) : undefined;
      const compressed = packed
        ? { size: packed.length, sha256: createHash("sha256").update(packed).digest("hex") }
        : undefined;
      await writeFile(join(destination, name + (packed ? ".gz" : "")), packed ?? bytes, {
        flag: "wx",
        mode: executable ? 0o755 : 0o600,
      });
      files.push({
        path: name,
        sha256,
        size: bytes.length,
        executable,
        ...(compressed ? { compressed } : {}),
      });
    }
  }
}
await walk(source);
if (
  !files.length ||
  files.length > 100000 ||
  new Set(files.map((f) => f.path.toLowerCase())).size !== files.length ||
  files.reduce((sum, f) => sum + f.size, 0) > 2 ** 31
)
  throw Error("Invalid artifact inventory");
await writeFile(
  inventoryArgument,
  JSON.stringify(
    {
      directory: destinationArgument,
      files,
      artifactSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Prepared immutable artifact inventory. Commit the artifact tree before creating its signed catalog entry; native acceptance is still required.",
);
