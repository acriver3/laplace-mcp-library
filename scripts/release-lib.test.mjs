import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { verifyAcceptance } from "./update-acceptance.mjs";
import {
	acceptanceRecord, artifactHash, compressForTransport, draftReleases, gitWouldNormalize, latestByPlatform,
	matchNativeEvidence, modesOf, serverBlockChanged, sha256, versionExists,
} from "./release-lib.mjs";

const files = [{ path: "manifest.json", sha256: "a".repeat(64), size: 2, executable: false }];
const entry = (over) => ({
	id: "demo", version: "1.0.0", sequence: 1, mode: "background-browser", channel: "stable", platforms: ["win32-x64"],
	minDesktop: "0.1.28", minCli: "0.1.5", sessionRevision: "1", permissionRevision: "perm-1", configurationRevision: "conf-1",
	qualified: true, qualificationSha256: "b".repeat(64), commit: "c".repeat(40), directory: "updates/artifacts/demo/x/1.0.0/universal",
	files, ...over,
});
const index = {
	schemaVersion: 1,
	sequence: 4,
	releases: [
		entry({}),
		entry({ platforms: ["darwin-arm64"] }),
		entry({ version: "1.1.0", sequence: 2, permissionRevision: "perm-2" }),
		entry({ mode: "tethered", platforms: ["win32-x64"], sequence: 7 }),
		entry({ id: "other", sequence: 9 }),
	],
};

test("newline detection finds exactly the files Git would change", () => {
	const repo = mkdtempSync(join(tmpdir(), "release-lib-git-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n*.bin -text\n");
		writeFileSync(join(repo, "crlf.js"), "a\r\nb\r\n");
		writeFileSync(join(repo, "lf.js"), "a\nb\n");
		writeFileSync(join(repo, "raw.bin"), "a\r\nb\r\n");
		assert.deepEqual(gitWouldNormalize(["crlf.js", "lf.js", "raw.bin"], repo), ["crlf.js"]);
		assert.deepEqual(gitWouldNormalize([], repo), []);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("gzip transport keeps the installed receipt and adds the transport receipt", () => {
	const bytes = Buffer.from("a\r\nb\r\n");
	const receipt = { path: "x.js", sha256: sha256(bytes), size: bytes.length, executable: false };
	const { packed, receipt: next } = compressForTransport(receipt, bytes);
	assert.deepEqual(gunzipSync(packed), bytes);
	assert.deepEqual(next, { ...receipt, compressed: { size: packed.length, sha256: sha256(packed) } });
	assert.deepEqual(Object.keys(next), ["path", "sha256", "size", "executable", "compressed"]);
	assert.throws(() => compressForTransport(receipt, Buffer.from("changed")), /changed after preparation/);
});

test("latest entries are chosen per platform within one connector and mode", () => {
	const latest = latestByPlatform(index, "demo", "background-browser");
	assert.equal(latest.get("win32-x64").version, "1.1.0");
	assert.equal(latest.get("darwin-arm64").version, "1.0.0");
	assert.deepEqual(modesOf(index, "demo").sort(), ["background-browser", "tethered"]);
	assert.equal(versionExists(index, [], "demo", "1.1.0"), true);
	assert.equal(versionExists(index, [{ id: "demo", version: "2.0.0" }], "demo", "2.0.0"), true);
	assert.equal(versionExists(index, [], "demo", "2.0.0"), false);
});

test("drafting bumps index and per-connector sequences and inherits revisions", () => {
	const next = [{ path: "manifest.json", sha256: "d".repeat(64), size: 3, executable: false }];
	const { index: draft, releases } = draftReleases(index, {
		id: "demo", mode: "background-browser", version: "1.2.0", platforms: ["win32-x64", "darwin-arm64"],
		commit: "e".repeat(40), directory: "updates/artifacts/demo/background-browser/1.2.0/universal", files: next,
	});
	assert.equal(draft.sequence, 5);
	assert.equal(draft.releases.length, index.releases.length + 2);
	assert.equal(index.releases.length, 5, "input index is not mutated");
	const [win, mac] = releases;
	assert.deepEqual([win.sequence, mac.sequence], [3, 2]);
	assert.deepEqual([win.permissionRevision, mac.permissionRevision], ["perm-2", "perm-1"]);
	assert.deepEqual(win.platforms, ["win32-x64"]);
	assert.equal(win.qualificationSha256, "PENDING_ACCEPTANCE");
	assert.equal(win.files, next);
	assert.deepEqual(Object.keys(win), Object.keys(index.releases[0]), "same key order as existing entries");
	const override = draftReleases(index, {
		id: "demo", mode: "background-browser", version: "1.2.0", platforms: ["win32-x64"], commit: "e".repeat(40),
		directory: "d", files: next, configurationRevision: "conf-2", permissionRevision: "perm-3",
	}).releases[0];
	assert.deepEqual([override.configurationRevision, override.permissionRevision], ["conf-2", "perm-3"]);
	assert.throws(() => draftReleases(index, { id: "demo", mode: "background-browser", version: "1.2.0", platforms: ["win32-x64"], commit: "HEAD", directory: "d", files: next }), /full artifact commit/);
	assert.throws(() => draftReleases(index, { id: "demo", mode: "background-browser", version: "1.2.0", platforms: ["linux-arm64"], commit: "e".repeat(40), directory: "d", files: next }), /Unsupported platform/);
	assert.throws(() => draftReleases(index, { id: "nope", mode: "tethered", version: "1", platforms: [], commit: "e".repeat(40), directory: "d", files: next }), /No previous/);
});

test("launch-setting changes are detected", () => {
	const server = { type: "node", mcp_config: { command: "node", args: ["a"] } };
	assert.equal(serverBlockChanged({ server }, { server: structuredClone(server), version: "2" }), false);
	assert.equal(serverBlockChanged({ server }, { server: { ...server, entry_point: "b" } }), true);
});

test("acceptance records match the accepted-release shape and pass the signer's verifier", async () => {
	const at = "2026-11-06T10:00:00.000Z";
	const { record, bytes, hash } = acceptanceRecord({
		target: "win32-x64", distribution: "background-browser", commit: "e".repeat(40), files, statement: "I accept it.", at,
	});
	assert.deepEqual(record, {
		schemaVersion: 1, target: "win32-x64", distribution: "background-browser", commit: "e".repeat(40),
		artifactSha256: artifactHash(files), reviewer: "Laplace release owner (explicit acceptance in implementation chat)",
		completedAt: at, result: "accepted", localValidation: "passed",
		userAcceptance: { statement: "I accept it.", acceptedAt: at, nativeResults: "not-attested" },
	});
	assert.equal(hash, sha256(bytes));
	const dir = mkdtempSync(join(tmpdir(), "release-lib-evidence-"));
	try {
		writeFileSync(join(dir, `${hash}.json`), bytes);
		assert.equal((await verifyAcceptance(dir, hash, "win32-x64", "background-browser")).commit, "e".repeat(40));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.throws(() => acceptanceRecord({ target: "x", distribution: "y", commit: "z", files, statement: " ", at }), /verbatim/);
});

test("native evidence is matched only for the exact target, mode, commit and artifact", () => {
	const record = { result: "passed", target: "win32-x64", distribution: "tethered", commit: "e".repeat(40), artifactSha256: artifactHash(files) };
	const want = { target: "win32-x64", distribution: "tethered", commit: "e".repeat(40), files };
	assert.ok(matchNativeEvidence([{ record }], want));
	assert.equal(matchNativeEvidence([{ record }], { ...want, target: "darwin-arm64" }), undefined);
	assert.equal(matchNativeEvidence([{ record: { ...record, result: "accepted" } }], want), undefined);
	assert.equal(matchNativeEvidence([{ record }], { ...want, files: [] }), undefined);
});
