# Yale SOM CMS [Tethered] 0.1.1 candidate review

This first-party MIT package connects a Yale SOM student account to
https://som-yale.12twenty.com/dashboard/. Its canonical source is
`connectors/yale-som-cms-mcp`. It is not a Yale or 12twenty product.

The current npm identity is `@withlaplace/yale-som-cms-mcp@0.1.1`, targeting
Windows x64, Node 24 and visible Chrome. The catalog remains an unpublished
candidate with an empty acceptance list until final native verification.

## Authentication and connection

The connector attaches to the user's existing visible Chrome session through
Chrome's loopback DevTools connection. The user enables remote debugging at
`chrome://inspect/#remote-debugging` and approves Chrome's native connection
prompt. Login opens a connector-owned CMS tab for manual Yale sign-in, MFA
and browser verification. Chrome retains the authenticated session.

A private local gateway exposes only the connector-owned tab and its child
sessions to Playwright. Other tabs, Chrome-wide settings and global storage
mutations are excluded. Shutdown closes only that owned tab and disconnects;
it leaves Chrome running. Production code never launches a browser or runs
headless Chrome. Read and preview traffic remains guarded on the owned tab.
Browser challenge traffic is restricted to documented Cloudflare origins
and paths and never counts as evidence of a student submission.

The CLI contract is `serve|login|status --state-dir <absolute-path>
--cdp-url ws://127.0.0.1:9222/devtools/browser --downloads-dir <absolute-path>`.
CDP endpoints require an explicit port, a loopback host and the browser
WebSocket path; credentials, queries, fragments and remote hosts are rejected.
`--profile-dir` is a deprecated state-folder alias. The state folder stores
a lock and submission journal, outside the installed package. Cookies remain
in Chrome. No profile import or credential export is required.

## Release history and live findings

Version 0.1.0 was published from
`79630cf303608c4e71b05367dbcd793f29d0cb8a` on 2026-11-11. The registry integrity
matched the publisher artifact:
`sha512-nSmpu8y0LBXWk6QCRoM684O6JGpNLCmA0sc/kUy++yYGChs51mS/aCwvgPJH2P27GWCVFOYkfTLqk3UCJynsIw==`.
Manual Yale authentication succeeded, but automated browser windows encountered
Cloudflare security-verification loops. These were not accepted as successful
authenticated reads. The existing ordinary Chrome session remained signed in;
a newly created CMS dashboard tab in that session also authenticated successfully.

Version 0.1.1 changes the product to **Yale SOM CMS [Tethered]**, with no
headless serving mode. End-to-end native MCP acceptance through its scoped
connection is still being recorded. Existing 0.1.0 fixture evidence below
does not certify the changed connection architecture. No live student writes
have been used as tests.

Cloudflare documents its challenge paths and the limitations of automated
browsers: [reserved endpoints](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/),
[challenge detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/),
[supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).
No CAPTCHA solving, browser fingerprint changes or user-agent overrides are included.

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

## Tethered candidate verification

The native Windows development candidate completed two MCP process starts
against the same ordinary Chrome session, discovering 39 tools each time.
Both starts returned an authenticated session and dashboard data; Chrome
remained running after each disconnect. A subsequent live MCP read matrix
completed all 21 student areas with explicit `America/New_York` time zones
and continuation tokens where applicable. The matrix completed at
`2026-11-11T17:21:25.914Z`. These are candidate-source observations, pending
repetition against the published artifact and Desktop setup.

A live dashboard read exposed an Angular readiness race: the application's
injector belongs to its main element, not the document body. The readiness
check now waits for that injector's CMS API requests. A synthetic browser
regression failed before the change and passed afterward; a subsequent live
read had no pending CMS requests when recommendations were extracted.

Confirmed writes also bind the observed tenant authentication cookie to the
preview in memory. Before an unsafe request is released, its actual paused
Cookie header and Chrome's current CMS session must both match. Only a
hash enters account binding; cookie values never appear in tool output,
logs or persisted state. Fixtures cover an account switch after preview and
during durable journaling, with zero provider POSTs and an uncertain journal
when a commit was already armed. No live student writes were performed.

## Reviewed native workflow boundaries

The source includes dedicated adapters for a new native job application,
new event registration and appointment booking/cancellation. Application and
event documents are bound to the portal's stable requirement IDs. Existing
document selection, approved local uploads and optional materials-library
copies are separate, previewed effects. Applications with custom questions,
office ranking, bidding, approved-resume-only requirements or external
application destinations require interactive completion. Event surveys,
external instructions and core-event slot-locking flows are also excluded.

Appointment booking binds an available block and exact UTC start/end slot;
cancellation binds the student's existing active appointment. Editing,
rescheduling, attendance tracking and queues are outside this native adapter.
Unsupported custom controls or ambiguous records fail closed. No adapter
uses a completion message or settled network request alone as success:
verification requires the expected own record/state, and document linkage
or optional library saves may remain partial or uncertain.

These are implementation boundaries, not claims of live write acceptance.
The workflow and service-integration fixtures remain distinct from the
account-level checks and native artifact evidence below.

## Historical 0.1.0 automated evidence

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
`896ba071649ece404238761894d542de9fcb1978`. The feature branch was pushed; no production deployment was performed.

Final connector code at `eced14d550c8bf2e794c15e2b12043f87124dd29`
passed the complete suites on both systems:

- Native Windows: 100 of 100 Chrome browser fixtures passed; 52 unit/protocol
  tests passed and one symlink-permission fixture was skipped.
- WSL: all 100 Chrome browser fixtures and all 53 unit/protocol tests passed.
- Library `npm run verify` passed. The production dependency audit reported
  zero vulnerabilities.

The final suites include native application and event document workflows,
appointment booking/cancellation, exact final-click field and attachment
checks, changed account/eligibility/slots, blocked preview autosaves, profile
contention, uncertain submissions and duplicate confirmation. A changed
appointment during final journaling produces zero provider calls and an
honest uncertain journal outcome. Existing event-document associations remain
partial unless the portal supplies authoritative attachment verification.

Native logs are
`C:\Users\duney\.codex\tmp\yale-cms-native-unit-final-source.log` and
`C:\Users\duney\.codex\tmp\yale-cms-native-browser-final-source.log`.
WSL logs are `/tmp/yale-cms-unit-final-source.log` and
`/tmp/yale-cms-browser-final-source.log`. Sanitized fixtures use synthetic
data and do not establish live portal acceptance.

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

Manual dedicated-profile authentication succeeded, but automated browser
acceptance encountered the Cloudflare loop described above. The new tethered
connection uses the already-authenticated ordinary Chrome session. Its final
native checks, restart behavior and Desktop setup still require verification.

Before activation, record the exact npm version, OS and architecture, browser
version, Node/Desktop version and UTC timestamp, together with the observed
results for:

- Manual Chrome sign-in, tethered authenticated reads and restart
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

The publisher also enforces the clean `origin/main` requirement during a dry
run. It fetches origin first, rejects tracked or untracked changes and rejects
an existing npm version. It runs the package build and `npm test`, packs a
shrinkwrapped tarball and prints its source commit, file count and integrity.
It does not run the browser fixtures, install the CMS package into Desktop
or authenticate a user. A dry run does not publish and its temporary staging
directory is removed when it finishes; the real publication rebuilds.

After the coordinator has integrated and pushed the validated source while
keeping this catalog entry unpublished, use a clean release checkout with
Node 24+, Git, tar, installed Chrome and npm registry access. From the library
root:

```sh
git fetch origin main
git status --porcelain
git rev-parse HEAD origin/main
npm ci --ignore-scripts
npm run verify
npm --prefix connectors/yale-som-cms-mcp ci --ignore-scripts --workspaces=false
npm --prefix connectors/yale-som-cms-mcp run type-check
npm --prefix connectors/yale-som-cms-mcp test
npm --prefix connectors/yale-som-cms-mcp run test:browser
npm run publish:npm -- yale-som-cms-mcp 0.1.1 --dry-run
```

The status output must be empty and both SHAs must match; do not rewrite remote
tracking refs to satisfy this gate. Record the dry-run output with the final
source checks. Before actual publication, separately confirm npm authentication
and permission to publish `@withlaplace/yale-som-cms-mcp`; use npm's interactive
login/MFA flow without storing credentials in this repository. Publication,
registry integrity verification, installation of the published package and
authenticated Desktop acceptance remain separate steps. Do not activate the
catalog from a dry-run result or inherit acceptance from a prior build.

As of this update, version 0.1.0 is published and npm authentication succeeded.
Version 0.1.1 remains a candidate. The existing Desktop signing key was located
in Doppler and its public half matched Desktop's pinned key in a memory-only
preflight. No key contents were printed or saved. No new signed Desktop release
or catalog activation has been claimed.

The catalog remains `published: false`, `candidate: true`, with no acceptance
records, and its review reference remains `reviews/yale-som-cms-mcp.md`.
Record the final validated source commit, npm registry integrity and actual
acceptance before changing publication or acceptance fields.

## Integrated source verification on 2026-11-12

The tethered CMS changes were integrated with current library main. The library
catalog verification and CMS TypeScript check passed. All 79 unit/protocol tests
and all 123 browser-fixture tests passed on WSL with Node 24.21.0 and installed
Chrome. The catalog remains an unpublished 0.1.1 candidate with no acceptance
records. These checks cover source and synthetic browser behavior. Published
package installation and native student-account acceptance remain pending.
