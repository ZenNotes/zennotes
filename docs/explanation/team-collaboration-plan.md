# Team Collaboration Plan (Self-Hosted, File-Faithful)

> **Status:** Proposed — not yet implemented.
> **Last updated:** 2026-05-26
> **Scope:** Turn the self-hosted Go server (now in ZenNotes/znserver) from a single-secret,
> single-vault deployment into a multi-user, team-aware server that companies can
> run themselves, while keeping notes as ordinary `.md` files on their own disk.

This document is the design and sequencing plan for letting employees share notes
on a company-hosted ZenNotes server. It is the "self-hosted team server" direction:
**the company runs the server; the files stay on their disk.** It is deliberately
*not* a hosted multi-tenant SaaS, and *not* real-time co-editing (those are larger,
separate efforts noted under [Out of scope](#out-of-scope)).

---

## 1. Guiding principles

1. **File-faithful.** Note *bodies* never move into a database. A team's notes are
   a directory of `.md` files, exactly as today. The only thing a database stores
   is *metadata about people and access* (users, teams, membership, audit).
2. **Extend, don't replace.** The server already has a credible auth and security
   baseline (sessions, brute-force limiters, CORS, trusted-proxy handling, TLS
   posture). Each phase grows the existing primitives instead of rewriting them.
3. **Single-user mode keeps working.** Existing deployments that set one
   `ZENNOTES_AUTH_TOKEN` and one vault must continue to run unchanged. Team mode is
   additive and opt-in ("personal mode" vs "team mode").
4. **SSO is the adoption gate.** Companies will not deploy without OIDC/SSO. Local
   accounts remain as a fallback for small teams and for bootstrapping the first admin.
5. **Desktop is unaffected.** Identity and teams are a *web/server* concern. The
   Electron runtime has no users; the bridge contract must express identity as an
   *optional* capability so the desktop bridge can report "single user, no teams"
   without code churn in `packages/app-core`.

---

## 2. Where we are today (accurate baseline)

What already exists and should **not** be rebuilt:

| Capability | Where | Notes |
|---|---|---|
| Bearer token + cookie sessions | `httpserver/server.go:223` (`requireAuth`), `security.go:405` (`sessionLogin`) | Single shared secret; everyone who logs in is the same principal. |
| Session store | `security.go:24` (`sessionStore`) | **In-memory** (`map[string]time.Time`), survives no restart, carries **no user identity** — only an expiry. |
| Brute-force protection | `server.go:56` (`loginLimiter`, `wsRejectLimiter`), `security.go:101` | Exponential backoff + window cap, keyed on trust-aware client IP. |
| Token rotation | `security.go:452` (`sessionRotateToken`) | Requires current token, invalidates all sessions, persists to host config. Good model to mirror for user management. |
| CORS / origin / proxy trust | `security.go:253`, `:171`, `:384` | Trust-aware; `X-Forwarded-*` only honored from configured proxies. |
| TLS posture | `cmd/zennotes-server/main.go:26`, `:74` | Refuses non-loopback start without auth; warns on plain HTTP exposure. |
| Strict CSP | `security.go:311` | `script-src 'self'`; base/form/frame locked down. |
| **`If-Match` already allow-listed** | `security.go:287` | The header is permitted by CORS but **no handler consumes it yet** — the wire is half-ready for optimistic concurrency (Phase 3). |

The three gaps that block company use:

1. **One shared secret, not users.** `requireAuth` compares one `cfg.AuthToken`
   (`server.go:226`, `config.go:34`). There is no "who"; audit identity is therefore
   IP-based by necessity (`server.go:148-150`).
2. **One global vault, everyone sees everything.** Every handler calls
   `s.currentVault()` (`server.go:61`) — a single process-wide vault with no
   per-request user scoping (`switchVaultRoot`, `server.go:79`).
3. **Blind last-writer-wins.** `writeNote` (`server.go:559`) overwrites with no
   version check — silent data loss when two employees edit the same note.

---

## 3. Target architecture

### 3.1 Request flow (team mode)

```
request
  → securityHeaders / CORS / recover         (unchanged middleware, server.go:145)
  → identify()      resolve session → User    (Phase 1; replaces the "authenticated: yes" boolean)
  → authorize()     User + path → Team + Role  (Phase 2; rejects or scopes)
  → handler         operates on the team's Vault, not a global one
  → audit()         append {user, action, path, ts} to the audit log   (Phase 4)
```

The pivotal change is in step 3: handlers stop reading the process-global
`s.currentVault()` and instead receive a **request-scoped vault** chosen from the
caller's team membership. Concretely, introduce a resolver:

```go
// vaultForRequest returns the vault the authenticated user is allowed to act on
// for this request, plus their role, or an error that maps to 403/404.
func (s *Server) vaultForRequest(r *http.Request) (*vault.Vault, Role, error)
```

and thread it through `registerProtectedRoutes` handlers (`server.go:164`). In
personal mode this resolver returns the single global vault and role `owner`, so
the handler bodies are identical across modes.

### 3.2 Storage model: one vault directory per team

A team owns a directory; that directory is a standard ZenNotes vault.

```
/srv/zennotes/
  teams/
    engineering/        ← a vault.Vault root  (FolderInbox, archive, trash, assets…)
    design/             ← a vault.Vault root
  personal/
    alice/              ← optional per-user private vaults
    bob/
```

The server keeps a **registry** of `teamID → vault.Vault`, each constructed with the
existing `vault.New(root, Options{...})` (`server.go:81`). This reuses the entire
vault layer (parsing, safepath, watcher, search, tasks) untouched — a team vault is
just another root.

**Why per-team directory over a single tree with per-folder ACLs:**

- Maps 1:1 to the file-faithful model — a team's notes are literally a folder you
  can `rsync`, back up, or hand over.
- Reuses `switchVaultRoot` / `vault.New` and the per-root `watcher` with no changes
  to the vault package.
- Permission checks become "is this user in this team?" rather than a per-path ACL
  evaluator embedded in Markdown.

**The tradeoff:** sharing a *single note* across two teams is not free (it lives in
one team's tree). That is acceptable for v1; a later "shared folder" feature can add
symlinks or a lightweight share table without changing this foundation. (Note the
vault already lists symlinked notes — see commit `ebc28b5` — so a shared-folder
symlink approach is plausible later.)

### 3.3 Metadata store: SQLite, pure-Go, single file

Use **`modernc.org/sqlite`** (pure Go, **no cgo**). This matters: the desktop and
server are cross-compiled (`package.json` → `dist:mac` / `dist:win` / `dist:linux`),
and a cgo SQLite driver would break that single-binary, cross-platform story.

The DB lives alongside the existing host config (`~/.zennotes/server.db`, sibling of
`config.configFilePath()` at `config.go:49`). It stores **only** identity and access
metadata — never note bodies. Default file mode `0600`, matching `defaultVaultFileMode`.

---

## 4. Key decisions (with chosen defaults)

| Decision | Options | **Chosen default** | Rationale |
|---|---|---|---|
| Authentication | SSO-only / local-only / both | **OIDC/SSO + local fallback** | SSO clears procurement; local accounts bootstrap the first admin and serve tiny teams. |
| Storage model | per-team directory / single tree + folder ACLs | **per-team directory** | File-faithful, reuses vault layer, simplest correct permission check. (§3.2) |
| Metadata DB | SQLite / Postgres / files | **SQLite (modernc, no cgo)** | Single self-hosted binary; no external service to operate. |
| Session storage | in-memory / persisted | **persist in SQLite** | Restarts shouldn't log everyone out of a shared company server; also needed to attach identity. |
| Permission granularity (v1) | note / folder / vault(team) | **team-level role** | One role per user per team (viewer/editor/admin). Folder-level ACLs deferred. |

These are defaults, not locks — the open questions in §10 may revisit them.

---

## 5. Data model (SQLite schema sketch)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  is_server_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,                      -- NULL for SSO-only users (argon2id)
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);

CREATE TABLE identities (                  -- external SSO linkage (one user → many IdPs)
  user_id    TEXT NOT NULL REFERENCES users(id),
  provider   TEXT NOT NULL,                -- e.g. "google", "okta"
  subject    TEXT NOT NULL,                -- IdP 'sub' claim
  PRIMARY KEY (provider, subject)
);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,        -- maps to directory name under teams/
  name        TEXT NOT NULL,
  vault_root  TEXT NOT NULL,               -- absolute path; validated like browse roots
  created_at  INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id  TEXT NOT NULL REFERENCES teams(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  role     TEXT NOT NULL,                  -- 'viewer' | 'editor' | 'admin'
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,            -- random 32-byte hex, as today
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    TEXT,                         -- nullable: failed-login has no user yet
  team_id    TEXT,
  action     TEXT NOT NULL,                -- 'note.write', 'note.delete', 'login', …
  path       TEXT,
  client_ip  TEXT
);
```

`Role` ordering: `viewer < editor < admin`. Write endpoints require ≥ `editor`;
team/member management requires `admin`; server-level config requires
`users.is_server_admin`.

---

## 6. Phased roadmap

Each phase is independently shippable and leaves the server in a working state.

### Phase 1 — Real identity

**Goal:** a session resolves to a *user*, not just "authenticated."

- Add the SQLite store (`internal/store`): users, identities, sessions, with
  argon2id password hashing for local accounts.
- Change `sessionStore` (`security.go:24`) to persist and to carry `user_id`.
  `create()` takes a `userID`; `isValid()` → `lookup() (User, bool)`.
- Add `currentUser(r)` helper; have `requireAuth` (`server.go:223`) populate a
  request context value with the `User`.
- Add **OIDC login**: `/api/session/oidc/start` and `/api/session/oidc/callback`
  using `golang.org/x/oauth2` + `github.com/coreos/go-oidc`. On success, upsert
  `users` + `identities`, mint a session (same cookie path/flags as `sessionCookie`,
  `security.go:351`).
- Keep local login (`sessionLogin`) but compare against `users.password_hash`
  instead of the shared token. Preserve `loginLimiter` integration verbatim.
- Add a first-run bootstrap: if no users exist, the env `ZENNOTES_AUTH_TOKEN` acts as
  a one-time admin-creation secret (backward-compatible bridge from personal mode).

**Acceptance:** two distinct local users can log in and `/api/session` reports the
correct identity for each; sessions survive a restart; OIDC round-trip creates a user.

**Touchpoints:** `security.go` (sessions, login), `server.go` (`requireAuth`,
`capabilities`, `sessionStatus`), new `internal/store`, new `internal/oidc`,
`config.go` (OIDC issuer/client env vars).

### Phase 2 — Team-scoped vaults (the core change)

**Goal:** users only see and act on the vaults of teams they belong to.

- Add `teams` + `team_members` to the store; add a team→vault registry on `Server`
  (replacing the single `s.Vault`, but keeping a single-vault fast path for personal
  mode).
- Implement `vaultForRequest` (§3.1). Resolve the target team from a request param
  (`?team=engineering`) or a default-team rule; check membership + role.
- Thread the resolved vault through every handler in `registerProtectedRoutes`
  (`server.go:164`). Replace bare `s.currentVault()` calls. Write endpoints assert
  role ≥ editor.
- Add admin endpoints: create team, add/remove member, set role — all requiring
  `admin`/server-admin, mirroring the careful pattern of `sessionRotateToken`.
- `listNotes`, `search`, `tasks`, `watch` (the WS at `server.go:903`) must all scope
  to the request's team vault. The watcher registry becomes one watcher per active
  team root.

**Acceptance:** a viewer in Team A cannot read Team B's notes; an editor can write in
their team; the file tree shows one directory per team.

**Touchpoints:** `server.go` (all protected handlers, watcher wiring), new
`internal/store` team methods, `vault` package unchanged.

### Phase 3 — Safe concurrent writes

**Goal:** no silent overwrite when two people edit the same note. The CORS layer
already permits `If-Match` (`security.go:287`) — wire it up.

- `readNote` returns a version tag (ETag from content hash or mtime+size) in the
  `NoteMeta`/response header.
- `writeNote` (`server.go:559`) requires `If-Match`; if the on-disk version differs,
  return **409 Conflict** with the current server version, no write performed.
- Client (`apps/web/src/bridge/http-bridge.ts` → `app-core`) surfaces a "this note
  changed underneath you" prompt with reload/overwrite choices.
- This is *conflict detection*, not CRDT. Real-time co-editing remains out of scope.

**Acceptance:** concurrent edits from two sessions produce a 409 for the stale writer
rather than a lost update.

**Touchpoints:** `vault` read/write (version computation), `server.go:559`/`:522`,
`bridge-contract` (add version field), `app-core` conflict UI.

### Phase 4 — Trust layer for companies

**Goal:** the things procurement and IT require.

- **User-attributed audit log** (`audit_log` table) — now possible because Phase 1
  gives a real "who." Log write/delete/move/login/permission-change with user + IP
  (reuse `clientAddressKey`, `security.go:384`).
- **Admin/owner roles** and a minimal admin surface (users, teams, audit view).
- **Encryption-at-rest guidance**: since we stay file-faithful, document
  LUKS/FileVault/BitLocker on the vault disk rather than app-layer encryption.
  Extend the existing `docs/how-to/at-rest-encryption.md`.
- **Session hardening:** absolute + idle expiry, "log out everywhere," and rotation
  on privilege change.

**Acceptance:** every mutating action is attributable to a user in the audit log; an
admin can list users/teams and revoke access.

**Touchpoints:** `internal/store` (audit), `server.go` (audit hook in handlers),
`docs/how-to/*`, admin endpoints + minimal UI in `app-core`.

---

## 7. API & contract changes

Server JSON types are mirrored in TypeScript — `vault/types.go:8` calls this out.
The chain is:

```
Go (apps/server) → apps/web/src/bridge/http-bridge.ts → packages/bridge-contract
  → packages/app-core (store.ts, UI)
```

New/changed surfaces:

- `GET /api/session` → add `user: { id, email, displayName }` and `teams: [...]`.
- `GET /api/capabilities` (`server.go:289`) → add `supportsTeams`, `supportsSSO`,
  `ssoProviders`. The desktop bridge reports these **false/empty** so `app-core`
  branches cleanly with no desktop-side identity code.
- `bridge-contract` (`packages/bridge-contract/src/ipc.ts`) → identity and team types
  added as **optional** fields so the Electron IPC bridge (no users) stays valid.
- New endpoints: `/api/session/oidc/*`, `/api/teams`, `/api/teams/{id}/members`,
  `/api/admin/users`, `/api/audit`.

**Rule:** keep `bridge-contract` the single source of truth. Desktop implements the
identity surface as a constant single-user stub; web implements it for real.

---

## 8. Backward compatibility & migration

- **Personal mode is the default.** No teams configured + a single vault path →
  behaves exactly as today. `ZENNOTES_AUTH_TOKEN` still works (now as the bootstrap
  admin secret, §Phase 1).
- **No data migration of notes.** Existing vaults become a team's directory by
  registering their path as a team `vault_root`; files are untouched.
- The `capabilities` endpoint is the switch the client reads to show/hide team UI, so
  old clients against a new server (and vice versa) degrade gracefully.

---

## 9. Testing strategy

Follow the existing Go table-test style (`httpserver/security_test.go`,
`limiter_test.go`, `vault/*_test.go`):

- **Auth/identity:** login (local + OIDC stub), session persistence across restart,
  limiter behavior unchanged.
- **Authorization matrix:** {viewer, editor, admin, non-member} × {read, write,
  delete, admin} per team — the core safety net for Phase 2.
- **Path safety still holds per team:** reuse `safepath_test.go` against each team
  root; no `..` escape across team boundaries.
- **Concurrency:** stale `If-Match` → 409, fresh → 200; covers the lost-update case.
- **Contract:** a type-level test that web/desktop bridges both satisfy
  `bridge-contract` with identity optional.

---

## 10. Open questions

1. **Default team / personal vaults:** does every user get a private vault by default,
   or only team vaults? (Leaning: optional per-user vault under `personal/<user>`.)
2. **Team directory provisioning:** does an admin pick an existing path (validated
   like `browseRoots`) or does the server create it? (Leaning: admin supplies a path;
   server validates and initializes vault folders.)
3. **OIDC group → team mapping:** auto-provision team membership from IdP groups, or
   admin-managed only for v1? (Leaning: admin-managed v1, group-sync later.)
4. **Watcher scaling:** one fsnotify watcher per team root is fine for tens of teams;
   revisit if a deployment has hundreds.
5. **Shared-note across teams:** symlink-based shared folders vs a share table —
   defer until there's real demand.

---

## 11. Out of scope (separate efforts)

- **Hosted multi-tenant SaaS** (billing, you operate it, data liability).
- **Real-time collaborative editing** (CRDT/Yjs, presence, live cursors). Phase 3
  gives conflict *detection*, which is the company-ready bar; live co-editing is a
  later, heavier project that still sits on top of Phases 1–2.

---

## 12. Suggested sequencing

Phase 1 → 2 are the critical path (identity must precede authorization). Phase 3 is
small and independent — it can land anytime after the `If-Match` round-trip is wired.
Phase 4's audit log depends on Phase 1's identity. Recommended order: **1 → 2 → 3 → 4**,
shipping each behind the `capabilities` flags so the desktop and existing self-hosters
are never disrupted.
