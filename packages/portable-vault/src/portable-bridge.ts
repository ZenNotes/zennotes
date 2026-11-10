/**
 * The portable half of the phones' `window.zen`: every bridge method that
 * acts on the open vault, Cloud, a remote workspace or a desktop-only stub,
 * lifted from the iPhone shell's mobile-bridge.ts (the Android shell carried
 * a copy). Where vaults live, and everything else a host does natively
 * (iCloud, the Files-app and SAF pickers, sharing an attachment, the app
 * version), comes from the PortableHost (host.ts); the host opens a vault by
 * handing its files to openPortableVault.
 *
 * `runtime` reports `'web'`: the bridge contract only knows
 * 'desktop' | 'web', and every desktop-only code path in app-core is gated on
 * `runtime === 'desktop'`, so 'web' + capability flags produces the right
 * behavior here; `hostKind` tells the shells apart.
 */
import type {
  ZenAppInfo,
  ZenBridge,
  ZenCapabilities
} from '@zennotes/bridge-contract/bridge'
import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  DirectoryBrowseResult,
  ImportedAsset,
  LocalVaultEntry,
  NoteMeta,
  RaycastExtensionStatus,
  ServerCapabilities,
  ServerSessionStatus,
  TikzRenderResponse,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch
} from '@zennotes/shared-domain/ipc'
import { createDatabaseOps } from '@zennotes/shared-domain/database-ops'
import { missingDatabaseAsNull } from './database-open'
import { resolveVaultName } from '@zennotes/shared-domain/vault-display-name'
import type {
  CustomCodeLanguage,
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from '@zennotes/shared-domain/custom-code-languages'
import type {
  ApplyWorkflowInput,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@zennotes/bridge-contract/workflows'
import type {
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@zennotes/shared-domain/mcp-clients'
import { PortableVault } from './vault-fs'
import { randomUUID } from './uuid'
import { emitVaultChange, onVaultChange, onOpenNoteRequested, requestOpenNote } from './events'
import { renderTikzOnDevice } from './tikz'
import { fetchLinkMetadataOnDevice } from './link-metadata'
import {
  connectMobileCloudAccount,
  getMobileCloudAccountStatus,
  getMobileCloudServiceAccount,
  listMobileCloudPublishedNotes,
  listMobileCloudVaults,
  logoutMobileCloudAccount,
  onMobileCloudAccountChange,
  publishMobileCloudNote,
  unpublishMobileCloudNote,
  updateMobileCloudPublishedNote
} from './mobile-cloud-auth'
import { uploadObject } from './cloud-sync-client'
import { mobilePublishAssetPlatform } from './mobile-publish-assets'
import {
  createAndLinkMobileCloudVault,
  createMobileCloudBackup,
  deleteMobileCloudBackup,
  downloadMobileCloudBackup,
  getMobileCloudBackupSchedule,
  getMobileCloudVaultLink,
  linkMobileCloudVault,
  listMobileCloudBackupItems,
  listMobileCloudBackupItemsPage,
  listMobileCloudBackups,
  restoreMobileCloudBackup,
  restoreMobileCloudBackupNote,
  syncMobileCloudVault,
  hasMobileCloudVaultChanges,
  updateMobileCloudBackupSchedule,
  unlinkMobileCloudVault,
  deleteMobileCloudVault,
  getMobileCloudSettingsConflict,
  resolveMobileCloudSettingsConflict,
  getMobileCloudConflict,
  saveMobileCloudConflictDraft,
  resolveMobileCloudConflict,
  getMobileCloudBootstrapConflict,
  resolveMobileCloudBootstrapConflict
} from './mobile-cloud-sync'
import {
  changeMobileCloudEncryptionPassphrase,
  finishMobileCloudEncryptionSetup,
  finishNewMobileCloudRecoveryKey,
  getMobileCloudEncryptionStatus,
  lockMobileCloudEncryption,
  prepareMobileCloudEncryptionSetup,
  prepareNewMobileCloudRecoveryKey,
  unlockMobileCloudEncryption
} from './mobile-cloud-encryption'
import { RemoteVault } from './remote-vault'
import {
  activeRemote,
  connectRemote,
  connectRemoteProfile,
  deleteProfile,
  disconnectRemote,
  listProfiles,
  remoteStateKey,
  remoteVaultInfo,
  remoteWorkspaceInfo,
  restoreRemoteAtBoot,
  saveProfile
} from './remote-workspace'
import { folderForRelativePath, posixNormalize } from './vault-core'
import {
  hasSyncFastPath,
  installPortableHost,
  portableHost,
  type PortableHost,
  type PortableVaultFiles
} from './host'

const PORTABLE_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  // The host's picker opens any folder it can reach as a vault (the iPhone's
  // UIDocumentPicker, Android's ACTION_OPEN_DOCUMENT_TREE); this is what
  // makes "Choose Vault Folder" work. A host without one turns it off in
  // its capabilities.
  supportsLocalFilesystemPickers: true,
  // Self-hosted ZenNotes servers connect over the host's HTTP (native on the
  // phones, so no CORS and the Bearer header works). The desktop UI entry
  // points stay hidden (they also gate on runtime === 'desktop'); the mobile
  // shell owns the connect flow via the store's actions, which gate on this
  // flag alone.
  supportsRemoteWorkspace: true,
  supportsCloudSync: true,
  supportsCliInstall: false,
  supportsCustomTemplates: true,
  // vault.json's template folder (#1024) survives a settings save here
  // (vault-fs.ts normalizes it as desktop does) and a folder rename follows
  // it, so say so rather than lean on app-core reading an absent flag as
  // yes. A self-hosted vault answers with its server's own flag instead.
  supportsTemplateFolder: true,
  // TextMate grammar import is a desktop feature for now: grammars are
  // per-app (not per-vault), so nothing desyncs by gating this off. The
  // Settings section hides itself behind this flag.
  supportsCustomCodeLanguages: false
}

function portableCapabilities(): ZenCapabilities {
  return { ...PORTABLE_CAPABILITIES, ...portableHost().shell.capabilities }
}

/** Built per call: the host's version can arrive from native code during
 *  boot, and a value captured at module load would freeze a placeholder. */
function appInfo(): ZenAppInfo {
  return portableHost().shell.appInfo()
}

function appVersion(): string {
  return appInfo().version
}

let vault: PortableVault | null = null
let indexedVault: PortableVault | RemoteVault | null = null

export function activeVault(): PortableVault | RemoteVault {
  const remote = activeRemote()
  if (remote) return remote.vault
  if (!vault) throw new Error('No vault is open')
  return vault
}

/** The open vault when it is a local one (on the device, in the browser);
 *  Cloud sync and native file reads need one. */
export function activePortableVault(): PortableVault {
  const current = activeVault()
  if (!(current instanceof PortableVault)) {
    throw new Error('ZenNotes Cloud sync is available for on-device vaults only.')
  }
  return current
}

/** The open vault as background sync sees it: ready when it is a local
 *  vault linked to the signed-in account, the check app-core's automatic
 *  sync makes before each run. */
export const cloudBackgroundSyncHost = {
  async ready(): Promise<boolean> {
    let current: PortableVault
    try {
      current = activePortableVault()
    } catch {
      return false
    }
    const status = await getMobileCloudAccountStatus()
    if (status.state !== 'connected' || !status.account) return false
    const link = await getMobileCloudVaultLink(current)
    return link !== null && link.base_url === status.account.base_url
  },
  async sync(): Promise<void> {
    await syncMobileCloudVault(activePortableVault())
  },
  onVaultChange
}

function currentVaultInfo(): VaultInfo | null {
  const remote = remoteVaultInfo()
  if (remote) return remote
  if (!vault) return null
  // The root is a label, not a path, so the core cannot read the folder's
  // name off it; folderName is what the display name falls back to and what
  // the Vault name field shows as its placeholder (ZenNotes #692).
  return { root: portableHost().vaults.describeRoot(vault), name: vault.name, folderName: vault.name }
}

/**
 * The open local vault's folder name, null in a remote workspace or before
 * boot. The Vaults sheet lists folders and must mark the one that is open
 * whatever the vault is called (rename and delete act on the folder), and
 * the core's shell snapshot carries the vault's shown name, not its folder,
 * so the sheet asks the bridge, which holds the vault by folder name.
 */
export function currentVaultFolderName(): string | null {
  if (remoteVaultInfo()) return null
  return vault?.name ?? null
}

/**
 * The open vault as the app names it: the display name from its vault.json
 * when it has one (ZenNotes #692), else the folder name. Desktop resolves
 * this in main (describeVault) before the renderer ever sees a VaultInfo,
 * and the renderer only re-derives the name after a settings save or an
 * external vault.json change, so a shell that handed over the folder name
 * would show it until the first save. Every bridge method that returns the
 * opened vault goes through here; a remote workspace's name comes from its
 * server and passes untouched. The settings read is cached after the first
 * open, and a vault whose vault.json cannot be read keeps its folder name,
 * the way it always did.
 */
export async function describeCurrentVault(): Promise<VaultInfo | null> {
  const info = currentVaultInfo()
  if (!info || remoteVaultInfo() || !vault) return info
  try {
    const settings = await vault.getVaultSettings()
    return { ...info, name: resolveVaultName(settings.displayName, info.name) }
  } catch {
    return info
  }
}

/** Whether app-core's note-index request has completed for the active vault. */
export function isMobileNoteIndexReady(): boolean {
  if (!indexedVault) return false
  try {
    return activeVault() === indexedVault
  } catch {
    return false
  }
}

async function listNotesForActiveVault(): Promise<NoteMeta[]> {
  const source = activeVault()
  const notes = await source.listNotes()
  try {
    if (activeVault() === source) indexedVault = source
  } catch {
    // The vault closed while its listing was in flight; do not mark it ready.
  }
  return notes
}

/** Opens the vault at `files` and makes it the active one. The host's tiers
 *  call this (and then remember the choice their own way); it returns the
 *  vault as the app names it. */
export async function openPortableVault<F extends PortableVaultFiles>(
  name: string,
  files: F
): Promise<VaultInfo> {
  const next = new PortableVault<F>(name, files)
  await next.open()
  vault = next
  return (await describeCurrentVault()) as VaultInfo
}

/**
 * Boot: a remembered remote workspace wins; unreachable servers fall through
 * to the host's local tiers so launch never blocks on the network.
 */
export async function bootPortableVault(): Promise<void> {
  if (await restoreRemoteAtBoot()) return
  await portableHost().vaults.openDefault()
}

// --------------------------------------------------------------------
// Databases: the shared composition (@zennotes/shared-domain/database-ops, extracted from
// the web bridge in 2.20) bound to the active vault's file ops. Remap-aware:
// the shared layout honors vault.json `systemFolderPaths` when composing
// `.base/` paths, which the old local copy of this glue did not.
// --------------------------------------------------------------------

const dbOps = createDatabaseOps({
  // Absent files answer null; real errors must throw (openDatabase reads
  // null as "bare CSV, adopt it" and writes an inferred schema over it).
  // readTextOrNull follows that contract for the local tiers.
  readFileTextOrNull: (relPath) => activeVault().fs.readTextOrNull(posixNormalize(relPath)),
  writeFile: async (relPath, text) => {
    await activeVault().writeNote(relPath, text)
  },
  createFolder: (folder, subpath) => activeVault().createFolder(folder, subpath),
  renameFolder: (folder, oldSubpath, newSubpath) =>
    activeVault().renameFolder(folder, oldSubpath, newSubpath),
  listFolders: () => activeVault().listFolders(),
  vaultLayout: async () => {
    const settings = await activeVault().getVaultSettings()
    return {
      primaryNotesAtRoot: settings.primaryNotesLocation === 'root',
      systemFolderPaths: settings.systemFolderPaths
    }
  }
})

const {
  openDatabase: openDatabaseOrThrow,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  createRecordPage,
  renameDatabase,
  listDatabases
} = dbOps
// A tab whose database is gone answers null (database-open.ts).
const openDatabase = missingDatabaseAsNull(openDatabaseOrThrow)

// --------------------------------------------------------------------
// Asset URL resolution (WebView-loadable file URLs)
// --------------------------------------------------------------------

// Remote assets: `resolve*AssetUrl` is synchronous, so the first request for
// a path returns null while the bytes are fetched natively (Bearer header:
// an <img> src could never send it); completion emits a change event for the
// requesting note, whose re-render then hits this cache.
const remoteAssetUrls = new Map<string, string>()
const remoteAssetPending = new Set<string>()

function remoteAssetUrl(assetPath: string, notePathForRerender: string | null): string | null {
  const cached = remoteAssetUrls.get(assetPath)
  if (cached) return cached
  const remote = activeRemote()
  if (!remote || remoteAssetPending.has(assetPath)) return null
  remoteAssetPending.add(assetPath)
  void remote.client
    .fetchAssetBase64(assetPath)
    .then(({ base64, mimeType }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      remoteAssetUrls.set(
        assetPath,
        URL.createObjectURL(new Blob([bytes], { type: mimeType }))
      )
      emitVaultChange({
        kind: 'change',
        path: notePathForRerender ?? assetPath,
        folder: folderForRelativePath(notePathForRerender ?? assetPath) ?? 'inbox',
        scope: 'content'
      })
    })
    .catch(() => {})
    .finally(() => remoteAssetPending.delete(assetPath))
  return null
}

function resolveLocalAssetUrl(_vaultRoot: string, notePath: string, href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const stripQueryAndHash = (value: string): string => {
    const hashIdx = value.indexOf('#')
    const queryIdx = value.indexOf('?')
    const cutIdx =
      hashIdx === -1 ? queryIdx : queryIdx === -1 ? hashIdx : Math.min(hashIdx, queryIdx)
    return cutIdx === -1 ? value : value.slice(0, cutIdx)
  }
  let decoded = stripQueryAndHash(trimmed)
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep raw
  }
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  let target: string
  if (decoded.startsWith('/')) {
    target = decoded.replace(/^\/+/, '')
  } else if (noteDir) {
    target = `${noteDir}/${decoded}`
  } else {
    target = decoded
  }
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null
  if (activeRemote()) return remoteAssetUrl(target, notePath)
  return vault?.fs.fileSrc(target) ?? null
}

function resolveVaultAssetUrl(_vaultRoot: string, assetPath: string): string | null {
  const trimmed = assetPath.trim()
  if (!trimmed) return null
  const normalized = posixNormalize(trimmed.replace(/^\/+/, ''))
  if (normalized.startsWith('../') || normalized === '..') return null
  if (activeRemote()) return remoteAssetUrl(normalized, null)
  return vault?.fs.fileSrc(normalized) ?? null
}

function vaultAssetPath(assetPath: string): string {
  const normalized = posixNormalize(String(assetPath ?? '').trim().replace(/^\/+/, ''))
  if (!normalized || normalized.startsWith('../') || normalized === '..') {
    throw new Error('Asset path is invalid.')
  }
  return normalized
}

async function readVaultAssetBase64(assetPath: string): Promise<string> {
  const normalized = vaultAssetPath(assetPath)
  const remote = activeRemote()
  if (remote) return (await remote.client.fetchAssetBase64(normalized)).base64
  return await activePortableVault().fs.readBase64(normalized)
}

/** A published note's attachments, for the staged publish: a local vault
 *  with the native sync path has its files fingerprinted and uploaded
 *  natively; a remote vault's, or a host's without that path, go as base64. */
const mobilePublishAssets = mobilePublishAssetPlatform({
  async fingerprint(assetPath) {
    const normalized = vaultAssetPath(assetPath)
    if (activeRemote()) return null
    const files = activePortableVault().fs
    if (!hasSyncFastPath(files)) return null
    const print = await files.readForSync(normalized, false)
    return { uri: print.uri, sha256: print.sha256, byteLength: print.byteLength }
  },
  readBase64: readVaultAssetBase64
}, uploadObject)

// --------------------------------------------------------------------
// Dropped-file token bucket (mirrors the web bridge)
// --------------------------------------------------------------------

const droppedFiles = new Map<string, File>()

function getPathForFile(file: File): string | null {
  if (!file) return null
  const token = `mobile-drop://${randomUUID()}/${encodeURIComponent(file.name)}`
  droppedFiles.set(token, file)
  return token
}

async function importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]> {
  const results: ImportedAsset[] = []
  for (const raw of sourcePaths) {
    const file = droppedFiles.get(raw)
    if (!file) continue
    results.push(await activeVault().importDroppedFile(notePath, file))
    droppedFiles.delete(raw)
  }
  return results
}

// --------------------------------------------------------------------
// Stubs shared with the web bridge (desktop-only surfaces)
// --------------------------------------------------------------------

function notImplemented(name: string): never {
  throw new Error(`zen.${name} is not available ${portableHost().shell.unavailableWhere}`)
}

function unsupportedUpdateState(): AppUpdateState {
  return {
    phase: 'unsupported',
    currentVersion: appVersion(),
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    installable: false,
    message: portableHost().shell.updatesMessage
  }
}

const PORTABLE_CLI_STATUS: CliInstallStatus = {
  available: false,
  reason: 'CLI installation is only available in the desktop build.',
  defaultTarget: '',
  requiresSudo: false,
  targetOnPath: false,
  pathHint: null,
  installedAt: null,
  installedByThisApp: false,
  supportedPlatform: false
}

function portableRaycastStatus(): RaycastExtensionStatus {
  return {
    available: false,
    reason: 'Raycast extension installation is only available in the macOS desktop build.',
    supportedPlatform: false,
    installed: false,
    upToDate: false,
    extensionPath: '',
    sourcePath: null,
    raycastInstalled: false,
    nodeAvailable: false,
    npmAvailable: false,
    nodePath: null,
    npmPath: null,
    nodeVersion: null,
    npmVersion: null,
    nodeMeetsMinimum: false,
    npmMeetsMinimum: false,
    installedVersion: null,
    bundledVersion: appVersion(),
    lastInstalledAt: null
  }
}

// --------------------------------------------------------------------
// The bridge object
// --------------------------------------------------------------------

const portableBridge: ZenBridge = {
  getCapabilities: (): ZenCapabilities => portableCapabilities(),
  getAppInfo: (): ZenAppInfo => appInfo(),

  platform: async () => portableHost().shell.platform,
  platformSync: () => portableHost().shell.platform,
  // The host's list: a WebView cannot enumerate fonts, so a phone offers the
  // families it can render and the ones it ships itself.
  listSystemFonts: () => portableHost().shell.listSystemFonts(),
  getAppIconDataUrl: async () => null,
  zoomInApp: async () => 1,
  zoomOutApp: async () => 1,
  resetAppZoom: async () => 1,
  getAppUpdateState: async () => unsupportedUpdateState(),
  checkForAppUpdates: async () => unsupportedUpdateState(),
  checkForAppUpdatesWithUi: async () => {},
  downloadAppUpdate: async () => unsupportedUpdateState(),
  installAppUpdate: async () => {},

  getCloudAccountStatus: getMobileCloudAccountStatus,
  connectCloudAccount: connectMobileCloudAccount,
  logoutCloudAccount: logoutMobileCloudAccount,
  onCloudAccountChange: onMobileCloudAccountChange,
  getCloudServiceAccount: getMobileCloudServiceAccount,
  listCloudPublishedNotes: listMobileCloudPublishedNotes,
  publishCloudNote: (input) => publishMobileCloudNote(input, mobilePublishAssets),
  updateCloudPublishedNote: (shareId, input) => updateMobileCloudPublishedNote(shareId, input, mobilePublishAssets),
  unpublishCloudNote: unpublishMobileCloudNote,
  listCloudVaults: listMobileCloudVaults,
  getCloudVaultLink: () => {
    // app-core's auto-sync controller polls this every tick. A self-hosted
    // remote workspace has no local vault to link, that is a null, not
    // an error the controller would retry forever.
    const current = activeVault()
    return current instanceof PortableVault
      ? getMobileCloudVaultLink(current)
      : Promise.resolve(null)
  },
  linkCloudVault: (vaultId) => linkMobileCloudVault(activePortableVault(), vaultId),
  createAndLinkCloudVault: (name, options) =>
    createAndLinkMobileCloudVault(activePortableVault(), name, { encrypted: options?.encrypted === true }),
  // encryptCloudVault stays undefined: moving a readable vault into an
  // encrypted one is a desktop action in v1, and Settings hides it here.
  getCloudEncryptionStatus: getMobileCloudEncryptionStatus,
  prepareCloudEncryptionSetup: prepareMobileCloudEncryptionSetup,
  finishCloudEncryptionSetup: finishMobileCloudEncryptionSetup,
  unlockCloudEncryption: unlockMobileCloudEncryption,
  changeCloudEncryptionPassphrase: changeMobileCloudEncryptionPassphrase,
  prepareNewCloudRecoveryKey: prepareNewMobileCloudRecoveryKey,
  finishNewCloudRecoveryKey: finishNewMobileCloudRecoveryKey,
  lockCloudEncryption: lockMobileCloudEncryption,
  unlinkCloudVault: () => unlinkMobileCloudVault(activePortableVault()),
  deleteCloudVault: () => deleteMobileCloudVault(activePortableVault()),
  getCloudSettingsConflict: () => getMobileCloudSettingsConflict(activePortableVault()),
  resolveCloudSettingsConflict: (choice) =>
    resolveMobileCloudSettingsConflict(activePortableVault(), choice),
  syncCloudVault: () => syncMobileCloudVault(activePortableVault()),
  hasCloudVaultChanges: () => {
    const vault = activeVault()
    return vault instanceof PortableVault ? hasMobileCloudVaultChanges(vault) : Promise.resolve(false)
  },
  getCloudBootstrapConflict: (conflict) =>
    getMobileCloudBootstrapConflict(activePortableVault(), conflict),
  resolveCloudBootstrapConflict: (resolution) =>
    resolveMobileCloudBootstrapConflict(activePortableVault(), resolution),
  getCloudConflict: (conflictId) =>
    getMobileCloudConflict(activePortableVault(), conflictId),
  saveCloudConflictDraft: (conflictId, draftText) =>
    saveMobileCloudConflictDraft(activePortableVault(), conflictId, draftText),
  resolveCloudConflict: (resolution) =>
    resolveMobileCloudConflict(activePortableVault(), resolution),
  listCloudBackups: () => listMobileCloudBackups(activePortableVault()),
  getCloudBackupSchedule: () => getMobileCloudBackupSchedule(activePortableVault()),
  updateCloudBackupSchedule: (enabled) =>
    updateMobileCloudBackupSchedule(activePortableVault(), enabled),
  listCloudBackupItems: (backupId) =>
    listMobileCloudBackupItems(activePortableVault(), backupId),
  listCloudBackupItemsPage: (backupId, query) =>
    listMobileCloudBackupItemsPage(activePortableVault(), backupId, query),
  createCloudBackup: (label) => createMobileCloudBackup(activePortableVault(), label),
  downloadCloudBackup: (backupId) => downloadMobileCloudBackup(activePortableVault(), backupId),
  deleteCloudBackup: (backupId) => deleteMobileCloudBackup(activePortableVault(), backupId),
  restoreCloudBackup: (backupId) => restoreMobileCloudBackup(activePortableVault(), backupId),
  restoreCloudBackupNote: (backupId, snapshotItemId) =>
    restoreMobileCloudBackupNote(activePortableVault(), backupId, snapshotItemId),

  getServerCapabilities: async (): Promise<ServerCapabilities | null> =>
    activeRemote()?.capabilities ?? null,
  getServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  loginServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  logoutServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  getRemoteWorkspaceInfo: async () => remoteWorkspaceInfo(),
  connectRemoteWorkspace: (baseUrl, authToken) => connectRemote(baseUrl, authToken),
  disconnectRemoteWorkspace: async () => {
    await disconnectRemote()
    // Reopen the remembered local tier so the app lands somewhere real.
    await portableHost().vaults.openDefault()
    return describeCurrentVault()
  },
  // A portable host never boots into a broken workspace (an unreachable
  // remote falls back to the local vault in bootPortableVault), so "retry"
  // simply reports where the app already landed.
  retryWorkspaceBoot: () => describeCurrentVault(),
  listRemoteWorkspaceProfiles: () => listProfiles(),
  saveRemoteWorkspaceProfile: (input) => saveProfile(input),
  deleteRemoteWorkspaceProfile: (id) => deleteProfile(id),
  connectRemoteWorkspaceProfile: (id) => connectRemoteProfile(id),

  getCurrentVault: () => describeCurrentVault(),
  listLocalVaults: (): Promise<LocalVaultEntry[]> => portableHost().vaults.list(),
  openLocalVault: async (root: string) => {
    // One entry point for switching to any vault the host can reach (its
    // tiers decide what a root names). Either way leaves remote mode.
    await disconnectRemote()
    return await portableHost().vaults.open(root)
  },
  closeVault: () => describeCurrentVault(),
  // The host leaves remote mode itself (disconnectRemote) once a folder was
  // actually picked, so a dismissed picker changes nothing.
  pickVault: () => portableHost().vaults.pick(),
  selectVaultPath: async (path: string) => {
    // In a remote workspace this is the server-side vault chooser (fed by
    // browseServerDirectories below), matching the desktop flow.
    const remote = activeRemote()
    if (remote) {
      const serverVault = await remote.client.selectVaultPath(path)
      remote.serverVault = serverVault
      remote.vault = new RemoteVault(
        remote.client,
        serverVault,
        remoteStateKey(remote.client.baseUrl, serverVault)
      )
      return currentVaultInfo() as VaultInfo
    }
    return await portableHost().vaults.select(path)
  },
  browseServerDirectories: async (path = ''): Promise<DirectoryBrowseResult> => {
    const remote = activeRemote()
    if (remote) return await remote.client.browseDirectories(path)
    return await portableHost().vaults.browse(path)
  },
  getVaultSettings: () => activeVault().getVaultSettings(),
  setVaultSettings: (next) => activeVault().setVaultSettings(next),
  readWorkspaceState: () => activeVault().readWorkspaceState(),
  writeWorkspaceState: (json) => activeVault().writeWorkspaceState(json),
  rootContentHiddenByInboxMode: () => activeVault().rootContentHiddenByInboxMode(),

  listNotes: listNotesForActiveVault,
  listFolders: () => activeVault().listFolders(),
  listAssets: () => activeVault().listAssets(),
  hasAssetsDir: () => activeVault().hasAssetsDir(),
  generateDemoTour: () => activeVault().generateDemoTour(),
  removeDemoTour: () => activeVault().removeDemoTour(),
  listTemplates: () => activeVault().listTemplates(),
  readTemplate: (sourcePath) => activeVault().readTemplate(sourcePath),
  writeTemplate: (input) => activeVault().writeTemplate(input),
  deleteTemplate: (sourcePath) => activeVault().deleteTemplate(sourcePath),

  // Workflows are not offered on mobile: the Settings toggle is hidden by the
  // shell (MobileShell mobilizer), so none of these surfaces render. The
  // stubs mirror the web bridge: empty reads, honest rejections for anything
  // that would pretend to write. Note the vault may genuinely CONTAIN
  // `.zennotes/workflows/` files (synced from a desktop via iCloud), they
  // are simply inert here, exactly like on the web.
  listWorkflows: async (): Promise<WorkflowFile[]> => [],
  writeWorkflow: (_input: WriteWorkflowInput): Promise<WorkflowFile> =>
    Promise.reject(new Error('Editing workflows is available in the ZenNotes desktop app.')),
  deleteWorkflow: (_sourcePath: string): Promise<void> =>
    Promise.reject(new Error('Editing workflows is available in the ZenNotes desktop app.')),
  applyWorkflow: (_input: ApplyWorkflowInput): Promise<WorkflowRunReceipt> =>
    Promise.reject(new Error('Running workflows is available in the ZenNotes desktop app.')),
  undoWorkflowRun: (_runId: string): Promise<WorkflowUndoResult> =>
    Promise.reject(new Error('Running workflows is available in the ZenNotes desktop app.')),
  listWorkflowRuns: async (): Promise<WorkflowRunSummary[]> => [],
  deleteWorkflowRuns: async (_workflowId: string): Promise<number> => 0,
  getVaultTextSearchCapabilities: async (): Promise<VaultTextSearchCapabilities> => ({
    ripgrep: false,
    fzf: false
  }),
  searchVaultText: (
    query: string,
    _backend: VaultTextSearchBackendPreference = 'auto'
  ): Promise<VaultTextSearchMatch[]> => activeVault().searchVaultText(query),
  readNote: async (relPath) => {
    const content = await activeVault().readNote(relPath)
    // Drawings are view-only on phones (spec 06 defers touch drawing):
    // injecting viewModeEnabled at read time makes Excalidraw load with no
    // editing chrome: pan/zoom only. Never persisted (see writeNote). The
    // host decides when (the iPhone asks the DEVICE, not the layout, so an
    // iPad in Split View keeps editable drawings).
    if (portableHost().shell.drawingsViewOnly() && relPath.toLowerCase().endsWith('.excalidraw')) {
      try {
        const doc = JSON.parse(content.body) as { appState?: Record<string, unknown> }
        doc.appState = { ...(doc.appState ?? {}), viewModeEnabled: true }
        return { ...content, body: JSON.stringify(doc, null, 2) }
      } catch {
        // unparsable drawing: let the editor surface it as-is
      }
    }
    return content
  },
  readNoteComments: (relPath) => activeVault().readNoteComments(relPath),
  writeNoteComments: (relPath, comments) => activeVault().writeNoteComments(relPath, comments),
  scanTasks: () => activeVault().scanTasks(),
  scanTasksForPath: (relPath) => activeVault().scanTasksForPath(relPath),
  openDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  renameDatabase,
  createRecordPage,
  listDatabases,
  writeNote: (relPath, body) => {
    // Insurance for the view-only drawing injection above: never let
    // viewModeEnabled reach disk, or desktop would open the drawing locked.
    if (relPath.toLowerCase().endsWith('.excalidraw')) {
      try {
        const doc = JSON.parse(body) as { appState?: Record<string, unknown> }
        if (doc.appState && 'viewModeEnabled' in doc.appState) {
          delete doc.appState.viewModeEnabled
          body = JSON.stringify(doc, null, 2)
        }
      } catch {
        // not JSON: write as-is
      }
    }
    return activeVault().writeNote(relPath, body)
  },
  appendToNote: (relPath, body, position) => activeVault().appendToNote(relPath, body, position),
  createNote: (folder, title, subpath) => activeVault().createNote(folder, title, subpath),
  createExcalidraw: (folder, subpath, title) =>
    activeVault().createExcalidraw(folder, subpath, title),
  renameNote: (relPath, nextTitle) => activeVault().renameNote(relPath, nextTitle),
  deleteNote: (relPath) => activeVault().deleteNote(relPath),
  moveToTrash: (relPath) => activeVault().moveToTrash(relPath),
  restoreFromTrash: (relPath) => activeVault().restoreFromTrash(relPath),
  emptyTrash: () => activeVault().emptyTrash(),
  archiveNote: (relPath) => activeVault().archiveNote(relPath),
  unarchiveNote: (relPath) => activeVault().unarchiveNote(relPath),
  duplicateNote: (relPath) => activeVault().duplicateNote(relPath),
  exportNotePdf: async () => {
    throw new Error('PDF export is available in the ZenNotes desktop app.')
  },
  // The command is gated on runtime === 'desktop', so this never surfaces;
  // the reject keeps the contract honest if it ever does.
  exportNoteDocx: async () => {
    throw new Error('Word export is available in the ZenNotes desktop app.')
  },
  revealNote: async () => {},
  revealNoteTarget: async () => {},
  revealFilePath: async () => {},
  // External file links name OS paths outside the app's sandbox; the exact
  // 'desktop-only' token makes app-core show its friendly toast.
  openExternalFile: async () => ({ ok: false, error: 'desktop-only' }),
  openExternalUrl: async () => ({ ok: false, error: 'desktop-only' }),
  // A vault attachment, unlike an arbitrary OS path, is a file this app owns,
  // so the host can genuinely open it (share sheet / Quick Look) instead
  // of answering 'desktop-only' the way the web bridge must.
  openAssetExternally: (relPath) => portableHost().vaults.openAssetExternally(relPath),
  // Bookmark cards fetch open-graph metadata through the host's HTTP
  // (link-metadata.ts): a WebView fetch of an arbitrary page is CORS-blocked.
  fetchLinkMetadata: (url) => fetchLinkMetadataOnDevice(url),
  moveNote: (relPath, targetFolder, targetSubpath) =>
    activeVault().moveNote(relPath, targetFolder, targetSubpath),
  importFilesToNote,
  importPastedImage: (input) => activeVault().importPastedImage(input),
  readVaultAssetBase64,
  renameAsset: (relPath, nextName): Promise<AssetMeta> =>
    activeVault().renameAsset(relPath, nextName),
  moveAsset: (relPath, targetDir): Promise<AssetMeta> =>
    activeVault().moveAsset(relPath, targetDir),
  duplicateAsset: (relPath): Promise<AssetMeta> => activeVault().duplicateAsset(relPath),
  deleteAsset: (relPath): Promise<DeletedAsset> => activeVault().deleteAsset(relPath),
  restoreDeletedAsset: (asset): Promise<AssetMeta> => activeVault().restoreDeletedAsset(asset),
  listDeletedAssets: (): Promise<DeletedAsset[]> => activeVault().listDeletedAssets(),
  purgeDeletedAsset: (undoToken): Promise<void> => activeVault().purgeDeletedAsset(undoToken),
  emptyDeletedAssets: (): Promise<void> => activeVault().emptyDeletedAssets(),
  createFolder: (folder, subpath) => activeVault().createFolder(folder, subpath),
  renameFolder: (folder, oldSubpath, newSubpath) =>
    activeVault().renameFolder(folder, oldSubpath, newSubpath),
  deleteFolder: (folder, subpath) => activeVault().deleteFolder(folder, subpath),
  duplicateFolder: (folder, subpath) => activeVault().duplicateFolder(folder, subpath),
  revealFolder: async () => {},
  revealFolderTarget: async () => {},
  revealAssetsDir: async () => {},
  getPathForFile,
  openFolderTemporary: async () => {},
  resolveLocalAssetUrl,
  resolveVaultAssetUrl,

  onVaultChange,
  onOpenSettings: () => () => {},
  onOpenNoteRequested,
  notifyRendererReady: () => {},
  onAppUpdateState: () => () => {},

  windowMinimize: () => {},
  windowToggleMaximize: () => {},
  windowClose: () => {},
  openNoteWindow: async (relPath: string) => {
    requestOpenNote(relPath)
  },
  openVaultWindow: async () => null,
  readExternalFile: async () => notImplemented('readExternalFile'),
  writeExternalFile: async () => notImplemented('writeExternalFile'),
  moveExternalFileToVault: async () => notImplemented('moveExternalFileToVault'),
  followExternalFileLink: async () => ({ ok: false, error: 'desktop-only' }),
  openMarkdownFile: async () => false,
  openFileDialog: async () => false,
  toggleQuickCapture: async () => {
    const meta: NoteMeta = await activeVault().createNote('quick')
    requestOpenNote(meta.path)
  },
  getQuickCaptureHotkey: async () => '',
  setQuickCaptureHotkey: async () => ({
    ok: false,
    hotkey: '',
    error: 'Quick capture hotkeys are a desktop feature.'
  }),
  getQuickCapturePinned: async () => false,
  setQuickCapturePinned: async () => false,
  // On-device TeX via the vendored TikZJax wasm engine (src/bridge/tikz.ts);
  // falls back to the desktop-only message if the assets aren't bundled.
  renderTikz: (source): Promise<TikzRenderResponse> => renderTikzOnDevice(source),

  mcpGetRuntime: async () =>
    ({
      command: '',
      args: [],
      env: {},
      entryPath: null,
      available: false,
      reason: 'MCP client installation is only available in the desktop build.'
    }) as unknown as McpServerRuntime,
  mcpGetStatuses: async (): Promise<McpClientStatus[]> => [],
  mcpInstall: async () => notImplemented('mcpInstall'),
  mcpUninstall: async () => notImplemented('mcpUninstall'),
  mcpGetInstructions: async () =>
    ({
      defaultValue: '',
      current: '',
      isCustom: false,
      filePath: ''
    }) as unknown as McpInstructionsPayload,
  mcpSetInstructions: async () => notImplemented('mcpSetInstructions'),
  cliGetStatus: async () => PORTABLE_CLI_STATUS,
  cliInstall: async () => notImplemented('cliInstall'),
  cliUninstall: async () => notImplemented('cliUninstall'),
  raycastGetStatus: async () => portableRaycastStatus(),
  raycastInstall: async () => notImplemented('raycastInstall'),
  clipboardWriteText: (text: string) => {
    void portableHost().shell.writeClipboard(text).catch(() => {})
  },
  clipboardReadText: () => '',

  getConfigSync: () => null,
  setConfig: async () => {},
  getConfigPath: async () => null,
  revealConfigFile: async () => {},
  onConfigChange: () => () => {},

  listCustomThemes: async () => [],
  getCustomThemesDir: async () => null,
  revealCustomThemesDir: async () => {},
  deleteCustomTheme: async () => {},
  createCustomTheme: async () => null,
  onCustomThemesChange: () => () => {},
  // Custom code languages: capability-gated off (supportsCustomCodeLanguages
  // false hides the Settings section); the empty list keeps the editor and
  // reading view on their zero-cost fast path.
  listCustomCodeLanguages: async (): Promise<CustomCodeLanguage[]> => [],
  installCustomCodeLanguage: (_input: CustomCodeLanguageInstallInput): Promise<CustomCodeLanguage> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  updateCustomCodeLanguage: (_input: CustomCodeLanguageUpdateInput): Promise<CustomCodeLanguage> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  revealCustomCodeLanguagesDir: async () => {},
  deleteCustomCodeLanguage: (_id: string): Promise<void> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  onCustomCodeLanguagesChange: () => () => {},
  listOverrides: async () => [],
  revealOverridesDir: async () => {},
  deleteOverride: async () => {},
  onOverridesChange: () => () => {},
  toggleDevTools: async () => {}
}

/**
 * Installs the host and returns the bridge for it. The host installs the
 * bridge itself (installZenBridge), so it keeps control of its boot order:
 * the phones seed native preferences before any app-core import runs.
 */
export function createPortableBridge(host: PortableHost): ZenBridge {
  installPortableHost(host)
  return portableBridge
}
