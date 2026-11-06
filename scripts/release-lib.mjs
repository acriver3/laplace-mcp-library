// Pure helpers for scripts/release-connector.mjs. Local release tooling only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The catalog and acceptance records identify an artifact by the hash of its exact receipt list. */
export const artifactHash = (files) => sha256(JSON.stringify(files));
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];

/**
 * Paths (relative to `cwd`) whose bytes Git would change when storing them, e.g. CRLF files
 * under a `text=auto eol=lf` attribute (connectors ship their own nested .gitattributes).
 * Compares the filtered blob hash with the raw-bytes hash for every path in one batch each.
 */
export function gitWouldNormalize(paths, cwd) {
	if (!paths.length) return [];
	const run = (args) =>
		execFileSync("git", ["hash-object", ...args, "--stdin-paths"], {
			cwd,
			input: paths.join("\n") + "\n",
			encoding: "utf8",
			maxBuffer: 1 << 28,
		})
			.trim()
			.split("\n");
	const filtered = run([]);
	const raw = run(["--no-filters"]);
	if (filtered.length !== paths.length || raw.length !== paths.length)
		throw Error("git hash-object returned an unexpected number of hashes");
	return paths.filter((_, i) => filtered[i] !== raw[i]);
}

/** Gzip transport for one file; the receipt still describes the installed (original) bytes. */
export function compressForTransport(receipt, bytes) {
	if (sha256(bytes) !== receipt.sha256 || bytes.length !== receipt.size)
		throw Error(`Artifact file changed after preparation: ${receipt.path}`);
	const packed = gzipSync(bytes, { level: 9 });
	return { packed, receipt: { ...receipt, compressed: { size: packed.length, sha256: sha256(packed) } } };
}

/** The newest release entry for each platform of one connector/mode. */
export function latestByPlatform(index, id, mode) {
	const latest = new Map();
	for (const release of index.releases)
		if (release.id === id && release.mode === mode)
			for (const platform of release.platforms)
				if (!latest.has(platform) || latest.get(platform).sequence < release.sequence)
					latest.set(platform, release);
	return latest;
}

export function modesOf(index, id) {
	return [...new Set(index.releases.filter((r) => r.id === id).map((r) => r.mode))];
}

export function versionExists(index, catalog, id, version) {
	return (
		index.releases.some((r) => r.id === id && r.version === version) ||
		catalog.some((c) => c.id === id && c.version === version)
	);
}

/** Launch settings are part of the configuration revision; a change needs explicit migration. */
export function serverBlockChanged(previousManifest, nextManifest) {
	return JSON.stringify(previousManifest.server ?? null) !== JSON.stringify(nextManifest.server ?? null);
}

/**
 * New feed entries (one per platform, like existing releases) appended to a copy of the index.
 * Revisions are inherited from the previous release for that platform unless overridden.
 */
export function draftReleases(index, options) {
	const { id, mode, version, platforms, commit, directory, files } = options;
	if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("A full artifact commit is required");
	const latest = latestByPlatform(index, id, mode);
	if (!latest.size) throw Error(`No previous ${id} ${mode} release to base the entry on`);
	const releases = platforms.map((platform) => {
		if (!PLATFORMS.includes(platform)) throw Error(`Unsupported platform ${platform}`);
		const previous = latest.get(platform) ?? [...latest.values()].sort((a, b) => b.sequence - a.sequence)[0];
		const { files: _files, ...base } = previous;
		const entry = {
			...base,
			version,
			sequence: previous.sequence + 1,
			platforms: [platform],
			commit,
			directory,
			...(options.permissionRevision ? { permissionRevision: options.permissionRevision } : {}),
			...(options.configurationRevision ? { configurationRevision: options.configurationRevision } : {}),
			...(options.sessionRevision ? { sessionRevision: options.sessionRevision } : {}),
			qualified: true,
			qualificationSha256: "PENDING_ACCEPTANCE",
			files,
		};
		// Keep the same key order as existing entries so diffs stay readable.
		return Object.fromEntries(Object.keys(previous).map((k) => [k, entry[k]]).concat(
			Object.keys(entry).filter((k) => !(k in previous)).map((k) => [k, entry[k]]),
		));
	});
	return { index: { ...index, sequence: index.sequence + 1, releases: [...index.releases, ...releases] }, releases };
}

/** Release-owner acceptance in place of native results; never claims checks that did not run. */
export function acceptanceRecord({ target, distribution, commit, files, statement, at, reviewer }) {
	if (!statement?.trim()) throw Error("A verbatim acceptance statement is required");
	if (!Number.isFinite(Date.parse(at))) throw Error("Invalid acceptance time");
	const record = {
		schemaVersion: 1,
		target,
		distribution,
		commit,
		artifactSha256: artifactHash(files),
		reviewer: reviewer ?? "Laplace release owner (explicit acceptance in implementation chat)",
		completedAt: at,
		result: "accepted",
		localValidation: "passed",
		userAcceptance: { statement, acceptedAt: at, nativeResults: "not-attested" },
	};
	const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
	return { record, bytes, hash: sha256(bytes) };
}

/** Native evidence must already name this exact target, mode, commit and artifact. */
export function matchNativeEvidence(records, { target, distribution, commit, files }) {
	const want = artifactHash(files);
	return records.find(
		({ record }) =>
			record.result === "passed" &&
			record.target === target &&
			record.distribution === distribution &&
			record.commit === commit &&
			record.artifactSha256 === want,
	);
}
