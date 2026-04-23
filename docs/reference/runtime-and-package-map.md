# Runtime and Package Map

This document describes the repo layout and what each major app/package is responsible for.

## Top-level layout

```text
apps/
  desktop/
  web/
  server/
packages/
  app-core/
  bridge-contract/
  shared-domain/
  shared-ui/
tooling/
  scripts/
docs/
```

## apps/desktop

`apps/desktop` is the Electron shell.

Responsibilities:

- BrowserWindow lifecycle
- preload bridge
- native menus
- updater
- desktop packaging
- local vault access
- remote workspace client in the main process
- desktop-only integrations such as floating windows and local file reveal

Important scripts:

- `npm run dev:desktop`
- `npm run build --workspace @zennotes/desktop`
- `npm run dist:mac`
- `npm run dist:win`
- `npm run dist:linux`

## apps/web

`apps/web` is the browser frontend shell.

Responsibilities:

- Vite development/build pipeline
- browser bootstrapping
- HTTP bridge that implements the same `window.zen` API shape for the shared UI

Important point:

The web app does not reimplement the product UI. It mounts the shared UI from `packages/app-core`.

## apps/server

`apps/server` is the Go backend for self-hosted and future hosted modes.

Responsibilities:

- HTTP API
- WebSocket watch stream
- vault access on the server host
- directory browsing and vault selection
- auth/session flow
- security headers and CORS/origin checks
- serving the embedded web bundle

Important scripts:

- `npm run dev:server`
- `npm run build --workspace @zennotes/server`

## packages/app-core

`packages/app-core` is the source of truth for user-facing product behavior.

Responsibilities:

- React app shell
- Zustand store
- editor panes
- preview
- command palette
- sidebar
- settings modal
- tags/tasks/archive/trash views
- quick notes
- folder icons and sidebar customization
- shared app behavior across desktop and web

If a feature should behave the same on desktop and browser, it should usually live here.

## packages/bridge-contract

`packages/bridge-contract` defines the runtime contract between the shared UI and the host.

It describes:

- app info and capabilities
- vault operations
- remote workspace operations
- session operations
- update state
- watchers and events

The UI depends on this interface instead of depending directly on Electron or raw fetch calls.

## packages/shared-domain

`packages/shared-domain` contains shared types and models that are not renderer-specific.

Examples:

- tasks
- MCP client state
- shared domain types used across runtimes

## packages/shared-ui

`packages/shared-ui` is intentionally small today.

It exists as the place for UI primitives that are reusable without dragging in the whole app.

## tooling/scripts

`tooling/scripts` contains repo-level helpers used by workspaces and CI.

Examples:

- server build helpers
- web stack orchestration
- dist syncing/preparation scripts
- Windows-safe Go/Node wrapper scripts

## Runtime model

ZenNotes effectively runs in three product modes.

### Desktop

- UI from `app-core`
- host bridge from Electron preload
- local filesystem or remote server backend

### Self-hosted web

- UI from `app-core`
- host bridge from the HTTP implementation
- backend from the Go server

### Future hosted mode

- same web/server stack
- additional auth/storage/deployment layers

## What should go where?

As a rule:

- shared user-facing behavior -> `packages/app-core`
- runtime contract -> `packages/bridge-contract`
- desktop-only shell concerns -> `apps/desktop`
- browser-only bootstrapping -> `apps/web`
- server-side vault/network/security behavior -> `apps/server`

## Related docs

- [Monorepo Architecture](../monorepo-architecture.md)
- [Web Architecture](../web-architecture.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)
