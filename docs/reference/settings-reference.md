# Settings Reference

This document describes the main settings groups and what they control.

It is not a change log. It is a reference for the current settings model.

## Appearance

Appearance controls the app chrome and high-level presentation.

Current options include:

- theme family and mode
- sidebar presentation controls
- window/chrome visual behavior
- `Sidebar arrows`

### Sidebar arrows

Controls whether disclosure arrows are shown in the sidebar tree.

When arrows are hidden:

- folders and files should stay aligned
- folders remain expandable and collapsible
- the glyph is removed, not the behavior

## Editor

Editor settings control the writing workflow.

Current options include:

- editor behavior
- search backend preference
- Quick Note naming behavior

### Vault text search backend

ZenNotes can use:

- built-in search
- `ripgrep`
- `fzf`

The runtime backend depends on what is available on the system and the configured tool paths.

### Date-titled Quick Notes

When enabled:

- new Quick Notes use `YYYY-MM-DD`

When disabled:

- new Quick Notes use a timestamp-style title

### Quick Note prefix

Used when generating new Quick Note names.

Examples:

- prefix `Quick Note` plus timestamp mode -> `Quick Note 2026-04-22 1658`
- blank prefix plus timestamp mode -> `2026-04-22 1658`
- prefix `Capture` plus date mode -> `Capture 2026-04-22`

## Keymap

Keymap settings let you inspect and override bindings.

The app includes grouped key definitions for:

- global actions
- editing/navigation actions
- note and pane actions
- zoom actions

You can:

- inspect current bindings
- override individual bindings
- reset them

ZenNotes also exposes Vim-oriented flows in the shared UI.

Important current examples:

- `Export note as PDF` defaults to `Shift+Mod+E`
- `Zoom in` defaults to `Mod+=`
- `Zoom out` defaults to `Mod+-`
- `Reset zoom` defaults to `Mod+0`

These shortcuts are editable from Settings instead of being hard-coded renderer-only behavior.

### Picker navigation

Command-driven pickers use the shared keymap model and also support Vim-style list movement.

In the command palette, search palette, buffer picker, outline picker, and vault text search picker, you can move through results with:

- `ArrowDown`
- `ArrowUp`
- `Ctrl+N`
- `Ctrl+P`

That behavior works in both desktop and browser builds while the picker input is focused.

## Typography

Typography settings control readability and editor density.

Current options include:

- interface font
- text font
- monospace font
- editor and preview text size
- line height
- editor width

These settings affect the feel of both editing and reading.

## Vault

Vault settings describe how ZenNotes interprets and presents the current vault.

### Vault location

In local mode:

- shows the local vault directory

In remote mode:

- shows `Remote workspace`
- shows the connected server URL
- offers remote-specific actions like `Change Remote Vault...`

### Saved remote workspaces

Desktop builds can store multiple remote workspace profiles.

Each saved remote can include:

- an optional label
- a server URL
- an optional vault path
- credential presence

You can:

- create a new remote
- connect to a saved remote
- edit it
- remove it

### Primary notes location

Controls where ZenNotes treats the main notes area as living.

Options:

- `Inbox`
- `Vault root`

`Inbox` keeps the original lifecycle-first ZenNotes layout.

`Vault root` surfaces top-level vault notes and folders directly, which is better for flat vaults and many imported Obsidian setups.

### Quick Notes label

Lets you rename the user-facing label for the Quick Notes section without changing its underlying system meaning.

### Folder icons

Folders can have custom sidebar icons.

The current icon system supports:

- built-in system icons
- a growing set of semantic icons
- theme-compatible rendering through `currentColor`

Folder icons are intended to adapt to themes instead of carrying fixed hard-coded colors.

### PDF export

ZenNotes can export the current note as a PDF.

Behavior depends on runtime:

- desktop saves a PDF directly through the native save flow
- browser opens a print-friendly rendered note view so you can use the browser's `Save as PDF`

PDF export uses the rendered Markdown view rather than raw Markdown source, and the export surface uses a white paper-style background.

## CLI and launcher integrations

Desktop builds expose a `CLI` settings page for installing the `zen` command-line companion.

### Install Command-Line Tool

The installer creates a symlink named `zen` that points to the wrapper bundled with the app.
Packaged desktop releases include the CLI runtime dependencies, so `zen`, `zen mcp`, and launcher integrations use the app bundle instead of depending on the development build directory.

Install behavior:

- prefers a user-writable directory that is already on PATH
- can create `~/.local/bin` or `~/bin` and show a PATH snippet when needed
- falls back to `/usr/local/bin` with an admin prompt only when no user-writable target is available
- refuses to overwrite an unmanaged `zen` binary

The status panel shows:

- whether `zen` is installed
- the current or planned install path
- whether the install is managed by ZenNotes
- any PATH command you need to run after install

### Quick reference

The CLI can list, read, create, capture, search, append, prepend, rename, move, archive, trash, restore, delete, duplicate, manage folders, inspect tags, list/toggle tasks, and start the MCP server.

For note paths with spaces, quote the path or use `--path`.

Examples:

```bash
zen list --tag idea
zen read "inbox/Project.md"
zen read --path "hellointerview/system design.md"
zen search "deadline" --json
zen mcp
```

### Raycast

On macOS, the Raycast integration is installed from the `CLI` settings page.
It requires:

- Raycast installed on the Mac
- the ZenNotes CLI installed as `zen`
- Node.js 22.14 or newer
- npm 7 or newer

ZenNotes does not require the Raycast Store version. The app copies its bundled
Raycast extension source into app data, installs dependencies, builds the local
extension, and imports it into Raycast.

The Raycast command calls `zen list --json`, then opens selected notes through
`zennotes://open` or `zennotes://open-window`.

Raycast actions include:

- open in ZenNotes
- open in a floating window
- archive or unarchive
- move to Trash
- reveal in Finder
- copy note path
- copy wikilink

The settings panel shows whether Raycast, Node, and npm were found, whether the
local extension is installed, whether it matches the current ZenNotes version,
and the local extension path. When ZenNotes ships a newer bundled extension, the
same button changes from `Reinstall` to `Update`.

Read [Use ZenNotes with Raycast on macOS](../how-to/use-raycast.md) for setup and troubleshooting.

## Remote/session behavior

Relevant settings-like runtime behaviors:

- browser self-hosted login now uses a session cookie instead of a URL token
- desktop remote connections are handled by the main process
- desktop saved remote profiles should not expose raw credentials to the renderer

## Notes on persistence

Some settings are app-scoped.

Some are vault-scoped.

The practical rule is:

- visual/editor preferences usually belong to the app/user
- vault behavior belongs to the vault

Kanban column title overrides are app-scoped display preferences. They are edited directly from the Tasks Kanban column headers, not from the Settings modal. For the exact behavior, read the [Tasks Reference](./tasks-reference.md).

If you are trying to understand that boundary in more detail, read:

- [Vault and Folder Model](./vault-and-folder-model.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)
