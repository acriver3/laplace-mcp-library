# Managed connector update feed (frozen)

This feed is frozen. Connectors now ship on npm as `@withlaplace/<id>` packages
(see "Release a connector" in [README.md](README.md)), and new connector versions
are no longer added here. `updates/stable.json`, `updates/stable.json.sig`,
`updates/acceptance/` and `updates/artifacts/` stay exactly as they are because
already-installed Desktop and Laplace Local versions still read them: do not add,
edit, re-sign, move or delete any of these files. The MCPB build and release
scripts that produced them (`build-bundle.mjs`, `release-connector.mjs`,
`build-slack-ready.py`, `bundle-archive.py`, `publish-releases.py`) have been
retired.

## What installed clients read

Desktop and Laplace Local consume `updates/stable.json` and its detached signature
`updates/stable.json.sig`, verified against the pinned Laplace Ed25519 key
(`scripts/pinned-update-key.txt`). The version-1 catalog has `schemaVersion`, an
increasing `sequence`, and `releases`. Each release names a connector `id`,
`version`, per-connector `sequence`, `mode` (`tethered` or `background-browser`),
`channel`, `platforms`, `minDesktop`, `minCli`, revisions, `qualified`,
`qualificationSha256` (a record in `updates/acceptance/`), the Git `commit`, the
artifact `directory` under `updates/artifacts/`, and the `files` inventory clients
check before installing. Large executables may be stored as `.gz` transport files
with a `compressed` receipt. Catalogs cannot change browser modes, commands,
accounts, credentials or configuration, and automatic execution stays behind
`LAPLACE_AUTOMATIC_UPDATES_V1`, explicit opt-in and the client's other safeguards.

## Remaining tools

`scripts/sign-update-catalog.mjs`, `scripts/update-acceptance.mjs` and
`scripts/prepare-update-artifact.mjs` are kept only so the existing signed feed and
its acceptance records can still be checked and understood; their tests run with
`node --test scripts/update-release.test.mjs`.
