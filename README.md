# ZenNotes

ZenNotes is a keyboard-first desktop notes app built on Electron,
React, TypeScript, and CodeMirror 6. It keeps notes as ordinary local
Markdown files, adds a Vim-friendly editing and navigation model, and
ships a first-party MCP server so tools like Claude Code, Claude
Desktop, and Codex can work directly against the same vault.

The goal is not "another markdown renderer." The goal is a local-first
notes environment that still feels fast and intentional when you live in
it all day.

Download the latest build from [GitHub Releases](https://github.com/ZenNotes/zennotes/releases/latest).

## What ZenNotes is for

- writing and organizing plain-file Markdown notes without a database
- moving quickly with keyboard-first navigation and Vim motions
- working across edit, split, and preview modes without losing context
- keeping task management, tags, search, archive, and trash inside the
  same vault
- rendering math and diagrams directly from Markdown
- letting MCP-capable coding / note-taking tools read and write the
  vault safely through a bundled server

## Core product ideas

### Plain files first

Every note lives on disk as a normal `.md` file inside a chosen vault.
ZenNotes does not invent a hidden store for note content. The app adds
views, metadata extraction, search, and rendering on top of the files
you already own.

### Keyboard-first by default

The app assumes you want fast navigation, not pointer-heavy chrome.
There is first-class Vim mode, leader-key flows, remappable shortcuts,
buffer switching, pane motion, command palette access, local ex prompts,
and which-key style hint overlays.

### Preview is part of the workflow

ZenNotes supports:

- edit mode
- preview mode
- split mode
- pinned reference panes
- detached note windows

That makes it useful both as a writing tool and as a reading /
researching tool.

### AI tooling should work with the real vault

ZenNotes includes a standalone MCP server entry and a settings UI that
can install the server into supported clients. The intent is simple:
your assistant should operate on the same notes you do, using normal
Markdown files and safe vault operations.

## Feature overview

### Notes, folders, and lifecycle

Each vault is organized into four top-level folders:

- `inbox/` for active work
- `quick/` for fast capture
- `archive/` for cold storage
- `trash/` for recoverable deletion

ZenNotes can create, rename, duplicate, move, archive, unarchive, trash,
restore, and reveal notes and folders. The app also watches the vault on
disk, so external edits are reflected back into the UI.

Attachments are stored under a vault-local attachments directory
(`attachements/` in the current implementation, with legacy `_assets/`
support still recognized).

### Editor and preview

The editor stack is CodeMirror 6 with a Markdown-oriented workflow:

- live preview behavior in the editor
- heading folding
- outline extraction and jumps
- word wrap controls
- configurable line numbers
- syntax highlighting for fenced code blocks
- local asset embedding
- inline PDF support

Preview mode renders:

- GitHub-flavored Markdown
- KaTeX math
- Mermaid
- TikZ
- JSXGraph
- function-plot
- callouts
- footnotes
- wiki links and backlinks

Expanded diagram viewing is built in for diagram-heavy notes.

### Search, tags, tasks, and built-in views

ZenNotes includes:

- note search by title / path
- vault-wide text search
- tags view
- tasks view
- archive view
- trash view
- quick notes view
- built-in help view

Vault text search can use the built-in engine, `ripgrep`, or `fzf`,
with auto-detection and optional custom binary paths exposed in
Settings.

Task parsing is markdown-native: checkboxes stay as normal `- [ ]` /
`- [x]` lines in the note body and are surfaced into the global Tasks
view.

### Themes, fonts, and app customization

The app exposes a substantial settings surface:

- multiple theme families and light / dark / auto modes
- independent interface, text, and monospace font selection
- editor font size and line-height controls
- preview and editor width controls
- dark-sidebar option
- content alignment
- keymap overrides
- Vim toggles and leader hint behavior
- search backend selection

### MCP integration

ZenNotes ships a dedicated MCP server and installation flows for:

- Claude Code
- Claude Desktop
- Codex CLI

The app can:

- detect whether the ZenNotes MCP entry is installed
- install or uninstall it for each supported client
- show the exact runtime used to launch the server
- edit the server's default note-shaping instructions from Settings

The MCP server exposes vault operations like reading notes, creating
notes, moving notes, appending to notes, searching text, listing notes,
listing assets, toggling tasks, and related filesystem-safe actions.

## Download

The fastest way to get the app is the latest GitHub release:

- [Latest release](https://github.com/ZenNotes/zennotes/releases/latest)

Release assets are built per platform in GitHub Actions and uploaded to
the matching release automatically:

- macOS: `.dmg` and `.zip`
- Windows: installer `.exe` and `.zip`
- Linux: `.AppImage` and `.deb`

If the repository is private, GitHub access to the release assets follows
the repository's normal permissions.

## Vault model

ZenNotes expects a chosen vault root and will ensure the basic folder
layout exists on first open. The app also seeds a welcome note the first
time a vault is initialized.

High-level behavior:

- only `inbox`, `quick`, and `archive` are treated as searchable note
  folders
- `trash` is recoverable deletion, not part of normal search
- tags and wiki links are extracted from note bodies
- attachment presence is inferred from local links in Markdown
- vault changes are watched and pushed into the renderer over IPC

## Development

### Requirements

- Node.js 22+ recommended
- npm
- macOS, Windows, or Linux for Electron development

### Install

```bash
npm install
```

### Run the app in development

```bash
npm run dev
```

This starts the Electron main process, preload bundle, and renderer via
`electron-vite`.

### Typecheck

```bash
npm run typecheck
```

### Build

```bash
npm run build
```

This produces:

- `out/main` for the Electron main process
- `out/preload` for the preload bridge
- `out/renderer` for the renderer bundle

The standalone MCP server is built as `out/main/mcp.js`.

## Packaging

Available package scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the app in development mode |
| `npm run build` | Build all Electron bundles |
| `npm run start` | Preview the built app |
| `npm run typecheck` | Run node + web TypeScript checks |
| `npm run pack` | Build and create unpacked app output |
| `npm run dist:mac` | Build macOS distributables |
| `npm run dist:win` | Build Windows distributables |
| `npm run dist:linux` | Build Linux distributables |

Icon packaging notes live in [build/README.md](build/README.md).

## Repository layout

```text
src/
  main/       Electron main process, vault I/O, watchers, TikZ, MCP install management
  preload/    Context bridge / IPC surface exposed to the renderer
  renderer/   React app, editor UI, preview UI, settings, panes, styles
  mcp/        Standalone MCP server entry, tool definitions, default instructions
  shared/     Shared IPC contracts and cross-process types
build/        Packaging resources (icons, installer assets)
out/          Built output generated by electron-vite
```

## Architecture notes

### Main process

`src/main/` is responsible for:

- window lifecycle
- persisted app config
- vault selection and layout bootstrapping
- filesystem operations for notes, folders, archive, trash, and assets
- vault watching
- task scanning
- vault-wide text search
- TikZ rendering
- MCP client install / uninstall flows

### Preload

`src/preload/index.ts` exposes the app's typed bridge through
`window.zen`, including vault operations, search, task scanning, window
controls, TikZ rendering, clipboard helpers, and MCP settings actions.

### Renderer

`src/renderer/` holds the desktop UI:

- sidebar, note list, editor, preview, floating note windows
- command palette, help view, tags/tasks/archive/trash views
- pane layout and tab state
- settings UI
- theme system
- diagram rendering for Mermaid, TikZ, JSXGraph, and function-plot

State is managed with Zustand.

### MCP server

`src/mcp/index.ts` is a standalone stdio server built on
`@modelcontextprotocol/sdk`. It exposes vault operations to compatible
clients and ships opinionated note-writing instructions tailored to
ZenNotes' markdown features and vault model.

Those instructions can be overridden by the user and are persisted as a
plain Markdown file under the app's user-data directory.

## Why the MCP story matters here

ZenNotes is intentionally opinionated about how assistants should write
notes:

- use the vault as shared storage, not as a scratchpad
- prefer surgical edits over blind overwrites
- lean on KaTeX and diagram fences instead of ASCII approximations
- connect notes through wiki links
- preserve user-owned content and frontmatter

That behavior is encoded in the bundled MCP instructions and surfaced in
Settings so users can tune it without forking the app.

## Current status

ZenNotes is still an actively changing codebase. The app already has a
meaningful feature surface, but the product and interaction model are
still being refined quickly.

If you are contributing, expect UI polish, keyboard flows, diagram
rendering, and MCP ergonomics to keep evolving.

## License

MIT
