# ZenNotes Web Architecture

Target: turn ZenNotes into a progressive web app (PWA) that can also be
self-hosted on a home server and driven entirely from a browser, without
losing what makes ZenNotes ZenNotes — keyboard-first editing, vim
motions, plain Markdown files on disk, and first-party MCP access.

This is a design doc, not an implementation plan. It describes the
architecture, the deployment modes we want to support, and the phased
porting path from the current Electron build.

---

## 1. Goals and non-goals

### Goals

- A browser-accessible ZenNotes that keeps full parity with the desktop
  build for editing, navigation, search, tasks, and rendering.
- Installable as a PWA (add-to-home-screen, standalone window, offline).
- Self-hostable on a home server via Docker, one volume, one port, no
  database setup required.
- Vault is still plain Markdown files on a filesystem. No migration, no
  lock-in, no proprietary store.
- MCP server keeps working against the same vault, so Claude Desktop /
  Claude Code / Codex etc. still read and write user notes safely.
- Same keyboard model in the browser as on desktop: vim mode, leader
  flows, command palette, which-key hints, buffer switching.

### Non-goals (for v1)

- Real-time multi-user collaboration (CRDTs, presence cursors).
- A hosted SaaS offering run by the ZenNotes project. (We design so it
  is possible later; we don't ship it now.)
- Mobile-first UI. Mobile support is nice to have, but the primary web
  target is a desktop browser on a laptop or workstation.
- Replacing the Electron build. The desktop app stays, and users can
  run both against the same vault.

### Constraints that shape the design

- The renderer (`src/renderer/`) is a full React SPA with Zustand,
  CodeMirror 6, and the unified markdown pipeline. All of that is
  browser-compatible already. The porting work is almost entirely in
  the main/preload layer.
- The backend is a new **Go** service, not a reused Node/Electron
  module. `src/main/vault.ts` is the reference behavior — the Go
  service implements the same operations, validated against the same
  test fixtures. This trades "share one vault module" for the things Go
  buys us on a home server: single static binary, cold-start in
  milliseconds, tiny memory footprint, trivial multi-arch
  cross-compile, and a `FROM scratch` container image.
- MCP is part of the product, not an accessory. Any deployment story
  must keep the MCP server reachable against the same vault.

---

## 2. Deployment modes

ZenNotes Web supports four deployment modes. They share the same
client bundle and, for three of them, the same server binary.

### Mode A — Self-hosted home server (primary target)

A single Docker container (or single binary) runs on a home NAS, Mac
mini, Raspberry Pi, or VPS. The user mounts a vault directory into the
container and points a browser at `https://notes.home.lan` (or a
Tailscale/Cloudflare Tunnel hostname). This is the deployment the
"users who want to run this on their home server" request maps to.

- One container, one volume, one port.
- Single-user auth out of the box (bearer token in a cookie).
- Reverse proxy (Caddy) handles TLS so PWA features work.
- Optional sidecar MCP container shares the same vault volume.

### Mode B — Pure local PWA (no server)

For users who want zero backend and only their own browser, we ship a
"local vault" mode that uses the browser's
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API).
The user clicks "Open vault", picks a directory, and the PWA reads and
writes Markdown files directly through the browser.

- Chromium-only, desktop-only.
- No network traffic, no install, no account.
- Good entry-level mode and a useful fallback if the home server is
  down.
- MCP is not available in this mode (no Node process on the box).

### Mode C — Shared home server (multi-user, optional)

Same container as Mode A, but with per-user vault dirs and session
auth (passkeys or argon2-hashed passwords). Useful for families or
small teams running a single home server. Off by default.

### Mode D — Hosted SaaS

The same Go binary, run by us (or anyone) as a managed multi-tenant
service. Users sign up with email or passkey, pay via Stripe, and get
a vault at `https://app.zennotes.io` without running anything
themselves. This serves people who want the product but won't
self-host.

- Same server binary as Mode A, with `--mode=saas` plus a control
  plane (see §11). No second codebase.
- Per-tenant vault directories under a single storage root.
- Managed auth (email + passkey + OAuth), billing, email, backups.
- MCP access remains available for paid tenants via a per-tenant
  scoped HTTPS tunnel.
- Shipping Mode D is **in scope for this phase**, not deferred.
  Detailed architecture in §11.

---

## 3. High-level architecture

```
┌──────────────────────────┐         ┌──────────────────────────┐
│        Browser           │         │     Home server host     │
│                          │         │                          │
│  ┌────────────────────┐  │  HTTPS  │  ┌────────────────────┐  │
│  │   ZenNotes PWA     │◄─┼─────────┼─►│  zennotes-server   │  │
│  │  (React renderer)  │  │   WS    │  │  (Go, static bin)  │  │
│  │                    │  │         │  │                    │  │
│  │  CodeMirror 6      │  │         │  │  chi + net/http    │  │
│  │  Zustand store     │  │         │  │  fsnotify watcher  │  │
│  │  Service worker    │  │         │  │  SQLite FTS index  │  │
│  │  IndexedDB cache   │  │         │  │  embedded PWA      │  │
│  └────────────────────┘  │         │  └─────────┬──────────┘  │
│                          │         │            │             │
└──────────────────────────┘         │  ┌─────────▼──────────┐  │
                                     │  │  Filesystem vault  │  │
                                     │  │  /vault/           │  │
                                     │  │    inbox/          │  │
                                     │  │    quick/          │  │
                                     │  │    archive/        │  │
                                     │  │    trash/          │  │
                                     │  │    attachments/    │  │
                                     │  └─────────▲──────────┘  │
                                     │            │             │
                                     │  ┌─────────┴──────────┐  │
                                     │  │  zennotes-mcp      │  │
                                     │  │  (sidecar)         │  │
                                     │  └────────────────────┘  │
                                     └──────────────────────────┘
```

Three moving pieces:

1. **Client** — the existing renderer, unchanged in structure. All the
   Electron-specific code paths are hidden behind a single interface
   (`VaultBridge`, see §6). The client never talks to Node APIs
   directly; it talks to a bridge.
2. **Server** — a Go binary (`zennotes-server`) that exposes the same
   vault operations the Electron main process implements today, but
   over HTTP and WebSocket instead of IPC. Ships as a single static
   executable; Docker image is `FROM scratch`.
3. **MCP sidecar** — the existing standalone MCP server from
   `src/mcp/` (Node), reachable against the same vault. Shipped as a
   separate container so it can be disabled independently, and so we
   can keep using the upstream TS MCP SDK without re-porting it to Go.

---

## 4. What ports, what must be replaced

Maps cleanly against `src/main/` (replace) and `src/renderer/` (keep).

| Area                | Today (Electron, TS)                 | Web version                                                           |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Window lifecycle    | `BrowserWindow`, app menu            | Browser handles it                                                    |
| Preload IPC bridge  | `src/preload/index.ts`               | `VaultBridge` + fetch client                                          |
| Vault I/O           | `src/main/vault.ts` (Node `fs`)      | Go port in `server/internal/vault`, behind HTTP handlers              |
| File watcher        | chokidar (Node)                      | `fsnotify` (Go), piped over WS                                        |
| Asset protocol      | `zen-asset://` via `protocol.handle` | `GET /api/assets/*`                                                   |
| Native file picker  | `dialog.showOpenDialog`              | File System Access API (Mode B) or server-side config screen (Mode A) |
| Auto-updater        | `electron-updater` + GitHub releases | Service worker update + container image tag                           |
| Zoom / window state | `BrowserWindow.setZoomFactor`        | Browser zoom, CSS zoom if needed                                      |
| Global shortcuts    | `globalShortcut.register`            | Only in-tab; keep in-app bindings                                     |
| Deep links          | `zen://` custom protocol             | `https://.../open?path=...`                                           |
| Notifications       | Node `Notification`                  | Web Notifications API                                                 |
| Menus               | Native `Menu`                        | In-app command palette (already exists)                               |
| MCP server          | Bundled Node, spawned over stdio     | Separate container (still Node), same code                            |

Everything under `src/renderer/` is already browser-safe: CodeMirror 6,
unified/remark/rehype, KaTeX, Mermaid, JsxGraph, Tailwind, Zustand,
DOMPurify, Fuse.js. The port does not touch any of that.

---

## 5. Server

### 5.1 Stack

- **Language**: Go 1.22+. Chosen for static binaries, fast startup,
  low idle memory (critical on a Raspberry Pi or small VPS), trivial
  cross-compilation for amd64/arm64, and a `FROM scratch` Docker image.
- **Router**: `go-chi/chi` on top of `net/http`. Idiomatic, stable,
  composable middleware, no framework lock-in. We deliberately avoid
  non-stdlib-compatible frameworks (Fiber/fasthttp) so every standard
  middleware and observability tool works.
- **WebSocket**: `coder/websocket` (formerly `nhooyr.io/websocket`).
  Context-aware, modern API, cleaner than `gorilla/websocket`. WS is
  preferred over SSE because the client already needs bidirectional
  channels for future features (collaboration, command streaming).
- **Filesystem**: `os` / `io/fs` / `path/filepath` (stdlib) for vault
  I/O, `fsnotify/fsnotify` for watching.
- **Search index**: SQLite with FTS5 via `modernc.org/sqlite`
  (pure-Go, no CGO). Rebuilt on startup, maintained incrementally by
  the watcher. Stored at `/vault/.zennotes/index.db`. For small vaults
  we skip it and fall back to an in-memory index.
- **Markdown parsing (server-side)**: `yuin/goldmark` with GFM, YAML
  frontmatter, and wikilink extensions. Used only for extracting tags,
  tasks, and backlinks into the FTS index — rendering still happens in
  the browser via the existing unified pipeline, so the Go parser is a
  one-way metadata extractor, not a renderer.
- **Config**: single file at `/vault/.zennotes/server.json` plus env
  vars (`ZENNOTES_VAULT_PATH`, `ZENNOTES_BIND`, `ZENNOTES_AUTH_TOKEN`).
- **Static assets**: PWA bundle embedded via `go:embed` at build time,
  so the server binary is literally the whole app — no external
  `public/` directory, no separate CDN step.
- **No CGO**: `modernc.org/sqlite` is pure Go, `fsnotify` uses syscalls,
  `coder/websocket` is pure Go. The binary is statically linked
  (`CGO_ENABLED=0`), which is what makes the `FROM scratch` image work.

### 5.2 Vault logic: Go as the new source of truth

The current `src/main/vault.ts` is the *behavioral* reference. The Go
server implements the same operations — safe path resolution, soft
delete to `trash/`, move semantics across folders, duplicate, rename,
archive/unarchive, asset indexing, tag/task/backlink extraction — in
idiomatic Go under `server/internal/vault/`.

We accept a controlled duplication:

- **Shared contract**: the HTTP surface (§5.3) is the single source of
  truth for what a "vault operation" means. An OpenAPI spec
  (`api/openapi.yaml`) is the machine-readable contract.
- **Shared test fixtures**: the existing `src/main/vault.test.ts`
  scenarios are mirrored as Go tests using the same input vaults and
  expected outputs. This is the anti-drift mechanism.
- **Code-gen clients**: the client's `HttpBridge` (TypeScript) is
  generated from the OpenAPI spec so request/response types cannot
  drift from the Go handlers.

Proposed server layout:

```
server/                   ← Go module, separate from TS source
  cmd/
    zennotes-server/
      main.go             ← entrypoint, flag parsing, embed directive
  internal/
    vault/                ← filesystem ops (CRUD, move, trash…)
      ops.go
      ops_test.go         ← mirrors vault.test.ts fixtures
      safepath.go         ← path-traversal guard
    watcher/              ← fsnotify → event channel
      watcher.go
    index/                ← SQLite FTS5 + in-memory fallback
      sqlite.go
      memory.go
      parse.go            ← goldmark extraction (tags/tasks/backlinks)
    http/
      router.go           ← chi routes
      notes.go
      search.go
      assets.go
      watch.go            ← WS handler
      auth.go
      middleware.go
    config/
      config.go
  web/                    ← built PWA, embedded
    embed.go              ← //go:embed dist
    dist/                 ← output of `npm run build:web`
  api/
    openapi.yaml          ← single source of truth for API shape
  Dockerfile
  go.mod
```

**Long-term direction** (not v1): once the Go server is proven, the
Electron app moves to bundling the Go binary as a child process and
the renderer talks to `http://127.0.0.1:<port>` via the same
`HttpBridge`. That collapses the two vault implementations into one
and eliminates the drift concern entirely. We note it as a direction
here and return to it in §12.

### 5.3 HTTP API

REST, JSON bodies, all under `/api`. Paths relative to the vault root.

| Method | Path                     | Purpose                                     |
| ------ | ------------------------ | ------------------------------------------- |
| GET    | `/api/tree`              | Full folder/note tree (cached, etag'd)      |
| GET    | `/api/notes/*`           | Read a note (Markdown body + frontmatter)   |
| PUT    | `/api/notes/*`           | Write a note. Optional `If-Match` header    |
| POST   | `/api/notes`             | Create / rename / move / duplicate          |
| DELETE | `/api/notes/*`           | Trash a note (soft)                         |
| POST   | `/api/notes/*/restore`   | Restore from trash                          |
| POST   | `/api/notes/*/archive`   | Move to archive                             |
| POST   | `/api/notes/*/unarchive` | Move out of archive                         |
| GET    | `/api/search?q=&scope=`  | Full-text search (FTS5 or ripgrep fallback) |
| GET    | `/api/tags`              | All tags with counts                        |
| GET    | `/api/tags/:tag`         | Notes matching a tag                        |
| GET    | `/api/tasks`             | Aggregated task list                        |
| GET    | `/api/backlinks/*`       | Backlinks for a note                        |
| GET    | `/api/assets/*`          | Binary asset (range requests)               |
| POST   | `/api/assets`            | Upload asset                                |
| WS     | `/api/watch`             | Stream of `{type, path, mtime}` events      |
| GET    | `/api/config`            | Client-visible config                       |
| POST   | `/api/config`            | Update client-visible config                |
| GET    | `/api/healthz`           | Liveness                                    |
| GET    | `/api/version`           | Server version + build info                 |

All write endpoints accept an `If-Match` header carrying the last known
SHA of the note body. On mismatch the server returns 409 with both
versions and the client shows a merge UI. This gives us optimistic
concurrency without CRDTs. For the single-user case, conflicts are
rare (only across devices or with external edits), so the simple
"keep mine / keep theirs / open diff" UI is enough.

### 5.3 HTTP API

REST, JSON bodies, all under `/api`. Paths relative to the vault root.

| Method | Path                     | Purpose                                   |
| ------ | ------------------------ | ----------------------------------------- | -------- | ---------------- |
| GET    | `/api/tree`              | Full folder/note tree (cached, etag'd)    |
| GET    | `/api/notes/*`           | Read a note (Markdown body + frontmatter) |
| PUT    | `/api/notes/*`           | Write a note. Optional `If-Match` header  |
| POST   | `/api/notes`             | Create / rename / move / duplicate        |
| DELETE | `/api/notes/*`           | Trash a note (soft)                       |
| POST   | `/api/notes/*/restore`   | Restore from trash                        |
| POST   | `/api/notes/*/archive`   | Move to archive                           |
| POST   | `/api/notes/*/unarchive` | Move out of archive                       |
| GET    | `/api/search?q=&scope=`  | Full-text search (FTS or ripgrep/fzf)     |
| GET    | `/api/tags`              | All tags with counts                      |
| GET    | `/api/tags/:tag`         | Notes matching a tag                      |
| GET    | `/api/tasks`             | Aggregated task list                      |
| GET    | `/api/backlinks/*`       | Backlinks for a note                      |
| GET    | `/api/assets/*`          | Binary asset (range requests)             |
| POST   | `/api/assets`            | Upload asset                              |
| WS     | `/api/watch`             | `{type: 'add'                             | 'change' | 'unlink', path}` |
| GET    | `/api/config`            | Client-visible config                     |
| POST   | `/api/config`            | Update client-visible config              |
| GET    | `/api/healthz`           | Liveness                                  |

All write endpoints accept an `If-Match` header carrying the last known
SHA of the note body. On mismatch the server returns 409 with both
versions and the client shows a merge UI. This gives us optimistic
concurrency without CRDTs. For the single-user case, conflicts are
rare (only across devices or with external edits), so the simple
"keep mine / keep theirs / open diff" UI is enough.

### 5.4 Watcher channel

`/api/watch` is a WebSocket. Server emits:

```json
{ "type": "change", "path": "inbox/my-note.md", "mtime": 1700000000000 }
{ "type": "add",    "path": "inbox/new.md",     "mtime": 1700000001000 }
{ "type": "unlink", "path": "inbox/old.md" }
```

Clients debounce and reconcile against their local cache, same way the
renderer already reacts to chokidar events through IPC today. The
transport changes and the Go `fsnotify` driver replaces chokidar; the
client-side handling doesn't.

### 5.5 Auth

- **Mode A (single user)**: On first boot the server generates a long
  random token (`crypto/rand`) and prints it to logs (and to a file at
  `/vault/.zennotes/token`). The user pastes it into the login screen;
  the server sets a long-lived `HttpOnly`, `Secure`, `SameSite=Strict`
  cookie signed with HMAC (`crypto/hmac`, `crypto/sha256`). No
  passwords, no accounts. Rotate with `POST /api/auth/rotate`.
- **Mode B (pure local)**: no auth; the browser is the boundary.
- **Mode C (multi-user)**: passkeys first (`go-webauthn/webauthn`),
  argon2id passwords as a fallback (`golang.org/x/crypto/argon2`).
  Sessions in a signed cookie, refresh token in a separate cookie.
  OIDC is possible later as middleware; not in v1.

CSRF is handled by `SameSite=Strict` cookies plus an `Origin` header
check. All state-changing endpoints require the cookie.

### 5.6 Filesystem safety

Every path in a request is cleaned with `filepath.Clean`, resolved
against the vault root with `filepath.Join`, and rejected if it escapes
(check via `filepath.Rel` + prefix match, not string comparison on
Windows). Symlinks outside the vault are rejected explicitly. The Go
tests port the same path-traversal cases from `vault.test.ts` so
parity is checked, not assumed.

Search via ripgrep/fzf is opt-in and runs through `os/exec` with a
fixed, hardcoded argv prefix (no shell, no user-supplied flags).
Disabled by default for remote deployments.

---

## 6. Client

### 6.1 One bridge, two implementations

Everything in the renderer that used to call `window.api.*` goes
through a single `VaultBridge` interface:

```ts
interface VaultBridge {
  listTree(): Promise<VaultTree>;
  readNote(path: string): Promise<NoteContent>;
  writeNote(path: string, body: string, etag?: string): Promise<WriteResult>;
  // …one method per current IPC handler…
  watch(handler: (ev: WatchEvent) => void): Unsubscribe;
}
```

Three implementations ship; a Vite env flag picks which is wired up at
boot:

- `ElectronBridge` — current preload `window.api`, unchanged.
- `HttpBridge` — `fetch` + WebSocket against the Go server. The
  request/response types are **generated** from `api/openapi.yaml`
  (via `openapi-typescript` and a tiny fetch wrapper), so the bridge
  cannot silently drift from the server's handlers.
- `FsaBridge` — File System Access API, used by Mode B. Implements
  the same `VaultBridge` surface against `FileSystemDirectoryHandle`,
  with an in-memory watcher backed by a polling mtime scan (the FS
  Access API does not expose change events).

Nothing else in the renderer changes. Zustand store, CodeMirror,
preview pipeline, search palette, command palette, theme system — all
untouched. That is the whole point of going through a bridge: the port
is additive, not a rewrite.

### 6.2 PWA shell

- **Manifest** (`manifest.webmanifest`): `display: standalone`, theme
  colors matching the 8 ZenNotes themes, maskable icons at 192/512,
  `scope: /`, `start_url: /`.
- **Service worker**: Workbox. Precache the app shell (JS, CSS, fonts,
  theme CSS, icons). Runtime:
  - `GET /api/tree` → StaleWhileRevalidate.
  - `GET /api/notes/*` → StaleWhileRevalidate, mirrored into IndexedDB
    for offline reads.
  - `GET /api/assets/*` → CacheFirst with long max-age.
  - `PUT /api/notes/*` → NetworkFirst with Background Sync: if offline,
    queue in IndexedDB and replay on reconnect.
- **Update flow**: new bundle triggers a subtle banner ("Reload to
  apply update"), same as Electron today, but in-app.

### 6.3 Offline

IndexedDB has three stores:

- `notes` — mirror of server responses keyed by path, value is
  `{ body, frontmatter, mtime, sha }`.
- `pendingWrites` — queue of writes taken while offline.
- `tree` — last tree snapshot for instant startup.

Startup path, online: paint from IndexedDB immediately, revalidate
from server, merge. Startup path, offline: same, just no revalidate.

Conflict rules (single-user assumption):

- Server wins on read, client wins on write, `If-Match` catches true
  conflicts.
- If `If-Match` fails, the editor shows a three-way view (mine,
  server's, merged) and lets the user pick. We already have a diff
  renderer via the unified pipeline; we reuse it.

### 6.4 Keyboard model

No regression. The current bindings already run in the renderer, which
is now the PWA. Things to double-check on the web side:

- `Ctrl/Cmd+N`, `Ctrl/Cmd+W`, `Ctrl/Cmd+T` are captured by the
  browser. We remap the app defaults to `Leader+n`, `Leader+w`, `Leader+t`
  first-class, and document the browser conflicts. This is already
  how the vim bindings work.
- The command palette (`Ctrl/Cmd+P`) is claimed by some browsers' print
  dialog on certain OSes; we intercept via `keydown` and `preventDefault`
  and document the `Leader+p` alternative.
- Global shortcuts do not exist on the web. `zen://` deep links
  become `https://notes.home.lan/open?path=…` so links in other apps
  still work when the PWA is installed.

### 6.5 Installation

- Chromium desktop: we show an install prompt the first time the user
  stars a note or pins a reference pane, not on first load. The idea
  is to ask only once there's something worth installing.
- iOS/iPadOS: standard "Add to Home Screen" flow; we render an
  explainer if the user visits on Safari and hasn't installed.
- We do not ship `windowControlsOverlay` in v1 — it's nice but not
  necessary.

---

## 7. Storage

### 7.1 Filesystem layout

Unchanged from the desktop build. The server cares about:

```
/vault/
  inbox/
  quick/
  archive/
  trash/
  attachments/
  .zennotes/
    server.json      ← config: auth token, ports, feature flags
    index.db         ← SQLite FTS (optional)
    state.json       ← server-side UI hints (pin order, etc.)
    token            ← generated bearer token
```

No database is required. A fresh vault boots with no `.zennotes/`
directory and the server creates what it needs.

### 7.2 Search index (SQLite)

- Tables: `notes(path, title, body, mtime, sha)`,
  `notes_fts(title, body, content=notes)`, `tags(tag, path)`,
  `tasks(path, line, priority, due, waiting, done, body)`,
  `backlinks(from_path, to_path)`.
- Built on first run, maintained incrementally by watcher events.
- If the index file is deleted, the server rebuilds it on next start.
  This is the user's "repair" button.

For vaults under ~2k notes, a pure in-memory index matches or beats
SQLite and avoids the file. We keep both and pick by vault size.

### 7.3 Assets

Served via `GET /api/assets/*` with `Cache-Control: public, max-age=31536000, immutable`
keyed on a content hash (not the filename). Range requests supported
so videos/audio stream without loading whole files. The renderer still
references them with a `zen-asset://` scheme, which the bridge rewrites
to `/api/assets/...` at paint time. That keeps the markdown file
portable between desktop and web.

---

## 8. MCP in a web deployment

The existing MCP server in `src/mcp/` is Node-based and uses the
upstream `@modelcontextprotocol/sdk`. We deliberately do **not** port
it to Go in v1:

- The upstream SDK is well-maintained in TypeScript; the Go MCP
  ecosystem is still young.
- The MCP server doesn't sit on the request hot path — it's invoked
  by external clients (Claude Desktop, Claude Code, Codex) against the
  same vault. A Node sidecar has no user-visible performance cost.
- Keeping it in TS lets us share the existing vault-operation helpers
  in `src/mcp/` without rewriting them against the Go server's HTTP
  surface.

Deployment options:

1. **Sidecar container** (recommended for home servers). A second
   container — `ghcr.io/zennotes/mcp` — shares the vault volume and
   is reachable over stdio from clients running on the same machine
   (via `docker exec`) or over a remote MCP-capable transport like
   SSE-over-HTTPS when that spec stabilizes.
2. **MCP-over-HTTP bridge**. The Go server can optionally expose
   `/api/mcp` that proxies to the Node sidecar, so remote clients
   don't need direct container access. Opt-in, off by default.

For Mode B (pure local, no server), MCP is not available. This is a
known limitation: MCP needs a process, and a pure browser deployment
doesn't have one. Users who want MCP pick Mode A.

The settings UI that today generates config snippets for Claude
Desktop / Claude Code / Codex stays, but it now offers two variants
per client: "local stdio" (desktop build) and "remote tunnel" (home
server, pasted into the client's remote MCP config).

**Future**: once the Go server is proven, we can evaluate porting the
MCP server to Go using one of the emerging community SDKs. Not a v1
concern.

---

## 9. Security

- TLS is required. The PWA features we depend on (service worker,
  install prompt, notifications, File System Access, secure cookies)
  only work over HTTPS or `localhost`. We document three TLS paths:
  Caddy auto-HTTPS with Let's Encrypt, Tailscale Funnel, and Cloudflare
  Tunnel. Each is one config block.
- Cookies: `HttpOnly`, `Secure`, `SameSite=Strict`, name-prefixed with
  `__Host-`.
- CSP: strict default, `script-src 'self'`, no inline scripts. The
  markdown pipeline already produces safe HTML through DOMPurify.
- Rate-limit auth endpoints via `chi` middleware
  (`httprate.LimitByIP`) — 10 requests/minute on login, 100/minute on
  the rest.
- Path traversal: all paths cleaned + resolved against vault root; no
  `..` escape, no absolute paths, no symlink traversal outside root.
- No arbitrary shell-out. ripgrep/fzf integration is opt-in, uses
  `os/exec` with a fixed argv prefix, and never interpolates user
  input into a shell string.
- No telemetry from the server. No telemetry from the PWA by default.
  If we add optional usage metrics later, they are off by default and
  self-hosted (e.g., Plausible).

---

## 10. Packaging and distribution

### 10.1 Server

- **Primary artifact**: a single static binary, `zennotes-server`,
  roughly 15–25 MB uncompressed, with the PWA bundle embedded via
  `go:embed`. Users can download it from GitHub Releases, `chmod +x`,
  and run it. No runtime dependencies.
- **Cross-compiled targets**: linux/amd64, linux/arm64 (for NAS and
  Raspberry Pi), linux/armv7 (older Pis), darwin/amd64, darwin/arm64,
  windows/amd64. Produced in one `make release` pass with
  `GOOS`/`GOARCH` matrix.
- **Docker image**: `ghcr.io/zennotes/server:x.y.z`, built `FROM scratch`
  (or `gcr.io/distroless/static` if we want a CA bundle baked in),
  ~15 MB. Multi-arch manifest for amd64 and arm64. Because the binary
  is static and the image is scratch, there is no shell, no package
  manager, and no userland CVE surface to patch.
- **Reproducible builds**: `-trimpath -ldflags="-s -w -buildid="`,
  `SOURCE_DATE_EPOCH`, and goreleaser for release automation.
- **Compose example**:

```yaml
services:
  zennotes:
    image: ghcr.io/zennotes/server:latest
    restart: unless-stopped
    volumes:
      - /srv/vault:/vault
    environment:
      ZENNOTES_VAULT_PATH: /vault
      ZENNOTES_BIND: 0.0.0.0:7878
    ports:
      - "7878:7878"

  zennotes-mcp:
    image: ghcr.io/zennotes/mcp:latest
    restart: unless-stopped
    volumes:
      - /srv/vault:/vault

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

volumes:
  caddy_data:
```

with a one-line Caddyfile that terminates TLS and proxies to the app:

```
notes.home.lan {
    reverse_proxy zennotes:7878
}
```

### 10.2 Client

The client bundle lives **inside the Go binary** via `go:embed`. On a
new release, the user replaces the binary (or pulls the container),
restarts, and the PWA auto-updates in browsers via the service worker.
Versioning matches the desktop app's; `GET /api/version` returns both
the server version and the embedded client's commit hash so mismatches
are impossible.

### 10.3 Install docs

One page in the README plus one `docs/self-hosting.md` that covers:

- **Binary quickstart**: download, `chmod +x`, run, open browser.
- **Docker Compose quickstart**: copy Compose file, `docker compose up -d`.
- **systemd unit**: for users who want to run the binary directly
  without Docker (example `zennotes-server.service` included).
- TLS (Caddy, Tailscale, Cloudflare Tunnel — pick one).
- Backups (vault is just files; rsync works).
- Upgrades: `docker compose pull && up -d`, or replace the binary.
- Pairing with the desktop app for hybrid use.

---

## 11. Phased delivery

Each phase is shippable on its own. We cut releases at each boundary.

1. **API contract.** Draft `api/openapi.yaml` from the current IPC
   surface. Wire a TypeScript client-type generator into the renderer
   build. No backend code yet — this locks down the shape before either
   side is implemented. ~0.5 week.
2. **Go server skeleton.** `cmd/zennotes-server`, chi router, config
   loader, health endpoint, static `go:embed` of a placeholder page,
   Dockerfile. Boots in milliseconds, does nothing useful yet. ~0.5 week.
3. **Port vault operations to Go.** `internal/vault` package with full
   parity against `src/main/vault.ts`. Shared test fixtures drive both
   sides. This is the biggest single phase. ~2–3 weeks.
4. **Watcher + index.** `fsnotify` watcher, SQLite FTS5 index with
   goldmark-based extraction for tags/tasks/backlinks, in-memory
   fallback for small vaults. ~1.5 weeks.
5. **HTTP + WebSocket handlers.** Wire vault + watcher + index behind
   the OpenAPI routes. PWA runs against the Go server with a dev
   `HttpBridge`. Editing, search, watcher work end-to-end. ~1 week.
6. **PWA shell.** Manifest, service worker, IndexedDB cache, install
   prompt, offline reads. ~1 week.
7. **Offline writes and conflict UI.** Background Sync queue, `If-Match`
   conflict flow, merge modal. ~1 week.
8. **Auth + Docker.** Bearer-token single-user auth with HMAC-signed
   cookies, Compose file, Caddy example, first public release of
   `zennotes-server` on GitHub Releases and `ghcr.io`. ~1 week.
9. **File System Access mode** (Mode B). `FsaBridge` implementation,
   entry-level "open a folder in your browser" flow. ~1 week.
10. **MCP sidecar image.** Package the existing Node MCP server as a
    second container and document remote setup. ~0.5 week.
11. **Multi-user** (Mode C) — only if demand is there. Passkeys,
    per-user vault dirs, session store. Deferred, scoped separately.

Total to first home-server release: roughly eight to ten weeks of
focused work. The Go port (phase 3) is the biggest single chunk; the
rest is mechanical once the contract is locked.

---

## 12. Open questions

- **Collapse to one vault implementation.** After v1, do we bundle the
  Go binary *inside* the Electron app and have the renderer talk to
  `http://127.0.0.1:<port>` in both modes? That collapses the two
  vault implementations into one and kills the drift-risk argument
  against Go entirely. Cost: Electron process model gets more complex
  (supervisor + child), and resource usage on desktop grows by one
  process. Recommendation: yes, but only after the Go server is proven
  in the wild for a release or two.
- **SQLite index vs on-demand scan.** Large vaults (>10k notes) will
  need the index; small vaults don't. We ship both and switch by size.
  Open: where's the exact cutover, and do we let users force one?
- **Realtime multi-device editing.** Not a v1 goal, but the transport
  (WebSocket) and the versioning (`If-Match`) are picked so we can
  graduate to CRDTs (Yjs; server side would use `automerge-go` or a
  WS passthrough) without rewriting the server.
- **Mobile editor ergonomics.** CodeMirror 6 works on mobile, but vim
  mode without a physical `Esc` and modifier keys is rough. If we want
  mobile to be good, we need a slim virtual toolbar. Out of scope for
  v1; tracked.
- **MCP over remote transport.** Stdio is local-only. Remote MCP is
  still a moving target across clients; we watch the spec and pick
  when it settles. Sidecar + `docker exec` is the bridge until then.
- **Port MCP to Go eventually?** Only if the community Go SDK
  catches up with the TS one. No pressure to do it in v1.
- **Pure-browser MCP.** There is no plausible v1 path here. Mode B
  users either run the desktop app or the home server when they need
  MCP.

---

## 13. Summary

- The renderer already runs in a browser; the port is mostly additive
  on the client side.
- **Backend is Go**: a single static binary (`zennotes-server`) built
  with chi + `coder/websocket` + `modernc.org/sqlite` + `fsnotify`,
  with the PWA embedded via `go:embed`. Ports the vault operations
  from `src/main/vault.ts` into idiomatic Go, validated by shared
  test fixtures and an OpenAPI contract.
- Wire the renderer through a `VaultBridge` with three
  implementations: `ElectronBridge` (unchanged), `HttpBridge`
  (generated from OpenAPI, talks to the Go server), and `FsaBridge`
  (File System Access API, pure-local mode).
- Ship a single binary + a `FROM scratch` Docker image + a Caddy
  example as the home-server story. Ship the pure-local browser mode
  for users who want zero backend. Keep the Electron desktop app.
- MCP rides along as a Node sidecar container against the same vault;
  re-evaluate porting to Go after v1.
- Keyboard-first and vim-first are preserved, because the whole
  interaction layer is untouched — we only swap the transport and
  re-implement the vault logic in a language better suited to running
  on someone's home server 24/7.
