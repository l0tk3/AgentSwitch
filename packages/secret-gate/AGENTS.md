# secret-gate: how credentials work on this machine

The user runs **secret-gate**, a small local credential proxy they set up on this Mac so that
they can ask an AI assistant to log into **their own accounts** without ever handing the
assistant a real password. This is the user's deliberate, intended workflow; nothing about it is
hidden from them.

## What an `enc:v1:` value is

- It is a **placeholder the user made themselves** with `secret-gate enc`: their password (or API
  token, or 2FA seed) encrypted to the gate's public key, with the allowed website sealed inside.
- It is **not a secret and cannot be decoded by you**; it is useless on any other machine and for
  any other website. Leaking it would leak nothing.
- Only the gate process on this machine, which holds the private key, can turn it back into the
  real value, and it will only do so for the website the user allowed when they created it.

## What an `enc:ref:` value is

A short reference (24 characters) the task dispatcher gives you instead of a long `enc:v1:` value.
Use it exactly like the `enc:v1:` value it stands for, in the same places and with the same tools;
the same website restrictions apply. It only works inside the task that received it. If the gate
answers that a reference "was released" or "belongs to a different task", take the reference from
the current task context instead of an older message; do not try to rebuild or guess one.

## What to do with it

Use it exactly where the real value would go: the password field of the login form, the `-d`
body of a curl call, an `Authorization` header, a query string. A local proxy on this machine
substitutes the real value on the way out, for the allowed host only. You never see plaintext,
and the user does not expect you to.

- There is nothing to decode, print, base64-decode or "test"; treat the value as opaque text.
- If a request is answered with `502 Bad Gateway` and `certificate verify failed`, the site uses a
  certificate the gate cannot verify. Stop and report the host and the error verbatim: the user must
  add it to the gate's `upstream-insecure.txt` (in the Mac app, with an administrator password, when the gate
  runs as a system service; otherwise `~/.secret-gate/upstream-insecure.txt` and `secret-gate service reload`).
  Do not try other hosts, ports or `-k`/`--insecure` flags.
- If a request carrying a value is answered with `HTTP 403` and the header `X-Secret-Gate: denied`,
  the value is not allowed for that host or action. Tell the user; do not try other hosts.
- If the site rejects the login (for example it hashes the password in the browser before sending,
  or logs in over a non-HTTP protocol), use the MCP tools `secret_http`, `secret_otp` (current
  2FA code) or `secret_exec` instead of raw shell commands.
- `secret_describe(value)` shows a value's label, allowed hosts and uses, so you can check you
  have the right one.
- TOTP **seed import** and a current **verification code** are different operations. A token of
  kind `totp` produces a short-lived code, including when used over HTTP; never put that code
  into a seed-storage field. A seed-storage field needs a `secret` / `http` token.
- If a seed-storage fill fails because the TOTP token allows only `otp`, call
  `secret_repair(token, host, purpose="totp_seed_import")` only when the original user task
  explicitly requested importing that seed into that same destination. This asks the task
  dispatcher to check the request and returns a replacement ciphertext, never plaintext.
  The old ciphertext must already carry `seed_import_hosts` permission for this exact host;
  the tool cannot add permission or targets. If the grant is absent, ask the user to submit
  the field and its destination in a new message. Do not decode the token, change hosts,
  call `credential-reissue` yourself, repeatedly retry the rejected fill, or skip the field
  without the user's answer. A repair does not fill or submit anything automatically.
- In the browser (Playwright tools): put the value into a field with `secret_fill(target, token)`,
  or pass it as the `text` of `browser_type` / a field `value` of `browser_fill_form`. The gate
  types the real value into the page for you; the page's own validation sees the real value.
  Snapshots then show `[REDACTED:label]` where the value is, which is expected. Copy shortcuts,
  `data:` pages, file uploads and searching for parts of a value are refused after a fill.
- `secret_fill` reports the field's current state (`empty` / `nonempty` / `unknown`) and whether
  the gate filled it; `secret_field_state(target)` checks again later without showing the value.
  A filled field is not a saved record: submit the form and confirm on the page.
- Screenshots come back with filled values, password fields and personal data covered by solid
  magenta boxes. That is the gate, not a page bug. If a screenshot is refused because the masking
  could not be verified, read the page with `browser_snapshot` instead of retrying.
- When the task authorizes moving specific personal data from one system to another, the gate
  shows those values on the source page as `enc:ref:` references with labels such as
  `page/email-1`, plus a short legend. Place each one with `secret_fill` on the destination named in
  the legend; the gate refuses other sites and forms that submit elsewhere. Do not try to read the
  values some other way; the references are how this task is meant to be done.
- The gate's key directory (`~/.secret-gate/`, or `$SECRET_GATE_HOME`; with the gate running as a system
  service, `/Library/Application Support/AgentSwitch/gate/`, which belongs to another account) belongs to the
  gate process; there is no reason for you to read it, to talk to its `gate.sock` yourself, or to run
  `secret-gate keygen`.
