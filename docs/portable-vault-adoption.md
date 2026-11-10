# Adopting `@zennotes/portable-vault` on the phones

Status: plan for Phase 1c (iPhone) and 1d (Android) of the Cloud-in-the-browser
build order (`docs/ideas/cloud-in-browser.md`, "Step zero"). Nothing here is
done in the phone repos yet.

`packages/portable-vault` is the phones' vault layer and Cloud glue, lifted
from the iPhone's `src/bridge/` onto host interfaces (`src/host.ts`) and then
reconciled with the Android copy, family by family. Each phone adopts it the
way it adopts app-core: as an immutable vendored tarball, packed beside the
other three by `tooling/scripts/pack-app-core.mjs`, whose manifest now lists it
as a third entry in `dependencies`.

Both adoptions aim at no change a person notices beyond the reconciled fixes
listed under "What each phone gets". Every shared rule below applies to both;
the per-phone sections list only what differs.

## 0. Before the next core release: teach the tooling the fourth tarball

This has to come first, on both phones, in the release cycle where this
package lands on `main`. A core release now carries four archives, and the
phones' `adopt-core.mjs` refuses one it does not know (`unexpected package
@zennotes/portable-vault`), while `rewritePackageJson` and
`check-core-boundary.mjs` require a `file:` pin for every entry of the
manifest's `dependencies`. Until each phone takes step 1 below, it cannot
adopt any core release. Step 1 alone (vendor and pin the tarball, import
nothing from it yet) is safe to ship on its own; the rest of the adoption can
follow in its own phone release.

## 1. Vendor the fourth tarball

- `tooling/adopt-core.mjs`: add `'@zennotes/portable-vault'` to `CORE_PACKAGES`.
  `verifyCandidate` already checks every non-app-core entry against app-core's
  dependency list, and `rewritePackageJson` already walks
  `manifest.dependencies`; it asserts exactly one `file:` pin per entry, so
  teach it to insert a pin that is missing (the first adoption), beside the
  others. Update `adopt-core.test.mjs` for four archives and the insert.
- `tooling/check-core-boundary.mjs` loops over `manifest.dependencies`, so it
  checks the new archive's hash, pin and installed version with no change.
  Add: fail if any lifted file name (list in section 2) reappears in
  `src/bridge/`, so the copies cannot grow back, and the singleton check of
  section 10.
- `package.json`: `"@zennotes/portable-vault": "file:vendor/zennotes/zennotes-portable-vault-<version>.tgz"`.
  It pins `@zennotes/bridge-contract` and `@zennotes/shared-domain` at its own
  version suffix, the same one those two carry (one suffix for the three).

## 2. Delete the lifted files

From `src/bridge/` (and their tests, which now live in the package):

| Phone file | Package subpath |
| --- | --- |
| `vault-fs.ts` (`MobileVault`) | `@zennotes/portable-vault/vault` (`PortableVault`) |
| `vault-core.ts` | `/vault-core` |
| `welcome-note.ts` | `/welcome-note` |
| `database-open.ts` | `/database-open` |
| `link-metadata.ts` | `/link-metadata` |
| `imported-assets.ts` | `/imported-assets` |
| `events.ts` | `/events` |
| `uuid.ts` | `/uuid` |
| `base64.ts` (iPhone only) | `/base64` |
| `tikz.ts` | `/tikz` |
| `mobile-cloud-sync.ts` | `/cloud-sync` |
| `cloud-sync-client.ts` | `/cloud-sync-client` |
| `cloud-sync-repository.ts` | `/cloud-sync-repository` |
| `cloud-sync-staging.ts` | `/cloud-sync-staging` |
| `cloud-sync-refresh.ts` | `/cloud-sync-refresh` |
| `cloud-sync-work.ts` | `/cloud-sync-work` |
| `cloud-layout.ts` (Android only) | `/cloud-layout` |
| `mobile-cloud-auth.ts` | `/cloud-auth` |
| `mobile-cloud-encryption.ts` | `/cloud-encryption` |
| `mobile-direct-upload.ts` | `/direct-upload` |
| `mobile-publish-assets.ts` | `/publish-assets` |
| `remote-client.ts`, `remote-vault.ts`, `remote-workspace.ts` | `/remote-client`, `/remote-vault`, `/remote-workspace` |
| the portable half of `mobile-bridge.ts` | `/bridge` (`createPortableBridge`) |
| `fs-errors.ts` (Android only) | `/fs-errors` (`NativeFs.isNotFound` calls its `isNotFoundError`) |
| `public/tikzjax/` (both, byte-identical, ~12 MB) | `/tikzjax/*` (package files, section 3) |

Exported names are unchanged except `MobileVault` (now `PortableVault`, generic
over the file system: `PortableVault<NativeFs>` keeps `vault.fs` typed as the
phone's own NativeFs) and the bridge-side helpers listed in section 4.

What stays native: `native-fs.ts`, `icloud.ts` (iPhone), the SAF plugin
(Android), `folder-picker.ts`, `open-asset.ts`, `background-sync.ts`, the
widget files, keyboard and system-bar code, `typography-fonts.ts`, and the
Swift and Java plugins behind direct uploads.

## 3. Write the host (`src/bridge/host.ts`, new)

One `PortableHost`, installed once by `createPortableBridge(host)` before any
Cloud call (`configureMobileCloudAuth` reads it).

**VaultFileSystem + AssetUrls + SyncFastPath: NativeFs as it is, plus:**
- `syncKey` (the Cloud link key; must not change, see per-phone),
  `rootLabel` (`rootUri ?? rootPath`), and `isNotFound(error)` (section 5).
- `init()` takes over the iCloud materialize step `MobileVault.open()` used to
  run (`ensureDownloaded(rootUri, 20000)` when `isCloud`).
- `readdir`/`readdirStrict` return Capacitor `FileInfo`, which is assignable
  to `VaultDirEntry`. `fileSrc` stays synchronous.

**HttpTransport:** `request` is `CapacitorHttp.request` (the package turned
every `get`/`post` into `request` with a method), `putFile` is
`ZenDirectUpload.put`. Register `ZenDirectUpload` once, in `native-fs.ts`, and
hand the same proxy to `putFile`: today `native-fs.ts` and
`cloud-sync-client.ts` each call `registerPlugin('ZenDirectUpload')`, and
Capacitor keeps the first registration's shape.

**TikZJax:** delete `public/tikzjax/` and serve the package's
`assets/tikzjax/` at the same `tikzjax/` path (a Vite copy step from
`node_modules/@zennotes/portable-vault/assets/tikzjax`, or `publicDir`
pointing at a folder the build fills). `tikz.ts` still loads
`tikzjax/tikzjax.js` relative to the page, so nothing else moves.

**HostStorage, two instances:**
- `storage`: text files in `Directory.Data` (UTF-8, `recursive: true`), where
  the link, sync state and scan cache always lived; keys are the same
  `zennotes-cloud-sync/...` paths. `read` answers null only when
  `isNotFound(error)`, and throws otherwise.
- `preferences`: Capacitor Preferences (remote-workspace profiles and mode;
  keys `zn-remote-profiles`, `zn-workspace-mode`, unchanged).

**SecretStorage:** `@aparajita/capacitor-secure-storage`. `available()` is
`Capacitor.isNativePlatform()`. `prepare()` is the old `configureSecureStorage`:
`setKeyPrefix('zennotes.cloud.')`, `setSynchronize(false)`,
`setDefaultKeychainAccess(whenUnlockedThisDeviceOnly)`, then
`migrateAuthStoragePrefix()` (the `capacitor-storage_` move), all of which left
`mobile-cloud-auth.ts`. Its test moves with it (the package's
`mobile-cloud-auth.test.ts` header lists the cases).

**HostShell:**
- `appInfo()`: built per call, version from `loadNativeAppVersion()`
  (`CapApp.getInfo`, bounded by `waitAtBoot`).
- `platform`, `listSystemFonts`, `updatesMessage`, `unavailableWhere`,
  `drawingsViewOnly`: the values each bridge had (per-phone).
- `writeClipboard`: `Clipboard.write({ string })`.
- `saveDownload`: `Filesystem.downloadFile` to
  `zennotes-cloud-backups/<uuid>/<fileName>` in `Directory.Cache`
  (`recursive`, the given headers and timeouts), `Filesystem.getUri`, then
  `Share.share({ title, files: [uri] })`; a `/cancel/i` rejection resolves.
- `cloud`: `{ platform, deviceName, developmentBaseUrl: import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL, allowInsecureLoopback: import.meta.env.DEV, accountKeyScheme }`.
- `remoteConnectionHint`: `localNetworkConnectionHint` (iPhone) or
  `userCertificateConnectionHint` (Android), both exported by `/remote-client`.

**AppLifecycle:**
- `onOpenUrl` / `launchUrl` / `onActiveChange`: `CapApp.addListener('appUrlOpen')`,
  `CapApp.getLaunchUrl()` (its `url`), `CapApp.addListener('appStateChange')`.
- `leftApp` / `returnedToApp`: `background-sync.ts`'s `leaveApp` / `returnToApp`.
  **That module must import `stopMobileCloudRequests` /
  `resumeMobileCloudRequests` from `@zennotes/portable-vault/cloud-sync-client`**,
  the request lifetime the package's auth reads; a leftover local copy would
  stop a different lifetime and leave Cloud requests running in the background.

**Prove the file system with the contract.** Run
`vaultFileSystemContract` (`@zennotes/portable-vault/vault-fs-contract`) over
the host's NativeFs in the phone's own test runner, each case once per tier
it can reach (on-device, iCloud, SAF): a harness that creates a vault folder,
reopens it as after a relaunch, and breaks the store underneath (a revoked
permission, a provider gone). It fails an adapter that reads a failed listing
as an empty folder or a failed stat as a missing file, which is the class that
plans deleting a vault.

**HostVaults** (the tiers stay in `mobile-bridge.ts`; each calls
`openPortableVault(name, new NativeFs(name, url))` and then writes
`zn-mobile:current-vault` itself, as `openVaultByName` did):
- `openDefault`: the old `openLocalVaultTier`, seeding with
  `seedWelcomeNote(welcomeNoteBody(isPhoneViewport(), '<platform>'))`.
- `list`, `open(root)`, `select(path)`, `browse(path)`: the local branches of
  the old bridge methods. The bridge calls `disconnectRemote()` before `open`.
- `pick`: picker first, then `disconnectRemote()` only once a folder came back.
- `describeRoot`: the old `friendlyVaultRoot`.
- `openAssetExternally(relPath)`: `openAssetExternally(activeVault(), relPath)`.

## 4. Slim `mobile-bridge.ts`

It keeps: the tier tokens and `listSwitchableVaults`, `renameVault` /
`deleteVault` / `moveVault` (with `relocateLocalVault` from
`@zennotes/app-core/workspace`, which stays with the host), `bootVault`
(now `bootPortableVault()`), `isFirstRun`, `activeVaultStateKey`,
`activeVaultNativeRoot`, `importPendingShares` (iPhone), `loadNativeAppVersion`,
and the install: `installZenBridge(createPortableBridge(host))`. It re-exports
from `/bridge`: `activeVault`, `activePortableVault` (was the private
`activeMobileVault`), `currentVaultFolderName`, `describeCurrentVault`,
`isMobileNoteIndexReady`, `openPortableVault`, and `cloudBackgroundSyncHost`
(was `mobileBackgroundSyncHost`; same `ready` / `sync` / `onVaultChange`).

Boot order does not move: the inline prefs script in `index.html` still runs
before any module, and the host is installed before the store subscribers and
the first Cloud call.

## 5. Shared decisions the hosts implement

- **Not found means a stable native code, never a message.** Android's rule,
  now the package's `isNotFoundError` (`/fs-errors`: `OS-PLUG-FILE-0008`,
  `ZN-SAF-NOT-FOUND`). The iPhone also accepted any "does not exist" message,
  for the `npm run dev` web fallback; that predicate decides re-bootstrap and
  deletes, so keep the message match only under `import.meta.env.DEV`, if at
  all.
- **Welcome bodies come from the package** (`welcomeNoteBody(phoneLayout,
  'ios' | 'android')`), so the seed hash set has one owner. A new body must add
  its hash in the package, and the package test fails if it does not.

## 6. iPhone (1c)

- `syncKey`: `rootPath` (`ZenNotes/<name>`); never the container URI, whose
  UUID iOS rotates.
- `accountKeyScheme: 'labeled'` (existing unlocked keys are under
  `cloud-e2ee:<base url>#<email>`).
- `platform: 'darwin'`, fonts `TYPOGRAPHY_FONT_FAMILIES`,
  `updatesMessage: 'Updates are delivered through the App Store.'`,
  `unavailableWhere: 'on iPhone'`, `drawingsViewOnly: isPhoneDevice`,
  `cloud.platform: 'ios'`, `deviceName: 'ZenNotes iPhone'`.
- No `cloudTimeouts` (the package default is the iPhone's), no
  `putsInMemoryBodies` (in-memory PUTs stay on CapacitorHttp).

## 7. Android (1d)

- `syncKey`: `rootUri ?? rootPath` (Android's existing key; changing it
  orphans every link, state and scan cache).
- `accountKeyScheme: 'hashed'` (`e2ee-account-key.<sha256>`).
- `http.cloudTimeouts`: `({ timeoutMs }) => ({ connectTimeout: CLOUD_CONNECT_TIMEOUT_MS, readTimeout: timeoutMs ?? CLOUD_STALL_TIMEOUT_MS })`
  (Android's read timeout restarts per byte). `http.putsInMemoryBodies: true`
  (every object PUT goes through `ZenDirectUpload.put`, as today).
- `NativeFs.sealForUpload(sourceUri, keys)` takes the base64 `Zne1NativeKeys`
  and returns a `Zne1NativeSealedFile` (the iPhone's shape); today it takes
  byte params and encodes them itself. The package passes base64.
- `vaultsRoot()` / `initVaultsRoot()` stay in the host (`openDefault` runs
  `initVaultsRoot` first, as `bootVault` did). External-vault tokens
  (`zn://external-vaults/<bookmark>`) stay in `mobile-bridge.ts`.
- `platform: 'android'`, the bridge's font list, `unavailableWhere: 'in the
  mobile app'`, `cloud.platform: 'android'`, `deviceName: 'ZenNotes Android'`,
  `welcomeNoteBody(…, 'android')`, `remoteConnectionHint: userCertificateConnectionHint`.
- `appInfo().version` from `loadNativeAppVersion()` (`CapApp.getInfo()`,
  `versionName`), as today; `'1.1.57'` stays only as the boot fallback. The
  package builds the update and Raycast states per call, so they no longer
  freeze at the fallback.
- Delete Android's own remote poller (now in the package's
  `remote-workspace.ts`) and its diffing `RemoteVault.rescan` (now `poll()`).

## 8. What each phone gets (release notes, QA)

The iPhone gains:
- Search never lists or reads the template folder (fewer reads).
- Removing or regenerating the demo tour never touches a folder named like an
  old tour note.
- Linking to a Cloud vault with the other layout moves notes to match before
  the first sync, so nothing shows twice (zennotesandroid#17).
- Live updates from a self-hosted server, polled every 4 s while visible.
- An unreadable encryption key reads as locked instead of failing sync; a
  failed key sweep no longer blocks signing in, and signing out sweeps keys
  before removing the credential.
- A local edit during an encrypted upload reports "changed while uploading",
  not "damaged".

Android gains:
- Deleting an attachment can no longer strand it where Trash cannot see it,
  and restore reads the stored record, never the caller's name.
- The native version in the update and Raycast states too (they froze at the
  `'1.1.57'` fallback).
- No auto-sync error loop in a self-hosted workspace (`getCloudVaultLink` is null).
- Self-hosted asset operations (server 2.24): duplicate, delete, restore.
- A 100 MB cap with a clear message for multipart publishes, encoded with
  FileReader (about a sixth of the memory).
- The first field error of a refused sign-in, the E2EE header on backup
  downloads, a clear "cannot seal" message, and a foreground in a remote
  workspace announces one resync (the 4 s poll still sends per-note events).

## 9. Decisions for Adib before 1d ships

- `updatesMessage` on Android: today's text says "App Store". Proposed:
  "Updates are delivered through Google Play."
- `drawingsViewOnly` on Android: the iPhone gates on the device (an iPad in
  Split View keeps editable drawings); Android gates on the layout. Adopting
  the iPhone rule needs an `isPhoneDevice` in Android's `viewport.ts`.
- Layout reconciliation on join now runs on the iPhone too (it was
  Android-only). It is best-effort and never breaks a link; say if the
  iPhone should opt out.

## 10. Upgrade safety (runtime, not typecheck)

A typecheck proves none of these; an upgrade from the build in the store does.

- **Storage identity is byte-identical.** `STORAGE_ROOT = 'zennotes-cloud-sync'`
  and every key under it (links, states, retired states, scan cache, all keyed
  by the SHA-256 of `syncKey`), `syncKey` itself (section 6, 7), the secure
  store's `zennotes.cloud.` prefix and its keys (`credential`, `pending-auth`,
  the account key under the host's scheme), the Preferences keys
  (`zn-remote-profiles`, `zn-workspace-mode`), and the host's own
  `zn-mobile:current-vault`. A changed byte reads as a first launch: a
  re-bootstrap, a forgotten offline delete, a lost sign-in or a locked vault.
- **One registration of `ZenDirectUpload`** (section 3).
- **One copy of each singleton.** The host installed once; one
  `@zennotes/portable-vault` in `node_modules` (extend the singleton check in
  `check-core-boundary.mjs` to it, as for React), and no local copy of
  `events.ts` or `cloud-sync-client.ts` left behind: a second events module
  is a second vault-change bus app-core never hears, and a second client
  module is a second request lifetime (section 3, AppLifecycle).
- **No static app-core import from the package** (the boundary check enforces
  it). The host's own app-core imports keep their place in the boot order:
  native preferences before any app-core module, the Home guard before store
  subscribers.

## 11. The gate

Before and after adoption, same results: the phone's `npm test`, `npm run
typecheck`, `npm run upstream` (boundaries + typecheck), the runtime gates
(`tooling/native-boundary-fixture.ts`, `tooling/cloud-ui-tests.mjs`,
`tooling/cloud-direct-upload-e2e.mjs`, the ZNE1 cipher tests,
`adopt-core.test.mjs`), a build from a clean checkout with only the vendored
tarballs, the VaultFileSystem contract over the host's NativeFs, and a manual
pass on a simulator or emulator: read and write notes, attachments, rename,
trash and restore, Cloud sync of a test vault, E2EE unlock, a self-hosted
workspace, a TikZ block.

And the upgrade test: install the build that is in the store, link a vault to
Cloud and sync it, make an offline edit, then install the adopted build over
it without uninstalling. The linked vault keeps its link and state (no
bootstrap, no first-sync conflicts), the offline edit goes up on the next
sync, the account stays signed in and an unlocked encrypted vault stays
unlocked, and saved self-hosted profiles are still there.

## Notes for the browser host (Phase 2)

- Without the sync fast path, Cloud sync uses shared-domain's
  `PortableCloudSyncRepository`, which reads every file and has neither the
  scan cache nor the untouched-Welcome holdback (both live in
  `CachedCloudSyncRepository`). A browser vault seeded with the Welcome would
  raise a conflict on its first link; give the browser host its own holdback
  or seed differently before Phase 4.
- `HttpTransportRequest` with `dataType: 'formData'` carries CapacitorHttp's entry
  list (`HttpTransportFormEntry`); a fetch-based host rebuilds a FormData from it.
- `MemoryVaultFileSystem` (`/memory-fs`) is the test double to start the OPFS
  file system's tests from.
