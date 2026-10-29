# Outlook bundle review — 2026-10-10

The user accepted and authorized publication of Outlook `0.5.0-laplace.1` for its declared Windows x64, macOS Intel and macOS Apple Silicon targets. The exact approval was: “I accept and please publish the bundle”. This is release acceptance, not a report that authenticated platform tests were performed. The user authorized proceeding with publication on the evidence below. Linux is unverified.

| Candidate                 | Source commit                              | SHA-256                                                            | Size             |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ---------------- |
| Outlook `0.5.0-laplace.1` | `834e3764e01aa06ddde73590a8bc71aeafab74c0` | `df2c9e92ed0ac692817e311c2217ddf0da2db9fbfbec17c0c0e45eb8d25b9d1b` | 11,000,205 bytes |

Upstream: [shayanline/msoutlook-mcp](https://github.com/shayanline/msoutlook-mcp/tree/834e3764e01aa06ddde73590a8bc71aeafab74c0). The MIT license, source, source tests, npm lockfile, compiled server, dependency attribution and Laplace provenance are retained. No upstream source patch is applied. The build installs locked dependencies with lifecycle scripts disabled, compiles TypeScript, runs upstream tests, and prunes development and optional dependencies. Playwright's optional native `fsevents` file watcher is excluded so the artifact has no native Node modules or shared libraries. Installed Chrome or Edge supplies the browser; browser binaries are not downloaded or bundled. Compiled test files and generated Vitest caches are excluded; original source tests are retained.

The manifest launches `node <bundle>/dist/index.js` and sets `MSOUTLOOK_SKIP_COOKIE_IMPORT=false`. Outlook first attempts to import an existing Chrome/Edge Microsoft session, then falls back to interactive sign-in in its dedicated browser profile. Any Keychain/keyring prompt or Microsoft sign-in is completed by the user. The browser channel can be automatic or explicitly `chrome`/`msedge`. Upstream controls the browser through Playwright; it does not support Codex's in-app browser.

Session data stays in the upstream shared directory outside the bundle: `~/.msoutlook-mcp-server` on macOS or `%APPDATA%/msoutlook-mcp-server` on Windows. JSON session/token files use upstream AES-256-GCM encryption with a key derived from hostname and username, rather than a secret held in the OS keychain. A persistent browser profile is also retained. This packaging does not strengthen upstream session storage. Existing upstream sessions must be preserved; setup must not invoke logout or force a new session. Archive checks exclude Outlook session directories, token caches, storage-state files and browser profiles.

The server accesses Microsoft Outlook/Graph endpoints with Outlook Web's first-party session. It uses internal APIs that Microsoft can change. Tools include sending/deleting mail, changing calendars, contacts and account settings. Setup instructions use `outlook_status` and `outlook_list_folders` for read checks, and delegate confirmations to the AI client's permissions. No write tool is invoked during verification.

Automated checks on macOS Apple Silicon with Node 25.9.0:

- Upstream TypeScript build and all 330 tests in 20 files passed.
- MCPB 2.1.2 manifest validation and canonical archive inspection passed. Two independent builds produced the same checksum and byte length.
- Catalog tests (20), wrapper visibility tests (7), publication contracts (6), archive tests (5) and project-protocol type checking passed.
- A fresh extraction initialized over MCP stdio and discovered 53 uniquely named tools with object input schemas, including login, status, folders, calendar, directory and draft tools. No Microsoft login or account access was attempted.
- Upstream reports MCP server version `0.3.0` despite package version `0.5.0`. Identity is established by the pinned commit and artifact checksum, not this reported version.

These checks establish source/build/startup behavior. No authenticated Outlook test through Laplace Local was performed or reported. The release acceptance records reference the exact artifact SHA-256 and the user’s explicit publication approval; they do not borrow Canvas/LinkedIn results. Authenticated verification remains useful follow-up evidence for each target.

Publication: uploaded through the existing authenticated Cloudflare R2 dashboard to `laplace-local-mcp-releases/v0.1.0/bundles/msoutlook-mcp/0.5.0-laplace.1/msoutlook-mcp-0.5.0-laplace.1-universal.mcpb`. The destination returned 404 and the folder was empty before upload; no existing artifact was replaced. The public origin returned HTTP 200 with exactly 11,000,205 bytes and SHA-256 `df2c9e92ed0ac692817e311c2217ddf0da2db9fbfbec17c0c0e45eb8d25b9d1b` after upload. This upload path does not attach the CLI publisher’s custom SHA-256 metadata; any future publisher reconciliation must verify the stored bytes before accepting it. The committed download API independently verifies the exact size and SHA-256.
