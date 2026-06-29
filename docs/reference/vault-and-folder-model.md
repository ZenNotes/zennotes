# Vault and Folder Model

This document describes how ZenNotes models a vault on disk.

## Core rule

A ZenNotes vault is a normal directory on a filesystem.

Notes are plain Markdown files.

ZenNotes does not store note content in a proprietary database.

## System areas

ZenNotes has four built-in lifecycle areas:

- `inbox`
- `quick`
- `archive`
- `trash`

These areas still exist conceptually even when the UI is customized.

Examples:

- `Quick Notes` can have a custom label
- `Archive` and `Trash` can be shown higher in the sidebar
- folder icons can change

The underlying lifecycle semantics remain the same.

## Primary notes location

The most important vault-mode setting is:

- `Primary notes location`

### Inbox mode

In `Inbox` mode:

- ZenNotes treats `inbox/` as the main notes area
- this keeps the original ZenNotes lifecycle structure

### Vault root mode

In `Vault root` mode:

- ZenNotes surfaces top-level Markdown files and folders directly
- this is better for flatter vaults, especially imported Obsidian vaults
- the original `inbox` lifecycle id still exists internally, but the UI can present the vault root as the primary notes area

Important nuance:

Switching to `Vault root` should not make your notes appear to disappear. If a real top-level `inbox/` exists, current behavior should still surface it appropriately instead of making the tree feel empty or misleading.

When primary notes live at the vault root, folders nested under `inbox/` can be moved up to the vault root from sidebar actions. That keeps imported or demo content from being trapped under `inbox/` when the vault is configured for a root-first layout.

## Quick Notes

Quick Notes are capture notes that live in the `quick` area.

Naming is configurable through settings:

- timestamp or date-only titles
- optional prefix

Quick Notes are still ordinary Markdown files.

## Archive and trash

Archive and trash are lifecycle views backed by file operations.

Archive:

- moves a note out of active circulation without deleting it

Trash:

- soft-deletes the note
- allows restore
- can be emptied

## Daily and weekly notes

Daily and weekly notes are optional.

When enabled:

- ZenNotes creates one note per day
- ZenNotes creates one note per ISO week
- the default daily title format is an ISO date
- the default weekly title format is an ISO week title
- notes live in dedicated date-note directories under the primary notes area
- the directory and title can use date patterns such as `yyyy/MM-MMM` and `yyyy-MM-dd-EEE`
- weekly title patterns can use ISO week tokens such as `yyyy-'W'ww`
- localized month and weekday names can use `system`, `en-US`, `pt-BR`, or another BCP 47 locale

Supported pattern tokens are `yyyy`, `yy`, `M`, `MM`, `MMM`, `MMMM`, `d`, `dd`, `EEE`, `EEEE`, `w`, and `ww`. Weekly notes render date tokens from the ISO week's Monday, and `yyyy` is the ISO week-year for weekly patterns. Literal words can be wrapped in single quotes, for example `'Daily Notes'/yyyy/MM-MMM`.

## Assets and local files

ZenNotes now behaves more like an Obsidian-compatible file-based vault:

- loose files anywhere in the vault can be treated as vault files/assets
- image and file embeds are supported
- images, SVGs, video, audio, PDFs, and generic files can open in ZenNotes tabs or the reference pane
- Obsidian-style `![[image.png]]` resolution works better than a strict note-relative-only model

New referenced files default to the vault root rather than forcing a special attachments folder.

Legacy attachment locations such as `attachements/` and `_assets/` are still recognized for compatibility.

## Selection and bulk actions

The sidebar supports selecting multiple notes and folders.

Supported selection gestures:

- Cmd-click on macOS, or Ctrl-click on Windows/Linux, toggles one visible item
- Shift-click selects a visible range from the anchor item
- dragging a selected item drags the selected group

Bulk actions can open selected notes in tabs, move notes, archive/unarchive, move notes to Trash, restore trashed notes, permanently delete trashed notes, delete folders, copy paths, or move compatible folders by drag/drop.

## Metadata

ZenNotes stores small amounts of vault metadata under `.zennotes/`.

This metadata is for app behavior around the vault, not for replacing the notes themselves.

The vault content model stays:

- files and folders on disk
- Markdown notes
- normal local assets

## Watching and sync behavior

ZenNotes watches the vault for changes.

That includes:

- Markdown note changes
- file asset changes
- vault settings changes that belong to the shared vault state

This matters when:

- desktop and browser are pointed at the same mounted vault
- files change outside the app
- the server is serving a host-mounted vault through Docker

## Obsidian-compatible expectations

ZenNotes is not trying to be a byte-for-byte clone of Obsidian. But it now supports important expectations users bring from file-based Markdown workflows:

- flat vault roots
- loose files in the vault
- Obsidian-style image/file embed behavior
- imported vaults that are not structured around `inbox/`
- media files that stay inside the app when opened from the vault tree, note list, or preview

## Related docs

- [Settings Reference](./settings-reference.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)
