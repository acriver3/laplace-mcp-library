# Slack MCP — Laplace Patchright edition

Precompiled platform-specific MCPBs include the Slack Go server, Node 24 runtime,
and locked Patchright dependencies. No Go installation, npm, or local build is
needed. The first login downloads the matching Chromium browser into your user
cache. Internet access and a graphical desktop are required for sign-in/MFA.
Browser sessions stay in a dedicated profile outside the bundle.

## Choose a bundle

| Operating system | Bundle suffix | Verification |
| --- | --- | --- |
| Windows x64 | `win32-x64.mcpb` | Cross-compiled; native login acceptance pending |
| macOS Intel | `darwin-x64.mcpb` | Cross-compiled; native login acceptance pending |
| macOS Apple Silicon | `darwin-arm64.mcpb` | Cross-compiled; native login acceptance pending |
| Linux x64 | `linux-x64.mcpb` | Local runtime checks; real Slack login acceptance pending |

Use a currently supported Windows 10/11, macOS, or Ubuntu/Debian desktop compatible
with Node 24 and the bundled Patchright version. Linux needs Chromium's OS shared
libraries (these are not application dependencies and are not bundled). ARM64
Windows and Linux packages are not provided. These are package targets, not claims
that all native platforms have passed authenticated Slack testing. Check the
library catalog and release notes for the exact artifact verification record.

Download from the library catalog, check SHA-256 and size, then extract the MCPB
(a ZIP archive) into a persistent directory. Use an extractor that preserves Unix
executable permissions on macOS/Linux. If yours does not, run
`chmod +x slack runtime/node build/slack-mcp-server` in the extracted folder.
OS security prompts may apply to downloaded executables; packages are not notarized.

## Sign in

Windows (PowerShell, from the extracted folder):

```powershell
.\slack.cmd login --workspace https://your-team.slack.com
```

macOS/Linux:

```sh
./slack login --workspace https://your-team.slack.com
```

The launcher downloads Chromium if missing, opens a dedicated profile, and lets
you complete Slack sign-in and MFA. No compiler or package-manager step is needed.
OAuth, bot tokens, manual token entry and importing your everyday browser profile
are not supported. The Go server still uses Slack APIs through this browser session.

## Connect to Laplace Local

Use the bundle's `manifest.json` to create a local JSON `mcpServers` entry named
`slack`. Resolve `${__dirname}` to the absolute extracted directory and
`${user_config.workspace}` to your Slack workspace HTTPS URL. The command is the
bundled `runtime/node.exe` on Windows or `runtime/node` on macOS/Linux, with args
pointing to `browser/cli.mjs`, `serve`, `--workspace`, and your workspace URL.
Keep the manifest's read-only `SLACK_MCP_ENABLED_TOOLS` setting. Then run:

```sh
laplace-local attach /absolute/path/slack.json --select slack --confirm
```

Verify MCP initialization, tool discovery and `channels_list`. Do not post messages
or enable write tools during setup. Starting `serve` does not trigger a download or
open a login window; run `login` first. Only Laplace Local is registered in your AI
client. Existing connections should be reused.

The default dedicated profile is workspace-specific under
`~/.laplace-local/sessions/slack-patchright/`. Use `--profile-dir` consistently for
both login and serve if overriding it. Session expiry requires running `login`
again. Profiles contain secrets and must not be copied into the bundle or Git.
Credentials go only to the child server environment, not a separate token file.

## Source development

This connector derives from `korotovsky/slack-mcp-server` commit
`b88c0de3f706f4f07337c9eda7133c736d1c9524`. Upstream MIT authorship is retained;
Node and Patchright dependencies retain their licenses. Original provenance is in
`LAPLACE-PROVENANCE.json`; each binary bundle adds its library commit, toolchain,
runtime checksum and target in `LAPLACE-LIBRARY-PROVENANCE.json`.

Developers can install `browser` dependencies with `npm ci --ignore-scripts`, run
`npm --prefix browser test`, and use Go to run `go test -skip TestIntegration ./...`.
The library's `npm run build:slack -- <new-version>` builds release bundles from
committed source with the pinned Go toolchain and checksum-verified Node runtimes.
An optional `RUN_PATCHRIGHT_SMOKE=1 npm --prefix browser test` runs a local browser
fixture. It does not establish real Slack authentication. Old source-only releases
remain available for reproducibility; use the new platform-specific bundle for setup.
