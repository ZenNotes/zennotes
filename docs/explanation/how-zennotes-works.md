# How ZenNotes Works

This document explains the mental model behind ZenNotes: what the app is, how the desktop and browser versions relate to each other, and why the codebase is structured the way it is.

## The short version

ZenNotes is a plain-file Markdown app with a shared UI core and multiple runtime shells.

That means:

- the product is one app
- the notes are normal files on disk
- the desktop app and browser app are two runtimes of the same core product

ZenNotes is not:

- a database-first note system
- a separate desktop product and separate web product that just happen to look similar
- a hosted-first app with a desktop wrapper

## The core idea: plain files first

The most important design choice in ZenNotes is that the vault lives as files and folders on disk.

Everything else is built around that decision.

Benefits:

- your notes stay portable
- your files are inspectable outside the app
- tools such as Git, sync systems, backup tools, and MCP clients can work directly against the same content

Tradeoff:

- the app has to solve product features on top of a filesystem instead of assuming total control through a hidden database

That is why ZenNotes spends so much effort on:

- path resolution
- file watching
- vault layout interpretation
- soft-delete/archive semantics
- external-change handling

## One product, multiple runtimes

ZenNotes used to be easiest to think of as a desktop app.

The current architecture is stricter:

- `packages/app-core` is the shared product
- `apps/desktop` is the Electron shell
- `apps/web` is the browser shell
- `apps/server` is the server runtime for browser and remote use

This is the real difference between:

- "keeping two apps in sync"
- and "having one app with multiple runtimes"

ZenNotes is intentionally moving toward the second model.

## Why the bridge exists

The shared UI cannot talk directly to Electron APIs and cannot assume the browser has the same capabilities either.

So the app talks through a typed bridge contract.

That bridge answers questions like:

- how do I list notes?
- how do I read or write a note?
- how do I get vault settings?
- can this runtime support native menus?
- can this runtime connect to a remote workspace?

Desktop installs one implementation of the bridge.

Web installs another.

From the shared UI's point of view, the product behavior stays the same.

## Why the server exists

The browser version needs a backend whenever it is working against a real server-hosted vault.

That server is responsible for:

- vault I/O
- watching files
- listing assets
- selecting the active vault
- auth/session handling
- security headers and origin checks
- serving the web bundle in self-hosted mode

The server is written in Go because that fits the self-hosted deployment goal:

- simple binary
- fast startup
- good cross-platform behavior
- lightweight runtime for home-server deployment

## Why Docker matters

For browser/self-hosted use, the main supported path is Docker.

But Docker is not supposed to become the owner of your notes.

The intended model is:

- host machine owns the vault folder
- Docker mounts that vault into the ZenNotes server container
- ZenNotes serves and edits the host files

This is why copied server paths, remote vault selection, and the mounted host path behavior matter so much. The product goal is "serve my files", not "trap my notes inside a container."

## Why remote workspaces exist in desktop

Desktop used to be only:

- local app
- local vault

That is not enough once users want:

- a home server
- a self-hosted browser version
- the same vault available from multiple machines

So ZenNotes desktop now supports:

- local workspaces
- remote workspaces backed by a ZenNotes server

This is intentionally implemented as a workspace backend switch, not as a separate "remote app."

That preserves:

- tabs and panes
- native desktop behavior
- floating windows
- shared UI behavior

while letting the note data come from a server.

## Why the vault model is configurable

The original ZenNotes layout centered the `inbox/` lifecycle.

That works well for a certain style of note-taking, but it makes imported file-based vaults feel foreign.

So ZenNotes now allows:

- `Inbox` as the main notes location
- `Vault root` as the main notes location

This is not just cosmetic. It changes how the app interprets the note tree, quick capture, daily notes placement, and how natural imported vaults feel.

This is also why Obsidian compatibility work matters:

- top-level folders
- loose files
- image embeds
- vault-root behavior

## Why the app has archive, trash, and quick notes

These are not just folders. They are product concepts.

ZenNotes is opinionated about note lifecycle:

- inbox for active notes
- quick for fast capture
- archive for notes you want to keep but not actively work in
- trash for recoverable deletion

At the same time, newer versions let you present those concepts more flexibly:

- move archive/trash higher in the sidebar
- rename labels
- customize icons
- flatten the primary note area

That combination is important. ZenNotes wants opinionated workflow support without forcing a rigid visual presentation forever.

## Why settings sync the way they do

Some settings belong to the app/user.

Some belong to the vault.

That distinction matters because:

- desktop and browser can point at the same vault
- local and remote modes need to behave coherently
- self-hosted use means multiple clients may touch the same vault state

So ZenNotes now watches more than just note files. It also reacts to vault-level settings changes that affect how the shared workspace should behave.

## Why security became a bigger topic

A pure local desktop app can get away with assumptions that a remotely accessible server cannot.

Once ZenNotes started supporting:

- browser access
- self-hosted remote access
- desktop connecting to a remote server

the security model had to tighten:

- browser login sessions
- server auth token boundaries
- browse-root enforcement
- origin checks
- safer Docker defaults
- keeping secrets out of synced vault state

This is not extra polish. It is required for the product to make sense as a remotely deployed notes system.

## Why the docs are split into tutorials, how-to, reference, and explanation

ZenNotes now has enough surface area that a single README is not enough.

People approach the product with different needs:

- "show me how to start"
- "show me how to self-host it"
- "tell me exactly what this setting does"
- "explain the architecture"

That is why the docs are intentionally split by purpose rather than being one giant mixed document.

## Related docs

- [Get Started on Desktop](../tutorials/get-started-desktop.md)
- [Self-Host with Docker](../how-to/self-host-with-docker.md)
- [Connect Desktop to a Remote ZenNotes Server](../how-to/connect-desktop-to-remote-server.md)
- [Settings Reference](../reference/settings-reference.md)
- [Vault and Folder Model](../reference/vault-and-folder-model.md)
