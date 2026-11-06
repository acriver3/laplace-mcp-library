#!/usr/bin/env node
// Publish a reviewed connector source to npm as @laplace/<id>, for runtime-managed npm installs.
// Usage: npm run publish:npm -- <connector-id> <version> [--dry-run] [--otp <code>]
// Builds from a clean checkout of origin/main, pins the whole dependency tree with
// npm-shrinkwrap.json, publishes the exact tarball without lifecycle scripts, and verifies that
// the registry serves the same bytes. Published npm versions are immutable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const otp = args.includes("--otp") ? args[args.indexOf("--otp") + 1] : undefined;
const [id, version] = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--otp");
const connectors = {
	"msoutlook-mcp": { build: ["build"], test: true, workspaces: true },
	"canvas-session-mcp": { build: [], test: true, workspaces: false },
};
assert(Object.hasOwn(connectors, id ?? ""), `Choose one of: ${Object.keys(connectors).join(", ")}`);
assert(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version ?? ""), "Supply an exact version");
const name = `@laplace/${id}`;
const registry = "https://registry.npmjs.org/";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
function run(command, commandArgs, cwd, options = {}) {
	return execFileSync(command, commandArgs, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
}

git("fetch", "-q", "origin", "main");
assert.equal(git("status", "--porcelain"), "", "Commit or stash local changes first");
const commit = git("rev-parse", "HEAD");
assert.equal(commit, git("rev-parse", "origin/main"), "Publish only the current origin/main");
let published = "";
try {
	published = execFileSync(npm, ["view", `${name}@${version}`, "version", "--registry", registry], {
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {} // E404: the package or version does not exist yet.
assert.equal(published, "", `${name}@${version} is already published`);

mkdirSync(join(root, ".build"), { recursive: true });
const stage = mkdtempSync(join(root, ".build", `npm-${id}-`));
try {
	const source = execFileSync("git", ["archive", `${commit}:connectors/${id}`], {
		cwd: root,
		maxBuffer: 200 * 1024 * 1024,
	});
	execFileSync("tar", ["-x", "-C", stage], { input: source });
	const spec = connectors[id];
	const workspaces = spec.workspaces ? ["--workspaces=false"] : [];
	run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...workspaces], stage);
	for (const script of spec.build) run(npm, ["run", script], stage);
	if (spec.test) run(npm, ["test"], stage);

	const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
	const upstream = manifest.name;
	manifest.name = name;
	manifest.version = version;
	manifest.repository = {
		type: "git",
		url: "git+https://github.com/acriver3/laplace-mcp-library.git",
		directory: `connectors/${id}`,
	};
	manifest.publishConfig = { access: "public", registry };
	manifest.laplace = { libraryCommit: commit, upstream };
	if (Array.isArray(manifest.files)) manifest.files.push("npm-shrinkwrap.json");
	delete manifest.scripts;
	delete manifest.private;
	writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	// The shrinkwrap pins every transitive dependency for installs of this package.
	const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
	lock.name = name;
	lock.version = version;
	lock.packages[""] = { ...lock.packages[""], name, version };
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (!path || entry.link || entry.inBundle) continue;
		assert(
			entry.resolved?.startsWith(registry) && entry.integrity?.startsWith("sha512-"),
			`${path} is not pinned to the npm registry`,
		);
	}
	writeFileSync(join(stage, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2) + "\n");
	rmSync(join(stage, "package-lock.json"));

	run(npm, ["pack", "--ignore-scripts", "--pack-destination", stage], stage);
	const tarball = join(stage, readdirSync(stage).find((file) => file.endsWith(".tgz")));
	const contents = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
	for (const required of ["package/package.json", "package/npm-shrinkwrap.json"])
		assert(contents.includes(required), `Tarball lacks ${required}`);
	assert(!contents.some((file) => /(^|\/)(\.env|node_modules)(\/|$)/.test(file)), "Unexpected files");
	const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
	assert(bin && contents.includes(`package/${bin.replace(/^\.\//, "")}`), "Tarball lacks its command");
	const bytes = readFileSync(tarball);
	const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
	console.log(JSON.stringify({ name, version, commit, files: contents.length - 1, integrity }));
	if (dryRun) process.exit(0);

	run(
		npm,
		[
			"publish",
			tarball,
			"--access",
			"public",
			"--tag",
			"latest",
			"--ignore-scripts",
			...(otp ? ["--otp", otp] : []),
		],
		stage,
	);
	let served;
	for (let attempt = 0; attempt < 10 && !served; attempt++) {
		try {
			served = execFileSync(
				npm,
				["view", `${name}@${version}`, "dist.integrity", "--registry", registry],
				{ encoding: "utf8", shell: process.platform === "win32" },
			).trim();
		} catch {}
		if (!served) await new Promise((accept) => setTimeout(accept, 3000));
	}
	assert.equal(served, integrity, "Registry integrity does not match the published tarball");
	console.log(`Published ${name}@${version} (${integrity})`);
} finally {
	rmSync(stage, { recursive: true, force: true });
}
