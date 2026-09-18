# Shared application core

This package owns the shared React application, editor, navigation state, and
feature orchestration. Hosts implement the bridge and own native I/O. Public
exports are the integration boundary; the internal store and pane tree remain
implementation details.

## Public exports

- `@zennotes/app-core/main`: application bootstrap and Cloud auto-sync request.
- `@zennotes/app-core/navigation`: note navigation and Home behavior for shells.
- `@zennotes/app-core/notes`: prompted note moves and renames with host-session and save guards.
- `@zennotes/app-core/shell`: immutable note metadata, shell observations, and mobile Browse ordering.
- `@zennotes/app-core/browse`: folder/database rows, date-directory settings, and confirmed folder actions for native drawers.
- `@zennotes/app-core/editor`: run formatting/search commands, inspect selection,
  configure native typing/insets, and import attachments without accessing
  CodeMirror or the store.
- `@zennotes/app-core/tasks`: immutable task observations, today's groups, refresh, navigation, and Kanban moves.
- `@zennotes/app-core/workspace`: restoration, profile metadata, workspace switching and save draining.
- `@zennotes/app-core/settings`: observed theme/editor settings and supported updates.
- `@zennotes/app-core/commands`: command descriptions, checked invocation, and core palettes.
- `@zennotes/app-core/dialogs`: host prompts and confirmations that do not replace pending dialogs.
- `@zennotes/app-core/host`: explicit host kind and advertised capabilities.
- `@zennotes/app-core/styles.css`: shared styles, also imported by `main`.
- `@zennotes/app-core/vite`: build integration for lazy WASM and drawing fonts.

The navigation export provides:

| API | Behavior |
| --- | --- |
| `openNote(path)` | Opens a vault-relative note or app-generated page path through normal saving and history. |
| `goBack()` / `goForward()` | Uses the existing note navigation history. |
| `goHome()` | Shows Home without closing tabs; starts normal saving for pending edits. |
| `useSelectedNotePath()` | React hook exposing the current path, or null. |
| `installHomeGuard()` | Keeps Home visible across background rescans; returns a cleanup function. |

Shells that offer Home while retaining open tabs install the guard once during
bootstrap, before mounting React or registering other store subscribers. A mount
effect runs too late to protect those subscribers from a rescan transition:

```tsx
// Install the host bridge and restore preferences first.
const { renderZenNotesApp } = await import('@zennotes/app-core/main')
const { installHomeGuard } = await import('@zennotes/app-core/navigation')
const disposeHomeGuard = installHomeGuard()
renderZenNotesApp(document.getElementById('root')!)
// Call disposeHomeGuard() when the host shell is torn down.
```

The iOS and Android shells now adopt these exports together with editor commands,
settings, workspace lifecycle, and attachment handling. Their installed package
checks reject the old private paths so only one application-state instance exists.

## Note actions

`requestMoveNote(host, path)` prompts for a logical `inbox` or `archive` destination,
including a subfolder such as `inbox/Projects`. The host resolves logical folders
through its vault settings. The prompt starts in the note's actual folder even
with custom folder names or primary notes at the vault root. Missing notes,
trashed notes, database record pages, hidden folders, traversal segments, and
database destinations are rejected. New ordinary subfolders may be created.

The host supplies `isCurrent()` against a vault token captured before the prompt.
Results are `completed`, `cancelled`, `stale`, or `unavailable`; operational errors
reject. A dispatched operation may finish in its original vault after its token
becomes stale, so callers must not automatically retry it. Hosts must await the
normal save/drain step before replacing the active vault or bridge.

Moves wait for note and comment saves, preserve edits made during the operation,
and reconcile tabs, comments, tasks, references, and manual order to the canonical
returned path. A move requested during a task write rejects so it can be retried
after that task settles; new task actions during the move show a wait message.
Desktop and Go roll back the note and comment file together on failure. If rollback
fails, the existing `FOLDER_STATE_UNCERTAIN` recovery guard retains buffers and
blocks writes until the vault is reloaded.

`requestRenameNote(host, path)` prompts for a title and preserves the note's
existing directory and file type. The host's returned path/title is authoritative,
including collision suffixes. Renames hold note, comment, database, and task writes
across the vault while inbound wikilinks are updated. Open buffers, including edits
made during the rename, receive the same link rewrite before saving again. Existing
heading-sync preferences apply. Core note writers, including tag rewrites, task
rollover, record pages, imports, and templates, cannot overlap the operation.
Vault switching drains those writers as well as pending editor saves. A failed save
retains dirty buffers and rejects;
the rename may already have completed, so check the current snapshot before retrying.

Host backlink rewriting remains best effort for closed notes. A successful rename
is not an atomic transaction covering every inbound file or another client's edits.
Desktop and Go roll back the renamed note and its comment sidecar together when
that relocation fails; failed rollback activates the recovery guard described above.

`requestArchiveNote`, `requestTrashNote`, `restoreNote`, and
`requestDeleteNotePermanently` use the same host token and result contract.
Archive confirms when indexed unfinished tasks exist. Trash and permanent deletion
always confirm; permanent deletion is available only for trashed ordinary notes.
Restore accepts archive or trash and uses the host's configured primary notes
location. These public actions exclude database record pages.

Archive and vault Trash save late edits at the returned path before closing the
editor. If that save fails, the destination stays open and dirty. Restore keeps
open tabs at the canonical returned path. Permanent deletion and temporary-session
system Trash lock every editor for the note after confirmation, save first, then
remove it. An active IME composition must finish before deletion. Failed saves or
host operations leave the note editable. The lock preserves existing Vim input and
read-only restrictions and covers the pinned reference editor and Preview writes.

Desktop and Go detach content and comment sidecars together before permanent
cleanup. A cleanup failure is logged and may retain files in private quarantine;
this is not secure erasure. System Trash keeps the original note filename for file
manager restoration, rolls back comment detachment if the OS refuses, and removes
the old comment sidecar after success. Restoring that file through the OS does not
restore its discussion. Temporary sessions without comments gain no private folder.

Single-note menus, file-task deletion, bulk Sidebar actions, Empty Trash, and
database row/page batches now use coordinated guards. Native storage adapters
implement matching note/comment rollback and have lifecycle fixture coverage.

## Shell snapshots and Browse ordering

`getShellSnapshot()` returns a frozen snapshot of the current vault metadata,
workspace mode/restoration, note index metadata, selected path/note, history
availability, and note sort preference. Each note contains only its path, title,
logical folder, folder-relative parent directory, and creation/update timestamps.
The snapshot does not expose note bodies, remote credentials, settings objects,
editor views, or store actions. Home and virtual pages have no selected note.

`subscribeShell((next, previous) => ...)` observes public changes and returns a
disposer. It does not send an initial notification; use `getShellSnapshot()` for
the initial value. `useShellSnapshot()` provides the same data to React. Repeated
reads and unrelated editor changes retain snapshot identity; selection changes
reuse the frozen note index. An index refresh may produce a new snapshot even if
its metadata is equal. Previously returned values never change.

`workspaceRestored` describes app-core's restoration step. Native note-index
readiness and keyboard/lifecycle state still belong to the host. Vault roots are
display/change metadata, not durable persistence keys or authorization for I/O.
In particular, iOS can expose a friendly remote-vault label there. Continue using
the host's stable vault token when storing pins or other native preferences.

```ts
import { getShellSnapshot, getBrowseNotes, getAdjacentNotePath } from '@zennotes/app-core/shell'
import { openNote } from '@zennotes/app-core/navigation'

const current = getShellSnapshot()
const rows = getBrowseNotes(current, 'Projects', pinnedPaths)
const next = current.selectedPath &&
  getAdjacentNotePath(current, current.selectedPath, 'next', pinnedPaths)
if (next) await openNote(next)
```

Browse helpers share the mobile drawer's ordering: pinned notes first, with the
chosen sort preserved within each group. `none` and `manual` retain the mobile
fallback to most recently edited; desktop manual ordering is unchanged. Names
use natural sorting, so Note 2 precedes Note 10. Ties retain note-index order.
Pins remain host-owned and must belong to the snapshot's vault.

`getBrowseNotes` takes a directory relative to the primary notes area, with an
empty string for its root. Custom system-folder mappings and notes stored at the
vault root are resolved by app-core. Only immediate primary-folder notes appear;
database records below any `.base` ancestor are excluded. Adjacent navigation uses
that same list, does not wrap, and returns null for missing/virtual paths or notes
outside the primary area. Both helpers only query the supplied snapshot. Read a
fresh snapshot when handling an action, then use the normal navigation API.

Database/note batches, tasks, settings, dialogs, commands, and workspace lifecycle
now have named public APIs. Both native shells use those exports; boundary checks
reject private imports and source-checkout aliases.

## Browse folders and databases

`getBrowseSnapshot()`, `subscribeBrowse()`, and `useBrowseSnapshot()` provide the
drawer's data without subscribing to editor selection or cursor changes. This
snapshot reuses the shell's frozen note metadata and adds frozen primary-folder
and database rows, the note sort order, vault display/change metadata, and enabled
daily/weekly/monthly directory settings. Disabled date directories are null.
Directory settings remain unchanged, including any patterns; this API does not
expand date patterns or check whether their folders exist.

```tsx
import { getBrowseDirectory, useBrowseSnapshot } from '@zennotes/app-core/browse'
import { openNote } from '@zennotes/app-core/navigation'

const snapshot = useBrowseSnapshot()
const rows = getBrowseDirectory(snapshot, directory, {
  notes: pinnedNotePaths,
  folders: pinnedFolderDirectories
})
// A folder row's directory becomes the next local drawer location.
// Note and database row paths are navigation targets:
await openNote(rows.databases[0].path)
```

The directory argument and folder pins are relative to the primary notes area.
The empty string means its root. Results contain separate `folders`, `databases`,
and `notes` arrays. Folders sort by title with pinned folders first; databases
sort by title without pin partitioning; notes use the shared Browse ordering.
Empty folders remain visible. Database internals under `.base` never become
ordinary drawer rows, including nested `pages/` directories.

Database paths are opaque app-generated navigation targets. Pass them to
`openNote`; do not construct their URLs or treat them as filesystem paths.
App-core handles custom system-folder mappings and notes stored at the vault
root. The snapshot exposes no mutable `FolderEntry` or `VaultSettings` objects.

Subscriptions behave like `subscribeShell`: no initial notification, only public
changes, coherent previous/next snapshots, and a returned disposer. Unchanged
folder and date data retain identity when notes change. Pins remain host-owned,
keyed by the native host's stable vault token.

### Folder and database actions

- `createBrowseDatabase(host, directory?)` creates and opens an untitled database. Omitting the directory uses the configured database location, including the active note's folder. Explicit `''` selects the primary root; any other explicit directory must be an existing ordinary Browse folder.
- `requestRenameBrowseDatabase(host, directory)` prompts for a database title and preserves host collision numbering. Names starting with a dot are rejected because vault scanners hide those directories. Case-only renames retain existing host behavior and can receive a numbered suffix on case-insensitive filesystems.
- `requestCreateBrowseFolder(host, directory = '')` prompts for a child folder.
- `requestRenameBrowseFolder(host, directory)` prompts for an ordinary folder's leaf name.
- `requestMoveBrowseDirectory(host, directory)` prompts for a new parent for an ordinary folder or an entire database, using the move-note prompt's `inbox[/path]` values. Only existing notes-area folders are offered, never the directory itself, its descendants, or a database. The leaf name, and so a database's `.base` suffix, is kept. A destination that already holds that name is blocked in the prompt, and the host still refuses to overwrite. The store carries open tabs (database tabs included), folder icons and colors, favorites, and manual order to the new path. Pins are host-owned: a host that pins folders re-keys them after `completed`.
- `requestDeleteBrowseDirectory(host, directory)` confirms permanent deletion of an ordinary folder or an entire database, with the appropriate warning.

All directories are relative to the primary notes area. Root deletion, missing
rows, database internals, invalid names, and overlapping dialogs are rejected.
The actions return `completed`, `cancelled`, `stale`, or `unavailable`; host I/O
errors reject the promise and the caller must show the error. `stale` means the
context changed and further work stopped. An already dispatched operation may
have finished in the original vault, so do not automatically retry it.

`host.isCurrent()` must compare a token captured before opening the dialog with
the native host's current vault/session token. Invalidate that token synchronously
when a switch or teardown begins. Then drain current folder operations and pending
saves before changing the bridge's active vault. An operation already dispatched
must finish reconciling paths and persisting favorites in its original vault.
Renderer vault labels alone are insufficient. The public workspace transition
owns this drain, and hosts compare the captured workspace generation as well as
their native session token. Cancelled or failed switches do not revive old captures.

Folder operations coordinate pending note/database/comment saves, move open tabs,
manual order, references, and cached metadata to the host's canonical returned
path, and discard stale reads. Desktop and Go also move the parallel comment
subtree; a pre-existing destination comment subtree causes a rename to fail
before changing content. Delete quarantines content and comments together before
cleanup. Temporary desktop sessions with no comments delete directly without
creating ZenNotes metadata. Native menus, dismissal, and pins remain host-owned.

If a host reports `FOLDER_STATE_UNCERTAIN:` after a failed rollback, app-core keeps
buffers in memory and blocks further writes to that subtree. A vault switch's save
step also rejects. The host must show the error and recover/reload the vault before
continuing; do not automatically retry a partially completed filesystem operation.

Native `MobileVault` operations now implement equivalent comment-subtree rollback.
The host must keep its active vault fixed until database creation also finishes,
since HTTP creation spans multiple file operations.
Database renames use the same save and workspace reconciliation as folder renames.
Note lifecycle actions use the notes export described above. Future adapters must provide equivalent file/comment rollback before adoption.

## Batch lifecycle and native shell actions

`requestNoteBatch(host, paths, action)` confirms the selection once and applies
moves sequentially. The result distinguishes completed source paths from
unconfirmed paths. `NoteBatchError` retains both lists after an operational failure;
an unconfirmed item may already have moved before its final save failed. Refresh
and inspect the workspace before retrying. Previously completed moves stay complete.

`requestEmptyTrash(host)` saves and freezes the entire configured Trash subtree,
including database grids, before deleting its contents and comments. Cancellation
or failure releases editors without removing their buffers. Desktop and Go use
transactional relocation before cleanup; remapped Trash paths are supported.

Database row deletion materializes each exclusively owned linked page's latest
properties and body before committing the rows/schema. A save failure retains
recoverable rows. After the database commit, pages move sequentially through the
same note guard. A later move failure leaves remaining pages saved standalone and
reports partial completion. Shared or foreign page mappings are detached without
changing those files. The whole operation is drained before a vault switch.

Task snapshots are frozen copies. `moveTaskToColumn` takes the host's captured
vault identity and expected grouping, then uses desktop's existing queued writer;
its boolean reports whether the request was recognized, while write failures use
core's existing toast UI. `getTodayTasks` applies the same display filtering and
file order as core. Hosts retain widget limits, theme sampling, and native updates.

Workspace snapshots expose profile display metadata, never credentials or store
methods. Native vault tokens pass unchanged to the bridge. `flushWorkspace`
waits for pending file, row, task, database, and editor saves; unsaved buffers reject
instead of allowing a vault switch to discard them. Presentation options control
panel visibility without exposing the pane tree. `readPersistedHomeState` owns
interpretation of the persisted layout for mobile cold-start landing.

`getAppCommands` returns descriptions; `runAppCommand` resolves availability again
at invocation. Editor presentation exposes the active mode and note availability,
without exposing CodeMirror. Navigation also accepts an initial note mode and
follows wikilinks without taking editor focus. Tag-presence observation includes
live note tags and excludes Typst preambles.

Hosts may supply `ZenAppInfo.hostKind` as `desktop`, `browser`, `ios`, or `android`.
The legacy renderer `runtime` remains compatible with installed bridges. Use
capabilities for feature availability, not the reported OS or renderer family.

## Native editor host integration

Install host configuration after restoring preferences and before mounting React.
Typing attributes then exist before any editor receives its first focus. Installing
later also updates existing editors, without changing their note or selection.

```ts
import { installEditorHost, revealEditorCaret } from '@zennotes/app-core/editor'

const host = installEditorHost({
  nativeTyping: true,
  measureBottomInsets: ({ editor, scroll }) => ({
    // These geometry helpers and overlay elements belong to the native shell.
    layout: bottomOverlap(editor, selectionToolbarBounds()),
    scroll: bottomOverlap(scroll, keyboardToolbarBounds())
  })
})

// After keyboard resize, overlay mount/removal, or a toolbar size change:
host.refresh()
revealEditorCaret()
// On shell teardown, also cancel the host's observers/listeners/timers:
host.dispose()
```

`nativeTyping: true` enables sentence capitalization, autocorrect, spellchecking,
and writing suggestions through the editor's content attributes. The native
keyboard decides which features to provide. It does not install keyboard plugins
or change the host's spelling capabilities.

The measurement callback receives frozen copies of editor and scroll-viewport
bounds (`top`, `bottom`, `left`, `right`, `width`, `height`) in CSS pixels. It receives
no DOM element or CodeMirror object. Read host geometry there; do not mutate layout
or call configuration APIs from the callback.

- `layout` reserves physical space below the scroller, keeping native selection
  handles above an overlay. Calculate it from the stable `editor` bounds.
- `scroll` adds clearance inside the remaining scroll viewport. Calculate it from
  `scroll` bounds to avoid counting an area already reserved by `layout` twice.

Core remeasures after changing layout clearance and on editor geometry changes.
Hosts call `refresh()` when their overlays change independently. Insets are
clamped to the available height; invalid values and failed measurements clear the
affected clearance. No configuration means the existing editor behavior remains.

`revealEditorCaret()` returns whether a reveal was scheduled for a focused, active
note editor. It waits for measurement, uses the current caret in that note, and
never takes focus. Pending work is discarded if the note, vault, pane, focus, or
registration changes, or the editor is destroyed. Native keyboard timing and
delayed retries remain host-owned; cancel those timers during teardown.

The newest registration owns configuration for all mounted and future note
editors. Older handles become no-ops. Disposing the current handle removes its
typing attributes and insets, returning to the underlying editor configuration;
it does not restore an older registration.

## Editor commands

Call `runEditorCommand(command)` from the host toolbar. It resolves the actual
active note editor immediately and returns the underlying command's handled
boolean. It returns `false` for an unavailable or transitioning editor, an unknown
command, or an unhandled operation such as Undo with no history. Formatting and
history commands restore editor focus even when there is nothing to change.

| Commands | Behavior |
| --- | --- |
| `toggle-bold`, `toggle-italic`, `toggle-strikethrough`, `toggle-highlight`, `toggle-inline-code` | Wrap or unwrap every selection using the existing editor rules. |
| `set-bullet-list`, `set-task-list` | Convert the selected lines, or start a list on an empty line while retaining indentation. |
| `cycle-heading` | Choose the next heading level from the main selection's first line (1, 2, 3, then paragraph) and apply it to the selected nonblank lines. |
| `insert-link` | Wrap every selection as a Markdown link and place its caret in the URL. |
| `insert-wikilink`, `insert-tag` | Replace the main selection with `[[]]` or `#` and position a single caret for typing. |
| `indent`, `outdent`, `undo`, `redo` | Use the editor's existing settings and history. |
| `open-search`, `close-search` | Open and focus Find, or close it through the normal search command. |

Search owns its focus: opening Find leaves its field focused, and closing it
returns focus to the editor only when the search panel held focus. Search also
works in a read-only note; commands that change text are rejected there. The
commands do not require editor focus, so toolbar buttons can receive it first.
Hosts should scope formatting controls to their editing UI.

`hasEditorSelection()` returns whether any text range is selected in the active
registered editor. It returns `false` when no matching note editor is available.
For mobile swipe/gesture suppression, combine this with a noncollapsed DOM
selection check. Preview text uses DOM selection and must still suppress gestures.

```ts
import { runEditorCommand, hasEditorSelection } from '@zennotes/app-core/editor'

runEditorCommand('toggle-bold')
// In Android's back-button cascade:
if (runEditorCommand('close-search')) return
// In a gesture guard shared by Edit and Preview:
const selection = window.getSelection()
const hasSelection = Boolean(selection && !selection.isCollapsed) || hasEditorSelection()
```

These commands are synchronous. For a file picker or clipboard read, use the
captured attachment target below rather than running a command after an await.

## Attachment integration

Capture a target before opening the file picker or starting an asynchronous
clipboard read. The host binds storage operations to one vault instance:

```ts
import { captureEditorInsertion, attachFiles } from '@zennotes/app-core/editor'

const vault = activeVault() // Host-owned storage implementation.
const target = captureEditorInsertion({
  isCurrent: () => activeVault() === vault,
  importFile: (notePath, file) => vault.importDroppedFile(notePath, file),
  importPastedImage: (input) => vault.importPastedImage(input)
})
if (target) {
  const files = await pickFiles() // Host-owned picker.
  const result = await attachFiles(target, files)
  // Show the appropriate status below; do not assume every import was inserted.
}
```

Load the editor entrypoint after restoring native preferences, like navigation.
Never resolve `activeVault()` inside the two import methods. `isCurrent` checks
the host independently because it may switch vaults before renderer state updates.
Hosts continue to validate vault-relative paths and own filesystem/network I/O.

The target captures the actual registered note editor, vault, document, and full
selection. It is opaque and single-use. Toolbar actions can capture the active
editor after a button takes focus; keyboard paste can pass `{ requireFocus: true }`
as the second capture argument. A captured target survives picker blur. Call
`cancelEditorInsertion(target)` on picker cancellation or host disposal.
Cancellation prevents further imports and insertion; it cannot undo or abort a
host save already in progress.

`attachFiles(target, files)` snapshots the list, imports serially, and inserts at
the captured cursor head, preserving selected text. For clipboard images, call
`insertPastedImage(target, input)` after reading the bytes. It replaces the captured
selection. Both use the editor's existing attachment spacing rules and validate
the context before and after each save. A partial batch never inserts partial
Markdown. Successful insertion focuses the captured editor; stale work does not
steal focus or delete saved files.

| Result status | Meaning |
| --- | --- |
| `inserted` | All confirmed assets were inserted through the normal editor update. |
| `empty` | The file list was empty; nothing was imported or inserted. |
| `stale` | Target unavailable, used, cancelled, or changed before any confirmed save. |
| `saved-only` | Context changed or was cancelled after a confirmed save. Assets remain in the captured vault; no Markdown was inserted. |
| `failed` | Import/insertion failed. `error` describes the failure; `assets` lists confirmed prior saves. |

Every result includes `assets`. If a host commits a file and then rejects, the
core cannot know that file was saved; it reports only successful return values.
Map `saved-only` and partial failures to visible recovery guidance in the host.

## Local package candidates

From the repository root:

```sh
npm run artifact:app-core
npm run test:app-core-package
npm run test:app-core-browser
```

The producer creates three immutable archives in ignored `dist/shared-packages`:
app-core, bridge-contract, and shared-domain. Install all three together. The core
candidate pins its companion packages exactly. Each archive has a SHA-256 and
source record. This is a local validation workflow; it does not publish packages.

The package contains emitted JavaScript, declarations, compiled CSS, local fonts,
and image assets. Internal imports are relative ESM imports or declared package
dependencies. TypeScript sources, workspace aliases, and sibling checkouts are not
needed by consumers. `main` imports the shared CSS automatically. The source
workspace still uses Tailwind; the installed CSS is already compiled using the
same preset owned by app-core.

React, ReactDOM, Zustand, CodeMirror state/view/language, and Lezer common/highlight
are peers in the candidate. Hosts must install compatible versions. Lezer's node
property identifiers must come from one shared instance across every parser and
highlighter. The consumer test deliberately uses a nested installation, checks
app-core's peer identity, and verifies one React/CodeMirror/Lezer copy and its
resolution from every declared consumer. Drawing libraries may own independent
Zustand stores. No dedupe aliases hide a second instance.

### Vite host setup

```ts
import { defineConfig } from 'vite'
import { zenNotesAssets } from '@zennotes/app-core/vite'

export default defineConfig({
  plugins: zenNotesAssets(),
  base: './'
})
```

The helper resolves the Oniguruma binary as a data URL, resolves Harper's exported
binary entry, and serves/copies Excalidraw fonts. Hosts using native spelling can
pass `{ harper: false }` to omit Harper; they must also advertise
`supportsHarper: false` through their bridge. `{ excalidraw: false }` omits drawing
fonts for hosts that do not support drawings.

Before opening a drawing, set `window.EXCALIDRAW_ASSET_PATH` to the deployment's
`excalidraw-assets/` URL, including any mount prefix. Install the host bridge and
restore preferences before dynamically importing `main`, `navigation`, `editor`,
`shell`, or `browse`, because each can evaluate application state. The build-only `vite` export does not load
the renderer. Avoid manual chunk rules that pull lazy features into bootstrap.

### Validation and remaining work

The package test copies the current HTTP bridge into a separate temporary app,
rewrites its domain imports to public exports, verifies candidate hashes, installs
with a nested dependency tree, typechecks, and builds with Vite. It records the
consumer path in `dist/shared-packages/app-core-consumer.json` and keeps that
directory for inspection. The browser test uses the built app, a temporary vault,
and a temporary Chrome profile. Set `ZEN_CHROME_PATH` when Chrome is not installed
at the platform default. Both tests leave production vaults and settings alone.

Both native repositories now install exact immutable package archives without a
source clone. Clean builds, isolated Android/iOS runtime fixtures, and cold starts
pass. Live iCloud and account-backed Cloud sync remain staging-account acceptance
gates; browser fixtures alone do not prove those integrations.


## Native vault relocation and workspace identity

`getWorkspaceSnapshot().generation` changes whenever a transition begins, including
one that is cancelled or fails. Capture it with the host's opaque vault identity
before asynchronous UI work, and require both to match before dispatching writes.
Never infer identity from the visible vault name or a remote profile's display root.

`relocateLocalVault({ move, rollback, reopen })` reserves the workspace before save
draining and keeps it reserved through native filesystem work and reopen. Native
callbacks own platform I/O and must undo their own partial failure before rejecting.
`reopen` contains opaque source/destination tokens and is omitted for a closed vault.
If destination reopen fails, core rolls back, reopens the original token, and
restores the flushed state. If rollback/recovery also fails, core deactivates the
vault, preserves cached drafts, and reports the recovery failure. Editing must not
resume against an uncertain location. Both native bridges use this operation for
vault rename/move; callers must not implement separate flush/move/reopen sequences.
