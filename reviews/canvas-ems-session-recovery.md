# Canvas and Yale SOM EMS session recovery

The release trial compares independent, user-authorized sign-ins in dedicated
profiles. Keep the control profile untouched between sign-in and its final
read. In the comparison profile, enable checks and repeat the same final read.
Use Canvas `/api/v1/users/self` and EMS `Default.aspx` with the account check.
Use a fresh pair of sessions for each repeat. Start with 60 minutes between
checks, then try 30 and 15 minutes if the previous interval is ineffective.
Record the last successful read, whether the application session expired,
whether the existing SSO session could sign in again, and whether the user had
to finish sign-in. Record the OS, architecture, browser, npm integrity and
whether the profile was restarted or the machine slept.

Run the trial for Canvas on macOS Apple Silicon, macOS Intel and Windows x64,
and for EMS on macOS Apple Silicon and Windows x64. Use the same read-only
verification directly and through the packaged Laplace runtime. Record timing
and result codes without account data, cookies or provider request bodies.

Set these runtime environment values only for the approved trial. Managed
installations also require the local `background_session_checks` setting to be
`on`. Standalone runs use `LAPLACE_BACKGROUND_SESSION_CHECKS=on`.

- Canvas requires `CANVAS_MCP_VERIFIED_CHECK_ORIGIN` equal to the exact
  institution origin and `CANVAS_MCP_VERIFIED_CHECK_MINUTES` set to 60, 30 or 15.
- Yale SOM EMS requires `EMS_VERIFIED_CHECK_MINUTES` set to 60, 30 or 15.

Use the longest permitted interval that improves the result. Leave the runtime
values unset when live measurements are missing or show no improvement. Keep
the catalog on its accepted versions until the new packages pass live checks.

A read-only probe of the pre-existing Yale Canvas session on November 11,
2026 returned HTTP 401. This establishes that the saved session was already
expired. A fresh sign-in is needed to measure its lifetime or silent recovery.
