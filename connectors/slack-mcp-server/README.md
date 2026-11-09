# Slack MCP — Laplace Patchright edition

Slack ships on npm as `@withlaplace/slack-mcp-server`. The package contains the
Node launcher (`slack-mcp-server` → `browser/cli.mjs`) and depends on locked
Patchright. The Go server is cross-compiled (`CGO_ENABLED=0`, `-trimpath`) into
one optional package per platform, `@withlaplace/slack-mcp-server-<os>-<cpu>`;
npm installs only the one matching your machine, and the launcher finds it with
Node module resolution. No Go installation or local build is needed. The first
login downloads the matching Chromium browser into your user cache. Internet
access and a graphical desktop are required for sign-in/MFA. Browser sessions
stay in a dedicated profile outside the package directory.

| Operating system | Platform package | Verification |
| --- | --- | --- |
| Windows x64 | `@withlaplace/slack-mcp-server-win32-x64` | Cross-compiled; native login acceptance pending |
| macOS Intel | `@withlaplace/slack-mcp-server-darwin-x64` | Cross-compiled; native login acceptance pending |
| macOS Apple Silicon | `@withlaplace/slack-mcp-server-darwin-arm64` | Cross-compiled; native login acceptance pending |
| Linux x64 | `@withlaplace/slack-mcp-server-linux-x64` | Local install and offline server checks; real Slack login acceptance pending |

Use Windows 10/11, macOS 14+, Ubuntu 22.04/24.04/26.04, or Debian 12/13
with a graphical desktop and Node 22 or newer. Linux needs Chromium's OS shared
libraries (these are not application dependencies and are not packaged). ARM64
Windows and Linux packages are not provided. These are package targets, not claims
that all native platforms have passed authenticated Slack testing; the library
catalog records acceptance per platform.

Laplace Desktop installs the package with lifecycle scripts disabled and runs its
`slack-mcp-server` command with its own Node. Do not install with
`--omit=optional`, which would drop the server package.

## Sign in

```sh
slack-mcp-server login --workspace https://your-team.slack.com --profile-dir <profile>
```

The launcher downloads Chromium if missing, opens the dedicated profile, and lets
you complete Slack sign-in and MFA. No compiler or package-manager step is needed.
OAuth, bot tokens, manual token entry and importing your everyday browser profile
are not supported. The Go server still uses Slack APIs through this browser session.

## Connect to Laplace

The catalog launches `slack-mcp-server serve --workspace <url> --profile-dir <profile>`
with the read-only `SLACK_MCP_ENABLED_TOOLS` setting. `manifest.json` lists the two
settings: `workspace` (your HTTPS workspace URL) and `profile_dir` (default
`~/.laplace-local/sessions/slack-patchright/profile`). Use the same profile for
login and serve.

Verify MCP initialization, tool discovery and `channels_list`. Do not post messages
or enable write tools during setup. Starting `serve` does not trigger a download or
open a login window; run `login` first. Session expiry requires running `login`
again. Profiles contain secrets and must not be copied into the package or Git.
Credentials go only to the child server environment, not a separate token file.
Without `--profile-dir`, the CLI uses a workspace-specific profile under
`~/.laplace-local/sessions/slack-patchright/`.

## Source development

This connector derives from `korotovsky/slack-mcp-server` commit
`b88c0de3f706f4f07337c9eda7133c736d1c9524`. Upstream MIT authorship is retained;
Node and Patchright dependencies retain their licenses. Original provenance is in
`LAPLACE-PROVENANCE.json`; each published npm package records its library commit
in `package.json` (`laplace.libraryCommit`), and platform packages add the Go
version and target. Platform packages carry the Go and Go module license notices.

Developers can install dependencies with `npm ci --ignore-scripts` in this
directory, run `npm test`, and use Go to run `go test -skip TestIntegration ./...`.
From a source checkout, pass `--binary <path>` to `browser/cli.mjs serve` to use a
locally built server. The library's `npm run publish:npm -- slack-mcp-server <version>`
cross-compiles all four platform packages with the Go version pinned in
`scripts/slack-runtime-lock.json`, publishes them, then publishes the main package.
An optional `RUN_PATCHRIGHT_SMOKE=1 npm test` runs a local browser fixture. It
does not establish real Slack authentication. Historical MCPB bundles remain in
the library for already-installed clients.
