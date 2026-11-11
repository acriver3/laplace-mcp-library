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
protocol tests and 18 selected catalog, npm-install and setup tests. Its new
stdio fixture installs a synthetic CMS package into an isolated runtime and
checks login arguments, allowed setup tools, rejection of other calls and
inputs, and disabled state after failed authentication. It does not use a
Yale account or the real CMS browser adapter. Desktop type checking and the
production build passed.

Hosted library integration passed its prescribed full local validation and
build plan against the fixed web base
`69e66a389fefe8c6a125f15b583547d386aceaf5`. That included protocol synchronization,
unit tests, contract checks, type checks and local marketing, connector and
gateway builds. These are source/catalog integration checks, not live portal
acceptance.

The coordinating implementation agent reported a successful connector build
and 43 package tests (32 core/protocol and 11 CLI), with the dependency audit
reporting zero vulnerabilities. Sanitized browser fixtures are still in
progress and are not claimed as passing here. A fixture passing does not
establish that the live portal accepts the same operation.

## Pending live acceptance

No authenticated native Windows acceptance is recorded in this review yet.
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

This review does not claim that an npm tarball has been published or installed.
Record registry integrity and actual acceptance before changing the catalog's
publication and acceptance fields.
