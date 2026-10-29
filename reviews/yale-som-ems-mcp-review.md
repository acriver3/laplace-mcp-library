# Yale SOM EMS 0.1.0 candidate review

This first-party package implements the student-account browser-session plan
for Evans Hall breakout rooms, interview rooms, and Fit for Thought. The
signed-in Yale SOM portal reported EMS Web App v226.2 on October 9, 2026.
Template identifiers, required fields, room capacity, floor, type and check-in
notices were read from the account's interface. Empty template About dialogs
are reported as unavailable rule information; EMS form validation remains
authoritative.

The candidate is `yale-som-ems-mcp-0.1.0-universal.mcpb`, 5,827,293 bytes and
2,724 files. SHA-256:
`22447c4b7ea80bd044b9bc01fdd4085594924c3572058a3bdec981b1759c5a8a`.
Two independent builds produced identical normalized archive bytes. Archive
inspection verified compiled code, source, tests, documentation, the locked
production dependency tree, and license files for all 92 dependency packages.
Sessions, credentials, recovery journals, browser binaries and native
production dependencies are excluded.

Source is pinned to Laplace commit
`ed48ceb9d04e2a3a352c70ff275cf534f99e79b8`, subtree
`apps/yale-som-ems-mcp`, retained locally at
`refs/local-mcp-candidates/yale-som-ems/0.1.0`. The snapshot did not change HEAD
or the working index. The `archive/yale-som-ems-0.1.0-source` tag preserves
this exact source commit on origin for remote builds. The archive remains under
`.release/local-mcp-bundles/yale-som-ems-mcp/0.1.0/`.

Native Windows testing used Windows 10 Home 10.0.19045 x64, Node 24.21.0 and
Chrome 154.0.8037.98. Yale SSO/MFA was completed by the user in the dedicated
profile. Authentication survived browser restarts. All six read tools passed
against the exact extracted candidate, including room details, current/past
My Events, searching canceled reservations and individual booking reads.
A development read also verified the Second Floor availability filter.

The user authorized any promptly canceled disposable booking and supplied the
required contact email. The exact candidate's MCP tools created one free
Evans Hall breakout booking, changed its thirty-minute interval, and canceled
that individual booking. My Events verified the reservation and booking IDs,
room, explicit Eastern Time offsets, Confirmed creation/edit status and final
Cancelled status. No active test booking remained. Calendar invitations were
disabled. Private contact details, IDs, screenshots and profiles remain local
outside the versioned bundle.

Earlier development attempts exposed hidden cancellation labels, hidden edit
capacity fields, duplicate save buttons, empty About dialogs and summary
booking attributes. These were corrected before the final checksum was built.
Uncertain creations were inspected and canceled without replaying the write;
the recovery journal was acknowledged only after reconciliation. The final
candidate completed the entire sequence successfully.

Automated checks passed: 16 package tests on the extracted Windows candidate,
one Windows Chrome fixture with every request intercepted, 20 catalog tests,
five packaging/publication tests, four archive tests, project-protocol type
checking and one supervisor/manifest-resolution test. The fixture checks
required fields, empty/conflicting availability, hidden search panels,
unsupported workflows, pending approval and sibling preservation. Core tests
cover expiry, account changes, permissions, expired authentication, daylight
saving transitions and uncertain submissions. Existing Canvas/LinkedIn
manifest and catalog regressions passed. The catalog browser harness also
passed its search/copy and desktop/mobile navigation checks.

The installed Laplace Local 0.1.0 wrapper discovered all eight tools and
successfully executed authenticated ems_session_status and ems_list_templates
reads against the exact extracted candidate and resolved manifest. The
temporary acceptance attachment was removed afterward. The wrapper force-stops
managed Windows process trees; after verifying its EMS owner was dead, the
test released the stale profile lock using status --release-stale-lock and
confirmed the saved session remained usable. Normal direct CLI shutdown
released the lock without recovery.

At 2026-10-10T02:39:26Z, the user reported Apple Silicon acceptance for this
exact candidate, including login, reads, create/edit/cancel and Laplace Local.
This records the report time; the agent did not perform the macOS checks.
OS, browser and Node/wrapper versions were not supplied.

The user authorized publication after reporting Apple Silicon acceptance.
Catalog support now covers Windows x64 and macOS Apple Silicon, the accepted
platforms. At 2026-10-10T02:44:05Z, publication to the existing release bucket
and a public download verified the exact SHA-256 and 5,827,293-byte size. The
archive bytes and pinned source commit did not change. Publication and catalog
installation are enabled for the supported platforms.

macOS Intel and Linux remain unverified and are excluded from catalog support.
Adding Intel requires real student-account login, direct/wrapped reads and a
user-approved disposable create/edit/cancel sequence against this exact
checksum. Record OS/architecture, browser, Node/wrapper
versions, timestamp and redacted launch configuration for each platform; never
infer a platform's success from fixtures or another platform's run. Existing
checksum and immutable publication controls in local-mcp-bundles.md apply.
