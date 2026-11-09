# Laplace MCP Library

The home for Laplace-maintained local MCP source code. Connectors are published
to npm as `@withlaplace/<id>` packages, and [Laplace Desktop](https://github.com/acriver3/laplace-desktop)
installs the version named in [the catalog](catalog/local-mcp-bundles.json).
The shared browser runtime and extension also live here; Desktop and Laplace Local
CLI consume pinned, reviewed copies of those.
Previously named `slack-mcp-server-patchright`; the Slack fork and its Git history
are preserved here alongside the other connectors.

## Current connector setup

The accepted macOS Apple Silicon release provides Outlook [Tethered] and Slack [Tethered] through the user's existing Chrome session. Use [Desktop 0.1.22 for macOS ARM64](https://github.com/acriver3/laplace-desktop/releases/tag/desktop-macos-v0.1.22) or Laplace Local CLI 0.1.3 for macOS ARM64. [Release evidence](reviews/browser-runtime-0.4.1-macos.md) records the exact artifacts and platform scope. Other platforms retain their existing releases. LinkedIn keeps its original background browser implementation.

| Connector | Public setup instructions |
| --- | --- |
| Canvas [Background Browser] | https://connect.laplaceop.com/local-mcp/setup/canvas-session-mcp |
| LinkedIn [Background Browser] | https://connect.laplaceop.com/local-mcp/setup/linkedin-mcp-server |
| Yale SOM EMS [Background Browser] | https://connect.laplaceop.com/local-mcp/setup/yale-som-ems-mcp |
| Outlook [Tethered] | https://connect.laplaceop.com/local-mcp/setup/msoutlook-mcp |
| Slack [Tethered] | https://connect.laplaceop.com/local-mcp/setup/slack-mcp-server |
| Y Combinator · Demo Only | https://connect.laplaceop.com/local-mcp/setup/ycombinator-demo |

The displayed, copied, and agent-sent prompt is one sentence: `Please set up Slack [Tethered] with Laplace using these instructions: https://connect.laplaceop.com/local-mcp/setup/slack-mcp-server`.

These pages cover Desktop and CLI installation, existing-connection reuse, authentication, explicit migration and verification. MCP Apps hosts use the approval card; other chats show the account/profile/scopes and wait for the user's “approve” reply. Provider sign-in links are returned when needed. Ordinary setup performs read-only verification.

## Connectors on npm

| Connector | npm package | Catalog version | Platforms | Runtime |
| --- | --- | --- | --- | --- |
| [Canvas [Background Browser]](connectors/canvas-session-mcp/README.md) | `@withlaplace/canvas-session-mcp` | 0.1.0-laplace.2 | Windows x64, macOS Intel, macOS Apple Silicon | Node; Chrome/Edge |
| [LinkedIn [Background Browser]](connectors/linkedin-mcp-server/README.md) | `@withlaplace/linkedin-mcp-server` | 4.26.2-laplace.2 | Windows x64, macOS Intel, macOS Apple Silicon | Node launcher running the locked Python project with uv (Python 3.13) |
| [Yale SOM EMS [Background Browser]](connectors/yale-som-ems-mcp/README.md) | `@withlaplace/yale-som-ems-mcp` | 0.1.2 | Windows x64, macOS Apple Silicon | Node 24; Chrome/Edge |
| [Outlook](connectors/msoutlook-mcp/README.md) | `@withlaplace/msoutlook-mcp` | 0.5.0-laplace.2 | Windows x64, macOS Intel, macOS Apple Silicon | Node; Chrome/Edge |
| [Slack](connectors/slack-mcp-server/README.md) | `@withlaplace/slack-mcp-server` | 1.1.0-laplace.2 | Windows x64, macOS Intel, macOS Apple Silicon, Linux x64 | Node launcher with Patchright; Go server from `@withlaplace/slack-mcp-server-<os>-<cpu>` |

Each catalog entry names the npm `package`, `distTag`, `bin`, launch `args` and
`env`. Values may use `${user_config.<key>}` (a setting from the connector's
`manifest.json`) and `${package_dir}` (the installed package directory). The entry
also lists `platforms`, whether it is `published`, and per-platform `acceptance`
records naming the version that was accepted and the evidence. Acceptance differs
by connector: Canvas/LinkedIn have user-confirmed Windows/macOS acceptance; EMS has
Windows x64/macOS Apple Silicon acceptance of 0.1.0; Outlook has release approval
but no recorded authenticated native-platform test; Slack has no acceptance record
and remains unavailable for installation. See the catalog and `reviews/`.

Desktop installs a connector with `npm install --ignore-scripts` into an isolated
directory, so lifecycle scripts never run. `@withlaplace` packages must ship
`npm-shrinkwrap.json`, which pins every transitive dependency to registry tarballs
with sha512 integrity. Desktop then runs the package's `bin`: JavaScript launchers
run with Desktop's bundled Node. LinkedIn's launcher runs
`uv run --locked --no-dev --python 3.13 --project <package dir> -m linkedin_mcp_server`
(`LAPLACE_UV` selects uv; Desktop runs `uv sync --locked --no-dev --python 3.13` in
the package directory first). Slack's main package lists one optional package per
platform containing only its cross-compiled Go server, and npm installs the matching
one. No credentials or browser profiles are shipped; keep sessions outside the
package directory.

## Release a connector

Use Node 24+ and the connector's declared toolchain (Slack needs the Go version in
`scripts/slack-runtime-lock.json`; set `GO_BINARY` if it is not `go` on PATH).
Commit and push the reviewed source to `origin/main` first: `publish:npm` only
publishes from a clean checkout whose HEAD is `origin/main`, and builds from
`git archive` of `connectors/<id>`, so local files and sessions are never packaged.

```sh
npm ci --ignore-scripts
npm run verify
npm run publish:npm -- <id> <version> --dry-run
npm run publish:npm -- <id> <version> --otp <code>
```

The script installs locked dependencies without scripts, builds and runs the
connector's tests, renames the package to `@withlaplace/<id>`, converts its
lockfile into `npm-shrinkwrap.json`, packs, publishes with lifecycle scripts
disabled, and checks that the registry serves the same integrity. For Slack it
also builds and publishes `@withlaplace/slack-mcp-server-<os>-<cpu>` for all four
platforms first, at the same version, and pins them in the main package's
shrinkwrap; if the one-time password expires midway, rerun the same command with a
new code and it reuses platform packages already published from that commit.

npm versions are immutable: a published version can never be replaced, so any fix
gets a new version (for example `0.1.0-laplace.3`). After publishing, update the
catalog entry's `version` (and the connector manifest's `version`), record
`acceptance` for each platform actually tested or accepted with that version, then
run `npm run verify` and `python3 scripts/verify.py --registry --strict` before
pushing the catalog. A new version does not inherit acceptance; publish the
package before pushing a catalog that references it. No GitHub Actions are
configured by this library.

## Historical MCPB releases

Earlier releases were MCPB bundles. They stay in `bundles/<connector-id>/<version>/`
at their release tags, and the signed update feed in `updates/` is frozen (see
[updates-README.md](updates-README.md)), because already-installed Desktop and
Laplace Local versions still read them. No new bundles are built.

## Source and licenses

`connectors/` contains source, manifests, lockfiles, licenses and provenance.
Connector sources for Canvas, LinkedIn and Outlook track pinned upstream commits
with Laplace patches recorded in the catalog; Yale SOM EMS is first-party code whose
canonical source is `connectors/yale-som-ems-mcp`. Historical review notes are in
`reviews/`; references to the Laplace monorepo in those records describe the
original release process.

Each connector retains its own license and attribution. The root MIT license
covers the inherited Slack fork; it does not override connector licenses. In
particular, Yale SOM EMS is first-party proprietary code with its own LICENSE.
Third-party dependencies retain their licenses; Slack's platform packages carry
the Go and Go module notices.

## Connector setup links

Use `https://connect.laplaceop.com/local-mcp/setup/<catalog-id>` for the current public setup instructions. For example: “Please set up LinkedIn [Background Browser] with Laplace using these instructions: https://connect.laplaceop.com/local-mcp/setup/linkedin-mcp-server”. The web and Desktop catalogs use this same one-sentence format. Connector READMEs and manifests describe their versioned implementations.

The browser-runtime candidate contains Outlook and full Slack adapters, the shared extension and native installer, and Desktop/CLI approval and migration primitives. See [runtime release gates](browser-runtime/README.md) and its artifact-specific evidence before activation. LinkedIn retains its original implementation.
