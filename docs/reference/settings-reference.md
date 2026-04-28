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

### Daily notes

Daily notes are optional.

Related settings include:

- enable/disable daily notes
- daily notes directory

When enabled, ZenNotes can open or create today's note using an ISO-style date title.

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
