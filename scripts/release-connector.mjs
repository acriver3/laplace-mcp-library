#!/usr/bin/env node
// One-command managed connector release: build → immutable artifact → feed entries →
// acceptance records → signed catalog → verify → commit. Local release tooling only.
// Usage: npm run release:connector -- <connector-id> <new-version> --accept "<verbatim statement>" [options]
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import {
	copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import {
	acceptanceRecord, artifactHash, compressForTransport, draftReleases, gitWouldNormalize, latestByPlatform,
	matchNativeEvidence, modesOf, serverBlockChanged, sha256, versionExists,
} from "./release-lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		accept: { type: "string" },
		"evidence-dir": { type: "string" },
		mode: { type: "string" },
		platforms: { type: "string" },
		"permission-revision": { type: "string" },
		"configuration-revision": { type: "string" },
		"session-revision": { type: "string" },
		reviewer: { type: "string" },
		key: { type: "string" },
		"pinned-key": { type: "string" },
		"doppler-scope": { type: "string" },
		"no-fetch": { type: "boolean" },
		"dry-run": { type: "boolean" },
		push: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});
const usage = `Usage: npm run release:connector -- <connector-id> <new-version> (--accept "<verbatim owner statement>" | --evidence-dir <dir>) [options]
  --mode tethered|background-browser   Required only if the connector has releases in both modes
  --platforms win32-x64,darwin-arm64   Default: platforms of the previous release
  --permission-revision <value>        Default: inherited (set when browser permissions change)
  --configuration-revision <value>     Required when manifest.json "server" (launch settings) changes
  --session-revision <value>           Default: inherited (set when sessions need migration)
  --key <pem>                          Default: $LAPLACE_UPDATE_SIGNING_KEY_FILE, else Doppler (laplace/prd)
  --doppler-scope <dir>                Doppler token scope (default: $LAPLACE_DOPPLER_SCOPE, else this repository)
  --pinned-key <spki base64>           Default: scripts/pinned-update-key.txt
  --dry-run                            Build, prepare, draft, accept and sign into .build/ only; commits nothing
  --push                               Push the release commits to origin/main when done
  --no-fetch                           Skip fetching origin before checking HEAD contains origin/main`;
if (opt.help || positionals.length !== 2) {
	console.log(usage);
	process.exit(opt.help ? 0 : 2);
}
const [id, version] = positionals;
const dry = !!opt["dry-run"];

// Failures throw so that cleanup in `finally` (signing key, dry-run artifact) always runs.
class ReleaseError extends Error {}
const fail = (message) => {
	throw new ReleaseError(message);
};
process.on("uncaughtException", (error) => {
	console.error(`\nrelease-connector: ${error instanceof ReleaseError ? error.message : error.stack}`);
	process.exit(1);
});
const step = (message) => console.error(`\n==> ${message}`);
const git = (args, options = {}) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, ...options }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

if (!/^[a-z0-9-]+$/.test(id)) fail("Invalid connector id");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("Supply an explicit semantic version");
if (!!opt.accept === !!opt["evidence-dir"]) fail("Give exactly one of --accept \"<statement>\" or --evidence-dir <dir>");
if (opt.push && dry) fail("--push cannot be combined with --dry-run");

// Resumable state for this release.
const stateDir = join(root, ".build", "release", `${id}-${version}${dry ? "-dryrun" : ""}`);
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, "state.json");
const state = existsSync(statePath) ? readJson(statePath) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
// A dry run never keeps its artifact tree, so it always prepares again (the built bundle is reused).
if (dry) delete state.prepared;

// 1. Preconditions -------------------------------------------------------------------------
step("Checking preconditions");
// When resuming, files this release already wrote (acceptance records, the signed catalog) are expected.
const owned = new Set(state.owned ?? []);
const dirty = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean)
	.map((line) => line.slice(3)).filter((path) => !owned.has(path));
if (dirty.length) fail(`Working tree is not clean (${dirty.slice(0, 3).join(", ")}). Commit or stash changes first.`);
if (!opt["no-fetch"]) {
	try {
		git(["fetch", "-q", "origin"]);
	} catch {
		fail("Could not fetch origin. Retry, or pass --no-fetch if you know HEAD is current.");
	}
}
if (spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root }).status !== 0)
	fail("HEAD does not contain origin/main. Rebase or merge origin/main first.");
if (!git(["ls-tree", "--name-only", "HEAD", `connectors/${id}`])) fail(`connectors/${id} is not committed`);
const index = JSON.parse(git(["show", "HEAD:updates/stable.json"]));
const catalog = readJson(join(root, "catalog/local-mcp-bundles.json"));
if (versionExists(index, catalog, id, version)) fail(`${id} ${version} is already released; versions are immutable`);
const modes = modesOf(index, id);
const mode = opt.mode ?? (modes.length === 1 ? modes[0] : undefined);
if (!mode) fail(`${id} has releases in ${modes.join(" and ") || "no"} modes; pass --mode`);
const latest = latestByPlatform(index, id, mode);
if (!latest.size) fail(`No previous ${id} ${mode} release in updates/stable.json`);
const platforms = opt.platforms ? opt.platforms.split(",").map((p) => p.trim()).filter(Boolean) : [...latest.keys()];
const directory = `updates/artifacts/${id}/${mode}/${version}/universal`;
const artifactDir = join(root, directory);
const pinned = (opt["pinned-key"] ?? readFileSync(join(root, "scripts/pinned-update-key.txt"), "utf8")).trim();
console.error(`${id} ${version} · ${mode} · ${platforms.join(", ")}${dry ? " · DRY RUN" : ""}`);

let createdArtifactDir = false;
let keyTemp;
try {
	// 2. Build and unpack ----------------------------------------------------------------------
	const mcpb = join(root, ".artifacts", `${id}-${version}-universal.mcpb`);
	const unpacked = join(stateDir, "unpacked");
	if (!state.prepared) {
		if (state.mcpb && existsSync(mcpb) && state.sourceCommit === git(["rev-parse", "HEAD"])) {
			step("Reusing built bundle");
		} else {
			if (existsSync(mcpb)) fail(`${mcpb} exists from an earlier build; remove it to rebuild`);
			step("Building bundle (runs the connector's tests in a clean stage)");
			const build = spawnSync(process.execPath, [join(root, "scripts/build-bundle.mjs"), id, version], {
				cwd: root,
				stdio: ["ignore", "pipe", "inherit"],
				maxBuffer: 1 << 28,
			});
			const out = build.stdout.toString();
			process.stderr.write(out);
			if (build.status !== 0) fail("Bundle build failed");
			const result = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith('{"id"')).pop() ?? "null");
			if (!result || result.file !== mcpb) fail("Could not read the build result");
			Object.assign(state, { sourceCommit: git(["rev-parse", "HEAD"]), mcpb: { sha256: result.sha256, size: result.size } });
			save();
		}
		if (sha256(readFileSync(mcpb)) !== state.mcpb.sha256) fail("Built bundle changed since it was recorded");
		rmSync(unpacked, { recursive: true, force: true });
		execFileSync("python3", ["-I", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", mcpb, unpacked]);

		// 3. Immutable artifact ----------------------------------------------------------------
		step(`Preparing ${directory}`);
		if (existsSync(artifactDir)) fail(`${directory} already exists; remove the uncommitted directory or resume a recorded release`);
		mkdirSync(dirname(artifactDir), { recursive: true });
		createdArtifactDir = true;
		const inventoryPath = join(stateDir, "inventory.json");
		rmSync(inventoryPath, { force: true });
		execFileSync(process.execPath, [join(root, "scripts/prepare-update-artifact.mjs"), unpacked, directory, inventoryPath], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
		const inventory = readJson(inventoryPath);
		const plain = inventory.files.filter((f) => !f.compressed).map((f) => `${directory}/${f.path}`);
		const normalized = new Set(gitWouldNormalize(plain, root));
		inventory.files = inventory.files.map((file) => {
			const path = `${directory}/${file.path}`;
			if (!normalized.has(path)) return file;
			const { packed, receipt } = compressForTransport(file, readFileSync(join(root, path)));
			writeFileSync(join(root, path + ".gz"), packed, { flag: "wx", mode: file.executable ? 0o755 : 0o600 });
			rmSync(join(root, path));
			return receipt;
		});
		inventory.artifactSha256 = artifactHash(inventory.files);
		writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");
		console.error(`${inventory.files.length} files; ${normalized.size} stored as gzip to keep Git from changing their bytes`);
		if (dry) {
			state.artifactCommit = git(["rev-parse", "HEAD"]);
		} else {
			git(["add", "-f", "--", directory]);
			git(["commit", "-q", "-m", `Add immutable ${id} ${version} update artifact`]);
			state.artifactCommit = git(["rev-parse", "HEAD"]);
			createdArtifactDir = false;
		}
		state.prepared = true;
		save();
	} else step(`Resuming from recorded artifact ${state.artifactCommit}`);
	const inventory = readJson(join(stateDir, "inventory.json"));

	step(dry ? "Verifying prepared bytes" : "Verifying committed bytes");
	verifyStored(inventory.files, dry ? null : state.artifactCommit);

	// 4. Feed entries ----------------------------------------------------------------------------
	step("Drafting feed entries");
	const previous = [...latest.values()].sort((a, b) => b.sequence - a.sequence)[0];
	const previousManifest = JSON.parse(readStored(previous, "manifest.json"));
	const nextManifest = readJson(join(artifactDir, "manifest.json"));
	if (nextManifest.version !== version) fail(`Packaged manifest version is ${nextManifest.version}, expected ${version}`);
	if (serverBlockChanged(previousManifest, nextManifest) && !opt["configuration-revision"])
		fail("manifest.json launch settings (server) changed since the previous release. Pass --configuration-revision <new value>; installed copies will wait for manual migration.");
	const { index: draft, releases } = draftReleases(index, {
		id, mode, version, platforms, commit: state.artifactCommit, directory, files: inventory.files,
		permissionRevision: opt["permission-revision"],
		configurationRevision: opt["configuration-revision"],
		sessionRevision: opt["session-revision"],
	});

	// 5. Acceptance ------------------------------------------------------------------------------
	step("Recording acceptance");
	const evidenceDir = dry ? join(stateDir, "acceptance") : join(root, "updates/acceptance");
	if (dry) {
		rmSync(evidenceDir, { recursive: true, force: true });
		mkdirSync(evidenceDir);
		for (const f of readdirSync(join(root, "updates/acceptance"))) copyFileSync(join(root, "updates/acceptance", f), join(evidenceDir, f));
	}
	state.acceptedAt ??= new Date().toISOString();
	save();
	const native = opt["evidence-dir"]
		? readdirSync(opt["evidence-dir"]).filter((f) => f.endsWith(".json")).map((f) => {
				const bytes = readFileSync(join(opt["evidence-dir"], f));
				return { bytes, hash: sha256(bytes), record: JSON.parse(bytes) };
			})
		: [];
	for (const release of releases) {
		const target = release.platforms[0];
		const evidence = opt.accept
			? acceptanceRecord({ target, distribution: mode, commit: release.commit, files: release.files, statement: opt.accept, at: state.acceptedAt, reviewer: opt.reviewer })
			: matchNativeEvidence(native, { target, distribution: mode, commit: release.commit, files: release.files });
		if (!evidence) fail(`No native evidence in ${opt["evidence-dir"]} for ${target} ${mode} at ${release.commit}`);
		const path = join(evidenceDir, `${evidence.hash}.json`);
		if (!dry) {
			state.owned = [...new Set([...(state.owned ?? []), `updates/acceptance/${evidence.hash}.json`, "updates/stable.json", "updates/stable.json.sig"])];
			save();
		}
		if (!existsSync(path)) writeFileSync(path, evidence.bytes, { flag: "wx" });
		else if (sha256(readFileSync(path)) !== evidence.hash) fail(`${path} exists with different bytes`);
		release.qualificationSha256 = evidence.hash;
		console.error(`${target}: ${evidence.hash}`);
	}
	const qualifiedPath = join(stateDir, "stable-qualified.json");
	writeFileSync(qualifiedPath, JSON.stringify(draft));

	// 6. Sign ------------------------------------------------------------------------------------
	step("Signing the catalog");
	let keyFile = opt.key ?? process.env.LAPLACE_UPDATE_SIGNING_KEY_FILE;
	if (!keyFile) {
		keyTemp = mkdtempSync(join(tmpdir(), "laplace-release-key-"));
		keyFile = join(keyTemp, "key.pem");
		const scope = opt["doppler-scope"] ?? process.env.LAPLACE_DOPPLER_SCOPE;
		const pem = spawnSync("doppler", ["secrets", "get", "LAPLACE_DESKTOP_UPDATE_SIGNING_PRIVATE_KEY", "--project", "laplace", "--config", "prd", "--plain", ...(scope ? ["--scope", scope] : [])], { encoding: "utf8" });
		if (pem.status !== 0 || !pem.stdout.includes("PRIVATE KEY"))
			fail(`Could not read the signing key from Doppler${/token/i.test(pem.stderr ?? "") ? " (no token for this directory; pass --doppler-scope <dir with a Doppler login>)" : ""}. Or pass --key / set LAPLACE_UPDATE_SIGNING_KEY_FILE.`);
		writeFileSync(keyFile, pem.stdout, { mode: 0o600, flag: "wx" });
	}
	const derived = createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ type: "spki", format: "der" }).toString("base64");
	if (derived !== pinned) fail("Signing key does not match the public key pinned by Desktop and Laplace Local");
	const signed = join(stateDir, "stable.json");
	rmSync(signed, { force: true });
	rmSync(signed + ".sig", { force: true });
	execFileSync(process.execPath, [join(root, "scripts/sign-update-catalog.mjs"), qualifiedPath, keyFile, signed, evidenceDir], { cwd: root, stdio: "inherit" });
	if (keyTemp) {
		rmSync(keyTemp, { recursive: true, force: true });
		keyTemp = undefined;
	}
	const signedBytes = readFileSync(signed);
	const signature = readFileSync(signed + ".sig");
	const pinnedKey = createPublicKey({ key: Buffer.from(pinned, "base64"), format: "der", type: "spki" });
	if (!verify(null, signedBytes, pinnedKey, signature)) fail("Signature does not verify against the pinned key");
	console.error(`Signed index sequence ${draft.sequence} (${draft.releases.length} releases); signature verified`);

	if (dry) {
		console.log(`\nDry run complete. Nothing was committed. Signed catalog: ${signed}\nAcceptance records: ${evidenceDir}\nBuilt bundle (remove before a real release of this version): ${mcpb}`);
	} else {
		// 7. Install, verify, commit -----------------------------------------------------------------
		step("Installing the signed catalog and running npm run verify");
		writeFileSync(join(root, "updates/stable.json"), signedBytes);
		writeFileSync(join(root, "updates/stable.json.sig"), signature);
		const verifyRun = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "verify"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
		if (verifyRun.status !== 0) fail("npm run verify failed; the signed catalog is installed but not committed");
		git(["add", "updates/stable.json", "updates/stable.json.sig", ...releases.map((r) => `updates/acceptance/${r.qualificationSha256}.json`)]);
		const statement = opt.accept
			? `Release-owner acceptance (verbatim): "${opt.accept}"\nRecorded as acceptance; native results are not attested.`
			: `Qualified by native evidence from ${opt["evidence-dir"]}.`;
		git(["commit", "-q", "-m", `Sign ${id} ${version} for ${platforms.join(", ")}\n\n${statement}`]);
		for (const name of ["stable.json", "stable.json.sig"])
			if (sha256(execFileSync("git", ["show", `HEAD:updates/${name}`], { cwd: root, maxBuffer: 1 << 28 })) !== sha256(name.endsWith(".sig") ? signature : signedBytes))
				fail(`Committed updates/${name} differs from the signed bytes`);
		const raw = "https://raw.githubusercontent.com/acriver3/laplace-mcp-library";
		console.log(`\nRelease ${id} ${version} committed (${git(["rev-parse", "--short", "HEAD"])}).`);
		const pushCommand = "git push origin HEAD:main";
		if (opt.push) {
			step("Pushing to origin/main");
			execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: root, stdio: "inherit" });
		} else console.log(`Publish with:\n  ${pushCommand}`);
		console.log(`Check after publishing:
  curl -fsSL ${raw}/main/updates/stable.json | sha256sum   # expect ${sha256(signedBytes)}
  curl -fsSL ${raw}/main/updates/stable.json.sig | sha256sum   # expect ${sha256(signature)}
  curl -fsSL ${raw}/${state.artifactCommit}/${directory}/manifest.json | grep '"version"'`);
	}
} finally {
	if (keyTemp) rmSync(keyTemp, { recursive: true, force: true });
	// A dry run never leaves an uncommitted artifact tree behind (it would block the next release).
	if (dry && createdArtifactDir) rmSync(dirname(artifactDir), { recursive: true, force: true });
}

/** Bytes of one artifact file as installed, from a commit (or the working tree when commit is null). */
function readStored(release, path) {
	const file = release.files.find((f) => f.path === path);
	if (!file) fail(`${release.version} has no ${path}`);
	const stored = `${release.directory}/${path}${file.compressed ? ".gz" : ""}`;
	const bytes = execFileSync("git", ["show", `${release.commit}:${stored}`], { cwd: root, maxBuffer: 1 << 28 });
	return (file.compressed ? gunzipSync(bytes) : bytes).toString("utf8");
}

/** Every stored blob (or working-tree file) must match its receipt exactly. */
function verifyStored(files, commit) {
	const stored = files.map((f) => `${directory}/${f.path}${f.compressed ? ".gz" : ""}`);
	const expected = files.map((f) => (f.compressed ? f.compressed.sha256 : f.sha256));
	let actual;
	if (commit) {
		const tracked = git(["ls-tree", "-r", "--name-only", commit, "--", directory]).split("\n").filter(Boolean);
		if (tracked.length !== files.length) fail(`${commit} tracks ${tracked.length} artifact files; inventory has ${files.length}`);
		const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: stored.map((p) => `${commit}:${p}`).join("\n") + "\n", maxBuffer: 1 << 30 });
		actual = [];
		for (let offset = 0; actual.length < stored.length; ) {
			const end = out.indexOf(10, offset);
			const [, type, size] = out.subarray(offset, end).toString().split(" ");
			if (type !== "blob") fail(`Missing committed artifact file ${stored[actual.length]}`);
			actual.push(sha256(out.subarray(end + 1, end + 1 + Number(size))));
			offset = end + 1 + Number(size) + 1;
		}
	} else actual = stored.map((p) => sha256(readFileSync(join(root, p))));
	const bad = stored.filter((_, i) => actual[i] !== expected[i]);
	if (bad.length) fail(`${bad.length} artifact files differ from the inventory, e.g. ${bad.slice(0, 3).join(", ")}`);
	console.error(`${files.length} files match the inventory`);
}
