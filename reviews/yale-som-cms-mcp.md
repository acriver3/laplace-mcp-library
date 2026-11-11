# Yale SOM CMS 0.1.0 candidate review

This first-party package connects a Yale SOM student account to the career
platform at https://som-yale.12twenty.com/dashboard/. Its canonical source is
`connectors/yale-som-cms-mcp` in this repository, licensed under MIT. It is not
a Yale or 12twenty product and does not reuse third-party connector source.

The npm identity is `@withlaplace/yale-som-cms-mcp@0.1.0`. The initial catalog
target is Windows x64 with Node 24 and installed Chrome or Edge. The entry is
an unpublished candidate with an empty acceptance list. Platform availability
is an intended release target, not a claim that native acceptance passed.

## Authentication and scope

The user completes Yale/12twenty sign-in and MFA in a visible, dedicated
browser. Normal MCP calls reopen that saved profile headlessly. The connector
does not import cookies or attach to an ordinary Chrome tab. When the session
expires, the user must run login again.

The agreed CLI contract is `serve|login|status --profile-dir <absolute-path>
--browser chrome|msedge --downloads-dir <absolute-path>`. The browser profile,
download directory and browser channel remain consistent between commands.
Profile data and submission journals remain outside the installed package;
downloads are written only to the selected local download directory.

The student tool surface includes dashboard, jobs, applications, interviews,
events, appointments, employers, contacts, documents, resources, profile and
career organization reads. Changes use form discovery, a complete local
preview and explicit confirmation. The caller must obtain user approval for
the preview before committing it. The connector journals remote effects,
rejects changed or expired previews, and blocks replay after an uncertain
submission. External employer applications and account/calendar consent are
interactive handoffs. No tool accepts arbitrary JavaScript, selectors or
unrestricted HTTP requests.

Desktop authentication runs the login command. Setup verification calls only
`cms_session_status` and `cms_get_dashboard`; it does not submit applications,
register for events, book appointments or change a profile.

## Automated evidence

The Desktop catalog/runtime implementation was checked on WSL with 29 shared
protocol tests and 18 selected catalog, npm-install and setup tests. Its stdio
fixture installs a synthetic CMS package into an isolated runtime and checks
login arguments, allowed setup tools, rejection of other calls and inputs,
and disabled state after failed authentication. It does not use a Yale
account or the real CMS browser adapter.

Hosted library integration was rebased onto the latest reviewed web main,
`0b97d3b2a5b1567da67ea5e26f80ddfa284f98ce`, which added public documentation and
shared documentation MCP content. The four CMS commits rebased without
conflicts or patch changes. The prescribed full local validation and build
plan passed at web commit `0d443d7bbe6840ceacc7ab5f74659256837d5811`, using that
fixed base. This included documentation drift, protocol synchronization,
formatting, lint, type checks, contract checks, full selected unit suites and
local marketing, connector and gateway builds. The connector suite passed 576
tests; the shared protocol suite passed 75; the WSL Desktop suite passed 474
with one platform skip. The full log is retained locally at
`/tmp/yale-cms-web-rebase-verify.log`. The reviewed web integration pins Desktop
`896ba071649ece404238761894d542de9fcb1978`. No push or deployment was performed.

For the connector package, the coordinating implementation agent reported a
successful native Windows unit run with 53 tests: 52 passed and one platform
symlink test skipped, after correcting the staging manifest. A native Chrome
fixture run passed 47 tests. The dependency audit reported zero
vulnerabilities. Subsequent completion-observer and workflow integration
additions are undergoing final combined validation; these earlier counts do
not certify that later source state. Sanitized fixtures use synthetic data
and do not establish live portal acceptance.

## Native Windows Desktop evidence

An isolated local Desktop candidate was built on Windows 10 Home 10.0.19045
x64 using Node 24.21.0, pnpm 10.28.2, uv 0.12.24 and Visual Studio C++ Build
Tools. The native validation report completed at `2026-11-11T05:05:08Z`:
`E:\LaplaceBuilds\temp\yale-cms-desktop-native-validation.json`. Detailed
command logs remain beside that local report.

The packaged application source was Desktop commit
`0a3246dde6dea88e265d1fbceb6f623a079f436f`, retaining version `0.1.48`. Follow-up
changes affected test fixtures only. At Desktop commit
`896ba071649ece404238761894d542de9fcb1978`, the complete native source check
passed type checking, the production build and 77 test files: 472 tests
passed and three skipped. The CMS fixture now includes the native Windows
process supervisor. Migration tests isolate their Windows application-data
path from the live Outlook profile; cancellation tests wait for the durable
journal before deleting their temporary directory.

Runtime preparation, ZIP/Squirrel packaging and packaged Electron smoke
passed. Electron checks used isolated profiles and keychain entries and
covered local pages, signed-out setup, custom connector management, UI
navigation, provider-popup isolation, tray/runtime restart, two stdio clients,
window-close background operation and cleanup. Packaged native runtime smoke
passed keychain storage, encrypted restart, bundled Node/plugin launchers,
connector installation, 100 sequential and 32 concurrent bridge connections,
forced termination, helper restart, exactly-once uncertain effects and
managed process cleanup. The packaged helper contains the CMS catalog ID,
npm package, verification tool and downloads-directory configuration.

The local ZIP is 225,401,371 bytes with SHA-256
`b0e41fc47a43fa2e7b3178f122ead1dbbdbf6b119f3c7d9ead0593566ba2f003`.
The local Squirrel installer is 218,117,120 bytes with SHA-256
`0463c4524789e1c41e2d9e03fe24481b15aeb5d035326365265c80418d3d9c65`.
They remain under
`E:\LaplaceBuilds\yale-cms-desktop-b6773a3\apps\desktop\out\make`.
These checks cover the identified local artifacts, not a subsequently rebuilt
release. No installation/uninstallation of the user's existing Desktop,
signing, release publication or catalog activation was performed.

## Live read-only discovery

The coordinating implementation agent reported 27 live extractor cases
against the user's already-authenticated ordinary Chrome session. These were
read-only development observations. They help validate the account's visible
page structures and extracted data, but do not authenticate the connector's
separate profile or establish saved-profile/headless operation. No live
writes were performed: no application submission, event registration,
appointment booking, document upload or profile change was used as a test.

## Pending live acceptance

The dedicated-profile sign-in attempt timed out. No completed authentication
or restart persistence has been verified for that connector profile. Native
Desktop fixture/package success and ordinary-Chrome discovery are separate
from this pending authenticated acceptance.

Before activation, record the exact npm version, OS and architecture, browser
version, Node/Desktop version and UTC timestamp, together with the observed
results for:

- Manual dedicated-profile sign-in, headless authenticated reads and restart
  persistence.
- Published-package installation and Desktop authentication/setup verification.
- Read tools and document downloads against the account's accessible modules.
- Any concrete, user-approved live changes, listing the exact workflow tested
  and its verified outcome separately from untested workflows.

Do not submit an application or make a booking merely to satisfy setup
verification. Keep credentials, profile contents, screenshots and private
student records out of this repository. Other platforms remain unverified.

## Publication and provenance

The library publisher now permits this connector. It builds and tests from an
archive of a clean checkout whose HEAD equals `origin/main`, pins dependencies
in `npm-shrinkwrap.json`, publishes the exact tarball with lifecycle scripts
disabled and verifies registry integrity. The published package records its
source commit in `laplace.libraryCommit`; that immutable value is the source
provenance for the release.

As of this review update on 2026-11-11, the source/package candidate remains
unpublished. The npm web-login attempt expired, and registry authentication
is absent. Desktop update signing-key availability is unverified. No signed
release or published-package installation is claimed.

The catalog remains `published: false`, `candidate: true`, with no acceptance
records, and its review reference remains `reviews/yale-som-cms-mcp.md`.
Record the final validated source commit, npm registry integrity and actual
acceptance before changing publication or acceptance fields.
