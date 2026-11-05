/** Manual native-platform acceptance using shipped bytes and a temporary home.
 * Does not change the user's Chrome registration, accounts or connector state.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nativeBrowserOrigin } from "../src/browser-native-host";
import { installBrowserNativeHost, releaseBrowserNativeHost } from "../src/native-installation";

async function main() {
	const resources = resolve(process.argv[2]);
	const output = resolve(process.argv[3]);
	const home = await mkdtemp(join(tmpdir(), "laplace-native-acceptance-"));
	const source = join(home, "client-resources");
	try {
		await mkdir(join(source, "runtimes"), { recursive: true });
		await mkdir(join(source, "helper"));
		for (const file of [
			`runtimes/${process.platform === "win32" ? "node.exe" : "node"}`,
			"helper/browser-native-entry.cjs",
			...(process.platform === "win32" ? ["runtimes/browser-native-host.exe"] : []),
		])
			await copyFile(join(resources, file), join(source, file));
		await Promise.all([
			installBrowserNativeHost(source, { home, client: "desktop" }),
			installBrowserNativeHost(source, { home, client: "cli" }),
		]);
		const state = JSON.parse(
			await readFile(join(home, ".laplace/browser/installation.json"), "utf8"),
		);
		assert.deepEqual(state.owners.sort(), ["cli", "desktop"]);
		const executable =
			process.platform === "win32"
				? join(
						home,
						".laplace/browser/runtimes",
						`${state.version}-${state.digest}`,
						"runtimes/browser-native-host.exe",
					)
				: join(home, ".laplace/browser/laplace-browser-host");
		const probe = () => {
			const payload = Buffer.from(JSON.stringify({ method: "list_pending" }));
			const header = Buffer.alloc(4);
			header.writeUInt32LE(payload.length);
			const result = spawnSync(executable, [nativeBrowserOrigin], {
				input: Buffer.concat([header, payload]),
				timeout: 60000,
				maxBuffer: 1024 * 1024,
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, `Native host exited with ${result.signal ?? result.status}`);
			assert.equal(result.stdout.readUInt32LE(), result.stdout.length - 4);
			assert.ok(Array.isArray(JSON.parse(result.stdout.subarray(4).toString()).requests));
		};
		probe();
		await rm(source, { recursive: true });
		assert.deepEqual((await releaseBrowserNativeHost("desktop", home))?.owners, ["cli"]);
		probe();
		const older = await installBrowserNativeHost(source, {
			home,
			client: "desktop",
			version: "0.2.0",
		});
		assert.equal(older.version, state.version);
		assert.equal(older.digest, state.digest);
		assert.deepEqual((await releaseBrowserNativeHost("cli", home))?.owners, ["desktop"]);
		probe();
		assert.deepEqual((await releaseBrowserNativeHost("desktop", home))?.owners, []);
		await writeFile(
			output,
			JSON.stringify(
				{
					platform: `${process.platform}-${process.arch}`,
					at: new Date().toISOString(),
					nativeVersion: state.version,
					protocol: state.protocol,
					digest: state.digest,
					files: state.files,
					checks: [
						"simultaneous-owners",
						"framed-native-process",
						"remove-supplying-files",
						"remove-desktop-owner",
						"refuse-downgrade",
						"remove-cli-owner",
						"last-owner-recovery",
					],
					passed: true,
				},
				null,
				2,
			) + "\n",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
void main().catch((error) => {
	console.error(
		"Native acceptance failed. No user registration was changed.",
		error instanceof Error ? error.message : "Unknown error",
	);
	process.exitCode = 1;
});
