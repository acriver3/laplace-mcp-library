import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { packageDirectory, uvArguments, uvCommand } from "./linkedin-mcp-server.mjs";

const launcher = fileURLToPath(new URL("./linkedin-mcp-server.mjs", import.meta.url));

test("runs the locked project from the package directory", () => {
	assert.deepEqual(uvArguments(["--transport", "stdio"], "/pkg"), [
		"run", "--locked", "--no-dev", "--python", "3.13", "--project", "/pkg",
		"-m", "linkedin_mcp_server", "--transport", "stdio",
	]);
	assert.equal(packageDirectory, fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, ""));
	assert.equal(uvCommand({}), "uv");
	assert.equal(uvCommand({ LAPLACE_UV: "/opt/uv" }), "/opt/uv");
});

test("forwards arguments, stdio and the exit code to a fake uv", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "linkedin-launcher-"));
	try {
		const uv = join(dir, "uv");
		const record = join(dir, "args.json");
		writeFileSync(
			uv,
			`#!${process.execPath}\nconst fs = require("node:fs");\n` +
				`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n` +
				`process.stdout.write(fs.readFileSync(0, "utf8").toUpperCase());\nprocess.exit(7);\n`,
		);
		chmodSync(uv, 0o755);
		const result = spawnSync(process.execPath, [launcher, "--user-data-dir", "/profile"], {
			env: { ...process.env, LAPLACE_UV: uv },
			input: "ping",
			encoding: "utf8",
		});
		assert.equal(result.status, 7);
		assert.equal(result.stdout, "PING");
		assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), uvArguments(["--user-data-dir", "/profile"]));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("explains a missing uv on stderr", () => {
	const result = spawnSync(process.execPath, [launcher], {
		env: { ...process.env, LAPLACE_UV: join(tmpdir(), "definitely-missing-uv-binary") },
		encoding: "utf8",
	});
	assert.equal(result.status, 127);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /uv was not found/);
});

test("forwards SIGTERM to uv and reports its exit", { skip: process.platform === "win32" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "linkedin-launcher-"));
	try {
		const uv = join(dir, "uv");
		writeFileSync(
			uv,
			`#!${process.execPath}\nprocess.on("SIGTERM", () => { process.stdout.write("terminated"); process.exit(3); });\n` +
				`process.stdout.write("ready");\nsetInterval(() => {}, 1000);\n`,
		);
		chmodSync(uv, 0o755);
		const child = spawn(process.execPath, [launcher], { env: { ...process.env, LAPLACE_UV: uv } });
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output === "ready") child.kill("SIGTERM");
		});
		const [code] = await once(child, "exit");
		assert.equal(output, "readyterminated");
		assert.equal(code, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
