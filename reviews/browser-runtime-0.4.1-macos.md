# Browser runtime 0.4.1 — macOS ARM64 release

The release qualifies the exact runtime source at `9d7725940206bbfc9a63952503c197488ff93a23`, native runtime 0.3.0/protocol 1, and extension 0.7.0. The immutable candidate remains available unchanged; this release adds completed acceptance and macOS ARM64 activation. Internal Outlook and Slack artifact version identities retain their reviewed candidate identifiers, so migration records and hashes stay stable.

Desktop 0.1.22 at `9be2182b8b48e6e3dbfdcc8367c42f74b4f6e44f` and CLI 0.1.3 enable tethered setup on macOS ARM64. `LAPLACE_TETHERED_BROWSER_V1=false` remains the rollback switch. Other platforms default off and keep their existing downloads. macOS Intel, Windows and Linux native acceptance is not claimed. The owner explicitly limited the current acceptance work to Mac testing.

- [Desktop Mac release](https://github.com/acriver3/laplace-desktop/releases/tag/desktop-macos-v0.1.22): published archive, manifest and SHA256SUMS. This is an unsigned, non-notarized manual download; it does not advance the automatic-update channel.
- [CLI Mac archive](https://downloads.withlaplace.com/v0.1.3/laplace-local-0.1.3-darwin-arm64.tar.gz), [MCPB](https://downloads.withlaplace.com/v0.1.3/laplace-local-0.1.3-darwin-arm64.mcpb), [checksum manifest](https://downloads.withlaplace.com/v0.1.3/laplace-local-0.1.3-darwin-arm64.manifest.json).
- [Runtime release](https://github.com/acriver3/laplace-mcp-library/releases/tag/browser-runtime-v0.4.1-macos.1): immutable source/extension/native/connector payloads and release qualification manifest.

Both new packages retain the byte-identical native runtime already tested for simultaneous ownership, client removal, upgrade and downgrade refusal. Desktop's first registration now selects shared ownership on the accepted platform. Existing shared registration remains monotonic during rollback.

Final packaged Desktop UI and native checks passed. They include local catalog/copy prompts, imports, two AI clients sharing a process, background/hide/restore/quit behavior, native keychain and encrypted restart, 100 sequential and 32 concurrent bridges, forced termination, helper restart, and uncertain writes without replay. CLI packaged acceptance passed keychain, stdio, discovery, tool calls, metadata privacy and process cleanup; its default catalog reports the accepted tethered entries. Desktop passed 376 tests; CLI passed 63; protocol passed 117. Explicit rollback and non-Mac default tests pass.

The existing [live consent/write evidence](../browser-runtime/evidence/2026-11-05-darwin-arm64-chat-writes.json) covers this unchanged runtime source: account-bound chat approval, Outlook reads, a recipient-free draft and byte-identical 2 MiB attachment round trip, Slack reads, self-message and reaction add/remove. The draft was deleted; the user confirmed deleting the synthetic Slack self-message and confirmed extension 0.7.0. Ordinary setup remains read-only.

The public setup pages were checked over unauthenticated HTTP with JavaScript absent. The requested `connect.laplaceop.com` URLs retain their configured redirect to `connect.withlaplace.com`, preserving the path and serving the complete instructions.

Final Laplace integration: `59b0b6a8ef3e9a5ca4bf19da543e0cbcae8110d7`. The required local plan and build workflow passed against `a560f0384bcc805635c632cb46e49a0af420c50c`; marketing, connector, Builder and gateway builds passed. [Final release evidence](../browser-runtime/evidence/2026-11-05-macos-release.json) records the exact client hashes and validation log digest.

Production activation completed at `02e8cdb71b860fa62cefa8717499c2b34e74ad96`. Connect and marketing hosted releases passed, including runtime verification and promotion. All six public setup pages have the expected titles without login or JavaScript, and the live canonical Connect CLI manifest matches the published checksum. The release-only reconciliation fix leaves accepted client artifact bytes unchanged. See [production verification](browser-runtime-0.4.1-production.json).
