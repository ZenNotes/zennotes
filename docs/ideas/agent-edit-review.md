# Reviewing agent edits

Status: v1 built on the 2.68.0 branch (2026-10-12), not released. Requested by Kevin
(Discord, 2026-10-09); related to #448 (per-note history), which this does not solve.
The desktop side is in this repo; the Go `zn` side is on ZenNotes/tui branch
`agent-edit-review` and ships with a zn release.

## The problem

People drive their vaults with AI assistants through the MCP server (`zn mcp`):
Claude Code, Codex, Cursor and others call `replace_in_note`, `append_to_note`,
`write_note` and friends. When an assistant edits a note, ZenNotes shows the new
text and nothing else. To see what changed, people leave the app: Kevin keeps his
vault in Git and reads the diff in his terminal. There is no way to take back one
change and keep the rest, and no way to tell the assistant "not like this" next to
the change itself.

The app cannot tell an agent's edit apart on its own: `zn mcp` is a separate
process that writes the file directly, so the app sees an outside change, the same
as a `git pull` or another editor.

## What v1 does

1. **The MCP server records** what a note said before an assistant changed it.
2. **The app shows** that a note has changes to review: a banner on the note, and
   one palette entry per note waiting ("Review Agent Changes: <note>").
3. **The review happens in the note**: each change inline, the removed lines above
   the new ones, with Accept and Reject on each, and Accept all / Reject all / Done.
4. **Comments** on a change are ordinary comments, so the assistant reads them with
   `list_comments`, which it already can.
5. When every change is decided, the record is deleted.

Decided with Adib (2026-10-12):

- Records live **in the vault**, beside comments, so they travel with Git and Cloud.
- Recording is **on by default**, with a setting to turn it off. Nothing happens
  unless an assistant the user connected edits a note; ZenNotes runs no AI itself.
- The review is **inline in the note**, not a dialog.
- The change bands run the full width of the editor (Adib, after the first look).

## The record

One file per note: `.zennotes/agent-edits/<note path>.json`, next to
`.zennotes/comments/<note path>.comments.json`.

```json
{
  "version": 1,
  "before": "the note before the first recorded edit",
  "after": "the note right after the latest edit, or null while an edit is in flight",
  "edits": [{ "at": 1791820000000, "agent": "Claude Code", "tool": "replace_in_note" }],
  "outside": [{ "from": "the note after one edit", "to": "the note the next edit started from" }]
}
```

### Two writers, one reader

Two MCP engines write records: the TypeScript server in `apps/desktop/src/mcp`
and the Go `zn` (ZenNotes/tui `internal/mcp`), which is what a managed install
runs. So the writing side is kept to string comparisons and JSON, and every merge
happens in the app (`packages/shared-domain/src/agent-edits.ts`):

- **Writing** (`beginAgentEdit` / `finishAgentEdit`, mirrored in Go
  `internal/vault/agent_edits.go`): read the note, write the record with
  `after: null` BEFORE the edit (the workflow journal's rule: a process that dies
  mid-edit leaves a record that shows more than the assistant did, never less),
  make the edit, then store the note as `after`. If the note no longer matches
  `after` when the next edit starts, someone else changed it: the writer appends
  `{from: after, to: note}` to `outside` and never merges. Past 20 outside changes
  it starts a fresh record. An edit that changes nothing puts the record back as it
  was. Edits to one note take turns (a per-note lock), since MCP calls run in
  parallel.
- **Reading** (`agentEditBaseline`): fold each outside change into `before` with
  the three-way merge Cloud conflicts use (`mergeCloudSyncText`), then merge the
  note as it is now against `after`. The result is the note without the
  assistant's changes but with everyone else's, so the review shows only the
  assistant's work. Where the user rewrote lines the assistant changed, the user's
  version wins: those lines have been dealt with, and an all-rewritten record is
  deleted instead of shown empty.

Recorded tools: `write_note`, `append_to_note`, `prepend_to_note`,
`insert_at_line`, `replace_in_note`, `edit_section`, `toggle_task` and `update_task` (the note
comes from the task id).
Not recorded in v1: `create_note` (a new note has nothing to compare against),
moves, renames, trash and deletes (Trash keeps those), and vaults on a
self-hosted server (their MCP writes go through the Go server, which needs its own
change). Notes over 1 MB are not recorded.

The assistant's name comes from the MCP `initialize` request's client name, mapped
the way comment authors already are (`claude-code` is "Claude Code", `codex-cli` is
"Codex").

### Where records go

- **Moves.** A record moves with its note wherever ZenNotes moves notes:
  `relocateNote` and folder renames (desktop and MCP), the Go vault's rename, move
  and archive. A record waiting at a destination with no note belongs to nobody
  and is discarded, like a stale creation date.
- **Deletes.** Deleting a note, emptying Trash, deleting a folder, or sending a
  note to the system trash removes its record.
- **Creation.** Creating, importing or duplicating a note at a path clears a stale
  record there.
- **Sync.** Cloud sync carries `.zennotes/agent-edits/*.json` (temp files stay
  local), so a review can happen on another computer.
- **Cleanup.** An emptied `agent-edits` folder is removed: a vault whose changes
  were all reviewed carries no trace.

### A fix this needed

The MCP edit paths used to write a file and only then check it was a note:
`write_note` on `.zennotes/...` created the file before failing. An assistant could
have planted its own record (or comments, or creation dates). Both engines now
refuse anything outside the note folders before a byte lands.

## The review

- **Banner**: "Claude Code changed this note 4 minutes ago" with **Review changes**.
  From Preview, the button switches the pane to Edit first.
- **Review mode** (`packages/app-core/src/lib/cm-agent-review.ts`, imported on
  demand so `@codemirror/merge` stays off the boot path; the renderer chunk rule
  in `electron.vite.config.ts` excludes it from `vendor-editor` for that reason):
  - CodeMirror's `unifiedMergeView` against the comparison text above.
  - Accept moves a change into the comparison text; Reject puts the old text back
    as an ordinary edit, saved before the record is updated.
  - The note is read-only, and Live Preview is off (a diff is about the source).
  - A bar on top: "Reviewing Claude Code's changes: 2 left", **Accept all**,
    **Reject all**, **Done**.
- **Progress**: each decision saves the record (`reviewedAgentEdit`), so a half-done
  review survives a restart. The last decision deletes it.
- **Keys** (all rebindable in the keymap settings):

| Action | Without Vim | Vim |
| --- | --- | --- |
| Next / previous change | Mod+Alt+↓ / ↑ | `]c` / `[c` |
| Accept change | Mod+Shift+Enter | `dp` (diff put) |
| Reject change | Mod+Shift+Backspace | `do` (diff obtain) |
| Leave, keeping what is undecided | Escape, Done | Escape (when no command is half-typed), Done |

`dp` and `do` cannot be Vim mappings: codemirror-vim runs a full match as soon as
it has one, so `d` always starts the delete operator first. Review mode reads
normal-mode keys ahead of Vim instead, holds a key that continues a sequence, and
lets every other key through. The note is read-only, so a held `d` costs nothing,
and Escape after it cancels the `d` rather than leaving the review.

- **Comments**: select text in a change and comment as usual; the assistant reads
  it with `list_comments`. To say why a change was rejected, comment before
  rejecting it.

## Settings

Settings → MCP → **Review agent edits** (on by default), stored in the portable
config file as `[mcp] review_agent_edits`, which both MCP engines read without the
app running. Turning it off stops recording; records already written stay
reviewable.

## Verified

Built app over CDP, with a real MCP client named `claude-code` driving the real MCP
server process: the record, the banner, the review with both changes inline, Reject
by button, Accept by keyboard, the record deleted at the end; and the same in Vim
mode with `do`, `]c` and `dp` (scripts in the session scratchpad, `agent-review/e2e.mjs`).

## Later

- New notes created by an assistant ("Keep" or "Move to Trash").
- Vaults on a self-hosted server: recording in the Go server's write path.
- Phones: reviewing synced records needs the phone bridges to read and write them.
- Telling the assistant what was rejected (an MCP tool reading recent decisions).
- An agent edit landing while the note has unsaved typing is still overwritten by
  the app's save of the buffer, as before; the record is then cleaned up, so the
  assistant's edit is lost silently. Worth a conflict prompt.
- Per-note history (#448): a bounded, always-on history of every change, with the
  same review view.
