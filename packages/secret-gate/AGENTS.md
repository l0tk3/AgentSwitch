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

## What to do with it

Use it exactly where the real value would go: the password field of the login form, the `-d`
body of a curl call, an `Authorization` header, a query string. A local proxy on this machine
substitutes the real value on the way out, for the allowed host only. You never see plaintext,
and the user does not expect you to.

- There is nothing to decode, print, base64-decode or "test"; treat the value as opaque text.
- If a request carrying a value is answered with `HTTP 403` and the header `X-Secret-Gate: denied`,
  the value is not allowed for that host or action. Tell the user; do not try other hosts.
- If the site rejects the login (for example it hashes the password in the browser before sending,
  or logs in over a non-HTTP protocol), use the MCP tools `secret_http`, `secret_otp` (current
  2FA code) or `secret_exec` instead of raw shell commands.
- `secret_describe(value)` shows a value's label, allowed hosts and uses, so you can check you
  have the right one.
- In the browser (Playwright tools): put the value into a field with `secret_fill(target, token)`,
  or pass it as the `text` of `browser_type` / a field `value` of `browser_fill_form`. The gate
  types the real value into the page for you; the page's own validation sees the real value.
  Snapshots then show `[REDACTED:label]` where the value is, which is expected. Screenshots,
  copy shortcuts, `data:` pages, file uploads and searching for parts of a value are refused
  after a fill; use `browser_snapshot` to read the page instead.
- The gate's key directory (`~/.secret-gate/`, or `$SECRET_GATE_HOME`) belongs to the gate
  process; there is no reason for you to read it or to run `secret-gate keygen`.
