# Spec: Cloud conflict resolution

## Objective

ZenNotes must resolve first-sync and ongoing multi-device conflicts without creating user-visible `(cloud conflict)` files. Most people should never see the resolver: text edits that do not overlap are merged automatically. When a choice is necessary, one durable conflict queue explains the situation in plain language and preserves every version until the user finishes.

The feature is complete when the desktop/mobile scenario from GitHub issue #683 produces one safe conflict entry, no duplicate note, no leaked task, and a recoverable resolution flow from the main workspace.

## Product behavior

- Sync continues for every unaffected path while a conflicted path is paused.
- Non-overlapping text changes are combined automatically and uploaded as a new agreed revision.
- A true overlapping edit becomes a durable conflict containing the last agreed version, this device's version, and the latest Cloud version.
- The primary UI labels versions as **This device**, **Other device**, and **Last synced**. Revisions and hashes remain diagnostic details, not decision copy.
- The primary workflow is **Save combined note**. Per-change controls use **Use this device**, **Use other device**, and **Keep both changes**; whole-file actions remain available for text, binary, delete, and move conflicts.
- **Finish later** opens a plain-language warning, and the confirming action saves the current draft before closing. Backdrop and Escape cannot accidentally dismiss a pending resolution.
- After resolving one item, the next unresolved item opens automatically. The status bar always exposes the queue.
- The extra Cloud and last-synced snapshots live in private app storage, outside the vault, so they cannot appear as duplicate notes or enter search, backups, or third-party file sync. The user's existing local note stays visible and editable, while its unresolved task data is withheld from Tasks, Calendar, and Kanban until the conflict is resolved.
- Existing conflict-copy files are never deleted automatically. ZenNotes detects likely legacy copies and offers a separate, explicit review and cleanup action.
- If either side changes while the resolver is open, ZenNotes refreshes the conflict and never overwrites the newer change silently.

## Tech stack

- TypeScript shared sync domain and bridge contracts
- React 18 app-core UI with the existing Modal/Button design system
- Electron IPC and private desktop app-data persistence
- Capacitor host persistence for iOS and Android
- Laravel Cloud API for authorized historical-revision reads
- Vitest, Node test runner, PHPUnit/Pest, and production builds

No new runtime dependency is required. Line differencing and three-way merge behavior remain a small, tested shared-domain module.

## Commands

- Focused shared tests: `npm run test:run --workspace @zennotes/shared-domain`
- Focused UI tests: `npm run test:run --workspace @zennotes/app-core`
- Desktop tests: `npm run test:run --workspace @zennotes/desktop`
- Workspace typecheck: `npm run typecheck`
- Desktop build: `npm run build --workspace @zennotes/desktop`
- Cloud API tests: `php artisan test --filter=SyncApiTest`
- Mobile checks: `npm test && npm run typecheck && npm run build`

## Project structure

- `packages/shared-domain/src/`: conflict records, diff/merge logic, coordinator behavior, portable filesystem adapter
- `packages/bridge-contract/src/`: cross-platform conflict summaries, details, resolutions, and bridge methods
- `packages/app-core/src/components/`: responsive conflict queue and merge experience
- `apps/desktop/src/main|preload/`: desktop persistence and IPC
- `apps/web/src/bridge/`: explicit unsupported implementations where local-vault Cloud sync is unavailable
- `docs/releases/v2.44.0/`: user-facing release notes and verified demo media
- ZenNotes Cloud Laravel repository: historical revision endpoint and authorization tests
- iOS/Android repositories: native persistence/bridge adapters and responsive runtime verification

## Code style

Use explicit, portable records and outcome-oriented names:

```ts
if (merge.status === "clean") {
  await applyResolution({
    conflict_id: conflict.id,
    choice: "merged",
    text: merge.text,
  });
} else {
  await conflicts.save({ ...conflict, draft_text: merge.preview });
}
```

Keep filesystem and network effects behind existing repository/remote interfaces. Prefer immutable state transforms, discriminated unions, snake_case wire fields, and project formatting conventions.

## Testing strategy

- Unit-test line diffs, clean three-way merges, overlapping hunks, newline preservation, and complexity limits.
- Coordinator tests reproduce bootstrap, pull, rejected-push, delete, move, repeated remote update, restart, deferral, and stale-resolution scenarios.
- Filesystem tests prove no conflict copy is written and private snapshots never enter a vault scan.
- Component tests cover plain-language labels, queue navigation, per-hunk choices, persisted drafts, exit warning, keyboard use, and mobile-width layout.
- Bridge/IPC tests prove all conflict operations are available on desktop and portable hosts.
- Cloud API tests prove revision content is owner-scoped, revision-scoped, and unavailable across accounts.
- End-to-end demo uses the built Electron app and a real multi-device-shaped conflict, with captions.

## Boundaries

- Always: preserve every version, verify local and remote freshness, keep unrelated sync moving, keep pending data outside the vault, and provide keyboard-accessible controls.
- Ask first: adding dependencies, deleting legacy user files, changing account authorization, or committing/pushing.
- Never: silently pick a winner for overlapping changes, expose private conflict snapshots as notes, claim issue #683 is complete without runtime multi-device coverage, or auto-delete a legacy conflict copy.

## Implementation tasks

- [x] Add durable unified conflict records and conflict-only snapshots to shared sync state.
- [x] Replace runtime conflict-copy creation with queued conflicts and path-scoped sync pauses.
- [x] Convert rejected local mutations into queued conflicts using current Cloud content.
- [x] Add automatic three-way text merging and unresolved-change choices.
- [x] Unify bootstrap conflicts with the durable queue.
- [x] Add generic inspect, draft-save, and resolve bridge operations on desktop and portable hosts.
- [x] Build the responsive queue, plain-language merge workflow, auto-next behavior, and exit protection.
- [x] Detect legacy conflict-copy names and expose non-destructive review/cleanup guidance.
- [x] Add the authorized historical revision API used when an upgraded client lacks a local base snapshot.
- [x] Wire iOS and Android adapters.
- [x] Run complete tests/builds, update release documentation, and replace the captioned demo.

## Success criteria

1. Simultaneous edits on desktop and mobile never create another `(cloud conflict)` file.
2. Disjoint text edits merge without prompting and converge on both devices.
3. Overlapping edits remain byte-for-byte recoverable across sync runs and app restarts.
4. The resolver shows a real last-synced/local/Cloud comparison and lets the user choose each overlapping change.
5. Delete, move, binary, and path conflicts have safe, understandable whole-file choices.
6. Unresolved task data is excluded from Tasks, Calendar, and Kanban, while the user's local note remains visible and recoverable.
7. Unrelated files continue syncing while conflicts wait.
8. A stale action cannot overwrite a newer local or Cloud revision.
9. Desktop, iOS, and Android use the same conflict model and expose a reachable resolver.
10. Existing conflict copies remain untouched unless the user explicitly confirms cleanup.

## Open questions

None blocking. The approved direction is the broadest safe behavior: automatic clean merges, explicit decisions only for overlap, cross-platform support, and no destructive legacy migration.
