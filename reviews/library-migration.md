# Library migration verification — October 29, 2026

The existing Slack repository was renamed in place to `acriver3/laplace-mcp-library`
(repository ID 1417620001). Slack source history is preserved by moving its tree
under `connectors/slack-mcp-server`.

Canvas, LinkedIn, Yale SOM EMS and Outlook artifacts were downloaded from the
previous release origin and verified against the Laplace catalog's exact SHA-256
and byte length before source extraction. The four GitHub Release mirrors retain
those original bytes and acceptance records. Missing development files were
restored from the recorded immutable source commits. No upstream connector
implementation was modified during this move.

Validation performed in Linux with Node 24:

- All five source manifests passed MCPB 2.1.2 validation.
- All five catalog archives passed SHA-256, size, safe-path and identity checks.
- The standalone builder successfully produced separate unpublished candidate
  bundles for all five connectors. Candidate builds use new version numbers;
  these build-smoke artifacts are not the mirrored releases.
- Canvas: 19 source tests passed during candidate build.
- Outlook: TypeScript build and 330 tests passed during candidate build.
- Yale SOM EMS: TypeScript build and 16 tests passed.
- Slack: three offline Node tests passed; the optional browser smoke was skipped.
- LinkedIn: source packaging and manifest validation passed; its Python test suite
  was not run during this migration.

The Slack MCPB is a source-distribution prerelease. Users must install its locked
Node dependencies, install Patchright Chromium and compile Go locally. Go tests
were not rerun: this environment's `go` command is not the Go language toolchain.
The existing provenance retains earlier Go results. Real Slack sign-in and an
authenticated read, plus native-platform acceptance, remain unperformed. No fresh
authenticated platform acceptance is claimed for any connector in this migration.

Root build tooling preserves the environment's proxy and CA settings while
excluding application credentials. Dependencies and browser state are not copied
from developers' machines. Browser profiles and secrets stay outside source and
bundle directories. Existing R2 releases remain available.
