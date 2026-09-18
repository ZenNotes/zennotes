# Replace the desktop CLI with the standalone Go CLI and TUI

**Status:** Implemented locally on September 16, 2026, with a verified local Go
candidate. Production activation remains disabled in `apps/desktop/terminal-release.json`.
No commits, pushes, release uploads, installed user CLI changes, or MCP client
configuration changes were made for this implementation.

## Pre-release follow-up, September 16

- Linux `statx` now reads birth time where supported. Both hosts preserve the
  original note date in `.zennotes/note-metadata/<path>.metadata.json` before
  atomic saves. Renames, folder moves, Trash/restore and deletion maintain the
  sidecar; malformed metadata blocks a save before touching Markdown.
- Desktop and the retained Node/MCP surface read the same format. Cloud client
  and Laravel allowlists accept the exact metadata suffix. Deploy that server
  change before the desktop update. Older clients still use filesystem dates.
- Installer receipts authorize automatic repair only for the recorded path and
  exact link target. Unrecorded dangling AppImage/moved-app shortcuts require a
  Settings review, expiring main-issued token, unchanged-link check and backup.
- Real Linux arm64 AppImage UI testing passed fresh install, automatic upgrade,
  reviewed repair, foreign PATH protection and a shortcut-change race. Go keeps
  working after the extraction disappears and preserves the date on append.
  Final checks also cover a root-owned, non-writable directory: unavailable
  elevation leaves the shortcut unchanged and reports the error inside the card.
- Developer ID signed macOS package and embedded Go pass signature verification
  and launch into the real renderer. Thirty concurrent app/CLI saves yielded
  643 complete reads and kept the date. Content still uses last-writer semantics.
- Actual Raycast UI listed the isolated vault, archived and restored a note via
  Go. The temporary verification extension was uninstalled afterwards.
- Full Go suites pass on macOS, Linux arm64 and emulated Linux x64. Desktop suite: 820 passed, four
  platform skips; final focused suite: 47 passed, one Windows skip. All eight
  root typecheck tasks pass. Cloud API: 40 tests, 194 assertions. All six Go
  archives build; Intel probes pass under Rosetta and Linux emulation.
- Local release branch/worktree: `v0.2.0` at `/tmp/zn-tui-v0.2.0-release`, scoped
  to the CLI compatibility changes. It has no commits yet. Publication and the
  production desktop pin await explicit commit/push approval.

Platform limits: Linux proof uses an arm64 Docker VM with Xvfb and AppImage
extraction mode. It does not prove native Hyprland/Wayland, FUSE, or physical Intel
hardware. Linux x64 Electron did not reach a renderer under emulation, so native
x64 GUI verification remains a desktop release gate. Windows archives cross-build; desktop CLI installation remains disabled
there. Local macOS notarization cannot run without Apple credentials and remains
in the desktop release CI gate. The legacy arm64 AppImage runtime in the container
needed `zlib1g-dev`; this is separate from the persistent CLI.

Detailed evidence: ignored `dist/cli-tui-transition/`. Release handoff:
`docs/releases/cli-v0.2.0/`.

## Implemented locally

- Desktop stages a verified native binary, keeps versioned persistent copies under
  `<userData>/cli/terminal/versions`, and atomically updates `terminal/current`.
  `<userData>/cli/zn` is the stable managed launcher.
- Existing owned `zn` links upgrade at startup. The historical `resources/zen`
  launcher forwards to Go. Homebrew/manual commands keep their own ownership.
  Symlinked app folders and macOS `/tmp` aliases are recognized by canonical path.
- `zn` remains help, existing commands retain their shape, and `zn tui` opens the
  interactive app. Desktop commands default to `app`; the TUI defaults to
  `terminal`. Explicit selectors still win. `zn use` changes the terminal default.
- App mode uses desktop vault/profile names and token precedence. A terminal
  credential for the same URL cannot silently replace the desktop token.
  Interactive local/server switches retain the chosen workspace source.
- MCP keeps its first successfully opened backend for the process lifetime, just
  like the Node server. A failed initial resolution can be retried. Restarting
  MCP picks up a changed desktop default.
- macOS atomic note replacement preserves filesystem creation time. Explicit
  inbox/root layout settings now win over inferred layout in Go, including
  renamed system folders and leftover directories from an earlier layout.
- Settings shows the Go version and update errors with Repair. Help and the
  website explain workspace defaults, external installs, and rollback.
- `ZENNOTES_CLI_ENGINE=legacy` selects Node before invocation. Failed Go commands
  are never retried through Node. Direct `cli.js` and `mcp.js` entry points remain
  on the retained Node implementation during this transition.

## Earlier migration verification

This section records the initial candidate before the pre-release follow-up above.
The Developer ID, Linux creation-date and installer results above supersede its
corresponding limitations.

- Full desktop suite: 798 passed, 4 skipped. The later canonical-path regression
  and runtime suite: 16 passed, 1 platform skip. Root typecheck passes.
- Full Go test suite and `go vet ./...` pass, with failing-before-fix regressions
  for workspace names, credential precedence, TUI switching, macOS birth time,
  and explicit vault layout with remapped system folders.
- Sixty command comparisons pass on macOS arm64 and sixty on Linux arm64 in a
  container: inbox, root, and remapped-folder vaults. They cover read/search,
  tasks, append/write, capture, folder rename, trash/restore, comments and database
  rows. Resulting files match; exact piped Markdown bytes are asserted.
  The comparison deliberately normalizes generated UUIDs and operation timestamps.
  It does **not** establish creation-time parity on Linux.
- Actual stdio MCP subprocesses read/write/append identical content, select the
  desktop vault despite a different terminal default, and retain their initial
  vault after the desktop config changes. The terminal vault stays untouched.
- Actual Electron UI tested automatic old-link migration, Settings uninstall and
  reinstall, foreign off-PATH handling, and version display using isolated HOME,
  configuration and user-data directories.
- Packaged macOS arm64 app tested old resource-link upgrade, explicit Node
  rollback and `zn tui` in a real PTY. The persistent CLI still works after app
  exit with the app bundle temporarily unavailable.
- The package and embedded Go binary pass local code-signature verification.
  Runtime testing uses ad-hoc signing with hardened runtime disabled because
  ad-hoc binaries have no common Developer ID team. Production Developer ID
  signing and notarization remain a release gate.
- Twelve importer/launcher checks cover archive checksum failure, wrong target,
  disabled-pin cleanup, persistent launch, argument/stream preservation and no
  automatic retry. Unactivated candidates cannot bypass verification through the
  resource launcher. Website Blade compilation and six DocsPage tests pass.

Evidence lives in ignored `dist/cli-tui-transition/`. Previous assessment evidence
below describes the earlier candidate and is retained as migration context.

## Release gates and retained behavior

1. Approve the scoped Go commit/push, publish `v0.2.0`, then download the actual
   four desktop-target archives and verify checksums. Pin the exact source
   commit, version, protocol and uploaded archive hashes in
   `apps/desktop/terminal-release.json`. Normal packaging remains on Node until
   that manifest is filled. Never use local rehearsal hashes as release hashes.
2. Deploy the Laravel creation-metadata allowlist before the desktop update.
   Keep the sidecars with the vault. Older apps and manual file moves do not
   maintain the new metadata format.
3. Run notarization in the existing signed desktop CI release path. Local
   Developer ID signing and runtime verification passed; notarization did not run.
4. Complete the Linux x64 GUI check on a native runner. The emulated CLI passes,
   but the emulated AppImage did not reach Electron startup/CDP.
5. Retain Node and direct MCP/CLI entry points for the first transition release.
   Explicit Node rollback on AppImage requires its original resource mount.
   Runtime retirement is a later change after published upgrade coverage.

## Local build and repeatable checks

Build the candidate in the TUI checkout, then from the desktop repository:

```sh
node tooling/scripts/terminal-artifact.mjs --local-binary /absolute/path/to/zn --license /absolute/path/to/tui/LICENSE
node tooling/scripts/verify-terminal-compat.mjs /absolute/path/to/zn
npm run test:terminal
npm run test:run --workspace @zennotes/desktop -- src/main/cli-install.test.ts src/main/terminal-runtime.test.ts
npm run typecheck
npm run build --workspace @zennotes/desktop
```

Local packaging requires both `ZENNOTES_TERMINAL_ARTIFACT_DIR` pointing to
`apps/desktop/build/terminal` and `ZENNOTES_ALLOW_LOCAL_TERMINAL=1`. CI rejects
local overrides. Nothing from the sibling TUI checkout is imported by desktop.
A release manifest with `release: null` removes stale staged artifacts during
packaging so a local candidate cannot accidentally survive into a normal build.


## Recommendation

Make `ZenNotes/tui` the owner of the `zn` command line, terminal UI, and standalone
MCP server. Desktop should consume a pinned binary release and own only its
installation, update, and desktop integration. Keep `zn` as the public command.

The user experience remains Settings > CLI > Install. Existing commands such as
`zn list`, `zn capture`, and `zn mcp` continue to work; `zn tui` becomes available
through the same installation. Bare `zn` should continue showing help.

Bundle the selected Go binary with the app. Installation should copy it into a
persistent, user-owned directory and create the shell shortcut there. Updates
should arrive with desktop releases, using the exact tested TUI version. Homebrew
and manual installations continue to follow their own update channels.

## What exists today

| Surface | Current implementation | Migration consequence |
| --- | --- | --- |
| Desktop install | `apps/desktop/src/main/cli-install.ts` creates a `zn` symlink to `resources/zen` | Preserve command name, PATH discovery, managed ownership, and uninstall behavior |
| Bundled launcher | `apps/desktop/build/zen` runs Electron with `ELECTRON_RUN_AS_NODE=1` and `cli.js` | Replace the runtime dependency with the Go executable |
| Packaging | `apps/desktop/package.json` copies `zen`, `cli.js`, and shared chunks outside ASAR | Add native artifacts by target architecture; remove only obsolete resources after auditing consumers |
| MCP setup | `mcp-integrations.ts` prefers managed `zn mcp`, otherwise invokes Electron and `mcp.js` | Existing managed CLI configs will switch with the launcher; direct MCP configs need their own migration |
| Raycast | Discovers `zn`, with a legacy `zen` fallback, and consumes CLI JSON | Include Raycast commands in the compatibility gate |
| Go tool | `ZenNotes/tui` owns CLI, TUI, MCP, vault logic, and remote adapters | Reuse this implementation without copying its source into desktop |
| Platforms | Desktop Settings installs CLI on macOS/Linux; Go releases also include Windows | Migrate existing supported installers first; implement Windows PATH installation separately |

The latest published TUI release observed during this assessment was
[`v0.1.0`](https://github.com/ZenNotes/tui/releases/tag/v0.1.0), with macOS, Linux,
and Windows archives for amd64 and arm64 and a checksums file. Local tests below
used the current working tree, not those downloaded archives. Publication must
pin a release that actually contains the compatibility work.

## Local evidence

The desktop CLI was run from its built `out/main/cli.js`. A Go candidate was built
with `go build -trimpath -ldflags='-s -w' -o <temporary binary> ./cmd/zn`. Both ran
against the same disposable vault and isolated configuration.

- Fourteen of fifteen command comparisons had identical exit status, parsed JSON
  or text output, and stderr. Checks covered list, read, search, title search,
  backlinks, folders, tags, tasks, empty databases/comments, vault info/list, and
  an unknown command. JSON comparisons ignored object-key ordering, not fields.
- The differing case was a missing note: both exited 1 with no stdout; Node and
  Go worded the filesystem error differently.
- Writing a note through stdin preserved identical UTF-8 bytes, including Unicode,
  trailing spaces, and the final newline, in both implementations.
- Write responses exposed a metadata difference: the Go atomic replacement changed
  the fixture's creation timestamp, while the desktop write retained it. Go also
  reports integer milliseconds where Node can report fractional milliseconds.
- Real stdio MCP initialization succeeded for both. All 34 tool names and input
  schemas matched after removing descriptive schema text. `read_note` returned
  the same content. This does not prove parity for every tool's behavior.
- `zn tui` opened in a real PTY, displayed the fixture vault, notes, and task, and
  exited successfully through `:q`.
- The stripped local macOS arm64 Go executable was approximately 24.2 MiB before
  archive compression or distribution signing.

Reports and probe scripts are in the ignored
`dist/cli-tui-migration-assessment/` directory. `assessment.json` records source
HEADs, the candidate checksum, and validation limits. Both source checkouts had
local boundary work, so these are working-tree results rather than release proof.

## Compatibility decisions before switching

### Preserve the selected vault

This is a confirmed behavior difference, not just a possible risk. With desktop
using vault A and `workspaces.toml` selecting vault B, `zn list --json` from the
desktop CLI listed A; the Go CLI listed B. `zn use app` made Go follow A again,
but running that during migration would overwrite the user's terminal preference.

Recommended contract:

1. Explicit `--server`, `--vault`, and existing environment overrides retain their
   precedence.
2. A migrated desktop-managed command keeps following the desktop workspace until
   the user deliberately changes that command's default.
3. Selecting a different vault inside the TUI must not silently retarget existing
   scripts, Raycast, or desktop-configured MCP clients.
4. Standalone terminal users retain their existing saved default.
5. Desktop-managed MCP configuration gets an explicit follow-desktop option in the
   Go resolver. It must remain clear which workspace an agent will operate on.

Implement the selection policy in the Go tool and expose a small documented
option to the desktop launcher. Separate the interactive TUI preference from the
migrated command default. Do not have a shell wrapper reinterpret every command
or rewrite `workspaces.toml` during installation.

Keep the existing remote credential boundary. Neither CLI automatically decrypts
Electron's OS-protected server token. Continue supporting explicit token/env
configuration and the Go tool's own credential store; installation must not export
the desktop token into plaintext.

### Preserve output, mutations, and integrations

Add a repeatable differential gate against the shipped desktop CLI, using fresh
fixtures for each implementation. Compare JSON fields, array ordering, stdout,
stderr, exit codes, and resulting files. Normalize only explicitly identified
nondeterministic values such as generated IDs and operation timestamps.

Include stdin pipelines, argument quoting, custom system-folder paths, root mode,
task IDs and toggles, comments, databases, lifecycle commands, invalid paths,
remote errors, and concurrent edits. Resolve creation-time preservation before
calling write behavior compatible. Keep useful errors consistent; exact OS error
wording can be a documented exception rather than a reason to reproduce Node.

Exercise MCP reads and writes and its long-lived workspace behavior. Tool-schema
equivalence alone is insufficient. Verify Raycast with the selected Go artifact.

`zn open` needs a reliable way to locate the originating desktop installation,
including moved apps and AppImages. The Go tool already supports
`ZENNOTES_APP_PATH`; use a maintained desktop association rather than an ephemeral
mount path or an assumption that the app lives under `/Applications`.

## Artifact and installation boundary

### Build-time contract

Add a small checked-in manifest containing the TUI repository, release version,
source commit, compatibility revision, and archive URL/SHA-256 for each supported
OS/CPU pair. Map Electron `x64`/`win32` to Go `amd64`/`windows` explicitly.

Desktop packaging verifies the pin, extracts only the expected executable and
license, and includes the binary outside ASAR. Cache by checksum; reject missing,
wrong-architecture, or mismatched artifacts. Release builds must not silently fall
back to an unrelated `zn` on PATH or fetch mutable `latest`.

Use a local artifact override for development and testing. Keep it distinct from
the publishable release manifest. No sibling source checkout should be required
for a clean desktop build.

The repository uses electron-builder 26. Its `extraResources` supports native
resources, and `mac.binaries` identifies additional executables for signing.
Stage the binary before signing and test the signed installed copy. A macOS signing
step changes executable bytes, so distinguish upstream download checksums from any
post-signing checksum used to verify installation copies.
[Contents documentation](https://www.electron.build/v26/docs/contents/),
[macOS signing options](https://www.electron.build/v26/docs/mac/).

### Persistent managed installation

Use a versioned directory under the desktop's user-data CLI area, for example:

```text
<userData>/cli/releases/<version>-<platform>-<arch>/zn
<userData>/cli/current -> releases/<version>-<platform>-<arch>
<userData>/cli/zn       stable managed launcher
<selected PATH directory>/zn -> <userData>/cli/zn
```

The launcher supplies only documented desktop context and execs the selected Go
binary, preserving stdin, stdout, stderr, exit codes, and terminal signals.

Copy into staging, verify integrity and executable identity, run a version probe,
then atomically activate the selected version. Retain the last working version
for rollback. App startup only updates an installation already owned by desktop;
it must not install a command for someone who never requested it. Failed updates
leave the existing command usable and report the failure in Settings.

This persistent location matters particularly for AppImage: its application files
live under a temporary mount. A PATH shortcut must not depend on that mount
remaining available after the app exits.
[AppImage architecture](https://docs.appimage.org/reference/architecture.html).

### Existing installation ownership

- Recognize the exact prior ZenNotes wrapper paths and recorded managed install
  metadata, including stale links from an old bundle or AppImage. Do not decide
  ownership from a broad substring such as `ZenNotes.app` alone.
- Replace a managed shortcut in place; preserve its PATH location. Use atomic
  link replacement and recheck ownership before replacing or removing anything.
- Keep the resource named `zen` as a compatibility launcher during migration.
  The public command remains `zn`; never touch a foreign `zen` browser command.
- Discover which `zn` actually wins in login-shell PATH order. Report both a
  managed installation and a shadowing installation when they coexist.
- Recognize Homebrew/manual installations as externally managed. Offer usage and
  update guidance without overwriting, uninstalling, or shadowing them.
- Elevated changes happen only through the explicit install/repair flow. Startup
  migration must not trigger an administrator prompt.
- Show installed version, bundled version, ownership, and path in Settings. Keep
  UI text focused on `zn`, `zn tui`, install/update/repair, and useful errors.

## Delivery order

### Existing users: update desktop and keep using `zn`

The default migration should require only a normal desktop update and launch.
Users should not need to uninstall the old CLI, install Homebrew, edit PATH, or
change their scripts.

The existing shortcut points at a resource named `zen` inside the application.
Keep that exact resource path and replace its implementation with a compatibility
launcher. When an app updates in place, the old shortcut reaches the updated
launcher without editing the PATH directory. This also avoids requiring admin
access solely to replace a shortcut in `/usr/local/bin`.

On first launch after updating, stage and verify the managed Go installation.
Activate it only after the compatibility gate is satisfied. The old resource
launcher delegates to that installation; writable managed shortcuts can also be
repointed to the persistent launcher. Preserve the working legacy implementation
when staging or activation fails. An app move or stale AppImage link may still
need an explicit Repair action when its original PATH directory is not writable.

Preserve direct desktop-generated CLI/MCP entry paths with forwarding adapters
until those configurations have a supported migration route. Already-running MCP
processes finish on their existing runtime; newly started processes use the
selected implementation. Never rewrite unrelated client configuration.

Keep the default vault, existing commands, flags, pipe behavior, JSON output, and
exit codes compatible. Bare `zn` stays help; `zn tui` is the new opt-in interface.
Announce the new terminal UI in desktop release notes or Settings, never by
injecting migration notices into command output or MCP stdio.

Retain an explicit rollback to the old runtime for the initial transition release.
Remove that runtime after upgrade testing and the compatibility gates justify it;
the tiny launcher at the historical path can remain after the old engine is gone.

### Implementation slices

| Slice | Owner | Completion gate |
| --- | --- | --- |
| 1. Compatibility contract and Go fixes | TUI, shared fixtures | Differential checks pass; workspace defaults and creation timestamps resolved; real TUI and MCP exercised |
| 2. Pinned artifact consumption | Desktop tooling, TUI release | Clean desktop packaging obtains verified binaries without sibling source; per-target version/architecture checks pass |
| 3. Managed installer and migration | Desktop | Fresh install, legacy upgrade, app move, app exit, rollback, uninstall, and foreign-install cases pass in isolated environments |
| 4. Settings, MCP, Raycast, and docs | Desktop and website | Actual app Settings installs `zn`; terminal UI and scripts work; managed MCP and Raycast hit the intended vault |
| 5. Retire the TypeScript runtime | Desktop | Packaged verification passes; old MCP entry configurations have a supported compatibility route; obsolete CLI resources can be removed safely |

Keep the old implementation as a comparison oracle during development. A failed
Go command must never automatically retry a write through the old CLI: the first
attempt may already have changed files. Rollback selects an implementation before
an invocation, rather than retrying a possibly completed mutation.

Do not delete all of `src/mcp` together with `src/cli`: desktop main and other
features import vault operations from there. Audit imports and extract reusable
desktop helpers before removing the old command entry and MCP launcher.

Final acceptance needs packaged macOS and Linux runs, including AppImage after
desktop exits, installation offline, PATH conflicts, active MCP sessions during
updates, and desktop/TUI simultaneous edits. Windows installation can then be
added with its own persistent executable and user-PATH handling.

The implementation and remaining release gates are recorded at the top of this
document. This earlier assessment remains the rationale for the transition.
