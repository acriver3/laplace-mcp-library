import { gunzipSync } from "node:zlib";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { resolve, sep, join } from "node:path";

import { verifyAcceptance } from "./update-acceptance.mjs";
const [input, keyFile, output, evidenceDirectory] = process.argv.slice(2);
if (!input || !keyFile || !output || !evidenceDirectory)
  throw Error(
    "Usage: sign-update-catalog <qualified-catalog.json> <private-key.pem> <output.json> <acceptance-directory>",
  );
const index = JSON.parse(await readFile(input, "utf8"));
if (
  index.schemaVersion !== 1 ||
  !Number.isSafeInteger(index.sequence) ||
  index.sequence < 1 ||
  !Array.isArray(index.releases)
)
  throw Error("Invalid catalog");
const seen = new Set();
for (const release of index.releases) {
  const identities =
    release.platforms?.map(
      (platform) => `${release.id}/${release.mode}/${release.version}/${platform}`,
    ) ?? [];
  if (
    identities.some((identity) => seen.has(identity)) ||
    release.channel !== "stable" ||
    release.qualified !== true ||
    !release.platforms?.length ||
    !release.permissionRevision ||
    !release.configurationRevision ||
    !/^[a-f0-9]{40}$/.test(release.commit)
  )
    throw Error("Incomplete or duplicate qualified release");
  for (const identity of identities) seen.add(identity);
  if (
    !/^[a-z0-9-]+$/.test(release.id) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version) ||
    !["tethered", "background-browser"].includes(release.mode) ||
    !Number.isSafeInteger(release.sequence) ||
    release.sequence < 1 ||
    !/^\d+\.\d+\.\d+$/.test(release.minDesktop) ||
    !/^\d+\.\d+\.\d+$/.test(release.minCli) ||
    !release.files?.length ||
    release.files.length > 100000 ||
    new Set(release.files.map((f) => f.path.toLowerCase())).size !== release.files.length
  )
    throw Error("Invalid connector release contract");
  for (const platform of release.platforms) {
    if (!["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"].includes(platform))
      throw Error("Unsupported platform");
    const evidence = await verifyAcceptance(
      evidenceDirectory,
      release.qualificationSha256,
      platform,
      release.mode,
    );
    const artifactHash = createHash("sha256").update(JSON.stringify(release.files)).digest("hex");
    if (evidence.commit !== release.commit || evidence.artifactSha256 !== artifactHash)
      throw Error("Acceptance does not cover connector artifacts");
  }
  const root = resolve(release.directory);
  for (const file of release.files) {
    const storedPath = file.path + (file.compressed ? ".gz" : "");
    const path = resolve(root, storedPath);
    if (
      !path.startsWith(root + sep) ||
      /[\\:\x00-\x1f]/.test(file.path) ||
      file.path
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            /[ .]$/.test(p) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 256 * 1024 * 1024 ||
      typeof file.executable !== "boolean" ||
      (await lstat(path)).isSymbolicLink()
    )
      throw Error("Unsafe connector artifact path");
    let parent = root;
    for (const part of storedPath.split("/")) {
      parent = join(parent, part);
      if ((await lstat(parent)).isSymbolicLink()) throw Error("Linked artifact rejected");
    }
    let bytes = await readFile(path);
    if (file.compressed) {
      if (
        !Number.isSafeInteger(file.compressed.size) ||
        file.compressed.size < 1 ||
        file.compressed.size > 256 * 1024 * 1024 ||
        bytes.length !== file.compressed.size ||
        createHash("sha256").update(bytes).digest("hex") !== file.compressed.sha256
      )
        throw Error("Compressed artifact changed");
      bytes = gunzipSync(bytes, { maxOutputLength: Math.max(1, file.size) });
    }
    if (
      bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw Error("Connector artifact changed after qualification");
  }
}
const key = createPrivateKey(await readFile(keyFile));
if (key.asymmetricKeyType !== "ed25519") throw Error("Use an Ed25519 signing key");
const bytes = Buffer.from(JSON.stringify(index));
await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
await writeFile(output + ".sig", sign(null, bytes, key), { flag: "wx", mode: 0o600 });
