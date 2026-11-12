import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ProfileLock } from "../dist/browser.js";
import { backgroundInterval, createServer } from "../dist/server.js";
import { EmsError } from "../dist/types.js";

void test("real stdio initialization and eight tools require no browser or login", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ems-stdio-"));
	const client = new Client({ name: "fixture", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [resolve("dist/cli.js"), "serve", "--profile-dir", join(dir, "profile")],
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		assert.equal(tools.tools.length, 8);
		assert.equal(
			tools.tools.find((t) => t.name === "ems_commit_change").annotations.readOnlyHint,
			false,
		);
		assert.equal(
			tools.tools.find((t) => t.name === "ems_prepare_change").annotations.readOnlyHint,
			true,
		);
		assert.equal(
			tools.tools.find((t) => t.name === "ems_commit_change").inputSchema.type,
			"object",
		);
	} finally {
		await client.close();
		await rm(dir, { recursive: true, force: true });
	}
});
void test("MCP authenticated read preserves structured results and errors", async () => {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createServer({
		async identity() {
			return { key: "private", name: "Test Student" };
		},
		async templates() {
			return [];
		},
	});
	const client = new Client({ name: "fixture", version: "1.0.0" });
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "ems_session_status", arguments: {} });
		assert.equal(result.structuredContent.result.account, "Test Student");
		assert.equal(JSON.stringify(result).includes("private"), false);
		const templates = await client.callTool({ name: "ems_list_templates", arguments: {} });
		assert.deepEqual(templates.structuredContent.result, []);
		const invalid = await client.callTool({
			name: "ems_prepare_change",
			arguments: { operation: "create" },
		});
		assert.equal(invalid.isError, true);
	} finally {
		await client.close();
		await server.close();
	}
});
void test("profile ownership is exclusive and releases only its own lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ems-lock-"));
	const first = new ProfileLock(join(dir, "profile")),
		second = new ProfileLock(join(dir, "profile"));
	try {
		await first.acquire();
		await first.acquire(); // Explicit recovery and browser launch share one owner.
		const marker = join(dir, "profile.uncertain.json");
		await writeFile(marker, "synthetic submission intent");
		const recovery = spawnSync(
			process.execPath,
			[
				resolve("dist/cli.js"),
				"status",
				"--profile-dir",
				join(dir, "profile"),
				"--acknowledge-uncertain",
			],
			{ encoding: "utf8" },
		);
		assert.equal(recovery.status, 1);
		assert.match(recovery.stderr, /profile_busy/);
		assert.equal(await readFile(marker, "utf8"), "synthetic submission intent");
		await assert.rejects(() => second.acquire(), { code: "profile_busy" });
		await second.release();
		await assert.rejects(() => first.releaseStale(), { code: "profile_busy" });
		await first.release();
		await second.acquire();
		await second.release();
	} finally {
		await first.release();
		await second.release();
		await rm(dir, { recursive: true, force: true });
	}
});

void test("renews EMS reads once and clears pending booking drafts", async () => {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	let renewals = 0, reads = 0, prepares = 0, submits = 0;
	const adapter = {
		async identity() {
			if (++reads === 1) throw new EmsError("auth_required", "Sign in required");
			return { key: "fresh", name: "Test Student" };
		},
		async renewSession() { renewals++; },
		async prepare() {
			prepares++;
			return { identity: "expired", preview: { operation: "cancel" } };
		},
		async submit() { submits++; },
	};
	const server = createServer(adapter);
	const client = new Client({ name: "fixture", version: "1.0.0" });
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const draft = await client.callTool({
			name: "ems_prepare_change",
			arguments: { operation: "cancel", reservation_id: "2", booking_id: "3" },
		});
		const status = await client.callTool({ name: "ems_session_status", arguments: {} });
		assert.equal(status.structuredContent.result.authenticated, true);
		const commit = await client.callTool({
			name: "ems_commit_change",
			arguments: { confirm: true, draft_id: draft.structuredContent.result.draft_id },
		});
		assert.equal(commit.structuredContent.code, "draft_expired");
		assert.deepEqual([reads, renewals, prepares, submits], [2, 1, 1, 0]);
	} finally {
		await client.close();
		await server.close();
	}
});

void test("background checks default off, defer after rate limits, and stop at sign-in or shutdown", async (t) => {
	assert.equal(backgroundInterval({ EMS_VERIFIED_CHECK_MINUTES: "30" }), 0);
	assert.equal(backgroundInterval({ LAPLACE_BACKGROUND_SESSION_CHECKS: "on" }), 0);
	assert.equal(backgroundInterval({
		LAPLACE_BACKGROUND_SESSION_CHECKS: "on", EMS_VERIFIED_CHECK_MINUTES: "30",
	}), 1_800_000);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	let checks = 0;
	const server = createServer({
		async identity() { return { key: "test", name: "Test Student" }; },
		async checkSession() {
			if (++checks === 1) throw new EmsError("rate_limited", "Slow down", { retryAfterMs: 5_000 });
			throw new EmsError("auth_required", "Sign in required");
		},
	}, undefined, 1_000);
	const client = new Client({ name: "fixture", version: "1.0.0" });
	const advance = async (milliseconds) => {
		t.mock.timers.tick(milliseconds);
		await new Promise((resolve) => setImmediate(resolve));
	};
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		await advance(20_000);
		assert.equal(checks, 0);
		await client.callTool({ name: "ems_session_status", arguments: {} });
		await advance(1_000);
		assert.equal(checks, 1);
		await advance(4_999);
		assert.equal(checks, 1);
		await advance(1);
		assert.equal(checks, 2);
		await advance(20_000);
		assert.equal(checks, 2);
		await client.callTool({ name: "ems_session_status", arguments: {} });
		await server.close();
		await advance(20_000);
		assert.equal(checks, 2);
	} finally {
		await client.close();
		await server.close();
	}
});
