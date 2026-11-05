import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, before, after } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const require = createRequire(
	new URL("../../connectors/msoutlook-mcp/package.json", import.meta.url),
);
const { build } = require("esbuild");
let directory, SlackBrowserChild, slackChildEnvironment;
const binary = resolve(process.env.SLACK_TEST_BINARY || ".build/slack-browser");
before(async () => {
	directory = await mkdtemp(join(tmpdir(), "laplace-slack-test-"));
	await build({
		entryPoints: ["browser-runtime/src/slack-full-server.ts"],
		outfile: join(directory, "child.cjs"),
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node24",
	});
	({ SlackBrowserChild, slackChildEnvironment } = await import(join(directory, "child.cjs")));
});
after(async () => {
	await rm(directory, { recursive: true, force: true });
});
function fixture(options = {}) {
	const calls = [];
	let revision = "approved-one";
	const responses = {
		"api.auth.test": {
			ok: true,
			url: "https://fixture.slack.com/",
			team: "Fixture",
			user: "fixture",
			team_id: "T01234567",
			user_id: "U01234567",
		},
		"api.users.list": {
			ok: true,
			members: [{ id: "U01234567", name: "fixture", profile: { display_name: "Fixture User" } }],
		},
		"api.conversations.list": {
			ok: true,
			channels: [
				{
					id: "C01234567",
					name: "fixture",
					name_normalized: "fixture",
					is_channel: true,
					num_members: 1,
				},
			],
		},
		"api.users.conversations": {
			ok: true,
			channels: [{ id: "C01234567", name: "fixture", is_channel: true, num_members: 1 }],
		},
		"api.conversations.history": {
			ok: true,
			messages: [
				{ type: "message", user: "U01234567", text: "Fixture message", ts: "1700000000.000001" },
			],
			has_more: false,
		},
		"api.chat.postMessage": { ok: true, channel: "C01234567", ts: "1700000000.000002" },
		"api.usergroups.list": {
			ok: true,
			usergroups: [
				{
					id: "S01234567",
					name: "Fixture Group",
					handle: "fixture",
					description: "Fixture",
					users: ["U01234567"],
					user_count: 1,
				},
			],
		},
		"api.saved.list": { ok: true, saved_items: [], counts: {} },
	};
	const relay = {
		connectionRevision: () => revision,
		read: async (method, args) => {
			calls.push({ method, args });
			const override = await options.read?.(method, args);
			return {
				status: 200,
				contentType: "application/json",
				body: override ?? responses[method] ?? { ok: true },
			};
		},
	};
	const env = {
		...process.env,
		SLACK_MCP_ADD_MESSAGE_TOOL: "true",
		SLACK_MCP_REACTION_TOOL: "true",
		SLACK_MCP_ATTACHMENT_TOOL: "true",
	};
	const child = new SlackBrowserChild(relay, binary, env);
	return {
		child,
		calls,
		env,
		change: () => {
			revision = "approved-two";
		},
	};
}
test("offline tool catalog exactly preserves all 22 registered contracts and permission switches", async () => {
	const f = fixture();
	const expected = JSON.parse((await exec(binary, ["--catalog-json"], { env: f.env })).stdout);
	const actual = await f.child.catalog();
	assert.equal(actual.length, 22);
	assert.deepEqual(actual, expected);
	const restricted = new SlackBrowserChild({ connectionRevision: () => undefined }, binary, {
		...f.env,
		SLACK_MCP_ENABLED_TOOLS: "channels_list,users_search",
	});
	assert.deepEqual(
		(await restricted.catalog()).map((x) => x.name),
		["channels_list", "users_search"],
	);
	assert.equal(f.calls.length, 0);
	assert(
		!Object.keys(
			slackChildEnvironment({
				SLACK_MCP_XOXC_TOKEN: "secret",
				SLACK_MCP_XOXD_TOKEN: "secret",
				SLACK_MCP_ADD_MESSAGE_TOOL: "true",
			}),
		).some((key) => key.includes("XOX")),
	);
});
test("original handlers preserve representative read, write and saved-item outputs", async () => {
	const f = fixture();
	await f.child.listen();
	try {
		const cases = [
			["channels_list", { channel_types: "public_channel" }, "#fixture"],
			["conversations_history", { channel_id: "C01234567", limit: "1" }, "Fixture message"],
			["usergroups_list", {}, "Fixture Group"],
			["saved_list", { include_messages: false }, ""],
			[
				"conversations_add_message",
				{ channel_id: "C01234567", text: "fixture" },
				"1700000000.000002",
			],
			[
				"reactions_add",
				{ channel_id: "C01234567", timestamp: "1700000000.000001", emoji: "thumbsup" },
				"",
			],
		];
		for (const [name, args, text] of cases) {
			const result = await f.child.call(name, args, AbortSignal.timeout(10000));
			assert(!result.isError, JSON.stringify(result));
			assert(JSON.stringify(result).includes(text), name);
		}
		assert.equal(f.calls.filter((x) => x.method === "api.chat.postMessage").length, 1);
	} finally {
		await f.child.close();
	}
});
test("interrupted write is not replayed and a changed approval rebuilds account caches", async () => {
	const f = fixture({
		read: (method) => {
			if (method === "api.chat.postMessage") throw Error("lost response");
		},
	});
	await f.child.listen();
	try {
		await f.child.call(
			"channels_list",
			{ channel_types: "public_channel" },
			AbortSignal.timeout(10000),
		);
		f.change();
		await f.child.call(
			"channels_list",
			{ channel_types: "public_channel" },
			AbortSignal.timeout(10000),
		);
		assert.equal(f.calls.filter((x) => x.method === "api.users.list").length, 2);
		const result = await f.child.call(
			"conversations_add_message",
			{ channel_id: "C01234567", text: "fixture" },
			AbortSignal.timeout(10000),
		);
		assert.equal(result.isError, true);
		assert(JSON.stringify(result).includes("SAVE_UNVERIFIED"));
		assert.equal(f.calls.filter((x) => x.method === "api.chat.postMessage").length, 1);
	} finally {
		await f.child.close();
	}
});
