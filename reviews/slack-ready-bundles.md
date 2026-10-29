# Precompiled Slack MCPBs — 1.1.0-laplace.1

These platform-specific MCPBs replace the source-only default. Each includes a
CGO-disabled Go executable, official Node 24.19.0 runtime, locked Patchright 1.63.0
and patchright-core dependencies, runtime licenses, Go dependency notices, source,
and immutable build provenance. No Go compiler, system Node, npm installation, or
local compilation is needed. Runtime archive SHA-256 pins are committed in
`scripts/slack-runtime-lock.json`; Go builds use go1.27.3 with `-trimpath`.

The first `login` command downloads matching Chromium into the user's normal
browser cache and then opens a dedicated profile for Slack sign-in. Installer
output goes to stderr. `serve` never initiates browser installation or login.
Linux needs Chromium's OS shared libraries and a graphical session for real login.
The browser profile remains outside versioned bundles. OAuth and bot tokens remain
disabled, and launcher defaults and manifests enable read tools only.

Validation:

- All Go offline tests passed with `go test -skip TestIntegration ./...`.
- Seven Node tests passed; the optional browser fixture is run separately.
- All four manifests passed MCPB 2.1.2 schema validation.
- Archive checks verify SHA-256, size, safe paths, lockfiles, dependencies, license
  notices, target metadata, executable permissions and the Go/Node binary CPU
  headers: PE x64, Mach-O x64/arm64, and ELF x64.
- The extracted Linux bundle downloaded Chromium automatically using its bundled
  Node and Patchright, with zero installer bytes on stdout. The real local-browser
  fixture passed, including persistent-profile reopening and session extraction.
- Linux extracted-bundle Node, launcher help and Go executable help ran with no
  system Node/Go/npm available in PATH. The executable rejected OAuth without
  emitting stdout or performing authentication.

Windows x64, macOS Intel and macOS Apple Silicon are cross-compiled package targets;
they have not been executed on native machines in this environment. Packages are
not notarized. Real Slack sign-in, MFA, authenticated tool discovery/read and
native-platform acceptance remain unperformed. The new bundles remain prereleases;
precompiled distribution does not imply authenticated production acceptance.

The old source-only 1.0.0-laplace.patchright.1 bundle and release remain unchanged.
