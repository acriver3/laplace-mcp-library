import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { acceptanceChecks } from "./update-acceptance.mjs";
const signer = resolve(import.meta.dirname, "sign-update-catalog.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("signs only exact native-qualified artifacts and never overwrites a release", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-catalog-sign-"));
	try {
		await mkdir(join(root, "artifact"));
		await mkdir(join(root, "evidence"));
		await writeFile(join(root, "artifact/server.cjs"), "fixture");
		const files = [{ path: "server.cjs", size: 7, sha256: hash("fixture"), executable: false }];
		const evidence = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				target: "darwin-arm64",
				distribution: "tethered",
				commit: "a".repeat(40),
				artifactSha256: hash(JSON.stringify(files)),
				reviewer: "automated signing fixture only",
				completedAt: new Date().toISOString(),
				result: "passed",
				checks: Object.fromEntries(acceptanceChecks.map((c) => [c, "passed"])),
			}),
		);
		await writeFile(join(root, "evidence", hash(evidence) + ".json"), evidence);
		const index = {
			schemaVersion: 1,
			sequence: 1,
			releases: [
				{
					id: "fixture",
					version: "1.0.0",
					sequence: 1,
					mode: "tethered",
					channel: "stable",
					platforms: ["darwin-arm64"],
					minDesktop: "1.0.0",
					minCli: "1.0.0",
					permissionRevision: "1",
					configurationRevision: "1",
					qualified: true,
					qualificationSha256: hash(evidence),
					commit: "a".repeat(40),
					directory: "artifact",
					files,
				},
			],
		};
		await writeFile(join(root, "catalog.json"), JSON.stringify(index));
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		await writeFile(join(root, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), {
			mode: 0o600,
		});
		const run = (output) =>
			spawnSync(process.execPath, [signer, "catalog.json", "key.pem", output, "evidence"], {
				cwd: root,
				encoding: "utf8",
			});
		assert.equal(run("stable.json").status, 0);
		assert.equal(
			verify(
				null,
				await readFile(join(root, "stable.json")),
				publicKey,
				await readFile(join(root, "stable.json.sig")),
			),
			true,
		);
		assert.notEqual(run("stable.json").status, 0);
		await writeFile(join(root, "artifact/server.cjs"), "changed");
		assert.notEqual(run("tampered.json").status, 0);
		await writeFile(join(root, "artifact/server.cjs"), "fixture");
		index.releases[0].platforms = ["win32-x64"];
		await writeFile(join(root, "catalog.json"), JSON.stringify(index));
		assert.notEqual(run("unqualified.json").status, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
