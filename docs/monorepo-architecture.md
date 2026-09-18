# ZenNotes Monorepo Architecture

Desktop and web share one product core in this repository. iOS, Android, the TUI,
and Laravel Cloud have separate repositories. The Go self-hosted server currently
lives here and will move to `ZenNotes/znserver` after its build and release inputs
are independent. See [the ecosystem migration plan](specs/ecosystem-boundaries-and-repository-plan.md).

## Layout

```text
apps/
  desktop/   Electron shell, preload, updater, packaging
  web/       Vite/PWA shell and HTTP bridge
  server/    Go server for self-hosted deployments
  share-viewer/ Public read-only renderer packaged for Laravel
packages/
  app-core/        Shared React application and renderer logic
  bridge-contract/ Typed runtime contract between UI and host
  shared-domain/   Portable domain functions and compatibility type exports
  shared-ui/       Reserved workspace, currently an empty export
tooling/
  scripts/         Shared tooling hooks and migration scripts
```

## Source of Truth

`packages/app-core` is the source of truth for user-facing features.

Platform-specific code should stay in the app shells:

- `apps/desktop` for Electron-only concerns such as windows, menus, updater, packaging
- `apps/web` for browser/PWA bootstrapping
- [ZenNotes/znserver](https://github.com/ZenNotes/znserver) for HTTP/WebSocket serving, vault access, and deployment/runtime config

The Go server has its own repository. It develops and tests without frontend
assets; its distribution builds embed the browser artifact that this repository
publishes (`web-*` releases) and pin in its manifest. This repository's browser
harness, perf runs, and `dev:web-stack` use the release pinned in
`tooling/server-release.json`, an explicit `ZENNOTES_SERVER_BINARY`, or a
checkout in `ZENNOTES_SERVER_DIR`.

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
- The mobile repositories install their native adapters

### Dependency direction

`app-core` depends on `shared-domain` and `bridge-contract`. Domain functions
depend on contracts. Contracts depend only on their own source files and standard
browser types, never on domain implementations or Node globals.

The contract compiler uses `noResolve` and an empty `types` list to enforce this
closed source set. Existing domain type imports remain available through
compatibility re-exports. The portable preference key list has one definition in
the contract package and remains available from `shared-domain/app-config`.

See TypeScript's [noResolve](https://www.typescriptlang.org/tsconfig/noResolve.html)
and [types](https://www.typescriptlang.org/tsconfig/types.html) documentation.

## Deployment Modes

Runtime ownership is:

- desktop: `apps/desktop`
- self-hosted: `apps/web` + the Go server from ZenNotes/znserver
- Cloud: the separate private `ZenNotes/website` Laravel application owns
  accounts, billing, vault revisions, storage authorization, and publishing

Cloud browser editing is planned. It will share the editor source through a
browser adapter for Laravel; the existing Go HTTP bridge does not already provide
that integration.

The self-hosted browser can now be packed as a pinned archive with
`npm run artifact:web`. The Go-only `cmd/prepare-web` verifies its manifest and
assets before an `embed_web` build. A local extraction rehearsal builds with the
destination module name and no frontend source. Production publishing remains in
this repository until the remaining migration gates pass. See
[the rehearsal guide](server-extraction-rehearsal.md).

## Other repositories and release boundaries

| Repository | Owns | Current cross-repository dependency |
| --- | --- | --- |
| `ZenNotes/zennotesios` | iOS shell, iCloud/filesystem, native lifecycle and integrations | Exact vendored core/contract/domain archives, public exports, native lifecycle fixtures |
| `ZenNotes/zennotesandroid` | Android shell, storage access framework, native lifecycle and integrations | Exact vendored core/contract/domain archives, public exports, native lifecycle fixtures |
| `ZenNotes/tui` | TUI, standalone `zn` CLI and MCP, local/remote backends | Self-hosted HTTP API and independently implemented vault rules |
| `ZenNotes/website` (private) | Laravel Cloud, website, accounts, billing, public shares and publications | Versioned viewer manifest/importer with actual-payload browser tests; local pin awaits clean publication |
| `ZenNotes/znserver` | Selected destination for Go self-hosting | Empty repository at the start of this migration |

Desktop installers/updater and AUR/Homebrew/Nix desktop packages remain owned by
this repository. The Go binary, Docker publishing, and server-specific Nix inputs
move only after a verified server release and rollback rehearsal. Native releases
and the TUI's GoReleaser/Homebrew distribution remain independent.

The public share viewer source is restored under `apps/share-viewer`. Its new
artifact is verified against current Laravel payloads; it does not claim byte
identity with the older copied bundle. Laravel retains that legacy bundle and
installs current/retained versioned pins independently. The local candidate has
not been deployed. See [the viewer guide](../apps/share-viewer/README.md).
