# Yale SOM CMS [Background Browser]

Local stdio MCP for the Yale School of Management career platform at
[https://som-yale.12twenty.com/dashboard/](https://som-yale.12twenty.com/dashboard/).
The npm package is `@withlaplace/yale-som-cms-mcp`. The initial catalog target is
Windows x64, with Node 24 and installed Chrome or Edge.

As of 2026-11-11, version 0.1.0 is an **unpublished candidate**. The commands below
apply after publication; the catalog does not currently offer this candidate
for installation. See the [candidate review](https://github.com/acriver3/laplace-mcp-library/blob/main/reviews/yale-som-cms-mcp.md)
for completed checks and pending authenticated acceptance.

## Sign in once, then use the background browser

Laplace Desktop installs an exact package version with npm integrity checks.
Authenticate opens a **visible, dedicated browser window**. Complete Yale or
12twenty sign-in and any MFA yourself. The connector then reuses that saved
profile in headless Chrome or Edge for normal MCP calls. Wait for the login
command to report success and close its window before starting the server.
Stop any process using that profile before signing in again or running a
separate status command.

This is not a tether to your everyday Chrome tab. It does not import cookies,
attach to your personal browser, or ask for passwords in chat. Opening CMS in
your everyday browser helps inspect the website during development, but it
does not authenticate this connector's separate profile.

For direct installation and invocation:

```sh
npm install --ignore-scripts @withlaplace/yale-som-cms-mcp@0.1.0
node node_modules/@withlaplace/yale-som-cms-mcp/dist/cli.js login --profile-dir /absolute/path/to/cms/profile --browser chrome --downloads-dir /absolute/path/to/downloads
node node_modules/@withlaplace/yale-som-cms-mcp/dist/cli.js status --profile-dir /absolute/path/to/cms/profile --browser chrome --downloads-dir /absolute/path/to/downloads
node node_modules/@withlaplace/yale-som-cms-mcp/dist/cli.js serve --profile-dir /absolute/path/to/cms/profile --browser chrome --downloads-dir /absolute/path/to/downloads
```

On Windows, use absolute Windows paths and quote paths containing spaces.
Choose `msedge` for Edge. Keep the same browser channel, profile and download
folder for all commands. The standalone defaults are:

- Profile: `~/.laplace-local/sessions/yale-som-cms/profile`.
- Downloads: `~/Documents/Yale SOM CMS`.
- Browser: `chrome`.
- Interactive login timeout: 1,800 seconds, adjustable with
  `login --login-timeout 1..3600`.

Desktop supplies its own isolated session directory. Sessions, cookies,
submission journals and temporary upload snapshots stay outside the package.
Do not share a profile across operating systems or run two owners at once.
An expired session returns `auth_required`; run `login` again. Serving never
opens an unexpected sign-in window.

Setup verifies `cms_session_status` and `cms_get_dashboard`. Installation,
authentication and verification do not submit applications or make bookings.

## Student areas and read tools

| Area                       | Tools                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Session and dashboard      | `cms_session_status`, `cms_get_dashboard`                                                                 |
| Jobs and applications      | `cms_search_jobs`, `cms_get_job`, `cms_list_applications`, `cms_get_application`                          |
| Interviews                 | `cms_list_interviews`, `cms_get_interview`                                                                |
| Events                     | `cms_search_events`, `cms_get_event`                                                                      |
| Appointments and calendars | `cms_search_appointments`, `cms_get_appointment`, `cms_get_calendar`                                      |
| Employers and contacts     | `cms_search_employers`, `cms_get_employer`, `cms_search_contacts`, `cms_get_contact`                      |
| Career organization        | `cms_list_targets`, `cms_list_tasks`, `cms_get_task`, `cms_list_saved_searches`, `cms_get_activity`       |
| Profile and outcomes       | `cms_get_profile`, `cms_list_outcomes`, `cms_get_outcome`, `cms_get_settings`                             |
| Application materials      | `cms_list_documents`, `cms_list_resume_books`, `cms_get_resume_book`                                      |
| Resources and research     | `cms_search_resources`, `cms_get_resource`, `cms_get_job_analytics`, `cms_list_offices`, `cms_get_office` |

Use `cms_get_capabilities` to discover the implementation's supported operations
and any access restrictions. A tool being listed does not grant permission to
a page or action. Missing permissions, unavailable account features and changed
page layouts return explicit errors rather than fabricated results.

Search/list tools accept relevant `query`, `filters`, `cursor`, `limit`,
`view`, `start` and `end` arguments. Discover filter names and choices from
returned fields. Do not invent internal field identifiers. Detail tools use
the `id` returned by the corresponding read tool. Respect `next_cursor` and
`truncated`; a first page is not the entire result set.

Dates retain explicit offsets and use `America/New_York` for portal-local
times. Appointment and multi-slot event changes bind exact record and slot
identifiers, not a title or row number. Job IQ results retain their source,
cohort, filters and currency; suppressed or unavailable values are not inferred.

## Confirmed changes

The adapter exposes operations for student applications, registration and
scheduling, documents and resume books, profile and education/experience,
employment or offer reporting, tasks, targets, saved searches and alerts.
An operation is usable only when the account exposes its supported form,
controls and permissions. Listing an operation is not a promise that every
custom form or account configuration is supported.

1. Use the appropriate read tool to identify the record and exact slot.
2. Call `cms_get_form` with `operation`, `area`, and any required
   `target_id`, `parent_id` or `slot_id`.
3. Supply the returned field identifiers and exact values to
   `cms_prepare_change`. Uploads use `files: [{ field, path }]` with an explicit
   absolute local path.
4. Show the **entire** returned preview to the user, including all fields,
   selected files, targets and compound effects.
5. Only after approval, call
   `cms_commit_change({ draft_id, confirm: true })`.

A `confirm: true` flag is the caller's attestation, not proof of human consent.
Keep the MCP client's approval controls. Previews remain local: form
inspection must not trigger autosaving, favorite changes, uploads, application
drafts, registrations or other remote effects. Drafts expire after ten minutes
and are consumed once. Revalidation checks the account, target, eligibility,
current state and exact file contents. Changed details require a new preview.

The following reserved `fields` keys select known portal sections; other
field keys must come from `cms_get_form`:

| Key              | Meaning                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_section`       | Profile section: `General`, `Preferences` or `Summary`                                                                                                                                   |
| `_document_type` | `Resumes`, `Cover Letters`, `Transcripts`, `Recommendation Letters`, `Writing Samples`, `Others` or `Urls`                                                                               |
| `_outcome`       | `Accepted Job`, `Received Job`, `Declined Job`, `Sponsored Job`, `Own Venture`, `Seeking Employment`, `Continuing Education`, `Postponing job search` or `Not seeking for other reasons` |
| `_favorite`      | Boolean desired favorite state                                                                                                                                                           |
| `_target_type`   | `employers` or `contacts`                                                                                                                                                                |

No tool accepts arbitrary JavaScript, selectors, HTTP requests or execution
URLs. The server follows explicit CMS module adapters. Employer/admin actions
and unrelated external sites are outside its scope.

Native CMS application submission is separate from an employer's external
application site. External applications return a handoff link. External
calendar/account linking and consent remain interactive.

## Reviewed native application, event and appointment flows

These adapters follow the native CMS student forms and bind each action to
the signed-in student and exact record. Their automated coverage uses
synthetic browser fixtures; it is separate from live account acceptance.

| Workflow | Supported form | Interactive completion required |
| --- | --- | --- |
| Job application | A new native CMS application for an eligible posting, with reviewed document requirements. Choose each exact existing document or approved local upload, its name and whether to save a copy to application materials. | External, email, fax or mail applications; custom questions; office rankings; bidding; approved-resume-only requirements; URL/current-document modes; external document-service consent or additional steps. |
| Event registration | A new registration with either confirmation alone or documents followed by confirmation. The exact event and any selected slot are bound to the preview. Available existing documents and local uploads are supported; a waitlist outcome remains a waitlist outcome. | Surveys, custom questions or consent, external registration instructions, core-event reservation/slot-locking flows, URL/current-document modes or unrecognized steps. |
| Appointment | A new booking from an available appointment block, with an exact returned slot and the form's supported fields/uploads; cancellation of the student's own active appointment when CMS permits it. | Editing or rescheduling an existing appointment, attendance tracking, queues, unavailable slots or forms whose controls cannot be bound unambiguously. |

For appointment booking, use the available-block ID as `target_id` and choose
`slot_id` from `cms_get_form`. The slot binds the block and exact UTC start/end
times, so a reordered list cannot select another appointment. Cancellation
uses the booked appointment ID and accepts no slot, fields or files. A
reschedule is not performed as an implicit cancel-and-rebook operation.

Application and event document field IDs include the document requirement ID,
for example `document:<id>:type`, `document:<id>:existing` and
`document:<id>:file`. Copy the returned identifiers and choices; repeated
labels such as "Resume" do not identify a unique requirement. Unknown fields,
duplicate controls, changed requirements or unsupported custom forms return
an explicit error or an unsupported-form result. Complete those workflows
interactively instead of substituting another action. In particular, an
employer's external application and CMS "Mark as Applied" are different
actions.

## Files and compound outcomes

`cms_download_document` accepts a permitted document or resource ID and an
optional plain `filename`. It writes only within the configured downloads
folder, avoids silent overwrites, and does not forward Yale credentials to an
unrelated host.

The portal currently requests application documents in PDF format. The
connector checks actual form requirements and a local maximum of 50 MiB per
file; a lower portal limit remains authoritative. File previews include the
resolved path, name, size and SHA-256 hash. After confirmation, uploads use
private copies of the approved bytes and remove them when the operation ends.

Uploading a document, saving it to the application-material library, and
clicking Apply are separate remote effects. The preview lists intended
effects; each is journaled before execution. A partially completed operation
is not atomic and is not described as rolled back. Waitlisted or pending
approval is reported as that state, not a confirmed registration.

The connector waits for the final action and its captured write requests to
settle before reading the resulting record. A successful HTTP response, a
closed form or success text alone does not prove the intended change. The
result must identify the expected student, record and state. Upload
acknowledgment is also separate from proof that the exact document was linked
to the application, registration or appointment; missing attachment or
library-save evidence can leave the result partial or uncertain.

## Uncertain submissions and recovery

If a process ends during a submission, a response is lost, or verification
fails, further writes are blocked. Read tools remain available to inspect the
authoritative application, appointment, registration, document or profile.

First stop any remaining process using the profile. Inspect the affected
record in CMS. Then explicitly acknowledge the observed outcome locally:

```sh
node dist/cli.js status --profile-dir /absolute/path/to/cms/profile --browser chrome --downloads-dir /absolute/path/to/downloads --acknowledge-uncertain --note "Inspected CMS: the intended registration exists with the expected slot."
```

This records the acknowledgment; it never retries the operation or deletes the
remote record. A corrupt journal is not automatically discarded.

Normal shutdown releases profile ownership. If a crashed owner's lock remains,
stop its remaining browser before running the same `status` command with
`--release-stale-lock`. The command refuses to release a lock owned by a live
process. Recovery flags are valid only with `status`.

## Development and validation

The browser fixture suite requires installed Chrome. From this package directory:

```sh
npm ci --ignore-scripts --workspaces=false
npm run type-check
npm test
npm run test:browser
```

Core and protocol tests cover exact previews, expiry, duplicate confirmation,
account/state changes, changed files, durable effect journals, interrupted and
partial submissions, recovery, cancellation and real stdio initialization.
Browser fixtures use sanitized synthetic content and intercept requests so
they cannot contact Yale. The native workflow fixtures exercise exact
student/record/slot binding, multiple document requirements, upload
acknowledgments, delayed final responses, authoritative receipts, unsupported
forms and changed-state rejection. These checks do not submit real
applications, register a user for an event or book appointments.

The release publisher runs the package build and `npm test`, but does not run
`npm run test:browser` or authenticate a real account. Run and record those
separate checks for the final source before release.

Passing fixtures does not establish live write acceptance. Release evidence
must separately identify authenticated read checks, dedicated-profile login
and restart persistence, native Windows installation/Desktop setup, and any
concrete user-approved live write checks. Unverified platforms remain
unverified. Never submit an application or book a slot merely to test setup.

This is an independent Laplace integration, not a Yale or 12twenty product.
