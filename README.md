# Slack MCP — Laplace Patchright edition

A browser-session-only fork of [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server), based on commit `b88c0de3f706f4f07337c9eda7133c736d1c9524`.

Slack sign-in uses the official Node.js Patchright package with a dedicated Chromium profile. Complete sign-in and MFA yourself. OAuth, bot tokens, manual token entry, and importing your normal browser profile are not supported connection options. Existing MCP tools still call Slack APIs using the browser session; this is not a browser-driven implementation of every Slack operation.

## Setup

Requires Node.js 22+, Go 1.25+ for building, and a desktop for initial login. These commands work from the extracted source folder:

```sh
npm --prefix browser ci --ignore-scripts
npm --prefix browser run install-browser
go build -o build/slack-mcp-server ./cmd/slack-mcp-server
node browser/cli.mjs login --workspace https://your-team.slack.com
```

On Windows, build with `go build -o build/slack-mcp-server.exe ./cmd/slack-mcp-server`. Browser system dependencies may be required on Linux (`browser/node_modules/.bin/patchright install --with-deps chromium`).

## Connect to Laplace Local

Create a local JSON file with absolute paths:

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/absolute/path/slack-mcp-server-patchright/browser/cli.mjs", "serve", "--workspace", "https://your-team.slack.com"],
      "env": {
        "SLACK_MCP_ENABLED_TOOLS": "channels_list,conversations_history,conversations_replies,conversations_search_messages"
      }
    }
  }
}
```

Run `laplace-local attach /absolute/path/slack.json --select slack --confirm`. Verify initialization, tool discovery, and `channels_list`. The example enables only read tools. Posting is disabled by upstream unless explicitly enabled; do not add write tools during setup.

At each start, Patchright reopens the dedicated profile headlessly, reads the current workspace session, closes Chromium, and launches the Go MCP server. Credentials are passed in the child process environment and never written to a separate token file or stdout. The browser profile contains session secrets; keep it private. The default profile is workspace-specific under `~/.laplace-local/sessions/slack-patchright/`. Use `--profile-dir /absolute/dedicated/path` consistently for both login and serve to override it. Never point it at an everyday browser profile.

Session expiry requires running `login` again. Changing workspace URLs creates a separate default profile. GovSlack workspace URLs are supported in code but require real-workspace acceptance testing. A locked profile, expired session, missing browser, or invalid workspace stops startup; there is no OAuth fallback. Remove any inherited OAuth token variables before launching.

## Distribution and validation

This is a source distribution: users install locked Node dependencies and build the Go binary locally. Do not substitute an upstream latest binary, which permits OAuth. See `LAPLACE-PROVENANCE.json` for the source revision and validation record. Upstream MIT license and authorship are preserved in `LICENSE`. Node dependencies retain their own licenses.

Run `npm --prefix browser test`, `go test -skip TestIntegration ./...`, and `go build -o build/slack-mcp-server ./cmd/slack-mcp-server`. Run `RUN_PATCHRIGHT_SMOKE=1 npm --prefix browser test` for a local Chromium profile smoke test. Upstream integration tests need a real Slack session (some also require OpenAI credentials) and are excluded from the offline test command. A real Slack login and authenticated read are required before calling a platform release production-verified. The old upstream npm/DXT publishing configuration is not used by this fork.
