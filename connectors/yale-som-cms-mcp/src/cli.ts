#!/usr/bin/env node
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BrowserAdapter } from "./adapter.js";
import {
  CmsBrowser,
  DEFAULT_CDP_URL,
  DEFAULT_DOWNLOADS,
  DEFAULT_STATE,
  validateCdpUrl,
} from "./browser.js";
import { CmsService } from "./core.js";
import { createServer } from "./server.js";
import {
  CmsError,
  TIMEZONE,
  errorResult,
  type CmsAdapter,
  type Identity,
} from "./types.js";

export const VERSION = "0.1.1";
export const HELP = `yale-som-cms-mcp <login|status|serve> [options]

login   Attach to visible Chrome; sign in and complete MFA in a new CMS tab.
status  Attach to Chrome, check the session and recovery state, then close its tab.
serve   Serve MCP over stdio using its own visible CMS tab until shutdown.

--state-dir PATH         Absolute connector state directory; never a Chrome profile
--cdp-url URL            Existing Chrome's loopback WebSocket browser endpoint
--downloads-dir PATH     Absolute document destination, separate from state
--login-timeout SECONDS  Interactive login timeout, 1–3600 (default: 1800)
--release-stale-lock     Status only: release a dead connector owner's lock
--acknowledge-uncertain  Status only: acknowledge an inspected submission outcome
--note TEXT              Required descriptive note for that acknowledgment
--profile-dir PATH       Deprecated alias for state-dir; stores connector state only
--browser chrome         Deprecated compatibility option; Chrome must already run
--help, -h               Show help without attaching to Chrome
--version                Show package version

Use the same state directory for every command. The default CDP endpoint is
ws://127.0.0.1:9222/devtools/browser; only ws on localhost, 127.0.0.1 or [::1]
with an explicit port from 1 to 65535 is accepted. Chrome must already be running
with a supported local CDP endpoint.
The connector attaches to Chrome and uses its existing login; it does not launch
Chrome or copy cookies. Complete sign-in, MFA and any browser challenge yourself.
Status and serving guard student writes; login permits manual sign-in in its tab.
Shutdown closes only the connector's CMS tab and leaves Chrome and other tabs open.
Recovery never retries a submission. Inspect any prior connector tab before
releasing a crashed owner's state lock.`;

export interface CliConfig {
  command: "login" | "status" | "serve";
  stateDir: string;
  downloadsDir: string;
  cdpUrl: string;
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
        "state-dir": { type: "string" },
        "profile-dir": { type: "string" },
        "cdp-url": { type: "string", default: DEFAULT_CDP_URL },
        browser: { type: "string" },
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
  if (values["state-dir"] !== undefined && values["profile-dir"] !== undefined)
    throw new CmsError(
      "invalid_arguments",
      "Use state-dir or its deprecated profile-dir alias, not both. Neither option selects a Chrome profile.",
    );
  const stateDir = String(
      values["state-dir"] ?? values["profile-dir"] ?? DEFAULT_STATE,
    ),
    downloadsDir = String(values["downloads-dir"]);
  const timeout = Number(values["login-timeout"]);
  const help = values.help === true,
    version = values.version === true;
  if (!["login", "status", "serve"].includes(command) || positionals.length > 1)
    throw new CmsError(
      "invalid_arguments",
      "Use one command: login, status, or serve.",
    );
  if (values.browser !== undefined && values.browser !== "chrome")
    throw new CmsError(
      "invalid_arguments",
      "Only the deprecated --browser chrome option is accepted. Attach to existing Chrome with --cdp-url.",
    );
  let cdpUrl: string;
  try {
    cdpUrl = validateCdpUrl(String(values["cdp-url"]));
  } catch {
    throw new CmsError(
      "invalid_arguments",
      "cdp-url must be a loopback ws endpoint on localhost, 127.0.0.1 or [::1], with an explicit port from 1 to 65535, path /devtools/browser or /devtools/browser/ID and no credentials, query or fragment.",
    );
  }
  if (!isAbsolute(stateDir) || !isAbsolute(downloadsDir))
    throw new CmsError(
      "invalid_arguments",
      "state-dir (or its profile-dir alias) and downloads-dir must be absolute local paths.",
    );
  const downloadRelative = relative(resolve(stateDir), resolve(downloadsDir));
  if (
    !downloadRelative ||
    (!isAbsolute(downloadRelative) &&
      downloadRelative !== ".." &&
      !downloadRelative.startsWith(".." + sep))
  )
    throw new CmsError(
      "invalid_arguments",
      "Keep downloads outside the private connector state directory.",
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
    stateDir: resolve(stateDir),
    downloadsDir: resolve(downloadsDir),
    cdpUrl,
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
export function createCliRuntime(config: CliConfig) {
  const browser = new CmsBrowser(
    config.stateDir,
    config.cdpUrl,
    config.command === "login", // Only explicit login permits manual authentication writes.
    config.downloadsDir,
  );
  return { browser, adapter: new BrowserAdapter(browser) };
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
      : createCliRuntime(config);
    const browser = runtime.browser;
    adapter = runtime.adapter;
    service = new CmsService(adapter, { profileDir: browser.profile });
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(name, signal);
    listening = true;
    if (config.command === "login") {
      err(
        "Complete Yale/12twenty sign-in and MFA in the connector's new tab in your existing visible Chrome. Chrome keeps the login session; the connector stores no copied cookies.",
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
    const result = errorResult(error);
    if (error instanceof CmsError && error.code === "browser_challenge")
      result.message +=
        " This command closes only its CMS tab; Chrome and your other tabs remain open. Run login to complete checks manually, or retry the tool in a running connector's visible CMS tab.";
    err(JSON.stringify(result));
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
