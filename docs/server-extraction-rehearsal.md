# Local Go server extraction rehearsal

Status: completed. On September 16, 2026 the server history was extracted to
[ZenNotes/znserver](https://github.com/ZenNotes/znserver) (main `975412e8`),
its release `v2.50.4` was published, and the Docker channel moved to that
repository's publisher (`adibhanna/zennotes:2.50.5`). `apps/server` and the
rehearsal tooling were removed from this repository afterwards. The rest of
this document records how the rehearsal was run and what it proved.

## Reproduce the source and artifact boundary

From the main repository:

```sh
npm run artifact:web
node tooling/scripts/rehearse-server-extraction.mjs <printed-manifest-path>
```

The second command creates a new temporary directory and prints its location. It
copies Go source, fixtures, license, and the explicit browser artifact inputs. It
rewrites the module and Go imports to `github.com/ZenNotes/znserver` in that copy
only. It does not initialize a repository, change the original module, rewrite Git
history, remove source, or contact the destination repository.

The retained tree contains `source/web-artifact/manifest.json` and its adjacent
archive, so subsequent builds need neither the main checkout nor its artifact
directory. `provenance.json` records original/extracted file hashes and artifact
hashes. Source symlinks and npm workspace machinery are not copied.
Destination-specific Go/Docker/Nix/CI/release files come from
`tooling/server-repository`; they are inert templates until copied into a
reviewed destination checkpoint. `release.json` preserves the current server
version and Go vendor hash.

The rehearsal runs `go vet ./...`, `go test ./...`, and an API-only build before
installing browser assets. It then runs the Go artifact importer, tagged bundle
tests, and an embedded production build. `GOWORK=off` prevents an ambient Go
workspace from satisfying missing source dependencies.

For local dirty candidates, the command explicitly enables `-allow-dirty`. A
release build must use a reviewed clean-source manifest without that option.
See [the server build guide](../apps/server/README.md) for importer constraints.

To run the existing browser benchmark against the exact resulting binary:

```sh
ZEN_PERF_WEB_SERVER_BINARY=<printed-binary-path> \
  ZEN_PERF_WEB_NOTES=300 npm run perf:web-runtime
```

It seeds a temporary vault and browser profile. With a prebuilt binary selected,
the benchmark does not rebuild or restage the browser bundle.

## Evidence and remaining gates

Local verification covers:

- Full workspace typecheck and test suites; standalone contract/domain tarballs.
- Go tests and race checks for the importer, HTTP API, and vault operations.
- Strict manifests, checksums, unsafe archive paths/links, HTTPS redirects,
  immutable archive identity, and existing-output protection.
- A fresh source tree using the destination module name, built with Go alone.
- The compiled browser app: login, note read/edit, exact Unicode save bytes,
  asset metadata, reload with the session preserved, and logout at `/` and `/notes`.
- A 300-note browser benchmark against the extracted binary.
- A Go-only Docker candidate built from the copied source and archive, with root
  and prefixed HTTP checks for assets, authentication, exact writes, generic-file
  metadata, and logout across both route families. The candidate uses a temporary
  Dockerfile and local image tag; the published Dockerfile/publisher has not moved.

The HTTP fixture also covers legacy root-level API routes. Both route families use one session
cookie scoped to `<base>/`, allowing cached clients to change API paths across
upgrades. Login, logout, and rotation expire the old `<base>/api` cookie to avoid
duplicate cookies. Session flags and bearer authentication remain in place. Generic embedded file targets follow desktop metadata behavior.

Both native package consumers, the maintained viewer/Laravel boundary, and TUI
fixtures now pass local integration gates. Go-only Docker images for arm64/amd64
pass root and `/notes` runtime checks. A separate disposable Nix container builds
the Go-only candidate on aarch64-linux and verifies embedded HTML and authenticated
exact Unicode read/write. Its image is
`nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c`,
with nixpkgs `26.05.3494.714a5f8c4ead` and Go 1.26.4. No host Nix installation was
required. The Nix importer runs in `postConfigure`, after vendoring; `preBuild`
also runs during dependency collection and must not invoke the importer there.

A local released-v2.50.4 -> candidate -> released-v2.50.4 sequence at both URL
mounts preserves exact fixture bytes and permits continued writes after rollback.
The candidate includes the released v2.50.4 source, including asset-reference
rewrites. Its web artifact and Go source were rebuilt after reconciliation;
[the integration record](v2.50.4-boundary-integration.md) records the exact commit
and checks. Rehearsal release metadata reads the server package version while
retaining the established Go dependency hash. Remote CI and macOS Nix have not run. Live account-backed Cloud/iCloud acceptance and Cloud browser access have
separate gates in the [ecosystem plan](specs/ecosystem-boundaries-and-repository-plan.md).

Full reports are in [the local validation bundle](../dist/ecosystem-boundary-validation/VALIDATION.md).

## External server during browser development

The existing `dev:web-stack` command can run an extracted checkout or binary:

```sh
ZENNOTES_SERVER_DIR=/path/to/znserver npm run dev:web-stack
# Or choose the compiled binary, without a Go checkout:
ZENNOTES_SERVER_BINARY=/path/to/zennotes-server npm run dev:web-stack
```

Set only one option. The Vite proxy still targets localhost:7878. Keep dedicated
test config/vault/auth variables for runtime verification. With neither option,
the main repository's existing Go source remains the compatibility fallback.
The external-binary entrypoint has a local startup/health check.

## History and release ownership, after local validation and approval

The current rehearsal deliberately copies uncommitted working source. Actual history
extraction must wait until the intended source checkpoint is approved and committed.
A non-mutating dry run is complete: git-filter-repo 2.47.0 processed 979 commits,
including 160 touching `apps/server`, with original and scratch refs unchanged.
The dry run writes filtered fast-export text without running fast-import, so it
creates no replacement commits. The scratch clone then fetched v2.50.4 read-only
for the upstream comparison; its refs are no longer the initial dry-run snapshot.
Then use a disposable clone and filter `apps/server/` to the new repository root,
following the [GitHub extraction guide](https://docs.github.com/en/get-started/using-git/splitting-a-subfolder-out-into-a-new-repository).
Keep the original repository and release tags untouched. Module renaming and
destination-specific build files should be explicit follow-up changes in that copy.

Review distribution ownership before enabling any new publisher:

| Existing owner | Destination responsibility | Compatibility to preserve |
| --- | --- | --- |
| Main `.github/workflows/docker-publish.yml` and `Dockerfile` | Server Docker build and publishing | `adibhanna/zennotes`, amd64/arm64, tags, UID 65532, `/workspace`, `/data`, port 7878, binary entrypoint, configuration variables |
| Main `packaging/nix/package-server.nix` | Server source and pinned browser inputs | Package/binary name, Go vendor hash, supported Linux/macOS builds |
| Main server workspace and development scripts | Documented server checkout or installed binary | Convenient web-stack development, existing CLI/configuration behavior |
| Main web build | Immutable browser artifacts and protocol fixtures | Complete assets, reviewed manifest, retained previous artifact for rollback |

Do not move desktop installers, updater, desktop Nix, AUR, Homebrew, mobile, or TUI
publishing into the server repository. Switch one server channel only after its
candidate installation, upgrade, and rollback checks pass. Remove the original
server source only after a verified destination release and channel cutover.
