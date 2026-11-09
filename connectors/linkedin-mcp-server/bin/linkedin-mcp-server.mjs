#!/usr/bin/env node
// npm launcher for the LinkedIn MCP server. Runs this package's locked Python project with uv:
//   <uv> run --locked --no-dev --python 3.13 --project <package dir> -m linkedin_mcp_server <args...>
// <uv> is $LAPLACE_UV when set, otherwise `uv` on PATH. uv syncs the project environment on
// demand (Laplace Desktop runs `uv sync --locked --no-dev --python 3.13` in advance). stdio is
// inherited so MCP traffic flows directly; signals and the exit status are forwarded.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function uvCommand(env = process.env) {
	return env.LAPLACE_UV || "uv";
}

export function uvArguments(args, directory = packageDirectory) {
	return [
		"run",
		"--locked",
		"--no-dev",
		"--python",
		"3.13",
		"--project",
		directory,
		"-m",
		"linkedin_mcp_server",
		...args,
	];
}

export function launch(args = process.argv.slice(2), env = process.env) {
	const uv = uvCommand(env);
	const child = spawn(uv, uvArguments(args), { stdio: "inherit", env });
	const forward = (signal) => () => {
		if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	};
	const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, forward(signal)]);
	for (const [signal, handler] of handlers) process.on(signal, handler);
	const detach = () => {
		for (const [signal, handler] of handlers) process.removeListener(signal, handler);
	};
	child.once("error", (error) => {
		detach();
		process.stderr.write(
			error.code === "ENOENT"
				? `linkedin-mcp-server: uv was not found (${uv}). Install uv from https://docs.astral.sh/uv/ or set LAPLACE_UV to the uv executable.\n`
				: `linkedin-mcp-server: could not start uv (${uv}): ${error.message}\n`,
		);
		process.exitCode = error.code === "ENOENT" ? 127 : 1;
	});
	child.once("exit", (code, signal) => {
		detach();
		process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
	});
	return child;
}

const invoked = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked === import.meta.url) launch();
