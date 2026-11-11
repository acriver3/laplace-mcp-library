#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BrowserAdapter } from "./adapter.js";
import { CmsBrowser, DEFAULT_DOWNLOADS, DEFAULT_PROFILE } from "./browser.js";
import { CmsService } from "./core.js";
import { createServer } from "./server.js";
import {
  CmsError,
  TIMEZONE,
  errorResult,
  type CmsAdapter,
  type Identity,
} from "./types.js";

export const VERSION = "0.1.0";
export const HELP = `yale-som-cms-mcp <login|status|serve> [options]

login   Open visible dedicated Chrome/Edge; complete sign-in and MFA yourself.
status  Check the saved session in the background and show recovery state.
serve   Serve MCP over stdio using the saved background-browser session.

--profile-dir PATH       Absolute dedicated profile directory
--browser chrome|msedge  Installed browser channel (default: chrome)
--downloads-dir PATH     Absolute document destination, separate from profile
--login-timeout SECONDS  Interactive login timeout, 1–3600 (default: 1800)
--release-stale-lock     Status only: release a dead owner's lock
--acknowledge-uncertain  Status only: acknowledge an inspected submission outcome
--note TEXT              Required descriptive note for that acknowledgment
--help, -h               Show help without launching a browser
--version                Show package version

Keep the same profile and browser for all commands. Never use an everyday
Chrome profile. Login is visible and manual; ordinary serving is headless.
Recovery never retries a submission. Stop any remaining browser before
releasing a crashed owner's lock.`;

export interface CliConfig {
  command: "login" | "status" | "serve";
  profileDir: string;
  downloadsDir: string;
  browser: "chrome" | "msedge";
  loginTimeoutMs: number;
  releaseStaleLock: boolean;
  acknowledgeUncertain: boolean;
  note?: string;
  help: boolean;
  version: boolean;
}
export function parseCliArgs(args: string[]): CliConfig {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        "profile-dir": { type: "string", default: DEFAULT_PROFILE },
        browser: { type: "string", default: "chrome" },
        "downloads-dir": { type: "string", default: DEFAULT_DOWNLOADS },
        "login-timeout": { type: "string", default: "1800" },
        "release-stale-lock": { type: "boolean", default: false },
        "acknowledge-uncertain": { type: "boolean", default: false },
        note: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new CmsError(
      "invalid_arguments",
      error instanceof Error ? error.message : "Invalid command arguments.",
    );
  }
  const { values, positionals } = parsed;
  const command = positionals[0] || "serve";
  const profileDir = String(values["profile-dir"]),
    downloadsDir = String(values["downloads-dir"]);
  const channel = String(values.browser),
    timeout = Number(values["login-timeout"]);
  const help = values.help === true,
    version = values.version === true;
  if (!["login", "status", "serve"].includes(command) || positionals.length > 1)
    throw new CmsError(
      "invalid_arguments",
      "Use one command: login, status, or serve.",
    );
  if (!["chrome", "msedge"].includes(channel))
    throw new CmsError(
      "invalid_arguments",
      "browser must be chrome or msedge.",
    );
  if (!isAbsolute(profileDir) || !isAbsolute(downloadsDir))
    throw new CmsError(
      "invalid_arguments",
      "profile-dir and downloads-dir must be absolute local paths.",
    );
  const downloadRelative = relative(resolve(profileDir), resolve(downloadsDir));
  if (
    !downloadRelative ||
    (!isAbsolute(downloadRelative) &&
      downloadRelative !== ".." &&
      !downloadRelative.startsWith(".." + sep))
  )
    throw new CmsError(
      "invalid_arguments",
      "Keep downloads outside the private browser profile.",
    );
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new CmsError(
      "invalid_arguments",
      "login-timeout must be an integer from 1 to 3600 seconds.",
    );
  const explicitTimeout = args.some(
    (a) => a === "--login-timeout" || a.startsWith("--login-timeout="),
  );
  if (command !== "login" && explicitTimeout && !help)
    throw new CmsError(
      "invalid_arguments",
      "login-timeout is available only for login.",
    );
  const releaseStaleLock = values["release-stale-lock"] === true,
    acknowledgeUncertain = values["acknowledge-uncertain"] === true;
  const note = typeof values.note === "string" ? values.note : undefined;
  if (
    command !== "status" &&
    (releaseStaleLock || acknowledgeUncertain || note !== undefined)
  )
    throw new CmsError(
      "invalid_arguments",
      "Recovery flags are available only on the explicit status command.",
    );
  if (note !== undefined && !acknowledgeUncertain)
    throw new CmsError(
      "invalid_arguments",
      "note is valid only with acknowledge-uncertain.",
    );
  if (
    acknowledgeUncertain &&
    (!note || note.trim().length < 10 || note.length > 2000)
  )
    throw new CmsError(
      "invalid_arguments",
      "Acknowledgment requires --note with a descriptive outcome you inspected in CMS.",
    );
  return {
    command: command as CliConfig["command"],
    profileDir: resolve(profileDir),
    downloadsDir: resolve(downloadsDir),
    browser: channel as CliConfig["browser"],
    loginTimeoutMs: timeout * 1000,
    releaseStaleLock,
    acknowledgeUncertain,
    note,
    help,
    version,
  };
}
interface CliBrowser {
  readonly profile: string;
  readonly lock: { acquire(): Promise<void>; releaseStale(): Promise<void> };
  login(timeoutMs: number): Promise<Identity>;
}
export interface CliDependencies {
  createRuntime?: (config: CliConfig) => {
    browser: CliBrowser;
    adapter: CmsAdapter;
  };
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}
export async function runCli(
  args = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const out =
    dependencies.writeOut ||
    ((text: string) => {
      process.stdout.write(text + "\n");
    });
  const err =
    dependencies.writeErr ||
    ((text: string) => {
      process.stderr.write(text + "\n");
    });
  let service: CmsService | undefined,
    adapter: CmsAdapter | undefined,
    server: ReturnType<typeof createServer> | undefined;
  let stopped: Promise<void> | undefined, finishServe: (() => void) | undefined;
  const stop = () => {
    if (!stopped)
      stopped = (async () => {
        // Interrupt in-flight page work first; its journal remains pending if interrupted.
        await adapter?.close().catch(() => {});
        await service?.close().catch(() => {});
        await server?.close().catch(() => {});
        finishServe?.();
      })();
    return stopped;
  };
  const signal = () => {
    void stop();
  };
  const end = () => {
    void stop();
  };
  let listening = false;
  try {
    const config = parseCliArgs(args);
    if (config.help) {
      out(HELP);
      return 0;
    }
    if (config.version) {
      out(VERSION);
      return 0;
    }
    const runtime = dependencies.createRuntime
      ? dependencies.createRuntime(config)
      : (() => {
          const browser = new CmsBrowser(
            config.profileDir,
            config.browser,
            config.command === "login",
            config.downloadsDir,
          );
          return { browser, adapter: new BrowserAdapter(browser) };
        })();
    const browser = runtime.browser;
    adapter = runtime.adapter;
    service = new CmsService(adapter, { profileDir: browser.profile });
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(name, signal);
    listening = true;
    if (config.command === "login") {
      err(
        "Complete Yale/12twenty sign-in and MFA in the visible dedicated browser. The saved profile will be reused for background calls.",
      );
      const identity = await browser.login(config.loginTimeoutMs);
      out(
        JSON.stringify({
          authenticated: true,
          account: identity.name,
          ...(identity.account_id ? { account_id: identity.account_id } : {}),
          timezone: TIMEZONE,
          recovery: await service.recoveryStatus(),
        }),
      );
    } else if (config.command === "status") {
      if (config.releaseStaleLock) await browser.lock.releaseStale();
      // Hold the same ownership lock throughout status and any journal acknowledgment.
      await browser.lock.acquire();
      const status = await service.sessionStatus();
      if (config.acknowledgeUncertain) {
        const acknowledgement = await service.acknowledgeUncertain({
          acknowledge: true,
          note: config.note!,
        });
        out(
          JSON.stringify({
            ...status,
            recovery: await service.recoveryStatus(),
            acknowledgement,
          }),
        );
      } else out(JSON.stringify(status));
    } else {
      server = createServer(adapter, service);
      const finished = new Promise<void>((resolve) => {
        finishServe = resolve;
      });
      process.stdin.once("end", end);
      process.stdin.once("error", end);
      await server.connect(new StdioServerTransport());
      await finished;
    }
    return 0;
  } catch (error) {
    err(JSON.stringify(errorResult(error)));
    return 1;
  } finally {
    await stop();
    if (listening)
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.removeListener(name, signal);
    process.stdin.removeListener("end", end);
    process.stdin.removeListener("error", end);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runCli();
}
