# ZenNotes ecosystem, CLI migration, and bug-fix handoff

Prepared September 16, 2026. This document records the work in this task and the state checked at handoff. Read this before changing, committing, publishing, or replacing any working tree.

## 1. Start here

The work has three different publication states:

1. Desktop v2.50.3 was released, with website updates and demo videos. The user's subsequent v2.50.4 release was incorporated into the boundary work.
2. Five approved ecosystem-boundary snapshots were committed and pushed to draft PRs in separate worktrees. They remain open and have failed CI checks that need investigation.
3. Later CLI migration work, fixes for desktop issues #790, #791, and #792, and TUI/website usability changes are still local in the original working directories. They are newer than those PR snapshots. The issues were commented on and closed at the user's explicit request, with comments stating that the code is unpublished.

The compatible Go CLI release is prepared but unpublished. Desktop's production Go release pin is intentionally null. The server repository is still empty. The full ecosystem cutover is therefore not complete.

### Non-negotiable preservation and approval rules

- The user's global rule is: **Never commit or push code without explicitly asking first and receiving approval.** Prior approval covered the five boundary PR snapshots. Do not reuse it for later changes.
- Do useful local implementation and verification before asking for publication approval. The user should approve a concrete scope.
- Do not reset, clean, stash away, or blindly pull over the original dirty trees. Preserve the existing indexes and unrelated edits.
- Desktop has 23 previously staged files, 570 insertions and 487 deletions. Its working tree includes far more unstaged and untracked work.
- The original desktop HEAD is older than v2.50.4, but its files already contain the reconciled v2.50.4 fixes. A simple HEAD comparison does not describe its contents.
- iOS has an unrelated local Xcode version/build bump, 1.9.10/build 21, intentionally excluded from the boundary PR.
- Use isolated HOME, config, user-data, and vault paths for runtime tests. Do not use personal Cloud accounts or vaults. Packaged user-data overrides require `ZEN_PERF=1`.
- Keep local candidate artifacts separate from production release pins. Do not weaken provenance checks to make CI pass.
- Read applicable repository instructions before edits. The Laravel repository has its own AGENTS.md. The desktop house style avoids em dashes in new code/docs.
- No new Git commits, pushes, releases, deployments, or GitHub comments were made while preparing this handoff.

## 2. Working directories and snapshots

### Original working copies: latest local work lives here

| Component | Absolute path | Branch | HEAD at handoff |
| --- | --- | --- | --- |
| Desktop/web/shared packages | `/Users/adibhanna/Developer/opensource/zennotes` | `refactor/ecosystem-boundaries` | `a8fc4fc9a954c107b2fe4d6a4433c53702b01b13` |
| TUI/Go CLI | `/Users/adibhanna/Developer/opensource/zennotescli` | `main` | `3ccdc81547780eeee325eb1e4b8b09dc85d17f28` |
| Android | `/Users/adibhanna/Developer/apps/zennotesandroid` | `main` | `50c31dcb6ad7799f146cbe45ec6627181cda562f` |
| iOS | `/Users/adibhanna/Developer/apps/zennotesiphone` | `fix/cloud-live-regressions` | `9971018286cd371f90d7afb882e46d8be3afde50` |
| Laravel website/Cloud | `/Users/adibhanna/Developer/Laravel/zennotes` | `main` | `76a2e20ec7b58cf741ea76b29486558e8880d92d` |
| Homebrew tap | `/Users/adibhanna/Developer/opensource/homebrew-tap` | `main` | `ae257ff3faf6fd3883d03b6205f5386267c91ef2` |

The Homebrew checkout was clean. The application checkouts contain local work.

Fresh machine-readable snapshots:

- [Repository branches, HEADs, statuses, and staged stats](/Users/adibhanna/Developer/opensource/zennotes/dist/handoff-2026-09-16/repository-state.json)
- [Live PR states and check results](/Users/adibhanna/Developer/opensource/zennotes/dist/handoff-2026-09-16/pull-request-state.json)

These snapshots are inventories, not copies of all file contents.

### Separate approved PR worktrees

Root: `/Users/adibhanna/Developer/worktrees/zennotes-boundaries-pr-xvdswfdx`

Subdirectories: `main`, `android`, `ios`, `laravel`, `tui`. Each uses branch `refactor/ecosystem-boundaries-pr` in its own repository.

The root contains `README.md`, `manifest.json`, `verification.json`, and `backups/`. The manifest records source paths, base hashes, original index information, file hashes, and backups. Use these to distinguish the approved snapshot from later local edits.

Do not copy the old PR worktrees back over the originals. Reconcile later changes carefully against the recorded snapshots and current remote bases.

### Draft PRs and fresh CI status

| Component | PR | Head | Base | State checked September 16 |
| --- | --- | --- | --- | --- |
| Desktop/web/boundaries | [zennotes #789](https://github.com/ZenNotes/zennotes/pull/789) | `819f4fbb85ce50d9fb4460d81dd4ac4012b372c1` | `main` | Open draft, BLOCKED |
| Android | [zennotesandroid #66](https://github.com/ZenNotes/zennotesandroid/pull/66) | `a8ac7d18c8867feab3213e43f22628d5c85b2370` | `main` | Open draft, UNSTABLE |
| iOS | [zennotesios #23](https://github.com/ZenNotes/zennotesios/pull/23) | `e53fab7d5f66e3f0c4a8a91a55820d340ea4f923` | `fix/cloud-live-regressions` | Open draft, UNSTABLE |
| Website/Cloud | [website #25](https://github.com/ZenNotes/website/pull/25) | `be88655cebb989cca166b033b0d42b88bffa9f44` | `main` | Open draft, UNSTABLE |
| TUI | [tui #2](https://github.com/ZenNotes/tui/pull/2) | `91520ff86b8fabec67124bb5cd20a6beb3b89dd6` | `main` | Open draft, UNSTABLE |

iOS #23 is stacked on the existing [Cloud fixes PR #22](https://github.com/ZenNotes/zennotesios/pull/22). Preserve that base relationship until its dependency is merged or deliberately rebased.

Current check failures:

- Desktop: all four `Build` jobs fail, on Ubuntu x64, Ubuntu arm64, macOS, and Windows. Go without frontend dependencies, viewer build, web candidate/browser checks, production dependency audit, and Nix server checks pass. JavaScript/TypeScript CodeQL analysis passes, but the aggregate `CodeQL` PR status reports failure. Investigate that distinction.
- Android: TypeScript/package-boundary/Android-build job fails; emulator launch is skipped.
- iOS: TypeScript/package-boundary/iOS-build job fails.
- Website: PHP 8.4 and 8.5 CI jobs fail; quality passes; deployment is skipped. A published clean viewer artifact is a known prerequisite for the normal installation gate. Do not assume this explains every failure without reading logs.
- TUI: Linux/macOS Go jobs and Homebrew checks pass; Windows Go job fails.

The handoff pass checked statuses, not failure root causes. Historical local test results below do not mean GitHub CI is green.

Useful run IDs: desktop CI `35042872379`; Android `35042877819`; iOS `35042909298`; website tests `35042931054`; TUI `35042936230`. Inspect with `gh run view <id> --repo <owner/repo> --log-failed`.

`ZenNotes/znserver` was checked and is empty, with no base branch and no PR. Extraction preparation remains in the desktop boundary work.

## 3. Previously shipped desktop release: v2.50.3

[GitHub release v2.50.3](https://github.com/ZenNotes/zennotes/releases/tag/v2.50.3) was published September 15, 2026 at 15:32 UTC.

- Release commit: `cbd4d84a65679c9f909ff752fc83b30212f38d59`.
- macOS, Windows, and Linux installers were published.
- Website release content and videos were published; website release commit `652dbb19b4891f05d421401fb3b108cb4582b2da`.
- Homebrew, AUR, Nix packaging, and Docker were updated and verified as recorded in the release pack.

### Changes shipped

- **Optional window title bar, issue #754.** Settings > Appearance > Chrome can hide the main title row and controls while preserving tabs/sidebar/editor. Applies across vault windows and persists in config.toml. Particularly useful for Linux tiling window managers such as Hyprland.
- **External application links, issue #764.** Allowlisted URL schemes such as Zotero, Obsidian, and VS Code. Settings > Editor > Links configures schemes. Disabled schemes guide the user to settings; launch errors surface; editor, preview, and Vim `gd` preserve the original URL.
- **Editor settings tabs.** One line, equal spacing, balanced edge padding, horizontal scrolling at narrow widths, and selected-tab visibility. Resizing and maximized layouts were checked across 820 to 2560px widths.
- **Quick Capture over native macOS fullscreen apps.** Panel behavior allows the small editor to appear over fullscreen Spaces; pin, save, and dismiss were exercised.
- **Sidebar drag preview.** Dragging a partially clipped row uses a full-row preview instead of a cropped screenshot.
- **Daily rollover.** Real rolled-over tasks replace template placeholder tasks; preserves existing/nested tasks and other sections instead of leaving three empty checkboxes.
- **Literal bracket text.** `[EE]` remains text unless a valid Markdown reference definition exists, across editor hosts.

An earlier report also mentioned Kanban Today appearing on tomorrow's calendar date. The final v2.50.3 release notes do not identify a separate calendar-date fix. Do not invent a shipped fix for that report.

Issues #754 and #764 were commented on and closed. Nix PR #782 in ZenNotes/zennotes is closed, not merged; packaging hashes were committed separately. Do not infer an additional nixpkgs PR from that fact.

### Media and docs

[Release pack](/Users/adibhanna/Developer/opensource/zennotes/docs/releases/v2.50.3/RELEASE_NOTES.md)

Four videos are stored in the release pack's `media/` directory and the website's `public/release-media/v2.50.3/`:

- `window-title-bar-demo.mp4`
- `application-links-demo.mp4`
- `daily-editor-fixes-demo.mp4`
- `sidebar-drag-fix-demo.mp4`

They were attached to the GitHub release and website release page. The sidebar demo uses app captures with an illustrated pointer; the other three use native macOS footage. Tweet copy is in the release pack's `twitter-post.md`.

At that milestone: typechecks, desktop build/packaged CLI, app-core 2,087 tests, shared-domain 1,627, and desktop 767 passed with existing skips. The signed/notarized DMG passed Gatekeeper and stapled-ticket checks. Native Windows and Hyprland UI were not exercised.

## 4. Ecosystem boundary plan and completed local implementation

The user asked whether the web version could be added to Cloud so users could sign in and see their notes online. We assessed the architecture and prioritized separating responsibilities before adding that product capability.

### Agreed repository responsibilities

| Repository | Responsibility |
| --- | --- |
| `ZenNotes/zennotes` | Desktop and web shells, shared TypeScript editor/domain/contracts, read-only share viewer |
| `ZenNotes/znserver` | Independently built Go self-hosted server, consuming pinned web artifacts |
| `ZenNotes/website` (private) | Laravel marketing, accounts, billing, Cloud, publishing, consuming viewer artifacts |
| `ZenNotes/zennotesios` | iOS shell and native files/iCloud/keychain behavior |
| `ZenNotes/zennotesandroid` | Android shell and Storage Access Framework behavior |
| `ZenNotes/tui` | Go TUI, CLI, and MCP, with local/self-hosted backends |

Keep desktop/web/editor together. Avoid a framework rewrite, new microservices, merging Go and Laravel backends, moving private Laravel code public, or changing Capacitor versions as part of this split.

**Cloud browser login/private-note editing has not been implemented.** It remains a separate product stream requiring decisions about sessions/authentication, cache/service-worker isolation, revisions/conflicts, encrypted vaults, and recovery. Cloud integration in the TUI is also outside this boundary work.

### Contract and shared-core boundaries

- `bridge-contract` owns portable passive types and `ZenPlatform`; no NodeJS leakage or reverse dependency on domain implementation.
- `shared-domain` depends on contracts. Pure task/path/rename/demo logic moved into it; compatibility reexports retain existing callers.
- App-core exposes public host APIs for navigation, notes and batches, folder/database/task actions, settings, commands, dialogs, editor capabilities/attachments/geometry, and immutable shell/workspace observations.
- Hosts no longer reach into raw store or CodeMirror references through the public contract.
- Mobile private imports and copied source-tree integrations were removed.
- Native operations coordinate pending saves, stale host context invalidation, workspace reservations, relocation/save/move/reopen/rollback, and failed-rollback recovery.
- Shared package archives enforce singleton React/CodeMirror/Lezer dependencies and include assets, WASM, fonts, and consumer build support.

### Mobile consumption

- Android and iOS consume exact vendored package archives with lockfiles/manifests. They no longer require a sibling desktop source checkout.
- Removed `.zennotes-commit` and the old preparation/upstream-copying mechanism.
- Android SAF distinguishes missing files, missing directories, revoked access, and provider failures; a native provider fixture exercises those distinctions.
- iOS initializes native preferences and typing behavior before opening the editor; deployment minimums align at iOS 15.
- Actual simulators/emulators and runtime fixtures were used, not only static checks.

### Server and cross-language contracts

- Exact-byte task/date fixtures have shared SHA provenance in TypeScript, Go server, and TUI, including near-midnight Los Angeles and Auckland cases.
- Go HTTP contracts exercise authentication, root/prefixed deployments, reads/writes, invalid paths, and current/legacy routes.
- Go tests/builds run without Node or frontend dependencies.
- Web artifact importer validates protocol, source metadata, archive/file SHA-256, archive path/type safety, and immutable outputs.
- Server extraction templates use module `github.com/ZenNotes/znserver` and include Docker, Nix, release, and CI preparation.
- A disposable git-filter-repo 2.47 rehearsal covered 979 commits and 160 server paths. Original refs were unchanged; actual remote history import has not occurred.
- Go-only Docker arm64/amd64 root and prefix tests exercised auth/assets/exact writes/logout. A released-v2.50.4 to candidate to v2.50.4 rollback preserved exact note bytes.
- Go-only Nix aarch64-linux build/runtime proof was completed.

### Public share viewer and Laravel

- Rebuilt the maintained viewer from reproducible source with a read-only surface, safe Markdown fallback, themes, attachments, and lazy diagrams. Unsafe interactive plots were excluded.
- Historical viewer commit `c534a1d0` reproduced 67 of 73 historical files; no exact-provenance claim was made for the other six.
- Laravel importer verifies artifacts and installs both current and retained manifests on fresh deployments so old pages can still fetch lazy assets. The old root viewer remains a fallback.
- Protected/manual draft artifact workflows were prepared, but clean production artifact publication and cutover remain pending.

### Main reference documents

- [Architecture and repository plan](/Users/adibhanna/Developer/opensource/zennotes/docs/specs/ecosystem-boundaries-and-repository-plan.md)
- [Release and cutover gates](/Users/adibhanna/Developer/opensource/zennotes/docs/boundary-release-cutover.md)
- [Server extraction rehearsal](/Users/adibhanna/Developer/opensource/zennotes/docs/server-extraction-rehearsal.md)
- [v2.50.4 integration](/Users/adibhanna/Developer/opensource/zennotes/docs/v2.50.4-boundary-integration.md)
- [Monorepo architecture](/Users/adibhanna/Developer/opensource/zennotes/docs/monorepo-architecture.md)
- [Web architecture](/Users/adibhanna/Developer/opensource/zennotes/docs/web-architecture.md)
- [Boundary validation evidence](/Users/adibhanna/Developer/opensource/zennotes/dist/ecosystem-boundary-validation/VALIDATION.md)

Older validation documents saying nothing was committed/pushed describe their local checkpoint. They predate the five approved PR snapshots. Later fixes remain local as stated in this handoff.

## 5. Incorporating the user's v2.50.4 release

The user fixed and released v2.50.4 in a separate worktree while boundary work continued.

- Released commit: `850cf5f8a7f7e10d3f47df1c5732209d8e0c2dcc`.
- Annotated tag object: `c82ec31a9be663d8fa3827c865c28f8bb5020bd7`.
- [Release build](https://github.com/ZenNotes/zennotes/actions/runs/35036589163) passed and published 29 assets.
- [PR #787](https://github.com/ZenNotes/zennotes/pull/787) merged September 15 at 23:38 UTC.

Integrated fixes include #783 wikilink picker in code, #784 live modified-date tokens, #785 asset rename/move reference rewriting, and #786 forwarded/canceled Kanban tasks.

Thirty-eight changed paths were reconciled by three-way comparison into the original dirty boundary tree without changing its HEAD or index. The one lockfile conflict retained the version changes and new TypeScript dependency. Asset actions were integrated with workspace save/reservation guarantees.

The desktop PR snapshot subsequently used main `9a2e5e1a87f5e095692f0084a66ca012cfafe011`, including packaging metadata. The user's separate release worktree at `.claude/worktrees/pensive-mendeleev-d841e7` should be left alone.

## 6. Desktop Node CLI to Go CLI/TUI migration, local only

The user wanted existing desktop-installed Node CLI users to move to the new Go tool with minimal friction, retaining the `zn` command and desktop installation flow.

[Migration spec](/Users/adibhanna/Developer/opensource/zennotes/docs/specs/desktop-cli-tui-migration.md)

### Implemented behavior

- Desktop consumes a pinned Go binary rather than importing Go source.
- Durable versioned binaries live under `<userData>/cli/terminal/versions`, with an atomic current pointer and stable `<userData>/cli/zn` launcher.
- Existing desktop-owned links upgrade on startup. Old `resources/zen` launchers forward appropriately.
- Homebrew/manual installations are protected from replacement.
- Bare `zn` retains help behavior. `zn tui` opens the interactive application.
- Commands default to the desktop application's workspace; the TUI defaults to its terminal workspace. Explicit `--workspace-source app|terminal`, environment settings, and vault/server overrides take precedence.
- Desktop profile/token precedence is preserved; terminal credentials do not silently override desktop credentials.
- MCP pins the first successfully resolved backend for its process lifetime. An initial failed resolution may be retried.
- Node remains available for the first transition release. `ZENNOTES_CLI_ENGINE=legacy` explicitly selects rollback before invoking a command. A failed Go command is never automatically rerun through Node, avoiding duplicate writes.
- Direct `cli.js` and `mcp.js` remain legacy Node entry points.
- Settings reports installed version and repair errors; launcher resolution handles canonical path aliases.

### Linux creation timestamps and stale AppImage links

- Go uses Linux statx birth time and `.zennotes/note-metadata/<path>.metadata.json` to preserve creation dates across atomic saves.
- Desktop/Node/MCP read the same format. Renames, moves, trash/restore, and deletion carry the sidecars correctly.
- Malformed metadata blocks the Markdown write rather than destroying creation-date information.
- macOS preserves native filesystem creation time.
- Explicit root/inbox layouts and custom system-folder configuration are honored.
- Laravel Cloud's path allowlist accepts the exact creation-metadata suffix. This must deploy before desktop starts syncing these files.
- Installer receipts allow automatic repair only for the exact recorded path and target.
- An unknown stale link requires review in Settings, an expiring main-process token, a link-unchanged check, and backup. Foreign PATH entries, changed-link races, and non-writable/root-owned links are protected.

### Important source areas

Desktop main process: `apps/desktop/src/main/cli-install.ts`, `terminal-runtime.ts`, `note-creation-metadata.ts`, and accompanying tests. Launcher/packaging: `apps/desktop/build/zen`, `after-pack.js`. Artifact/compatibility tooling: `tooling/scripts/terminal-artifact.mjs`, `verify-terminal-compat.mjs`, `terminal-launcher.test.mjs`.

Go: backend target selection, CLI/TUI workspace handling, vault metadata, atomic writes, and platform file-time implementations in the TUI repository. Laravel: `app/Services/VaultPathService.php` and sync API metadata coverage.

### Release state and exact pending candidate

[Production manifest](/Users/adibhanna/Developer/opensource/zennotes/apps/desktop/terminal-release.json) remains:

```json
{"schemaVersion": 1, "release": null}
```

Normal packaging with a null release removes staged local runtimes and retains the Node fallback. Local rehearsal hashes are not production pins.

Prepared release worktree: `/tmp/zn-tui-v0.2.0-release` (`/private/tmp/...` canonical path), branch `v0.2.0`, HEAD `3ccdc81547780eeee325eb1e4b8b09dc85d17f28`.

It contains **28 staged files, with no commit**. Scope file: `/tmp/zn-go-release-scope.json`. Staged binary-diff SHA-256 recorded for that frozen candidate: `f533f738e91a9a645cd765a7b3295205f7c8022baf11f0f10ac6fd94814e7644`.

The later TUI theme/quit changes are NOT included in this frozen release worktree. Refresh its scope/patch and rerun affected verification before seeking final approval. Current published TUI is still [v0.1.0](https://github.com/ZenNotes/tui/releases/tag/v0.1.0).

Release pack:

- [Publish plan](/Users/adibhanna/Developer/opensource/zennotes/docs/releases/cli-v0.2.0/PUBLISH_PLAN.md)
- [Verification](/Users/adibhanna/Developer/opensource/zennotes/docs/releases/cli-v0.2.0/VERIFICATION.md)
- [Release notes](/Users/adibhanna/Developer/opensource/zennotes/docs/releases/cli-v0.2.0/RELEASE_NOTES.md)

The same directory contains `GO_RELEASE_SCOPE.json`, `go-release.patch`, `COMMIT_MESSAGE.txt`, and launch copy.

### Publish/pin sequence after explicit approval

1. Refresh the candidate with later TUI fixes, verify scope/source parity, and recheck remote main and whether v0.2.0 exists. Reconcile any remote movement before publishing.
2. Commit/push the approved scope and tag the exact source commit using the documented release process.
3. Confirm the release workflow publishes all six archives plus checksums from that tag.
4. Download the actual release assets, verify checksums, commit provenance, version 0.2.0, and protocol 1.
5. Pin actual published hashes/source commit for desktop `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. Go's archive architecture `amd64` maps to manifest `x64`.
6. Run importer, native integration, and compatibility checks using downloaded releases with local overrides removed.
7. Deploy Laravel's metadata allowlist before the signed/notarized desktop release. Retain Node rollback in this first migration release.

Standalone macOS signing/notarization remains separate from Developer ID signing of a Go binary embedded inside the desktop app.

## 7. Desktop and mobile bug fixes #790, #791, #792

All are implemented locally and tested. They are not in a published release. The user's latest authorization to comment and close them was executed.

[Combined evidence](/Users/adibhanna/Developer/opensource/zennotes/dist/issues-790-792/README.md)

### #792: rectangular Vim block editing

Cause: CodeMirror multi-selection was disabled, collapsing Vim's per-row ranges. The shared Vim extension now enables multiple selections in all editor hosts.

Coverage includes insert, append, reverse selection, delete, change, yank/paste, and short rows. Native Electron reproduced the original first-row-only insertion; the fix inserted and saved the prefix on all three rows. Ten new regressions and 57 focused tests passed.

Key files: `packages/app-core/src/lib/cm-vim-visual-highlight.ts` and `cm-vim-visual-block.test.ts`.

Final Developer ID signed macOS rehearsal: `/tmp/zn-issues-pack-signed/mac-arm64/ZenNotes.app`. Its runtime evidence is `dist/issues-790-792/792/packaged-runtime.json`. The directory-only package lacks `app-update.yml`, so the expected background update-feed error is a fixture limitation, not a claimed release regression.

The later Discord rectangular-edit report duplicates this issue. User Downloads attachment paths are no longer present, but the original issue videos are retained as `792/reported-desktop.mov` and `792/reported-tui.mov`, with extracted frames.

### #791: deleted Cloud vault still displayed as linked/up to date

A structured vault-level NOT_FOUND response retires the exact local association and active sync state. A missing item/revision first requires a separate vault-manifest check. Network, authorization, and server errors do not unlink the vault. A concurrent replacement link is protected.

The complete old sync state, including unsent merge drafts, is archived under uniquely named inactive `retired-states`. Local notes and other vaults remain intact. Settings removes the deleted destination and stale actions/up-to-date message, keeps other destinations usable, and displays a useful error without Electron's internal prefix.

Desktop and shared mobile hosts use the same rules. Native desktop manual sync and automatic five-second polling passed with Settings open throughout, against authenticated local Cloud fixtures. Each mobile adapter passed 20 integration tests against its installed packages. Physical-device Cloud deletion was not tested.

Key areas: shared-domain `cloud-vault-availability.ts`, `cloud-sync-host-service.ts`; desktop Cloud sync service/filesystem; core CloudSettings/auto-sync; mobile adapters.

### #790: pacman updater relaunch button appears to do nothing

Installation now has visible state, allows one privileged process at a time, disables pkexec's hidden terminal fallback, distinguishes cancellation code 126 from authorization failure 127, and offers recovery through Details > About. Startup update checks cannot overwrite a pending result.

Actual Linux arm64 Electron and PacmanUpdater verified feed/checksum handling, missing agent, cancellation, pending authorization, package failure, successful quit/relaunch, and error persistence past the eight-second startup timer. The feed and privileged subprocess were fixtures. No actual privilege elevation or system upgrade was performed.

The built pacman archive owns a lowercase `/usr/bin/zennotes` launcher, provides `zennotes`, and conflicts with `zennotes-bin`; AUR metadata has the reciprocal `ZenNotes` conflict. An isolated Arch pacman root verified ownership, conflicting-package rejection, and alias removal on uninstall. Dependency checks and maintainer scripts were disabled in that fixture.

Native Niri/Hyprland Wayland and graphical polkit behavior still require a real Linux host.

### GitHub disposition

- [#790 resolution comment](https://github.com/ZenNotes/zennotes/issues/790#issuecomment-5699697681)
- [#791 resolution comment](https://github.com/ZenNotes/zennotes/issues/791#issuecomment-5699698313)
- [#792 resolution comment](https://github.com/ZenNotes/zennotes/issues/792#issuecomment-5699699110)

All three were verified CLOSED with reason COMPLETED. Comments explicitly state the changes are local and not yet committed/released, and describe validation limits. Do not duplicate comments or reopen issues without a reason/user request.

[Closure record](/Users/adibhanna/Developer/opensource/zennotes/dist/issues-790-792/github-resolution.json)

### Latest mobile candidate, newer than boundary PR archives

Current app-core candidate: `2.50.4-core.h55a7458f56e50033`.

Contract/domain candidate: `2.50.4-boundaries.haeb944b71e3a163a`.

Core archive SHA-256: `94f00a496b2d6bbc98b90b97afd70cf106fe239319dfeb91bf2cf1a46d764083`.

[Candidate manifest](/Users/adibhanna/Developer/opensource/zennotes/dist/issues-790-792/checks/mobile-core-candidate.json)

Archive: `/Users/adibhanna/Developer/opensource/zennotes/dist/shared-packages/zennotes-app-core-2.50.4-core.h55a7458f56e50033.tgz`.

These honestly record dirty source based on original HEAD a8fc4fc9. Do not replace them with older h8a... boundary candidates, and do not publish them as clean production artifacts. Earlier web `2.50.4-web.hffc8c055ae2667f2` and viewer `2.50.4-viewer.h475ea70770234498` artifacts also require clean publication/repinning before production.

## 8. TUI usability and website follow-up, local only

The user supplied feedback about unreadable light mode, missing Homebrew instructions, competing `zn` commands, tag completion, themes, video viewing, quitting, and desktop rectangular editing.

The concrete usability gaps were fixed. Tag completion, custom whole-interface themes, and standalone macOS signing remain separate unfinished Go CLI/TUI work. They are not desktop editor settings work.

### Completed

- TUI renders explicit foreground/background across every row, including blanks and nested color reset sequences. Light-mode text no longer inherits a dark terminal background.
- Preserves nested selected/link colors and honors no-color output. Improved muted contrast: light FgDim `#665c54`, light FgMuted `#76695f`, dark FgMuted `#9d8e7d`.
- Footer exposes `:qa quit` early. Help and README distinguish closing one note with `:q` from saving/quitting the application with `:qa`; command palette carries the hint.
- Did not assign Space q q because Space q already opens Quick Capture.
- Website leads with `brew install zennotes/tap/zn`, retaining Go installation and all six binary downloads.
- Explains competing commands using `type -a zn` and `"$(brew --prefix)/bin/zn" tui`, without claiming the pending migration has shipped.
- Links official Apple verification guidance. Does not disable Gatekeeper or claim unsigned standalone binaries are signed.
- Copied the existing silent TUI tour and poster byte-for-byte into website `public/release-media/tui-v0.1.0/`.
- Added a native, user-started HTML video player under an expandable recording section, with controls, playsinline, and preload none. Kept the interactive preview and avoided autoplay.
- README now points to `https://zennotes.org/tui#recording`. Publish the website player before publishing that README link.

### Files and verification

TUI files: `README.md`, `internal/tui/app.go`, `commands.go`, `helpdata.go`, `hints.go`, `textutil.go`, `theme.go`, new `theme_render_test.go`.

Laravel files: `resources/views/tui.blade.php`, `resources/css/tui.css`, `tests/Feature/TuiPageTest.php`, and new `public/release-media/tui-v0.1.0/` media.

Go full tests/vet passed; final theme tests passed after contrast adjustments. Rendering regressions fail on original code and pass after the fix. Actual tmux TUI runs checked light/dark switching, closing one of two tabs with `:q`, and saving/exiting with `:qa`. Screenshots are rendered from real ANSI captures, not mockups. The fixture explicitly unsets the agent environment's `NO_COLOR=1` for color checks.

Laravel: five Pest tests, 41 assertions, Vite production build, and Pint passed. Actual Herd website was inspected at desktop and 390px widths without horizontal overflow. Native video playback reached 41 seconds without media error. One in-app browser tab crashed during accessibility automation of the native pause button; a fresh tab passed keyboard play/pause at 19 seconds. This is not universal-browser proof.

[Evidence and preservation record](/Users/adibhanna/Developer/opensource/zennotes/dist/tui-feedback/README.md)

The same directory contains runtime-check.py, runtime.json, light-before.png, light-after.png, dark-after.png, ANSI/cast/gif captures, and git-preservation.json. Temporary binaries are `/tmp/zn-tui-feedback-before` and `/tmp/zn-tui-feedback-after`; fixture root is `/tmp/zn-tui-feedback-runtime`.

### Still outstanding

- [TUI #3: tag-value completion](https://github.com/ZenNotes/tui/issues/3), open.
- [TUI #1: desktop-like colorschemes](https://github.com/ZenNotes/tui/issues/1), open. The contrast fix does not implement customizable whole-interface themes.
- Standalone macOS release signing/notarization. No separate GitHub issue was identified during this handoff.

The prepared 28-file Go release candidate has not been refreshed with these changes.

## 9. Verification summary and limits

These are results at recorded local checkpoints. They were not all rerun for this documentation-only handoff, and they do not supersede current remote CI failures.

### Boundary checkpoint

- 4,806 source tests passed, with five existing skips; eight typecheck tasks.
- Fifty browser checks each against nested Vite 6 and Vite 8 consumers.
- Android: 138 tests, native build/lint/unit checks, four instrumentation cases, 20 runtime checks, three cold starts.
- iOS: 102 tests, native simulator build, 20 runtime checks, three cold starts.
- Laravel: earlier full 793 tests / 6,272 assertions; after integration, 17 focused tests / 141 assertions, 11 importer checks, six real Laravel browser checks.
- Go server/TUI tests, vet, builds, protocol/fixture tests; five artifact-packer tests; production audit with zero advisories.
- Real app/runtime exercises covered Unicode and trailing spaces, Find, tasks, attachments, renames, trash/restore, comments, native vault moves/reopen, stale contexts, and cold starts.

### CLI transition checkpoint

- Sixty command-compatibility cases on macOS and 60 on Linux, including exact piped bytes.
- Actual MCP process parity and backend pinning.
- Actual Raycast isolated-vault list/archive/restore checks; fixture extension uninstalled afterward.
- Thirty concurrent app/CLI saves and 643 reads showed complete files and stable creation dates. Content remains last-writer-wins; this does not provide conflict merging.
- Native signed macOS Electron and embedded Go strict-signature checks.
- Actual Linux arm64 AppImage UI, and durable CLI behavior after removing the AppImage extraction directory.
- Go tests on macOS arm64, Linux arm64, and emulated Linux x64; six release archives built; Rosetta/x64 emulated CLI checks passed.

### Recent issue checkpoint

- Shared-domain: 1,666 passed.
- Desktop: 848 passed, four existing skips.
- App-core: 2,368 passed, one existing skip.
- Android: 149 passed. iOS: 113 passed.
- Later focused regressions: updater 35; Cloud settings/status 53.
- Eight root typechecks plus both mobile typechecks, boundary checks, and production web builds passed.

### Remaining validation limits

- Native Linux x64 desktop GUI is unproven; emulation did not reach the renderer. CLI emulation is not a substitute.
- Native Hyprland/Niri Wayland, graphical polkit, and FUSE behavior remain unproven.
- Native Windows TUI execution remains outstanding, and its current PR CI fails. Desktop CLI installation on Windows is disabled.
- Real account-backed Cloud/iCloud entitlement, account-switch, and revocation tests need isolated staging accounts/devices. Recent mobile Cloud-vault deletion was package/adapter-tested, not tested on physical devices with live Cloud.
- New packaged notarization still depends on release CI credentials; local Developer ID signing does not prove a newly notarized distribution.
- macOS Nix runtime and a live open-browser-tab viewer asset rollout remain cutover checks.

## 10. Recommended next actions

1. **Preserve and understand current state.** Read this file, repository-state.json, and the PR worktree manifest/backups. Recheck live remote state before touching branches. Keep the unrelated iOS version bump and all pre-existing indexes intact.
2. **Investigate the five draft PRs' CI failures.** Read logs and separate real regressions, platform failures, and clean-artifact prerequisites. Do not bypass artifact verification to get green checks.
3. **Prepare updated review scopes locally.** Reconcile the newer CLI, #790 to #792, TUI, and website changes into the appropriate snapshots. Refresh the isolated Go release candidate with later TUI fixes. Review exact diffs and run relevant checks before requesting explicit commit/push approval.
4. **Finish meaningful platform/staging tests.** Prioritize native Linux x64 and Wayland/polkit/FUSE, Windows TUI, and account-backed mobile/Cloud scenarios. Report unavailable environments honestly rather than substituting compilation claims.
5. **Publish and pin the compatible Go CLI once approved.** Use real release downloads and checksums, not rehearsal artifacts. Treat standalone macOS signing/notarization as a separate outstanding release concern.
6. **Respect deployment dependencies.** Laravel metadata allowlist before the desktop CLI migration; website player before the README's new recording link.
7. **Publish clean boundary artifacts and repin consumers.** Core/contracts/domain/web/viewer archives need clean approved source provenance, publication, and mobile/Laravel/server repinning. Dirty review candidates are not release assets.
8. **Complete znserver extraction/cutover.** Work in a disposable clone after an approved checkpoint; establish the empty remote's history/base, protect publication workflows, run Go/Docker/Nix/release checks, preserve distribution identity, and verify rollback. Disable the old Docker publisher before enabling the replacement. Remove `apps/server` only after the independent release and rollback are proven.
9. **Continue distinct feature work if requested.** TUI tag completion, customizable interface themes, and standalone signing remain open. Browser access to private Cloud notes remains a future product implementation, not an already completed part of this refactor.

## 11. Practical commands and evidence locations

Check scripts and flags before running artifact producers; output directories are immutable by design.

Desktop root commands used during verification:

```sh
npm run typecheck
npm run test:run --workspace @zennotes/shared-domain
npm run test:run --workspace @zennotes/app-core
npm run test:run --workspace @zennotes/desktop
npm run test:terminal
npm run test:app-core-package
npm run test:app-core-browser
npm run check:contract-fixtures
npm run test:web-artifact
```

Artifact entry points include `npm run artifact:app-core`, `npm run artifact:web`, and `npm run pack:share-viewer`. Consult their manifests and documented clean/local flags before producing anything.

TUI commands:

```sh
go test ./...
go vet ./...
go build -o /tmp/zn-handoff-check ./cmd/zn
```

Desktop compatibility runner: `node tooling/scripts/verify-terminal-compat.mjs /absolute/path/to/zn` from the desktop root.

Local-only artifact staging uses `terminal-artifact.mjs --local-binary ... --license ...`. Local desktop packaging requires an explicit terminal artifact directory and `ZENNOTES_ALLOW_LOCAL_TERMINAL=1`; CI rejects these local candidate overrides. Never carry them into production pin verification.

Laravel runs through Herd at `http://zennotes.test`; do not start artisan serve. Relevant focused check: `php artisan test --compact tests/Feature/TuiPageTest.php`, followed by appropriate project build/lint checks when changing those files.

Main evidence roots:

- `/Users/adibhanna/Developer/opensource/zennotes/dist/ecosystem-boundary-validation/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/ecosystem-boundary-validation/v2.50.4/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/cli-tui-migration-assessment/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/cli-tui-transition/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/issues-790-792/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/tui-feedback/`
- `/Users/adibhanna/Developer/opensource/zennotes/dist/handoff-2026-09-16/`

Preservation snapshots also exist at `/tmp/zn-cli-migration-state.json`, `/tmp/zn-cli-release-state.json`, `/tmp/zn-issues-790-792-state.json`, `/tmp/zn-792-state.json`, `/tmp/zn-issues-packaged-state.json`, and `/tmp/zn-tui-feedback-baseline.json`. Prefer durable worktree backups when available because temporary paths can disappear.

Many release packs and `dist/` artifacts are ignored local files. GitHub alone cannot reconstruct all evidence or the latest unpublished changes. A new agent should work on this machine/workspace or explicitly transfer these directories along with the source changes.

### Suggested opening instruction for the next agent

> Read `/Users/adibhanna/Developer/opensource/zennotes/docs/agent-handoff-2026-09-16.md` and the linked state snapshots first. Continue the ZenNotes boundary refactor, desktop-to-Go CLI migration, and local bug-fix release preparation. Preserve every original working tree and index. The five draft PRs contain an older snapshot and have failed CI; later fixes are local. Investigate those failures and prepare updated, tested review scopes. Do not commit or push without asking for and receiving explicit approval. Do not treat closed issues or passing historical local tests as evidence that the fixes have shipped or CI is green.

## 12. Update, later on September 16: CI failures diagnosed, review scopes prepared

A second pass on the same day investigated the five draft PRs' CI failures,
fixed every locally fixable cause, verified the fixes, refreshed the Go CLI
v0.2.0 candidate with the later TUI fixes, and prepared grouped review scopes.
With the maintainer's approval the four CI-fix commits were then pushed to the
PR branches (zennotes `1150ae3b` and four follow-ups through `2f2f00dc` that
CI runs revealed, zennotesandroid `cdab60d1`, zennotesios `09ff9790`, tui
`ee7aa647`); nothing else was committed, pushed, tagged, commented, or
deployed. Every original tree's staged index is byte-identical
to the state recorded in section 2.

Read [dist/handoff-2026-09-16/review-scopes/README.md](/Users/adibhanna/Developer/opensource/zennotes/dist/handoff-2026-09-16/review-scopes/README.md)
next. It holds the root causes, the per-PR fix patches (verified to apply to
each PR snapshot), the desktop later work split into six reviewable groups
with an assembly proof, the refreshed two-commit Go release candidate, the
verification log, and the exact approval asks. Patches live beside it under
`patches/`, evidence under `evidence/`.

Runtime validation of the current tree followed: desktop dev and packaged
builds over CDP, the self-hosted web shell over CDP, the TUI in tmux, and the
iOS simulator, and the Android emulator (SDK under Homebrew's command-line
tools, OpenJDK 21) all pass core flows with isolated data. See section 1c of the review-scopes README.

With approval, the Go server was then extracted to `ZenNotes/znserver`
(`main` at `975412e8`, 175 commits, pinned to the published clean web artifact
`web-2.50.4-web.h876d73fd3124e1fe`), with branch protection and the two
release environments configured; the Docker channel was swapped (main publisher disabled, `adibhanna/zennotes:2.50.5`
pushed from znserver; `latest` untouched). The monorepo cutover followed as
draft PR #795 (`refactor/server-cutover`, commits `e20bd43b` and `8caedda8` on top
of the boundary PR): `apps/server`, the old Docker publisher, and the server Nix
package are gone, and every script that still built the server now resolves
the pinned znserver release through `tooling/scripts/server-binary.mjs`. See
the review-scopes README, section 3b.

Short version of the causes: a cold npm cache has no registry metadata for
`--offline` range resolution; `tsc` rejects backslash include globs on
Windows; CRLF checkouts break byte-hashed contract fixtures on Windows; the
mobile lockfiles lacked the desktop's audit `overrides`; the website pin is a
dirty viewer candidate by design and needs a clean published artifact; CodeQL
flagged eight items in the large diff, all addressed.
