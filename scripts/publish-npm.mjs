#!/usr/bin/env node
// Publish a reviewed connector source to npm as @withlaplace/<id>, for runtime-managed npm installs.
// Usage: npm run publish:npm -- <connector-id> <version> [--dry-run] [--otp <code>]
// Builds from a clean checkout of origin/main, pins the whole dependency tree with
// npm-shrinkwrap.json, publishes the exact tarball without lifecycle scripts, and verifies that
// the registry serves the same bytes. Published npm versions are immutable: fixes need a new version.
//
// Connectors with a Go server (Slack) also publish one package per platform,
// @withlaplace/<id>-<os>-<cpu>, holding only the cross-compiled server with npm os/cpu fields.
// They are published first, at the same version; the main package lists them as exact
// optionalDependencies and its shrinkwrap pins their tarball integrity, so npm installs only the
// matching one. Re-running after a partial publish reuses platform packages that this same commit
// already published (for example when the one-time password expired midway).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const otp = args.includes("--otp") ? args[args.indexOf("--otp") + 1] : undefined;
const [id, version] = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--otp");
const connectors = {
	"msoutlook-mcp": { build: ["build"], test: true, workspaces: true },
	"canvas-session-mcp": { build: [], test: true, workspaces: false },
	"yale-som-ems-mcp": { build: ["build"], test: true, workspaces: true },
	"yale-som-cms-mcp": { build: ["build"], test: true, workspaces: true },
	"linkedin-mcp-server": { build: [], test: true, workspaces: false },
	"slack-mcp-server": {
		build: [],
		test: true,
		workspaces: false,
		go: {
			lock: "scripts/slack-runtime-lock.json",
			command: "./cmd/slack-mcp-server",
			versionVariable: "github.com/korotovsky/slack-mcp-server/pkg/version.Version",
			binary: "slack-mcp-server",
			test: ["test", "-skip", "TestIntegration", "./..."],
		},
	},
};
assert(Object.hasOwn(connectors, id ?? ""), `Choose one of: ${Object.keys(connectors).join(", ")}`);
assert(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version ?? ""), "Supply an exact version");
const spec = connectors[id];
const name = `@withlaplace/${id}`;
const registry = "https://registry.npmjs.org/";
const repository = "git+https://github.com/acriver3/laplace-mcp-library.git";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
function run(command, commandArgs, cwd, options = {}) {
	return execFileSync(command, commandArgs, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32" && command === npm,
		...options,
	});
}
/** Registry metadata for name@version, or undefined if that version does not exist (E404). */
function registryVersion(packageName) {
	try {
		const text = execFileSync(
			npm,
			["view", `${packageName}@${version}`, "--json", "--registry", registry],
			{ encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}
const integrityOf = (file) =>
	"sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");
const tarballUrl = (packageName) =>
	`${registry}${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`;

/** Packs a staged package and checks its file list; returns the tarball path, listing and integrity. */
function pack(stage, manifest, extraChecks = () => {}) {
	run(npm, ["pack", "--ignore-scripts", "--pack-destination", stage], stage);
	const tarball = join(stage, readdirSync(stage).find((file) => file.endsWith(".tgz")));
	const listing = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" }).trim().split("\n");
	const contents = listing.map((line) => line.split(/\s+/).pop());
	for (const required of ["package/package.json", "package/npm-shrinkwrap.json"])
		assert(contents.includes(required), `${manifest.name}: tarball lacks ${required}`);
	assert(
		!contents.some((file) => /(^|\/)(\.env|node_modules)(\/|$)/.test(file)),
		`${manifest.name}: unexpected files`,
	);
	extraChecks(contents, listing);
	return { tarball, files: contents.length, integrity: integrityOf(tarball) };
}

function publish(packed, packageName) {
	run(
		npm,
		[
			"publish",
			packed.tarball,
			"--access",
			"public",
			"--tag",
			"latest",
			"--ignore-scripts",
			...(otp ? ["--otp", otp] : []),
		],
		dirname(packed.tarball),
	);
	let served;
	for (let attempt = 0; attempt < 60 && !served; attempt++) {
		served = registryVersion(packageName)?.dist?.integrity;
		if (!served) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
	}
	assert.equal(served, packed.integrity, `${packageName}: registry integrity does not match`);
	console.log(`Published ${packageName}@${version} (${packed.integrity})`);
}

git("fetch", "-q", "origin", "main");
assert.equal(git("status", "--porcelain"), "", "Commit or stash local changes first");
const commit = git("rev-parse", "HEAD");
assert.equal(commit, git("rev-parse", "origin/main"), "Publish only the current origin/main");
assert.equal(registryVersion(name), undefined, `${name}@${version} is already published`);

const go = spec.go && JSON.parse(readFileSync(join(root, spec.go.lock), "utf8"));
const targets = go ? Object.keys(go.targets) : [];
const platformName = (target) => `${name}-${target}`;
const existing = {};
for (const target of targets) {
	const meta = registryVersion(platformName(target));
	if (!meta) continue;
	assert.equal(
		meta.laplace?.libraryCommit,
		commit,
		`${platformName(target)}@${version} was published from another commit; choose a new version`,
	);
	existing[target] = meta.dist.integrity;
}

mkdirSync(join(root, ".build"), { recursive: true });
const work = mkdtempSync(join(root, ".build", `npm-${id}-`));
const stage = join(work, "package");
mkdirSync(stage);
try {
	const source = execFileSync("git", ["archive", `${commit}:connectors/${id}`], {
		cwd: root,
		maxBuffer: 200 * 1024 * 1024,
	});
	execFileSync("tar", ["-x", "-C", stage], { input: source });
	const workspaces = spec.workspaces ? ["--workspaces=false"] : [];
	run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...workspaces], stage);
	for (const script of spec.build) run(npm, ["run", script], stage);
	if (spec.test) run(npm, ["test"], stage);

	// Per-platform Go server packages.
	const platforms = {};
	if (go) {
		const goBinary = process.env.GO_BINARY || "go";
		const goEnv = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly", CGO_ENABLED: "0" };
		const goRun = (goArgs, options = {}) =>
			execFileSync(goBinary, goArgs, { cwd: stage, env: goEnv, encoding: "utf8", ...options });
		assert.equal(goRun(["version"]).split(" ")[2], go.goVersion, `Use Go ${go.goVersion} (GO_BINARY)`);
		goRun(["mod", "download"], { stdio: "inherit" });
		if (spec.go.test) goRun(spec.go.test, { stdio: "inherit" });
		// Go and module notices travel with the statically linked binary.
		const notices = join(work, "go-licenses");
		mkdirSync(join(notices, "go-modules"), { recursive: true });
		copyFileSync(join(goRun(["env", "GOROOT"]).trim(), "LICENSE"), join(notices, "Go-LICENSE"));
		const records = [];
		const modules = goRun(["list", "-m", "-json", "all"], { maxBuffer: 50 * 1024 * 1024 });
		for (const chunk of modules.split(/\n}\n?/).filter((text) => text.trim())) {
			const module = JSON.parse(chunk + "}");
			if (module.Main || !module.Dir) continue;
			const files = readdirSync(module.Dir).filter((file) =>
				/^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(file),
			);
			assert(files.length, `Missing license for Go module ${module.Path}`);
			const destination = join(notices, "go-modules", `${module.Path.replaceAll("/", "_")}@${module.Version}`);
			mkdirSync(destination);
			for (const file of files) copyFileSync(join(module.Dir, file), join(destination, file));
			records.push({ module: module.Path, version: module.Version, notices: files });
		}
		writeFileSync(join(notices, "go-modules", "index.json"), JSON.stringify(records, null, 2) + "\n");

		for (const target of targets) {
			const { goos, goarch } = go.targets[target];
			const [os, cpu] = target.split("-");
			const packageName = platformName(target);
			const directory = join(work, target);
			const binary = `bin/${spec.go.binary}${goos === "windows" ? ".exe" : ""}`;
			mkdirSync(join(directory, "bin"), { recursive: true });
			goRun(
				[
					"build",
					"-trimpath",
					"-buildvcs=false",
					"-ldflags",
					`-s -w -X ${spec.go.versionVariable}=${version}`,
					"-o",
					join(directory, binary),
					spec.go.command,
				],
				{ env: { ...goEnv, GOOS: goos, GOARCH: goarch }, stdio: "inherit" },
			);
			copyFileSync(join(stage, "LICENSE"), join(directory, "LICENSE"));
			cpSync(notices, join(directory, "licenses"), { recursive: true });
			const manifest = {
				name: packageName,
				version,
				description: `Slack MCP Go server for ${target}. Installed automatically by ${name}.`,
				license: "MIT",
				os: [os],
				cpu: [cpu],
				files: [binary, "LICENSE", "licenses", "npm-shrinkwrap.json"],
				repository: { type: "git", url: repository, directory: `connectors/${id}` },
				publishConfig: { access: "public", registry },
				laplace: { libraryCommit: commit, goVersion: go.goVersion, cgo: false, target },
			};
			writeFileSync(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
			const self = { name: packageName, version, license: "MIT", os: [os], cpu: [cpu] };
			const shrinkwrap = { name: packageName, version, lockfileVersion: 3, requires: true, packages: { "": self } };
			writeFileSync(join(directory, "npm-shrinkwrap.json"), JSON.stringify(shrinkwrap, null, 2) + "\n");
			const packed = pack(directory, manifest, (contents, listing) => {
				assert(contents.includes(`package/${binary}`), `${packageName}: tarball lacks ${binary}`);
				const line = listing.find((entry) => entry.endsWith(`package/${binary}`));
				if (goos !== "windows") assert.match(line, /^-rwx/, `${packageName}: ${binary} is not executable`);
			});
			platforms[target] = { packageName, manifest, packed, os, cpu };
		}
	}

	const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
	const upstream = manifest.name;
	manifest.name = name;
	manifest.version = version;
	manifest.repository = { type: "git", url: repository, directory: `connectors/${id}` };
	manifest.publishConfig = { access: "public", registry };
	manifest.laplace = { libraryCommit: commit, upstream };
	if (Array.isArray(manifest.files)) manifest.files.push("npm-shrinkwrap.json");
	const optional = Object.fromEntries(targets.map((target) => [platformName(target), version]));
	if (targets.length) manifest.optionalDependencies = optional;
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
	if (targets.length) {
		lock.packages[""].optionalDependencies = optional;
		for (const [target, platform] of Object.entries(platforms)) {
			lock.packages[`node_modules/${platform.packageName}`] = {
				version,
				resolved: tarballUrl(platform.packageName),
				// An already-published platform package is pinned to the bytes the registry serves.
				integrity: existing[target] ?? platform.packed.integrity,
				license: "MIT",
				optional: true,
				os: [platform.os],
				cpu: [platform.cpu],
			};
		}
	}
	writeFileSync(join(stage, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2) + "\n");
	rmSync(join(stage, "package-lock.json"));

	const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
	const packed = pack(stage, manifest, (contents) =>
		assert(bin && contents.includes(`package/${bin.replace(/^\.\//, "")}`), "Tarball lacks its command"),
	);

	// Install the packed main package together with this machine's platform package, as a user
	// would, and run the server binary it locates (offline: --catalog-json needs no Slack sign-in).
	const host = `${process.platform}-${process.arch}`;
	if (platforms[host]) {
		const project = join(work, "install-check");
		mkdirSync(project);
		writeFileSync(join(project, "package.json"), '{"private":true}\n');
		run(
			npm,
			["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", packed.tarball, platforms[host].packed.tarball],
			project,
		);
		const installed = join(project, "node_modules", ...name.split("/"));
		const located = execFileSync(
			process.execPath,
			["--input-type=module", "-e", `import { serverBinary } from ${JSON.stringify(join(installed, "browser/server-binary.mjs"))}; process.stdout.write(serverBinary());`],
			{ encoding: "utf8" },
		);
		assert(located.includes(platforms[host].packageName.split("/").pop()), `Unexpected server: ${located}`);
		const tools = JSON.parse(execFileSync(located, ["--catalog-json"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
		assert(Object.keys(tools).length, "The server reported no tools");
		console.log(`Install check: ${host} resolved ${located} and listed its tools`);
	} else if (targets.length) {
		console.log(`Install check skipped: no platform package for ${host}`);
	}

	const summary = [
		...Object.entries(platforms).map(([target, platform]) => ({
			name: platform.packageName,
			version,
			files: platform.packed.files,
			integrity: platform.packed.integrity,
			...(existing[target] ? { alreadyPublished: existing[target] } : {}),
		})),
		{ name, version, commit, files: packed.files, integrity: packed.integrity },
	];
	for (const entry of summary) console.log(JSON.stringify(entry));
	if (dryRun) {
		if (targets.length)
			console.log(
				`Dry run: nothing published. A real run publishes the ${targets.length} platform packages first, ` +
					`waits until the registry serves each one with the integrity pinned in ${name}'s ` +
					`npm-shrinkwrap.json, then publishes ${name}. Until then, installing ${name} from the ` +
					"registry would skip its server package, so the check above installs the local tarballs.",
			);
	} else {
		for (const [target, platform] of Object.entries(platforms)) {
			if (existing[target]) console.log(`Reusing ${platform.packageName}@${version} (${existing[target]})`);
			else publish(platform.packed, platform.packageName);
		}
		publish(packed, name);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
