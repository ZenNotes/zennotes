# Get Started on Desktop

This tutorial is for someone opening ZenNotes for the first time on desktop and wanting to understand the basic workflow without setting up a server.

By the end, you will have:

- opened or created a vault
- created notes and folders
- used the sidebar, tabs, and editor
- understood the system folders
- changed a few important settings

## Before you start

You need:

- the desktop app installed from a release
- or the repo checked out locally with dependencies installed

If you are running from source:

```bash
npm ci
npm run dev:desktop
```

## 1. Open a vault

When ZenNotes starts on desktop, it expects a vault directory.

A vault is just a normal folder on disk that contains your Markdown notes and the small amount of metadata ZenNotes needs for UI behavior.

Choose a folder:

- use an empty folder if you want to start fresh
- use an existing Markdown notes folder if you want to bring your current notes into ZenNotes

ZenNotes reads and writes normal `.md` files directly in that folder.

## 2. Learn the default layout

By default, ZenNotes starts with a lifecycle-oriented layout:

- `inbox/` for your main notes
- `quick/` for quick capture
- `archive/` for archived notes
- `trash/` for soft-deleted notes

If you prefer an Obsidian-style flat vault, you can later switch the primary notes area from `Inbox` to `Vault root`.

That setting changes how ZenNotes surfaces the vault in the sidebar. It does not turn your notes into a database or move them into a proprietary store.

## 3. Create your first note

Use any of these:

- the `+` button in the sidebar
- the command palette
- the new-note shortcuts you have configured

ZenNotes opens the new note in a tab immediately. Notes are normal Markdown files, so typing into the editor is writing plain text to disk.

Important behavior:

- there is no hidden note database
- the note content on screen is the file content on disk
- if the file changes outside ZenNotes, the watcher can update the UI

## 4. Use the sidebar

The sidebar is the main navigation surface.

Top area:

- `Search`
- `Tasks`
- `Quick Notes`
- `Archive`
- `Trash`

Main tree area:

- your primary note folders and notes
- optional tag section
- folder icons, custom labels, and collapse state

Recent versions of ZenNotes also allow:

- moving Archive and Trash to the top utility area
- hiding sidebar arrows
- customizing folder icons
- naming Quick Notes with a prefix

## 5. Understand tabs and panes

ZenNotes is designed around keeping context.

You can:

- keep multiple note tabs open
- split the current note into another pane
- open pinned reference panes
- switch between edit, split, and preview modes

Desktop builds also support:

- floating note windows
- native menu integration
- app updates through the desktop updater

## 6. Learn the note modes

The editor stack has three main ways to work:

- `Edit`: write directly in the CodeMirror editor
- `Split`: see editor and rendered Markdown together
- `Preview`: see rendered Markdown only

ZenNotes is keyboard-first, so the app assumes that preview is part of the main writing workflow rather than a secondary export view.

## 7. Try Quick Notes

Quick Notes are fast-capture notes that live in the `quick/` area by default.

They are useful for:

- temporary notes
- scratch ideas
- things you want to rename or move later

You can control how Quick Notes are named from Settings:

- whether they use a full timestamp or only the date
- an optional prefix

If the prefix is blank, ZenNotes can create bare timestamp-style filenames instead of forcing `Quick Note ...`.

## 8. Try search, tags, and tasks

ZenNotes includes several built-in views:

- `Search`
- `Tasks`
- `Archive`
- `Trash`
- `Quick Notes`
- `Tags`

Tasks are extracted from Markdown task list syntax.

Tags come from hashtags in note content and can appear in the sidebar and related views.

Text search can use:

- the built-in search backend
- `ripgrep`
- `fzf`

depending on your settings and what is available on your machine.

## 9. Adjust the vault model if needed

Open `Settings -> Vault`.

The most important vault setting is:

- `Primary notes location`

Options:

- `Inbox`
- `Vault root`

Choose `Inbox` if you want ZenNotes' original lifecycle-first structure.

Choose `Vault root` if you want the app to surface top-level vault files and folders directly, which is often better for existing Obsidian-style vaults.

You can also configure:

- system folder labels
- daily notes behavior
- daily notes directory
- folder icons

## 10. Understand what ZenNotes stores

ZenNotes stores notes in your vault as plain Markdown files.

It also stores a small amount of app/vault metadata under `.zennotes/`.

That metadata is for things like:

- vault behavior
- layout preferences that belong to the vault
- server-side indexes or runtime state where applicable

The important boundary is:

- note content is yours, on disk, as files
- ZenNotes behavior is layered on top of those files

## 11. Where to go next

Now that you know the desktop basics, read one of these:

- [Settings Reference](../reference/settings-reference.md)
- [Vault and Folder Model](../reference/vault-and-folder-model.md)
- [Connect Desktop to a Remote ZenNotes Server](../how-to/connect-desktop-to-remote-server.md)
- [Self-Host with Docker](../how-to/self-host-with-docker.md)
