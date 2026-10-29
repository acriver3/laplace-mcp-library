# Laplace MCP Library

The home for Laplace-maintained local MCP source code and MCPB bundles.
Previously named `slack-mcp-server-patchright`; the Slack fork and its Git history
are preserved here alongside the other connectors.

| MCP | Source and setup | Distribution |
| --- | --- | --- |
| Canvas | [Connector README](connectors/canvas-session-mcp/README.md) | Versioned MCPB |
| LinkedIn | [Connector README](connectors/linkedin-mcp-server/README.md) | Versioned MCPB |
| Yale SOM EMS | [Connector README](connectors/yale-som-ems-mcp/README.md) | Versioned MCPB |
| Outlook | [Connector README](connectors/msoutlook-mcp/README.md) | Versioned MCPB |
| Slack | [Patchright README](connectors/slack-mcp-server/README.md) | Source MCPB candidate; local build required |

## Install through Laplace Local

1. Find the connector in [the catalog](catalog/local-mcp-bundles.json) and download
   its MCPB using the catalog download URL or the links in
   [Releases](https://github.com/acriver3/laplace-mcp-library/releases).
   Check its exact SHA-256 and byte length against the catalog before extraction
   or execution. Release notes distinguish published bundles from candidates.
2. Extract into a persistent, versioned local folder. Read the connector README
   and `manifest.json` for prerequisites, local configuration and sign-in.
   MCPB is a ZIP archive. It does not guarantee that runtimes or browsers are embedded.
3. Reuse or set up Laplace Local using your Laplace account's setup page. Resolve
   manifest placeholders to local absolute paths and your chosen settings; write
   the resulting command, args and env into a local JSON `mcpServers` entry.
   Keep credentials and browser sessions outside this repository and bundle folders.
4. Complete sign-in/MFA locally, then run
   `laplace-local attach <config.json> --select <server-id> --confirm`.
   Register only Laplace Local with your AI client. Preserve existing connections.
5. Verify startup, tool discovery and a harmless authenticated read. Do not send
   messages, connection requests or mail, change calendars, or create EMS bookings
   as part of setup. Report failures without substituting unverified packages.

Canvas needs your institution URL and download folder; verify `canvas_whoami` and
`canvas_list_courses`. LinkedIn uses Python 3.13 and `uv sync --locked --no-dev`;
verify `get_my_profile`. EMS needs Node 24 and Chrome/Edge; verify
`ems_session_status` and `ems_list_templates`. Outlook needs Node and Chrome/Edge;
verify `outlook_status` and `outlook_list_folders`. Follow each manifest's launch
configuration rather than registering an upstream server directly with a client.

Slack's source bundle requires Node 22+, Go 1.25+, locked dependencies installed
with `npm --prefix browser ci --ignore-scripts`, Patchright Chromium installed
with `npm --prefix browser run install-browser`, and the Go executable built as
its README describes. Run the documented `login` command before `serve`. Use
only the dedicated Patchright browser profile; OAuth and bot tokens are disabled.
Select server ID `slack`, verify `channels_list`, and keep writes disabled.
Its declared platforms are packaging targets, not authenticated acceptance claims.

## Source and releases

`connectors/` contains source, manifests, lockfiles, licenses and provenance.
`bundles/<connector-id>/<version>/` stores the actual MCPB files in Git. Release
notes link to those files at immutable version tags; they are not uploaded release
assets. This keeps both source and bundles accessible through this repository.
`catalog/local-mcp-bundles.json` records immutable versions, artifact checksums,
sizes, download URLs and acceptance evidence. The initial Canvas, LinkedIn, EMS
and Outlook releases are byte-for-byte mirrors of the existing Laplace releases;
their original upstream provenance and acceptance limitations are preserved.
Their source trees were extracted from those verified bundles, excluding installed
`node_modules`; omitted development files were restored from the pinned upstream
commits. Compiled files already present in the bundles are retained.
Historical review notes are in `reviews/`; references to the Laplace monorepo
in those records describe the original release process.

Each connector retains its own license and attribution. The root MIT license
covers the inherited Slack fork; it does not override connector licenses. In
particular, Yale SOM EMS is first-party proprietary code with its own LICENSE.
Third-party dependencies retain their licenses. No credentials or browser profiles
are shipped.

## Build a new candidate

Use Node 24+, Python 3 and the connector's declared toolchain. Commit source changes
first: builds use `git archive HEAD:connectors/<id>` so unrelated working files
and local sessions are not packaged.

```sh
npm ci --ignore-scripts
npm run build:bundle -- canvas-session-mcp 0.1.0-laplace.2
npm run verify
```

The builder uses locked inputs and MCPB 2.1.2, validates manifests and normalizes
archive timestamps and ordering. Canvas/EMS/Outlook install locked dependencies;
LinkedIn and Slack are source distributions with documented local prerequisites.
Outputs are ignored under `.artifacts/`; staging is under `.build/`. A build is a
candidate, not release acceptance. New bytes require a new version. Update the
catalog with the resulting SHA-256/size and actual platform evidence before
publishing; never overwrite a release asset. Native dependencies require
platform-specific recipes instead of a universal archive. No GitHub Actions are
configured by this library.

`npm run verify` checks every cataloged archive in `bundles/`, its checksum,
size, safe ZIP paths and manifest identity. A normal Git clone includes the
archives; missing archives are reported as errors.
Authenticated acceptance must be recorded against each exact archive and platform;
existing evidence does not carry over to rebuilt bytes.

After pushing the reviewed source commit, maintainers can run
`npm run publish:releases` with GitHub repository write access. This verifies every
cataloged archive, creates missing release notes without replacing tags, and
downloads the tagged repository files again to verify their exact bytes. Slack is a prerelease.
