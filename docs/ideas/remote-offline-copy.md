# Offline copy for remote vaults

Keep a copy of a self-hosted server's vault on this computer, so its notes open
and save while the server cannot be reached, and reach the server when it comes
back ([#1108](https://github.com/ZenNotes/zennotes/issues/1108), by @dwnsdp).

> **Status (November 24, 2026).** Phase 1 (conditional writes) shipped on
> November 23 in ZenNotes 2.91.0, znserver 2.91.0 and `zn` 0.18.2: note reads
> and writes return `sha256`, a write with a stale `baseSha256` gets 409
> (`supportsConditionalNoteWrites`), and the 2.91.0 retry, the desktop and web
> remote clients, the bundled `zn` and the Go `zn` (CLI, MCP and TUI autosave)
> send the base. Phase 2 (the server sync protocol) shipped on November 24 in
> znserver 2.91.1 ([ZenNotes/znserver#88](https://github.com/ZenNotes/znserver/pull/88)): `.zennotes/sync/`, the reconcile,
> `/api/sync/manifest`, `changes` and `mutations`, revision bumps in every
> mutator and `supportsSync: 1`, and Cloud's own `CloudSyncCoordinator` drives
> it end to end in znserver CI (`integration/cloud-engine`). Phase 3's toggle
> names server 2.91.1 as the version it needs. Phase 3, the desktop offline
> copy, shipped on November 24 in ZenNotes 2.92.0, with `/api/sync/revision`
> pulled in from phase 4 in server 2.92.0 (`supportsSync: 2`, decision 10,
> ZenNotes/znserver#91). What remains of phase 4 (attachments in the copy) and
> phase 5 (the phones, then perhaps the web client) are not started.
> Written from the code on `v2.91.0` at `3422803d` (the failed-save retry this
> builds on), znserver `origin/main` at server 2.84.1, and ZenNotes/tui
> `origin/main`; line numbers are from those trees. The eight questions the
> first draft left open were decided with Adib on November 23 (see Decisions
> made at the end). Until phase 3 ships, a local vault with ZenNotes Cloud is
> the way to work offline, which is what #1108 was told.

## What exists today

**A remote vault is a pass-through.** The desktop keeps one
`RemoteServerClient` for every remote window (`remoteWorkspaceClient`,
`apps/desktop/src/main/index.ts:462`), and every vault IPC handler branches on
`isRemoteWorkspaceActive()` (91 call sites in `index.ts`; the check is at
`index.ts:3739`). A note read is `client.readNote` (`index.ts:4866-4870`), a
save is `client.writeNote` (`index.ts:5096-5102`), and both are one HTTP request
(`apps/desktop/src/main/remote/server-client.ts:259-290`). Nothing is cached on
disk. An unreachable server at boot sets `remoteWorkspaceBootError`
(`index.ts:3706-3716`) and the renderer shows "Can't reach your ZenNotes server"
with no notes (`packages/app-core/src/components/EmptyVault.tsx:19-89`).

**2.91.0 stops losing the edit** (`3422803d`). A failed save is remembered per
note (`noteSaveErrors`, `packages/app-core/src/store.ts:3952-3956`), the header
says Not saved, and `retryFailedSaves` (`store.ts:9481`) tries again after 2, 5,
15, 30 and then 60 seconds (`packages/app-core/src/lib/save-retry.ts:13`), at
once on a feed reconnect (`store.ts:9117-9120`) and when the OS reports the
network back. Before retrying it reads the server, and if the note moved away
from `savedBodies` (`store.ts:4751`) it writes the server's version to
`Note (server copy).md` first (`save-retry.ts:26-39`). Quit and window close ask
first while any note is not saved (`apps/desktop/src/main/unsaved-notes-guard.ts`,
`index.ts:7102-7127`). Two limits remain, and this design is about both: the
edit lives only in the renderer's memory, so the vault is unreadable offline and
a crash still loses it; and the read-then-write check is two requests, not one
atomic step, because the server has no conditional write.

**The server has no versions.** `POST /api/notes/write` decodes `{path, body}`
and writes (znserver `internal/httpserver/server.go:773-790`); `WriteNote` takes
the vault lock and writes atomically with an fsynced temp file
(`internal/vault/vault.go:1673-1686`, `internal/vault/atomicwrite.go:49-138`).
Nothing reads a precondition: `If-Match` appears only in the CORS allow list
(`internal/httpserver/security.go:570`). `updatedAt` and `createdAt` are both the
file's mtime (`vault.go:1553-1554`), and no content hash is returned anywhere.
`GET /api/notes` returns the whole list every time (`vault.go:1231`).

**The change feed is a hint, not a log.** `/api/watch` sends
`{kind, path, folder, scope}` with no sequence number and no backlog
(`internal/vault/types.go:535-540`); a slow subscriber's events are dropped
silently (`internal/watcher/watcher.go:442-451`); a folder rename reports the
folder, not the notes inside it (`watcher.go:266-285`); and a client sees the
echo of its own writes. The desktop already treats any gap as "re-pull
everything" (`server-client.ts:560-576`, the `resync` handler at
`store.ts:9027`), and polls when the socket cannot stay up
(`server-client.ts:533-547`).

**One precedent for compare-and-swap exists.** A workflow apply compares each
file's live bytes with the client's `Before` under the vault lock and answers 409
on a mismatch (znserver `internal/vault/workflows.go:575-585`,
`server.go:332-334`). Auth is one shared token for the whole server, with no user
or device identity (`internal/config/config.go:35`), and the selected vault is
global to the server process: switching it swaps the vault for every client
(`server.go:110-137`).

**ZenNotes Cloud already solves the client half.** Its engine is pure and
host-agnostic in `packages/shared-domain/src/cloud-sync-*.ts`. It talks to a
server only through `CloudSyncRemote` (`cloud-sync-coordinator.ts:82-109`:
`manifest`, `changes`, `mutate`, optional `revision`) and to a folder only
through `CloudSyncRepository` (`cloud-sync-coordinator.ts:111-163`), with the
desktop implementation `DesktopCloudSyncRepository(root)`
(`apps/desktop/src/main/cloud-sync-filesystem.ts:93-94`). It tracks a revision
and sha256 per item (`cloud-sync-engine.ts:37-45`), plans uploads by diffing the
folder against that state and detects renames by hash
(`planCloudSyncMutations`, `cloud-sync-engine.ts:124`), sends each mutation with
a `base_revision` (`packages/bridge-contract/src/cloud-sync.ts:55-90`), tries a
three-way merge before asking (`mergeCloudSyncText`,
`cloud-sync-merge.ts:64`), and keeps unresolved conflicts for review
(`CloudPendingConflictResolver`, reached with `Space r`,
`packages/shared-domain/src/keymaps-catalog.ts:90`). Today it refuses remote
vaults outright (`requireLocalCloudVaultRoot`, `index.ts:666-677`).

## The idea

**The offline copy is a real local folder, and Cloud's engine keeps it in step
with the server.** With the copy on, a remote window opens a folder the app owns
under userData through the local-vault code path, so reading, saving, search,
tasks, databases, workflows and the watcher all work offline exactly as they do
for any local vault. A sync service runs `CloudSyncCoordinator` with the mirror
as its repository and znserver as its remote. For that, znserver learns a subset
of the Cloud sync protocol for the vault it serves: per-item revisions, a
sequenced change log with deletes as tombstones, and mutations that reject a
stale base.

### Alternatives considered

- **A caching proxy behind the 91 remote branches.** Keep `RemoteServerClient`
  and teach each handler what to do offline (read from cache, queue the write).
  Rejected: every handler grows offline semantics of its own, renames, trash,
  folder ops and workflows each need a hand-written replay, and the result is a
  second sync engine beside Cloud's.
- **No server change: base bytes on the client plus an mtime check.** This is
  what 2.91.0 does online. Offline it cannot be made safe: the check and the
  write stay two requests, an mtime is not a version (two writes in one
  millisecond, clock skew, a `touch`), and nothing tells the client what changed
  while it was away except a full re-list and re-read of every note.
- **Chosen: mirror folder + Cloud's engine + a server protocol.** The engine
  already handles the hard cases (rename detection, coalescing, echo skipping,
  crash resume, one file never wedging sync, keep-both review), on desktop and on
  the phones.

## What the user sees

**The setting.** Off by default, per remote profile, in the profile dialog
(`packages/app-core/src/components/RemoteWorkspaceProfileModal.tsx`), one line:
**Keep an offline copy**, "Notes open and save on this computer when the server
is away." Below it, once on: the space it uses and **Remove offline copy**.
Against a server without the protocol the row is disabled and says "Needs
ZenNotes server X or later." It is a per-device setting, not a portable pref:
`PORTABLE_PREF_KEYS` leaves it out, because whether a laptop holds a copy of a
server is a decision about that laptop.

**Online, the copy comes first.** Saves land in the mirror, as they do in a local
vault, and reach the server within the auto-sync debounce (2 seconds,
`CloudAutoSyncController`, `packages/shared-domain/src/cloud-auto-sync.ts:41`).
Edits from other devices arrive when the change feed says the server moved and
the engine pulls. This is the Cloud model, and it is a behavior change from
today's pass-through (Decisions made, 1).

**Offline.** Nothing about the editor changes: notes open, saves land, no Not
saved pill (that is for a save that has nowhere to go, and here it always has the
mirror). The status bar, where Cloud sync shows its state
(`packages/app-core/src/components/StatusBar.tsx`), says
**Offline · 3 changes waiting**, and its tooltip names the server and when it was
last reached. At boot, an unreachable server opens the mirror instead of the
reconnect screen, with the same status. What needs the server stays visible and
says so when used: Connect/select another server vault, directory browsing,
publishing, and attachments that are not in the copy (below).

**Keyboard.** All of it is in the palette: **Sync Remote Vault Now**, **Review
Remote Vault Conflicts**, **Work Offline** / **Work Online** (stop and resume
syncing on a metered or untrusted network). Vim: `Space r` already opens what
waits on a sync decision (`VimNav.tsx:1150-1169`); it opens remote conflicts the
same way, and its hint says which. `Space R` (free today) runs Sync Remote Vault
Now and only appears in the leader hints for a vault with a copy. With Vim off
these are palette entries only; no letter key acts.

**Conflicts.** A change the server rejected because the note moved there first is
merged line by line when the two edits do not overlap, silently, as Cloud does.
When they overlap, nothing is overwritten: the mirror keeps this device's text,
the note shows the conflict banner, and `Space r` opens the resolver with Keep
this device, Keep server, Keep both and per-change choices. Keep both puts the
server's version at the note's path and this device's at `Note (this device).md`
(`localCopyPath`, `CloudPendingConflictResolver.tsx:1010-1018`). Copy, with
"Cloud" replaced by the server's profile name: "**Notes** changed on **Home
server** and on this computer."

A vault without a copy keeps 2.91.0's behavior: the retry has no stored base,
local and server versions to hold a conflict for review, so it keeps both at
once and writes the server's version to `Note (server copy).md`. The naming
rule is the same in both cases: **the suffix names the side that moved aside**.
2.91.0 keeps this device's text at the path because it is the buffer open in the
editor, and moving an open note off its path would be worse than the two names.

**Quit.** A note in the mirror is on disk, so the 2.91.0 quit question does not
fire for it. What does ask: removing the copy, turning the setting off, or
deleting the profile while changes have not reached the server. "3 changes on
this computer have not reached Home server. Removing the offline copy deletes
them." Buttons: **Keep Offline Copy** (default) and **Remove Anyway**.

**Vocabulary on the surface.** "Offline copy" is the name in the setting, the
status tooltip, the manual and the palette, so the docs can say it.

## The local store

**Where.** `<userData>/remote-mirrors/<profileId>/<vaultId>/`, holding `vault/`
(the mirror) and `sync-state.json` (the engine's `CloudSyncState`, saved
atomically the way `DesktopCloudSyncStateStore` does,
`cloud-sync-filesystem.ts:659-670`). `vaultId` is the server's sync id for the
vault (below), not its root path: the server can switch vaults under every
client at once (`server.go:110-137`), and a mirror must never sync into a vault it
was not copied from. Undo history already keys remote vaults by profile and root
(`index.ts:4506-4510`); it moves to the mirror's key. `ZENNOTES_USER_DATA_PATH`
isolates mirrors for CDP runs with no extra work.

**Not a local vault.** A mirror is opened through the local code path but is never
remembered as one: not in `localVaults` (`rememberLocalVault`), never
`cfg.vaultRoot`, never in `knownLocalVaultRoots` (`index.ts:2852-2859`), and
refused by Cloud sync (`requireLocalCloudVaultRoot` gains the check), since two
sync engines on one folder would each read the other's writes as user edits. A
mirror root dropped onto the app as a folder is refused. **Open vault folder**
(`Space F`) opens it, read-mostly, with a one-line warning that edits made there
sync to the server.

**The window.** The simplest seam: a mirrored window is a local window whose
`VaultInfo` carries `mirrorOf: { profileId, baseUrl, vaultId }`.
`isRemoteWorkspaceActive()` is false for it, so all 91 branches take the local
path with the mirror root, and `RemoteWorkspaceInfo` (the Settings rows, the
status, the share sheet) is built from `mirrorOf` instead of the live client.

**The never-write rule, inverted.** A temporary folder session must not receive
ZenNotes state (`apps/desktop/src/main/ephemeral-vaults.ts:3-9`). A mirror has the
opposite problem: anything ZenNotes writes into it that sync would carry goes to
the user's server. So mirror roots get a registry beside the ephemeral one, and:

- `ensureVaultLayout` (`apps/desktop/src/main/vault.ts:1780`) and the seeded
  Welcome note never run on a mirror. The server's layout arrives by sync; a
  layout written first would upload an `inbox/` and a Welcome note into a vault
  that may map Inbox elsewhere (`systemFolderPaths`).
- App-local state (`.zennotes/workspace.json`, `index.ts:4496-4499`; the
  note-meta cache) stays in the mirror and never syncs, by construction:
  `shouldSyncVaultPath` treats unknown `.zennotes/` files as local-only
  (`packages/shared-domain/src/cloud-sync.ts:79-90`). Its allow list (vault.json,
  comments, agent edits, note metadata, templates, workflows) is what the server
  serves through its own routes today, so the two agree.
- System folders resolve through the synced `vault.json`, as in any local vault;
  nothing joins a literal folder name.

**Size and attachments.** Notes and the synced `.zennotes/` files are always in
the copy. Attachments are in it by default, up to 25 MB per file, with no total
budget: the profile dialog shows the space the copy uses beside **Remove offline
copy**, and a budget waits until someone asks for one. A larger file is held the way Cloud holds a path it refused
(`refused_paths`, `cloud-sync-engine.ts:76-77`): listed, fetched from the server
when online, and shown offline as "Not in the offline copy" in its embed. The
first download shows progress in the status tooltip, and a disk that fills stops
the run with the engine's usual error instead of a half-written note (writes are
temp plus rename, `cloud-sync-filesystem.ts:591-624`).

## The server protocol

Advertised as `supportsSync: 1` in `/api/capabilities` (an inline map,
`server.go:450-504`; the number is a protocol version, so a later change can
raise it). The wire types are Cloud's (`packages/bridge-contract/src/cloud-sync.ts`)
minus encryption, so the client adapter is thin.

- `GET /api/sync/manifest?page=&perPage=` lists every synced item:
  `{item_id, path, kind, revision, sha256, byte_length, media_type}`, text
  content inline for small files. Answers also carry `vault_id` and the current
  `cursor`.
- `GET /api/sync/changes?after=<cursor>&limit=` returns
  `{data: [{sequence, item_id, type: upsert|move|delete, path, previous_path,
  revision, content?}], cursor, has_more}`. A cursor older than the retained log
  answers 410 `CURSOR_EXPIRED`, and the engine rebuilds from the manifest
  (`cloud-sync-coordinator.ts:746-770`).
- `POST /api/sync/mutations` takes up to 100 `upsert | move | delete` mutations,
  each with `operation_id`, `item_id` and `base_revision` (`null` to create).
  Each is applied under the vault lock (`v.mu`) only if the item's current
  revision equals the base; otherwise it answers that mutation with
  `REVISION_CONFLICT`, `PATH_CONFLICT` or `ITEM_DELETED` and the current
  revision. Results are per mutation (`acknowledged`, `conflicts`), so one stale
  note does not hold back the rest. A repeated `operation_id` returns its first
  answer, which makes a retry after a timeout safe.
- `GET /api/sync/revision?item=&revision=` (phase 4) returns a retained older
  version, the base for a three-way merge. Without it a conflict stays two-way
  instead of blocking sync (`cloud-sync-coordinator.ts:1319-1323`).
- Attachments above the inline limit reuse `GET /api/assets/raw` and a staged
  `POST /api/assets/upload` referenced by the mutation, the same split Cloud makes
  for files over 5 MB.

**Every write path bumps revisions, not just the sync routes.** The web client,
the phones, both `zn` builds, and the server's own `/mcp` all write through
`/api/notes/write` and friends (tui `mcpserver/mcpserver.go:277-281` uses the
server's own HTTP API). So the revision index is updated inside the vault's
existing mutators, under the lock they already take. Each rename, trash, move and
folder rename becomes one `move` per item, a permanent delete or Empty Trash one
`delete` per item (the tombstone), and a rename's wikilink rewrites
(`vault.go:2048-2052`) become `upsert`s of the notes they touched.

**Edits that bypass the server are caught by a reconcile, not the watcher.**
People edit server vaults with a shell, `git pull` or Syncthing. The watcher drops
events and misses notes inside a moved folder, so it only wakes the reconcile:
a stat walk that compares mtime and size with the index, hashes what differs,
records a new revision, and pairs a vanished path with a new one of the same hash
as a move (the same rule as `cloud-sync-engine.ts:183-198`). It runs at startup,
on a watcher hint (debounced), and every few minutes. Until it has seen a file, a
mutation on it compares the live hash, so an out-of-band edit is never written
over.

**The store.** `.zennotes/sync/` inside the vault: `vault_id`, the index
(path to item id, revision, sha256, mtime, size), the append-only change log
(fsynced per batch, kept for 90 days as Cloud keeps its own), the `operation_id`
replay table, and retained revisions: note text only, for 30 days or the last 20
revisions of each note, whichever keeps more. Merges need the revision the
offline device last saw, and offline stretches run hours to days; binaries get
no merge, so no old versions of them are kept, and text keeps the disk cost
small. In the vault, not in `/data`, because it describes
the vault: it must follow a vault switch and a vault moved to another server, and
the Docker image already mounts the vault as its own volume (znserver
`Dockerfile:22-28`). The watcher already ignores dot-paths outside its allow list
(`watcher.go:295`, `371`), and Cloud's `shouldSyncVaultPath` excludes it too, so
a server vault that is also a Cloud vault does not carry it. The server writes a
`.gitignore` inside it for vaults kept in Git.

**Crash safety on the server.** A mutation writes the file atomically first
(`atomicwrite.go`), then appends its change to the log. A crash between the two
leaves a file newer than the index, which the startup reconcile records as an
out-of-band edit: the client sees one extra revision, never a lost one. A batch
needs no workflow-style journal, because each mutation stands alone and Cloud's
engine already expects per-item answers.

**The live feed stays as it is.** A watch event means "pull now"; the change log
is the authority. The engine skips its own echoes by the sequences its mutations
were acknowledged with (`cloud-sync-coordinator.ts:1024-1035`).

**Conditional writes on the existing API (the first slice).** Independent of the
sync routes, `/api/notes/read` and `/api/notes/write` return a `sha256` of the
body, and `/api/notes/write` accepts an optional `baseSha256`. Under the lock the
server hashes the file on disk and answers 409 with the current body's hash when
they differ. A content hash needs no stored state and no reconcile, and stays
correct when the file is edited behind the server's back. A write without it is
unconditional, as today, so every installed client keeps working.

## The client sync engine

**A `RemoteMirrorSyncService` in desktop main**, a thin sibling of
`DesktopCloudSyncService` (`apps/desktop/src/main/cloud-sync-service.ts`) without
accounts, links, E2EE or backups. Per mirrored profile it builds a
`CloudSyncCoordinator` with:

- **remote**: `ZnServerSyncRemote`, implementing `CloudSyncRemote` over the
  `/api/sync/*` routes with the profile's token and gateway headers
  (`apps/desktop/src/main/remote/connection.ts:128-159`);
- **repository**: `DesktopCloudSyncRepository(mirrorRoot)`, unchanged;
- **state store**: the state file above;
- **triggers**: `CloudAutoSyncController` (debounced local change, periodic run,
  backoff 5, 15, 60, 300 seconds), plus a pull on every watch event and a full
  run on feed reconnect, where `startRemoteWatch` (`index.ts:2676-2700`) sends
  `resync` today.

**The offline queue is the folder.** There is no operation log to replay. While
offline, edits change files in the mirror; when the server answers, the planner
diffs the mirror against the last state the server acknowledged and sends what
differs. A rename is a hash match, ten saves of one note are one upsert, and an
edit undone offline sends nothing. The replay order is the coordinator's:
recover interrupted work, pull, scan, retry pending merges, plan, write in
batches of 100 with deletes last, then pull again if the cursor moved
(`cloud-sync-coordinator.ts:498-744`).

**Conflict detection** is the base revision: a mutation built on revision 7 of a
note now at 8 comes back `REVISION_CONFLICT`, the next pull brings revision 8,
and the engine stores `{base, local, server}` in `pending_conflicts` and tries the
merge. A pull that would replace a note whose bytes are not what the engine last
recorded (the user saved it a moment ago) is held as a conflict instead of
written (`cloud-sync-filesystem.ts:529-539`). A dirty buffer in the editor is
never replaced either: sync's writes reach the renderer as ordinary watcher
events, which already defer to unsaved edits (#863).

**Crash safety on the client** is the engine's: the state advances only on an
acknowledgement (`cloud-sync-engine.ts:226-281`), the cursor is saved per applied
change, so a killed run resumes at the change that failed, and every replacement
rechecks the file's hash just before the rename
(`cloud-sync-filesystem.ts:226-246`). The one multi-file operation a user can run
offline, a workflow, is journalled by `workflow-apply.ts` in the mirror before it
writes (`apps/desktop/src/main/workflow-apply.ts:31-40`), and its writes sync as
ordinary upserts afterwards. Comparing with the workflows applier: Cloud's
per-item model gives the same promise (never report a write the server did not
take) without a run journal, because each item is acknowledged on its own.

**What the 2.91.0 code becomes.** For a vault with a copy, `retryFailedSaves` has
nothing to do (the mirror takes every save). For a vault without one, it stays,
and against a server with conditional writes it sends `baseSha256` and turns a
409 into the server copy, which makes it atomic.

## What changes in each repo

| Where | Change |
|---|---|
| desktop main (`apps/desktop/src/main`) | Mirror registry and paths; `mirrorOf` on `VaultInfo`; boot opens the mirror when the server is down; `RemoteMirrorSyncService` and `ZnServerSyncRemote`; Cloud refuses mirrors; remove-copy guard; `remoteWorkspaceInfo` from `mirrorOf`. |
| app-core | Profile dialog toggle and size row; status bar item; palette commands, `Space R`, `Space r` for remote conflicts; resolver and banner copy parameterized ("Cloud" becomes the server's name); "Not in the offline copy" embed; help.ts entry. |
| shared-domain / bridge-contract | Coordinator and resolver copy that names Cloud (`cloud-sync-coordinator.ts:55-64`, `cloud-error-copy.ts`) parameterized; `CLOUD_SYNC_MAX_PATH_CHARACTERS` made per remote; conflict IPC generalized from `getCloudConflict` to a sync-source id; `ServerCapabilities.supportsSync`; optional `sha256` on `NoteContent`. |
| znserver | Conditional write on `/api/notes/write`; `.zennotes/sync/` index, log and reconcile; `/api/sync/*`; revision bumps in every mutator; capability flag. Unrelated bug found on the way: `switchVaultRoot` never calls `SetFolderPaths` (`server.go:110-137`; only `cmd/zennotes-server/main.go:69-71` does), so after a vault switch the watcher classifies events against default folder names. |
| web client (`apps/web`) | Phase 1: send `baseSha256` from its bridge (`apps/web/src/bridge/http-bridge.ts:464-484`, where `appendToNote` is a read-modify-write today). An offline copy there is IndexedDB plus the same engine and is a later, separate decision; the service worker caches only the shell and never the API (`apps/web/public/sw.js:1-8`). |
| desktop `zn` CLI and MCP | Stay server-only: they follow the app's workspace (`apps/desktop/src/cli/vault-target.ts:218-237`) and keep talking to the server, so offline they fail as today. Their read-modify-write helpers (`apps/desktop/src/cli/backend.ts:527-574`) send `baseSha256` and retry once on 409. Writing the mirror from another process is out: runs are serialized per root inside the app only (`cloud-sync-service.ts:618-633`). |
| Go `zn` CLI/TUI (ZenNotes/tui) | TUI autosave's pre-write check (`internal/tui/io_async.go:15-35`, whose comment already names this race) sends `baseSha256`, turning it into a real compare-and-swap; remote read-modify-write helpers (`internal/backend/remote.go:140-222`) likewise. A mirrored backend could slot in behind `backend.Backend` (`internal/backend/backend.go:27-84`) later. Old builds ignore the new field (Go `json` drops unknown keys). |
| phone shells | They do use self-hosted remotes, through `packages/portable-vault/src/remote-vault.ts` (polling every 4 s, `remote-workspace.ts:60-75`), and at boot an unreachable server silently switches them to the on-device vault (`remote-workspace.ts:283-296`). They already run Cloud's engine on the device (`PortableCloudSyncRepository`), so an offline copy there is the same design over portable-vault plus a phone release in both repos. Phase 5, first of the other clients: phones go offline more than laptops, and their silent switch to the on-device vault is the opposite of a copy. |
| docs | help.ts and the website mirror (`docs.blade.php`, `docs-sections.json`) in the same change; this file gets a status banner when a phase ships. |

## How much of Cloud is reused

| Piece | Reuse |
|---|---|
| `CloudSyncCoordinator`, `planCloudSyncMutations`, change reduction, echo skip, landed-state saves, refused-path holds | As is |
| `mergeCloudSyncText`, pending conflicts, `resolveConflict` | As is |
| `DesktopCloudSyncRepository`, state store, staged downloads, `cloudSyncFreePath`, `shouldSyncVaultPath` | As is, rooted at the mirror |
| `CloudAutoSyncController`, stall and retry helpers | As is |
| Conflict resolver, banner, `Space r` | Copy and IPC generalized |
| `DesktopCloudSyncService` | Replaced by a thin mirror service |
| `CloudSyncRemote` HTTP client | New adapter for `/api/sync/*` |
| E2EE, accounts, keysets, publishing, backups, quotas, signed URLs, `cloud-layout.ts` | Not used |

The server side is new code, but its shapes are dictated by the engine, so the
two cannot drift in meaning.

## Compatibility

- **Older server:** no `supportsSync`, so the toggle is disabled with the version
  it needs, and the vault works online-only with the 2.91.0 retry. No
  `sha256` in a read means the retry keeps its two-request check.
- **Older clients on a newer server:** unconditional writes keep working and bump
  revisions like any write, so a mirror sees their edits on its next pull.
- **Turning it on** downloads the manifest (the engine's bootstrap), then the
  window switches to the mirror. **Turning it off** with nothing pending deletes
  the mirror and returns to pass-through.
- **Server downgraded and upgraded again:** `.zennotes/sync/` is ignored by the
  old server; the new one's startup reconcile records whatever changed, and a
  pruned cursor answers 410, which rebuilds from the manifest.
- **Server switched to another vault:** `vault_id` differs, sync stops, the status
  says "Home server now serves a different vault," and the mirror is kept as it
  is. The window offers to open the server's new vault online.

## Phased plan

1. **Conditional writes (smallest safe slice, useful alone, next znserver
   release).** znserver:
   `sha256` on note read and write responses, optional `baseSha256` on
   `/api/notes/write` with 409, a capability flag. Clients: the 2.91.0 retry, the
   desktop CLI/MCP helpers, the web bridge and the TUI autosave send it. This
   closes the race 3422803d's commit message names, with no stored server state.
   No ordering between server and clients: a client sends `baseSha256` only when
   a read gave it a `sha256`.
2. **Server sync protocol.** `.zennotes/sync/`, reconcile, `/api/sync/manifest`,
   `changes`, `mutations` for notes and the synced `.zennotes/` files, revision
   bumps in every mutator, `supportsSync: 1`. Shipped and tested against
   `CloudSyncCoordinator` in a Go-plus-Node integration test before any UI.
3. **Desktop offline copy, notes only.** Mirror store, toggle, boot from the
   mirror, status, palette and Vim entries, conflict review. Attachments stay
   online-only and say so offline. Ships when it is ready, gated only on the
   server's `supportsSync`, not on every server channel (Docker, AUR, Homebrew,
   Nix) having phase 2: against an older server the toggle stays disabled and
   names the version it needs.
4. **Attachments and three-way merges.** Attachments in the copy under the cap,
   retained revisions and `/api/sync/revision`.
5. **Other clients, each its own decision.** Phones first (portable-vault already
   hosts the engine), then possibly the web client (IndexedDB, whose storage a
   browser may evict, which makes offline web a product question of its own).
   The protocol of phase 2 serves them all, so neither needs a second server
   change.

## Risks

- **Online behavior changes.** With the copy on, a save is on this computer
  before it is on the server, so another device sees it after a sync, not at
  once. In return two devices editing one note get a merge or a conflict instead
  of last writer wins.
- **Server cost.** The reconcile walks the vault; on a large vault on a slow NAS
  that must stay on the mtime and size fast path and hash only what moved (the
  phones' scan cache does the same, `packages/portable-vault/src/cloud-sync-repository.ts:1-20`).
  The desktop engine hashes every mirror file on every run
  (`cloud-sync-filesystem.ts:465-487`); fine at Cloud's scale today, worth the
  perf harness on a 5,000-note mirror.
- **A second copy of the user's data.** Self-hosters may host precisely so notes
  stay on their machine. The mirror is an unencrypted folder in userData; the
  setting is opt-in, per device, removable, and says where it lives.
- **Two writers.** MCP and the CLI keep writing to the server while the app writes
  the mirror. That is safe (the server orders them and the engine merges), but
  while the server is away an assistant cannot edit the vault even though the
  app can.
- **Engine assumptions.** Cloud's engine was written against one service. A
  second remote will find Cloud-only assumptions (path length, error copy,
  quota codes); each is small, but they surface one at a time.
- **Stale UI copy.** The 2.91.0 manual entry ("When the server cannot be
  reached", `packages/app-core/src/lib/help.ts:371`) must say which behavior
  applies with and without a copy.

## Decisions made

Decided with Adib on November 23, 2026, on the first draft's recommendations.

1. **The copy comes first, online too.** The copy must be fresh to be worth
   opening offline, so it is synced while online either way; the fallback
   variant (pass-through while the server answers) adds a switch between two
   paths mid-edit, which is where edits are lost or doubled. Copy first is
   Cloud's proven model and one path to test. The cost is a save reaching other
   devices about 2 seconds later.
2. **Conflicts: merge, then the review queue, with Keep both as a choice.** Most
   conflicts settle in the line merge. The queue needs the base, local and server
   versions held across restarts, which only the engine's state has, so vaults
   without a copy keep 2.91.0's automatic server copy. Neither naming changes:
   the suffix names the side that moved aside.
3. **Attachments in the copy by default, 25 MB per file, no total budget.** Notes
   without their images read as broken offline; the cap mostly keeps out video.
   The space used is shown with Remove offline copy beside it.
4. **The server's store is `.zennotes/sync/` in the vault.** It describes one
   vault and must follow a vault switch or a move to another server; `/data` is
   shared by every vault a plain-binary server can open. Losing it is
   recoverable (a new `vault_id`, clients rebuild from the manifest), and a
   `.gitignore` keeps it out of Git.
5. **Retention: note text for 30 days or the last 20 revisions, whichever keeps
   more; the change log for 90 days.** That covers the base of a merge after any
   ordinary offline stretch, at a text-only disk cost; an older cursor rebuilds
   from the manifest.
6. **The CLI and MCP stay server-only.** Writing the mirror from another process
   needs cross-process locking the app does not have, and they mostly run where
   the server is reachable. Phase 1 still makes their edits atomic.
7. **Phones and web are separate decisions, phones first.** The protocol is
   designed for every client so none needs a second server change.
8. **Phase 1 goes in the next znserver release; desktop phase 3 is gated only on
   `supportsSync`.** Feature detection covers a server that lags, so the desktop
   does not wait for every server channel.
9. **Phase 2 ships in server 2.91.1** (Adib, November 24), a server-only
   release like 2.84.1, so the disabled toggle names 2.91.1.
10. **`/api/sync/revision` moves into phase 3** (Adib, November 24). Without a
    base every note edited on both sides went to review; with it the engine's
    line merge settles edits to different parts on its own. The server
    advertises it as `supportsSync: 2` and keeps the current bytes of every
    item as well as the log's, so revision 1 of a note it started with is a
    base too. The desktop reads revisions only from a server that says 2, so a
    2.91.1 server still keeps copies, with review-only conflicts.
11. **Work Offline gets its palette entry in phase 3** (Adib, November 24),
    with Work Online beside it; a paused copy keeps every change and says
    Working offline in the status bar.

## Open questions

None open. Work Offline was decided (decision 11).
