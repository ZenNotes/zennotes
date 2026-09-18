# Boundary release and repository cutover

Local preparation is verified. No workflow here has been dispatched, and no
release owner or production build setting has changed.

## Reviewable local changes

| Repository | Review groups |
| --- | --- |
| Main `zennotes` | Contract ownership/fixtures; public core API and mutation lifecycle; package producer/consumer checks; web/Go artifact boundary; maintained public viewer; extraction/distribution templates; architecture evidence |
| Android | Vendored package pins and public imports; native workspace rollback and SAF error contracts; boundary/runtime/provider fixtures |
| iOS | Same package/public API migration and native lifecycle checks; existing unrelated Xcode project changes must remain separate |
| TUI | Exact-byte task and HTTP contract fixtures, opt-in real-server verification, documentation |
| Laravel | Verified viewer importer and retained pins; current payload integration; document/fallback behavior; read-only viewer browser gate |

The user's pre-existing staged changes in main are preserved. Do not stage the
entire ecosystem as one change. Review the existing index first, then make focused
checkpoints per group after explicit approval. The core package and its consumers
must move together; they cannot mix the package store with private source imports.

## Publication order

1. The released v2.50.4 source has been reconciled locally and affected checks
   pass; see [the integration record](v2.50.4-boundary-integration.md). Review and
   approve source commits and branch-history alignment before any push. The
   existing HEAD and index are unchanged.
2. Configure the `boundary-artifacts` GitHub environment with required review.
   `.github/workflows/boundary-artifact-release.yml` accepts an approved full source
   SHA, validates/builds the selected artifact, and creates a draft release only.
   It does not publish to npm. The machine has no npm identity; scope ownership
   must be settled before choosing registry publication instead of archives.
3. Verify the draft's consumer behavior, then approve publication. Web and viewer
   manifests already name their immutable final release URL. Dirty manifests have
   no URL and ordinary consumers reject them. Never hand-edit dirty provenance to
   make a candidate appear released.
4. Update both mobile consumers from the published package set. Retain the exact
   archives in their repository `vendor` directories and update lockfiles and
   checksum manifests together; fresh CI must need no main-repository checkout.
   Run native/account-backed staging gates before native releases.
5. Update Laravel's viewer pin, placing the prior released pin in
   `resources/share-viewer/retained/`. `viewer:install` rebuilds that complete
   supported asset set on every deployment. Run Pest and the actual-payload Chrome
   harness. Add `npm run viewer:install` to the production build only in the reviewed
   deployment change. The retained legacy root bundle permits rollback during the
   migration. Do not assume Laravel Cloud preserves an old build directory.
6. Pin a clean published web manifest in the extracted Go source. Its API-only
   tests, embedded build, Docker build, and Nix build must pass without Node.

## Go repository and channel order

Status: done on September 16, 2026 through the manual publisher and a channel
rehearsal; see the server extraction document. The steps below are kept as the
record of the order that was followed.

- Verify `ZenNotes/znserver` is still empty before import. Preserve old repository
  history and tags. The documented dry-run is complete; actual filtering must run
  only in a disposable clone of the approved checkpoint.
- Copy `tooling/server-repository` into the extracted tree, rewrite module imports,
  and retain fixture provenance. Add the reviewed web pin and server release
  metadata. The source-copy rehearsal automates these transformations.
- Configure required CI checks, review/branch protections, security reporting,
  protected release environments, and minimum necessary publisher credentials.
  Do not copy website/account credentials into a public repository.
- Run fresh destination CI. The manual `release.yml` creates draft binaries and
  SHA-256 sums for Linux/macOS amd64/arm64 and Windows amd64. Complete candidate
  installation and rollback checks before publishing that draft.
- Disable the main repository's Docker publisher before enabling the destination's
  manual publisher. Preserve `adibhanna/zennotes`, amd64/arm64, tags, non-root UID,
  port, volume paths, config variables, and binary name. Configure the protected
  `server-docker-publisher` environment. Move Nix server source/artifact pins in a
  separate reviewed channel update; desktop Nix/AUR/Homebrew stay in main.
- After one verified destination release and channel rollback rehearsal, remove
  `apps/server`, its npm workspace and old publisher. Keep `dev:web-stack` using the
  configured external checkout/binary. Until then, the old source stays available.

## Acceptance that needs an external environment

- Real Cloud/iCloud entitlements, account switching/revocation, and sync with
  isolated staging accounts; local native/provider tests do not claim this proof.
- Clean remote CI and macOS Nix; local Nix proof is aarch64 Linux.
- Open-tab behavior through the chosen server rollout: unlike Laravel's retained
  manifest set, a single embedded Go binary contains one browser bundle. Preserve
  old hashed assets at the deployment layer during overlap, or define and test a
  recoverable reload path before promising seamless tab survival.
- Installed-client support policy. Public release inventory is recorded, but App
  Store/TestFlight availability and older installed versions need owner input.
  Keep existing HTTP aliases and compatibility exports in the meantime.

Cloud browser login/editing is a separate feature with its own auth, cache,
revision/conflict, encrypted-vault, and draft-recovery gates. This migration does
not expose private notes through browser login.
