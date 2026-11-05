#!/usr/bin/env node
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BrowserAdapter } from "./adapter.js";
import { EmsBrowser, DEFAULT_PROFILE } from "./browser.js";
import { EmsService } from "./core.js";
import { createServer } from "./server.js";
import { errorResult, EmsError } from "./types.js";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"profile-dir": { type: "string", default: DEFAULT_PROFILE },
		browser: { type: "string", default: "chrome" },
		"login-timeout": { type: "string", default: "1800" },
		"acknowledge-uncertain": { type: "boolean", default: false },
		"release-stale-lock": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});
const command = positionals[0] || "serve";
if (values.help) {
	console.log(
		"yale-som-ems-mcp <login|status|serve> [--profile-dir PATH] [--browser chrome|msedge]\nlogin: finish Yale SSO/MFA in the dedicated browser.\nstatus --release-stale-lock: release a dead owner after stopping its browser.\nstatus --acknowledge-uncertain: acknowledge that you inspected My Events after an uncertain submission. No write is retried.",
	);
	process.exit(0);
}
if (
	!["login", "status", "serve"].includes(command) ||
	positionals.length > 1 ||
	!["chrome", "msedge"].includes(values.browser!)
)
	throw new EmsError(
		"invalid_arguments",
		"Use login, status, or serve with browser chrome or msedge.",
	);
if (command !== "status" && (values["acknowledge-uncertain"] || values["release-stale-lock"]))
	throw new EmsError(
		"invalid_arguments",
		"Recovery flags are available only on the explicit status command.",
	);
const browser = new EmsBrowser(
	values["profile-dir"],
	values.browser as "chrome" | "msedge",
	command === "login",
);
const adapter = new BrowserAdapter(browser);
const marker = `${browser.profile}.uncertain.json`;
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	await adapter.close();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
	process.once(signal, () => {
		void stop().finally(() => process.exit(0));
	});
try {
	if (command === "login") {
		const timeout = Number(values["login-timeout"]);
		if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600)
			throw new EmsError("invalid_arguments", "login-timeout must be 1–3600 seconds.");
		console.error(
			"Complete Yale SSO/MFA in the dedicated browser. Your credentials stay in that browser.",
		);
		const identity = await browser.login(timeout * 1000);
		console.log(JSON.stringify({ authenticated: true, account: identity.name }));
		await stop();
	} else if (command === "status") {
		if (values["release-stale-lock"]) await browser.lock.releaseStale();
		// Recovery must not erase the journal while another server is submitting.
		await browser.lock.acquire();
		if (values["acknowledge-uncertain"])
			await unlink(marker).catch((e) => {
				if (e.code !== "ENOENT") throw e;
			});
		const uncertain = await readFile(marker, "utf8")
			.then(() => true)
			.catch((e) => {
				if (e.code === "ENOENT") return false;
				throw e;
			});
		const identity = await adapter.identity();
		console.log(
			JSON.stringify({
				authenticated: true,
				account: identity.name,
				reconciliation_required: uncertain,
			}),
		);
		await stop();
	} else {
		const uncertain = await readFile(marker, "utf8")
			.then(() => true)
			.catch((e) => {
				if (e.code === "ENOENT") return false;
				throw e;
			});
		const service = new EmsService(
			adapter,
			Date.now,
			async (change) => {
				await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
				// Metadata only; no contact information or cookies in the recovery journal.
				await writeFile(
					marker,
					JSON.stringify({
						operation: change.operation,
						at: new Date().toISOString(),
						reservation_id: change.operation === "create" ? undefined : change.reservation_id,
					}),
					{ mode: 0o600 },
				);
			},
			uncertain,
			() => unlink(marker),
		);
		const server = createServer(adapter, service);
		const transport = new StdioServerTransport();
		process.stdin.once("end", () => {
			void stop().finally(() => server.close());
		});
		await server.connect(transport);
	}
} catch (e) {
	console.error(JSON.stringify(errorResult(e)));
	await stop();
	process.exitCode = 1;
}
