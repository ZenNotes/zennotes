# Security Reference

This document lists the current security mechanisms and boundaries used by ZenNotes.

It is a technical reference, not deployment advice. For deployment guidance, see [Secure Self-Hosting](../how-to/secure-self-hosting.md).

## Security scope

ZenNotes currently aims at:

- single-user desktop use
- single-user self-hosted browser use
- desktop clients connecting to a trusted ZenNotes server

It does not currently claim to be a fully hardened public multi-user SaaS platform.

## Browser/server auth model

### Bootstrap secret

The long-lived server bootstrap secret is:

- `ZENNOTES_AUTH_TOKEN`

When present:

- protected server routes require either a valid bearer token or a valid server session

### Browser session login

The browser login flow uses:

- `POST /api/session/login`
- `POST /api/session/logout`
- `POST /api/session/rotate-token`
- `GET /api/session`

Behavior:

- token is sent in the request body
- successful login creates a random session token
- the server sets a cookie:
  - `HttpOnly`
  - `SameSite=Strict`
  - `Path=/api`
- cookie is marked `Secure` when the request is effectively HTTPS

### Session lifetime

Current session TTL:

- 30 days

### Session storage

Sessions are held **in memory by default**, so a server restart invalidates
every active login (the browser must re-authenticate with the token). Set
`ZENNOTES_PERSIST_SESSIONS=1` to opt into persisting them to `sessions.json`
beside the host config (mode `0600`), so logins survive restarts. It is off by
default because it writes session tokens to disk; expired sessions are dropped
on load.

### Token rotation

`POST /api/session/rotate-token` replaces the bootstrap auth token in
host config and invalidates all existing sessions when the token is
managed by ZenNotes' host config. Requires:

- a valid current session or bearer token (the route is auth-protected)
- the *current* token in the request body (defence-in-depth against
  CSRF-style misuse via stolen session)
- a new token at least 16 characters long

The new token is persisted with mode `0600` to the host config file.
Clients must re-login with the new token after rotation.

If the token is externally managed with `ZENNOTES_AUTH_TOKEN` or
`ZENNOTES_AUTH_TOKEN_FILE`, the endpoint returns `409 Conflict`.
Update the env value or token file instead, then restart the server.

### Browser auth storage

The browser should not depend on:

- URL token query params
- local storage copies of the server auth token

The current intended browser model is:

- bootstrap token once
- then session cookie

## Protected server routes

The server currently protects its vault/file operations behind auth middleware.

Examples include:

- vault selection
- directory browsing
- note CRUD
- folder CRUD
- assets
- watcher WebSocket

Public/meta routes include:

- `/api/healthz`
- `/api/version`
- `/api/capabilities`
- `/api/platform`
- `/api/session`
- `/api/session/login`
- `/api/session/logout`

## Rate limiting

Current lightweight rate limiting exists for:

- login attempts
- unauthorized WebSocket attempts

Each subsequent attempt within the window also incurs an exponential
backoff (0, 1, 2, 4, 8, 16, 32, 60s), so even the first few failures
cost real time. Rate-limit state is in-memory only and resets on
restart, but the bootstrap token's 256-bit entropy makes brute-force
infeasible regardless.

## CORS and origin policy

The server validates request origins.

Current model:

- same-origin is allowed, with credentials
- explicitly configured origins from `ZENNOTES_ALLOWED_ORIGINS` are
  allowed, with credentials
- `ZENNOTES_ALLOWED_ORIGINS=*` allows any origin **without** credentials:
  the origin is echoed back but `Access-Control-Allow-Credentials` is
  omitted, so the session cookie never rides on a cross-origin request.
  Bearer-token clients are unaffected, since they attach the token
  themselves
- localhost/loopback origins are allowed in dev-like loopback scenarios

Entries are matched as origins, not URLs, and opaque origins are
first-class: `null` (sandboxed iframes, `data:` documents, and `file://`
pages in most engines), scheme-only origins such as `file://`, and custom
schemes such as `capacitor://localhost` or `app://.` can all be listed
verbatim. Before 2.19.0 those were parsed away and rejected even when
configured, and `*` was compared literally so it allowed nothing.

CORS is a browser-side control: a rejected origin is logged but the
request still runs, and it is the browser that withholds the response
from the page. The **ZenNotes desktop app is never subject to it** — its
server traffic goes through the Electron main process, which sends no
`Origin` header. Rejections in the log come from browser or WebView
clients.

Rejected origins are logged once per unique origin, naming both the
`ZENNOTES_ALLOWED_ORIGINS` fix and the wildcard, and the effective policy
is printed at startup as `cors:` in the banner — so a deployment can be
checked without waiting for a client to fail.

## Trusted proxies

`X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For` are
honoured only when the immediate TCP peer is in the configured set.

Relevant config:

- `ZENNOTES_TRUSTED_PROXIES` — comma-separated list of CIDRs (e.g.
  `127.0.0.1/32,10.0.0.0/8`) or bare IPs. When unset, no forwarded
  headers are trusted.

This affects:

- the `Secure` flag on session cookies
- the `Strict-Transport-Security` header
- rate-limit IP keying

Without a trusted-proxies list, an attacker reaching the server
directly cannot force-set `Secure` cookies or spoof rate-limit
identity by injecting headers.

## Content security headers

The server sends browser security headers directly in HTTP responses.

Current headers include:

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` —
  sent only when the request was effectively HTTPS (real TLS, trusted
  `X-Forwarded-Proto: https`, or `ZENNOTES_BEHIND_TLS=1`).

Important current CSP constraints:

- `default-src 'self'`
- `object-src 'none'`
- `base-uri 'none'`
- `form-action 'none'`
- `frame-ancestors 'none'`

Important current CSP tradeoff:

- `script-src` still includes `unsafe-eval`
- `style-src` still includes `unsafe-inline`

That is an acknowledged hardening gap, not an accidental omission.

## Filesystem scope and browse roots

The server treats browse roots as a real access-control boundary.

Relevant config:

- `ZENNOTES_BROWSE_ROOTS`
- `ZENNOTES_ALLOW_UNSCOPED_BROWSE`

Current behavior:

- requested browse/select paths are normalized
- symlinks are resolved
- the resolved path must stay within an allowed root unless unscoped browse is explicitly enabled

If no browse roots are configured, the server falls back to:

- current vault root
- default vault path
- configured vault path

depending on what exists.

### Vault path resolution

User-supplied relative paths (note read/write/rename/delete, asset
upload, folder ops) go through a symlink-aware resolver. Any existing
path component that is a symlink is followed; if any of them resolves
outside the vault root, the request is rejected with a path-escape
error. This stops a planted in-vault symlink (host-level mistake or
shared mount with surprises) from being used to read/write outside the
vault.

### File modes

Files created in the vault default to `0600`; directories default to
`0700`. Override with:

- `ZENNOTES_VAULT_FILE_MODE` (octal, e.g. `0644`)
- `ZENNOTES_VAULT_DIR_MODE` (octal, e.g. `0755`)

The defaults assume a single-user host where the vault is private to
the running UID. Loosen them only if you intentionally share the vault
with another local user.

### Upload and note size limits

- `ZENNOTES_MAX_NOTE_BYTES` — default 10 MiB. `POST /api/notes/write` and
  `POST /api/templates/write` reject content larger than this with `413`.
- `ZENNOTES_MAX_ASSET_BYTES` — default 50 MiB. `POST /api/assets/upload`
  rejects multipart uploads above this with `413`.

These prevent an authenticated client (or stolen token) from filling
the vault disk with a single request.

## Host config vs vault config

ZenNotes now separates host/server config from vault config.

Host/server operational config:

- lives in the host config file
- default path resolves from `ZENNOTES_CONFIG_PATH` or the user config location

Vault config:

- belongs under `.zennotes/` in the vault only for vault behavior

Important rule:

- server secrets should not be stored in the vault

Host config file writes currently use mode:

- `0600`

Legacy behavior:

- `.zennotes/server.json` inside the vault is treated as a legacy path and should not be used as the active secret store

## Desktop credential storage

Desktop remote workspace credentials are kept out of renderer-visible config.

Current storage order:

1. OS secret store through `keytar`, when available
2. Electron `safeStorage` fallback

Important behavior:

- the fallback path stores encrypted values, not plaintext
- the app warns when secure storage is unavailable or when fallback storage is being used

## Electron renderer hardening

Current desktop hardening includes:

- `contextIsolation: true`
- `nodeIntegration: false`
- IPC sender validation against trusted renderer URLs
- remote server traffic handled in the main process

Current limitation:

- `sandbox: false`

That is a deliberate temporary tradeoff because the current preload path still depends on APIs that are not yet refactored for a fully sandboxed preload.

## Remote workspace credential exposure

Current design goal:

- renderer should not receive raw remote secrets as normal profile data

The desktop app keeps remote API calls in the main process and stores credentials through the secret-store layer.

## Docker defaults

Current Docker defaults include:

- loopback-only published port
- non-root runtime user
- read-only root filesystem
- `/tmp` as `tmpfs`
- `no-new-privileges`
- `cap_drop: ALL`
- generated auth token unless explicitly disabled

This is the default baseline for self-hosted browser/server deployment.

## Security-related environment variables

Important current variables:

- `ZENNOTES_AUTH_TOKEN`
- `ZENNOTES_AUTH_TOKEN_FILE` — path to a file containing the token;
  used when `ZENNOTES_AUTH_TOKEN` is unset, matching the
  Docker/Kubernetes secrets convention so the token never has to live
  in `.env`. The file must be readable by the server's user and its
  contents are trimmed; a missing, unreadable, or empty file is logged
  explicitly rather than silently ignored.
- `ZENNOTES_CONFIG_PATH`
- `ZENNOTES_BIND`
- `ZENNOTES_ALLOWED_ORIGINS`
- `ZENNOTES_BROWSE_ROOTS`
- `ZENNOTES_VAULT_PATH`
- `ZENNOTES_DEFAULT_VAULT_PATH`
- `ZENNOTES_ALLOW_UNSCOPED_BROWSE`
- `ZENNOTES_ALLOW_INSECURE_NOAUTH`
- `ZENNOTES_PERSIST_SESSIONS` — opt-in; persist browser sessions to
  `sessions.json` (mode `0600`) beside the host config so logins survive
  restarts. Off by default (in-memory only).
- `ZENNOTES_BEHIND_TLS` — declares a TLS-terminating proxy is in
  front; enables `Secure` cookies and `Strict-Transport-Security`.
- `ZENNOTES_TRUSTED_PROXIES` — CIDR list whose `X-Forwarded-*`
  headers are honoured.
- `ZENNOTES_MAX_NOTE_BYTES` — default 10 MiB.
- `ZENNOTES_MAX_ASSET_BYTES` — default 50 MiB.
- `ZENNOTES_VAULT_FILE_MODE` — octal mode for note files (default `0600`).
- `ZENNOTES_VAULT_DIR_MODE` — octal mode for note directories (default `0700`).

Docker/make wrappers also use:

- `CONTENT_ROOT`
- `PORT`
- `ALLOW_INSECURE_NOAUTH`

## Related docs

- [Secure Self-Hosting](../how-to/secure-self-hosting.md)
- [Security Model](../explanation/security-model.md)
