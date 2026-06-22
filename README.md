# ZenNotes

<p align="center">
  <img src="apps/desktop/build/icon.png" alt="ZenNotes app icon" width="160">
</p>

ZenNotes is a keyboard-first Markdown notes app with a shared product core and multiple runtimes:

- a desktop app built with Electron
- a self-hosted web app backed by a Go server
- a future hosted deployment mode built on the same web/server stack

ZenNotes keeps your notes as ordinary Markdown files on disk. It adds Vim-friendly editing, split and preview workflows, tasks, tags, archive/trash, diagrams, search, daily notes, CSV databases (Notion-style Table + Board views over plain `.csv` files), and MCP integration on top of the files you already own.
On macOS, the first-party `zen` CLI also powers launcher workflows such as the Raycast extension.

Grab the latest build from [GitHub Releases](https://github.com/ZenNotes/zennotes/releases/latest) — see [Install](#install) below.  
Website: [zennotes.org](https://zennotes.org)
Support development: [GitHub Sponsors](https://github.com/sponsors/adibhanna)

Detailed in-repo documentation lives under [docs/README.md](docs/README.md).

## Install

All desktop installers are attached to each [GitHub Release](https://github.com/ZenNotes/zennotes/releases/latest). The app auto-updates, so you only download once. (Replace `<version>` with the current release, e.g. `2.2.0`.)

### macOS

**Homebrew (recommended):**

```sh
brew install --cask zennotes/tap/zennotes
```

Or download the `.dmg` for your chip, open it, and drag **ZenNotes** to Applications. Builds are signed and notarized.

- Apple Silicon: `ZenNotes-<version>-mac-arm64.dmg`
- Intel: `ZenNotes-<version>-mac-x64.dmg`

### Windows

Download and run `ZenNotes-<version>-win-x64.exe`.

### Linux

Pick whatever suits your distro:

- **Arch / CachyOS / Manjaro — AUR (recommended):**
  ```sh
  yay -S zennotes-bin     # or: paru -S zennotes-bin
  ```
  Installs cleanly without `libfuse2`.
- **Arch — native package:**
  ```sh
  sudo pacman -U ZenNotes-<version>-linux-x86_64.pacman
  ```
- **Debian / Ubuntu:**
  ```sh
  sudo apt install ./ZenNotes-<version>-linux-amd64.deb
  ```
- **Nix / NixOS:**
  Read [packaging/nix/README.md](packaging/nix/README.md) for installation instructions
- **Any distro — AppImage:**
  ```sh
  chmod +x ZenNotes-<version>-linux-x86_64.AppImage
  ./ZenNotes-<version>-linux-x86_64.AppImage
  ```
  AppImages need **FUSE 2**. On distros that ship only FUSE 3 (Arch, CachyOS, Fedora), either install it (`sudo pacman -S fuse2`, `sudo dnf install fuse`) or run without FUSE:
  ```sh
  ./ZenNotes-<version>-linux-x86_64.AppImage --appimage-extract-and-run
  ```
  (Or just use the AUR / `.pacman` / `.deb` package, which sidestep this entirely.)

### `zen` CLI

The desktop app installs a `zen` command-line companion from **Settings → CLI** — list, read, search, capture, edit, archive/trash notes, plus tasks, folders, and MCP. On macOS it can also install the Raycast extension locally.

### Self-hosted web app

ZenNotes also runs as a self-hosted web app backed by a Go server. See [Local development](#local-development) to run the web client and server.

## What ZenNotes is for

- writing and organizing plain-file Markdown notes without a database
- moving quickly with keyboard-first navigation and Vim motions
- working across edit, split, and preview modes without losing context
- keeping tasks, tags, search, archive, trash, and quick capture inside the same vault
- rendering math and diagrams directly from Markdown
- exposing the vault to MCP-capable tools through a first-party server
- searching and opening notes from terminal scripts or Raycast on macOS
- self-hosting the app on your own machine or home server

## Product modes

ZenNotes now ships from one monorepo with one shared app core.

- `desktop`: Electron shell, native menus, updater, floating windows, desktop packaging
- `self-hosted`: browser frontend plus Go server, suitable for home servers and LAN use
- `hosted`: planned as the same web/server stack with auth and multi-user storage added later

The source of truth for user-facing features is the shared UI in `packages/app-core`.

## Core ideas

### Plain files first

Every note is a normal `.md` file inside a chosen vault. ZenNotes does not store note content in a hidden database.

### Keyboard-first by default

ZenNotes assumes you want to move fast:

- first-class Vim mode
- leader-key flows
- command palette
- pane and tab motion
- local ex commands
- built-in help

### Preview is part of the workflow

ZenNotes supports:

- edit mode
- preview mode
- split mode
- pinned reference panes
- detached note windows on desktop

### Shared vault, shared tooling

ZenNotes includes a first-party MCP server and desktop install flows for compatible clients, so tools can work on the same vault you do instead of a copy.

## Feature overview

### Notes, folders, and lifecycle

ZenNotes can:

- create, rename, duplicate, move, archive, unarchive, trash, restore, and reveal notes and folders
- watch the vault for external changes
- reopen your workspace layout with tabs and panes

System folders still exist, but the vault model is more flexible now:

- `quick`, `archive`, and `trash` remain built-in lifecycle areas
- the main notes area can be either:
  - `inbox/`
  - the vault root directly, for Obsidian-style flat vaults

The built-in folder labels are also customizable in the UI without changing the underlying internal ids.

### Daily and weekly notes

Daily and weekly notes are optional and can be enabled from Settings.

- when enabled, ZenNotes can open or create today's daily note and this week's weekly note automatically
- the default daily title is a simple ISO date like `2026-04-21`
- the default weekly title is an ISO week title like `2026-W24`
- date notes live in dedicated directories under your primary notes area
- the default directories are `Daily Notes` and `Weekly Notes`
- the directory and title can use date patterns such as `yyyy/MM-MMM` and `yyyy-MM-dd-EEE`
- weekly title patterns can use ISO week tokens such as `yyyy-'W'ww`
- localized month and weekday names can follow `system`, `en-US`, `pt-BR`, or another BCP 47 locale

Supported date note pattern tokens:

- `yyyy` / `yy` for `2026` / `26`
- `M` / `MM` / `MMM` / `MMMM` for `6` / `06` / `Jun` / `June`
- `d` / `dd` for `9` / `09`
- `EEE` / `EEEE` for `Tue` / `Tuesday`
- `w` / `ww` for ISO week numbers like `24`
- single-quoted literals, such as `'Daily Notes'/yyyy/MM-MMM`

Weekly notes render date tokens from the ISO week's Monday, and `yyyy` is the ISO week-year for weekly patterns.

### Editor and preview

The editor stack is CodeMirror 6 with a Markdown-oriented workflow:

- live preview behavior in the editor
- heading folding
- outline extraction and jumps
- configurable line numbers
- configurable line-height and typography controls
- syntax highlighting for fenced code blocks
- wiki links, callouts, tables, footnotes, and local embeds
- Vim block cursor and keyboard navigation

Preview and split mode support:

- GitHub-flavored Markdown
- KaTeX math
- Mermaid
- TikZ
- JSXGraph
- function-plot
- callouts
- footnotes
- wiki links and backlinks

### Search, tasks, tags, and built-in views

ZenNotes includes:

- note search by title and path
- vault-wide text search
- tags view
- tasks view
- archive view
- trash view
- quick notes view
- built-in help/manual

Vault text search can use the built-in engine, `ripgrep`, or `fzf`, with auto-detection and optional custom binary paths.

The desktop app also ships a `zen` command-line companion for list, read, search, capture, edit, archive/trash, task, folder, and MCP workflows. On macOS, ZenNotes can install its Raycast extension locally from Settings -> CLI, avoiding the Raycast Store review path. The integration uses the CLI plus `zennotes://` deep links to search notes, open them in the main app, open them in floating windows, archive/unarchive, move notes to Trash, reveal files in Finder, and copy note paths or wikilinks.

### Obsidian-friendly vault support

ZenNotes now works better with existing Obsidian-style vaults.

- primary notes can live at the vault root instead of requiring `inbox/`
- loose files anywhere in the vault are surfaced as files/assets
- embedded files like `![[image.png]]` resolve more like Obsidian
- new referenced files default to the vault root instead of a required attachments folder
- legacy `attachements/` and `_assets/` folders are still recognized

This means imported vaults with top-level notes, folders, and loose images/files behave much more naturally.

### Files and local assets

ZenNotes supports local files in notes and in the sidebar/list views.

- local images and files can appear directly in the vault tree
- images, SVGs, videos, audio, PDFs, and other media open inside ZenNotes tabs or reference panes instead of being handed off to the OS by default
- desktop context menus include reveal-in-file-manager actions
- desktop uses Finder on macOS and the platform file manager on Windows/Linux
- watcher updates now include non-Markdown file changes, so deleting files externally updates the UI without a manual refresh

Sidebar multi-select supports platform modifiers: use Cmd/Ctrl-click to toggle individual notes or folders, Shift-click to select a visible range, then use the context menu to apply actions such as open in tabs, move, archive, trash, restore, delete folders, copy paths, or drag the selected group to a folder.

### Themes, fonts, and customization

The settings surface includes:

- theme families and light/dark/auto modes
- interface, text, and monospace font selection
- editor font size and line-height controls
- preview and editor width controls
- content alignment
- keymap overrides
- Vim toggles and leader hint behavior
- search backend selection
- vault layout settings
- daily notes settings
- system-folder display labels

## Desktop vs web

Both runtimes share the same core app, but they do not expose identical platform features.

Desktop-only features include:

- native menus
- app updater
- floating note windows
- `zen` CLI install/uninstall flow
- local Raycast extension installation on macOS
- MCP install/uninstall flows for supported clients
- reveal in Finder / platform file manager
- packaging and signed releases

Web/self-hosted mode includes:

- the same shared note UI and workflows
- a Go backend for vault access and file watching
- a server-side vault picker/browser
- browser access on a LAN or home server

## Monorepo layout

ZenNotes now uses a single monorepo.

```text
apps/
  desktop/   Electron shell, preload, updater, packaging
  web/       Vite/PWA shell and HTTP bridge
  server/    Go server for self-hosted and hosted deployments
packages/
  app-core/        Shared React application and renderer logic
  bridge-contract/ Typed runtime contract between UI and host
  shared-domain/   Shared types and note/task/view models
  shared-ui/       Reusable UI primitives
tooling/
  scripts/         Shared tooling hooks and migration scripts
docs/
```

Read [docs/monorepo-architecture.md](docs/monorepo-architecture.md) for the architectural boundary between the shared app core and the platform-specific shells.

## Quick start

### Requirements

- Node.js 22+
- npm
- Go 1.22+ for the server build path
- Docker optional, for self-hosting

### Install dependencies

```bash
npm ci
```

## Local development

### Desktop app

```bash
npm run dev:desktop
```

or:

```bash
make desktop
```

### Web client

```bash
npm run dev:web
```

or:

```bash
make web-dev
```

### Go server

```bash
npm run dev:server
```

or:

```bash
make server-dev
```

### Web + server together

```bash
npm run dev:web-stack
```

or:

```bash
make web-stack
```

Important dev note:

- the browser app and the Go server are separate processes in dev mode
- frontend-only changes usually need only the web dev server
- backend changes need the Go server restarted
- if the web client is newer than the running server, ZenNotes now shows a clearer error instead of raw 404 noise for newer API flows like the vault picker

## Root scripts

From the repository root:

| Script                  | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `npm run dev`           | Alias for `npm run dev:desktop`                 |
| `npm run dev:desktop`   | Run the Electron desktop app in development     |
| `npm run dev:web`       | Run the Vite web client                         |
| `npm run dev:server`    | Run the Go server                               |
| `npm run dev:web-stack` | Run web + server development together           |
| `npm run start`         | Start the built desktop app                     |
| `npm run typecheck`     | Run monorepo typechecks                         |
| `npm run test`          | Run monorepo tests                              |
| `npm run test:run`      | Run the full test suite                         |
| `npm run build`         | Build the monorepo and then build the Go server |
| `npm run build:prod`    | Typecheck + test + build                        |
| `npm run pack`          | Desktop packaged output                         |
| `npm run dist:mac`      | Build macOS desktop distributables              |
| `npm run dist:win`      | Build Windows desktop distributables            |
| `npm run dist:linux`    | Build Linux desktop distributables              |

## Makefile commands

The root `Makefile` provides a simpler interface:

| Command              | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `make install`       | Install workspace dependencies                          |
| `make desktop`       | Run the Electron app in dev mode                        |
| `make web-dev`       | Run the web client                                      |
| `make server-dev`    | Run the Go server                                       |
| `make web-stack`     | Run web + server together                               |
| `make build`         | Build the full monorepo                                 |
| `make desktop-build` | Build the Electron app                                  |
| `make web-build`     | Build `apps/web`                                        |
| `make server-build`  | Build `apps/server` with the latest embedded web bundle |
| `make up`            | Build and start the self-hosted Docker stack            |
| `make down`          | Stop the Docker stack                                   |
| `make restart`       | Restart the Docker stack                                |
| `make logs`          | Follow Docker logs                                      |
| `make status`        | Show Docker status                                      |
| `make open`          | Open the self-hosted app in a browser                   |
| `make rebuild`       | Force a full Docker rebuild                             |
| `make nuke`          | Remove local Docker image/build output                  |
| `make clean`         | Remove local web/server build output                    |

Run `make help` to print the same summary.

## Self-hosting with Docker

### Start the self-hosted app

```bash
make up
```

Then open:

- [http://localhost:7878](http://localhost:7878)

### Default Docker mounts

When you start Docker with `make up`, ZenNotes mounts:

- host `./vault` -> container `./vault`'s absolute host path
- host `./data` -> container `/data`

In practice, that means the container sees the vault at the same absolute path you chose on the host, instead of rewriting it to `/workspace`.

The server stores its config under `/data/server.json` by default.

### Default Docker security behavior

The self-hosted Docker flow is now secure by default:

- the published port binds to `127.0.0.1` unless you override it
- ZenNotes generates a bootstrap auth token on first `make up` and stores it in `./data/auth-token`
- the browser version signs in with that token once, then uses an `HttpOnly` session cookie
- the container runs as your local UID/GID by default, with a read-only root filesystem, `no-new-privileges`, and dropped Linux capabilities

Useful env vars:

- `ALLOW_INSECURE_NOAUTH=1`: only use this if you intentionally want to disable auth
- `ZENNOTES_ALLOWED_ORIGINS`: explicit browser origin allowlist
- `ZENNOTES_BROWSE_ROOTS`: restricts which server-side directories the picker can browse

Recommended deployment model:

- keep ZenNotes behind a reverse proxy, VPN, or private network gate
- do not expose the raw Go server directly to the public internet unless you understand the tradeoffs

### Choosing a different host folder

You can mount a different host content root:

```bash
CONTENT_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs" make up
```

That works for paths with spaces too.

Useful variables:

- `CONTENT_ROOT`: host folder used as the live vault root
- `DATA`: host directory used for persisted server config
- `PORT`: published host port
- `IMAGE`: Docker image tag
- `ALLOW_INSECURE_NOAUTH`: disable the default auth requirement

### Docker browse model

Important limitation:

- the Docker container can only browse folders that are mounted into it
- it cannot browse your entire host filesystem
- by default, the picker is scoped to the mounted content root unless you explicitly relax it

So if you want to browse an Obsidian vault, iCloud Drive, or another directory from the web picker, that directory needs to be mounted into the container first.

### Relevant container env vars

The current compose/runtime flow supports:

- `ZENNOTES_BIND`
- `ZENNOTES_CONFIG_PATH`
- `ZENNOTES_DEFAULT_VAULT_PATH`
- `ZENNOTES_BROWSE_ROOTS`
- `ZENNOTES_VAULT_PATH`

Behavior notes:

- `ZENNOTES_VAULT_PATH` hard-locks the server to a specific vault path
- `ZENNOTES_DEFAULT_VAULT_PATH` sets the starting vault when no saved selection exists
- `ZENNOTES_BROWSE_ROOTS` limits what the web picker can browse
- `ZENNOTES_ALLOWED_ORIGINS` restricts which browser origins can connect
- `ZENNOTES_ALLOW_UNSCOPED_BROWSE=1` removes browse-root enforcement
- `ZENNOTES_ALLOW_INSECURE_NOAUTH=1` disables the default auth guardrail

## Web vault picker

The self-hosted web build now includes a server-backed vault chooser.

- it browses folders on the server, not the browser machine
- it only browses configured allowed roots by default
- it starts from sensible locations instead of requiring blind path typing
- it supports a simpler folder-picker flow for choosing the active vault
- on macOS-hosted servers, common shortcuts like iCloud Drive are supported when available

If you start the server with `ZENNOTES_VAULT_PATH`, manual vault switching is intentionally disabled.

If auth is enabled, the browser asks for the bootstrap token once and then switches to a secure session cookie. ZenNotes no longer relies on auth tokens in browser URLs or local storage.

## MCP integration

ZenNotes ships a dedicated MCP server and desktop install flows for:

- Claude Code
- Claude Desktop
- Codex

The desktop app can:

- detect whether the ZenNotes MCP entry is installed
- install or uninstall it for each supported client
- show the exact runtime used to launch the server
- edit the server's default instructions from Settings

The MCP server exposes vault operations such as:

- reading notes
- creating notes
- moving notes
- appending to notes
- listing notes
- searching vault text
- listing files/assets
- toggling tasks

## Building and packaging desktop releases

### Build everything

```bash
npm run build:prod
```

### Desktop package scripts

```bash
npm run pack
npm run dist:mac
npm run dist:win
npm run dist:linux
```

### Signed macOS releases

Public macOS releases are wired for hardened runtime signing and notarization.

The GitHub Actions release workflow expects:

- `MACOS_CERTIFICATE_P12`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Optional Windows signing can be supplied with:

- `WINDOWS_CERTIFICATE_P12`
- `WINDOWS_CERTIFICATE_PASSWORD`

Tagged releases fail the macOS release job if the required Apple signing or notarization secrets are missing. That prevents accidentally shipping an unsigned public mac build.

## Current status

ZenNotes is actively evolving. The desktop app is the more mature runtime today, while the self-hosted web/server path is being brought into parity through the shared monorepo core.

That means:

- many features are shared already
- some platform-specific behavior still lives in the shell layers
- the README will keep evolving as desktop, web, and self-hosted flows converge further

## License

MIT
