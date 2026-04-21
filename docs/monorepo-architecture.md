# ZenNotes Monorepo Architecture

ZenNotes now uses a single monorepo so the desktop app, self-hosted web app, and future hosted deployment can share one product core instead of drifting across separate repositories.

## Layout

```text
apps/
  desktop/   Electron shell, preload, updater, packaging
  web/       Vite/PWA shell and HTTP bridge
  server/    Go server for self-hosted and hosted deployments
packages/
  app-core/        Shared React application and renderer logic
  bridge-contract/ Typed runtime contract between UI and host
  shared-domain/   Shared types and note/task/view models
  shared-ui/       Reusable UI primitives (small today, can grow later)
tooling/
  scripts/         Shared tooling hooks and migration scripts
```

## Source of Truth

`packages/app-core` is the source of truth for user-facing features.

Platform-specific code should stay in the app shells:

- `apps/desktop` for Electron-only concerns such as windows, menus, updater, packaging
- `apps/web` for browser/PWA bootstrapping
- `apps/server` for HTTP/WebSocket serving, vault access, and deployment/runtime config

## Bridge Contract

The shared UI depends on the typed bridge in `packages/bridge-contract`.

That contract covers:

- note and folder CRUD
- search, tasks, archive, trash, tags
- asset operations
- watcher/subscription events
- update/runtime metadata
- capability flags for unsupported platform features

Each runtime installs its own implementation:

- Electron preload installs the desktop bridge
- The web client installs the HTTP bridge backed by the Go server

## Deployment Modes

ZenNotes should ship as:

- desktop: `apps/desktop`
- self-hosted: `apps/web` + `apps/server`
- hosted: the same `apps/web` + `apps/server` stack, with auth/storage additions

Hosted mode is a deployment mode of the same web stack, not a separate frontend.
