# Yale SOM EMS Student MCP

Local stdio MCP for Yale SOM student breakout rooms, interview rooms, and Fit
for Thought. Version 0.1.0 is a candidate: authentication, booking changes,
and Laplace Local acceptance must pass on every declared platform against the
exact artifact checksum before catalog installation is enabled. The inspected
portal was EMS Web App v226.2.

## Setup

Use Node 24 and installed Google Chrome or Microsoft Edge. A packaged bundle
includes compiled code and production dependencies; do not reinstall them.
For development only, run `npm ci --ignore-scripts --workspaces=false` and
`npm run build` inside this package. The independent npm lockfile supports
building this subtree without other Laplace packages or credentials.

```sh
node dist/cli.js login --profile-dir /absolute/path/to/dedicated/ems/profile --browser chrome
node dist/cli.js status --profile-dir /absolute/path/to/dedicated/ems/profile --browser chrome
node dist/cli.js serve --profile-dir /absolute/path/to/dedicated/ems/profile --browser chrome
```

On Windows use an absolute Windows profile path. Choose `msedge` for Edge.
Use the same browser channel and profile for all three commands. The default
profile is `~/.laplace-local/sessions/yale-som-ems/profile`. Login is interactive;
complete Yale SSO and MFA yourself. Credentials are never requested in chat.
Do not share profiles across operating systems or open one simultaneously in
multiple clients. Normal shutdown releases ownership; after a process crash,
stop its remaining browser before using `status --release-stale-lock`.

Resolve the bundle's manifest locally, then attach only its `yale-som-ems` stdio
configuration through Laplace Local. Setup checks `ems_session_status` and
`ems_list_templates` directly and through the wrapper. It does not test writes.

## Tools

| Tool                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `ems_session_status`       | Verify authentication and identify the account                      |
| `ems_list_templates`       | Discover template IDs, rules and required fields                    |
| `ems_search_availability`  | Search a template's rooms for a time interval                       |
| `ems_get_room`             | Read room details for that template and interval                    |
| `ems_list_my_reservations` | Read current/past My Events, including cancellations when requested |
| `ems_get_reservation`      | Read one reservation with separate booking IDs and status           |
| `ems_prepare_change`       | Prepare one creation, update or cancellation without submitting     |
| `ems_commit_change`        | Submit a confirmed preview once and verify it through My Events     |

Search requires `template_id`, `start`, `end` and `attendance`; times must be
ISO timestamps with offsets and whole minutes. Results use America/New_York
and include explicit daylight-saving offsets. EMS's clock picker currently
offers quarter-hour steps; other minutes return its available choices.
Optional filters are `room`,
`floor`, `room_type` and `features`. Obtain IDs and filter labels from EMS.

Creation also requires `room_id`, `event_name`, `contact_name` and
`contact_email`. Optional values include `event_type`, `group_id`,
`contact_phone` and discovered user-defined `fields`. Required fields and
choices come from the actual template. Calendar invitations are disabled.
Updates require reservation/booking IDs and a replacement template, room,
interval and attendance; they do not change the shared reservation name.
Cancellations require both IDs and any reason required by EMS.
Cancellations verify the individual booking's template using its edit form and
a read-only availability search. If EMS prevents opening that form or the
template is unsupported, V1 stops before submission.

Show the full preview to the user before committing with its `draft_id` and
`confirm: true`. A confirmation flag attests that the caller obtained approval;
it does not prove human consent. Retain MCP client approval controls. Drafts
expire after ten minutes, are tied to the authenticated session, and are
consumed before revalidation. Changed details require a new preview.

Submission intent is journaled locally before the final action. If the process
ends or verification fails, another write is blocked. Inspect My Events and
the affected booking in EMS, then explicitly acknowledge the outcome with
`status --acknowledge-uncertain` using the same profile. Restart the MCP server
after recovery. This acknowledgment does not replay an operation.

EMS rules and permissions remain authoritative. Pending approval is returned
as pending. Room notices may require physical room-pad check-in.
V1 excludes recurrence, multiple rooms, services, paid requests, staff
templates, Campus Groups, browser-cookie import, remote check-in and other
EMS institutions. Unrecognized DOM or missing individual booking identities
fail closed before a write. Templates with service workflows are unsupported.

## Validation

`npm test` covers time handling, previews, permission/auth failures, uncertain
submissions, profile ownership, MCP schemas and real stdio initialization.
`npm run test:browser` uses installed Chrome and an isolated synthetic EMS
fixture; every request is intercepted and it never contacts EMS or Yale SSO.
It exercises discovery, searches, previews, creation, updating and cancellation.
Synthetic tests do not establish real account or platform acceptance.

Sessions, cookies and recovery files stay outside the bundle; protocol output
uses stdout and diagnostics use stderr. Laplace Local's existing privacy and
permission controls continue to apply. This is an independent Laplace
integration, not a Yale or Accruent product.
