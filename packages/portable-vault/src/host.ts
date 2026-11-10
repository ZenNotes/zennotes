/**
 * What a host gives the portable vault layer. The phones were two hand-kept
 * copies of this layer over Capacitor (zennotesiphone and zennotesandroid
 * `src/bridge/`), and every fix was ported twice; the browser build would
 * have made it three times. Everything here is TypeScript over these
 * interfaces, and nothing in the package may import `@capacitor/*` (the
 * boundary check in tooling/scripts/check-portable-vault-boundary.mjs).
 *
 * One process runs one host: the shell installs it once, before the bridge or
 * any Cloud call runs (createPortableBridge does it), and the modules read it
 * through portableHost(). That keeps the lifted code line for line with the
 * phone copies it came from, which is what made reconciling them reviewable.
 */
import type {
  DirectoryBrowseResult,
  LocalVaultEntry,
  VaultInfo
} from '@zennotes/bridge-contract/ipc'
import type { ZenAppInfo, ZenBridge, ZenCapabilities } from '@zennotes/bridge-contract/bridge'

// ---------------------------------------------------------------------------
// Vault files
// ---------------------------------------------------------------------------

/** One entry of a directory listing, the subset of Capacitor's FileInfo the
 *  vault reads. `uri` is the host's native address for the file when it has
 *  one; the sync fast path takes it back to fingerprint without a re-stat. */
export interface VaultDirEntry {
  name: string
  type: 'file' | 'directory'
  size: number
  mtime: number
  ctime?: number
  uri?: string
}

export interface VaultStat {
  type: 'file' | 'directory'
  size: number
  mtime: number
  ctime: number | null
  uri?: string
}

/**
 * The file operations a vault runs on, every path vault-relative POSIX. The
 * phones' NativeFs (Capacitor Filesystem, iCloud, Android SAF trees) and the
 * browser's OPFS worker implement it. The contracts that matter:
 *
 * - `statVerified` and `readTextOrNull` answer null only for a VERIFIED
 *   absence. Sync turns null into delete and conflict decisions, so a
 *   transient failure, an iCloud eviction stub or a provider that is not
 *   answering must throw (or report the file), never read as missing.
 * - `readdirStrict` throws when a listing fails; `readdir` maps failure to [].
 *   Cloud sync's scan uses the strict one, because an empty listing there
 *   would plan a delete for every tracked item.
 * - `writeGeneration` moves before and after every change the vault makes,
 *   so a listing taken at one generation is known to predate nothing written
 *   since (PortableVault shares listings between overlapping walks on it).
 */
export interface VaultFileSystem {
  /** Resolves the root and anything the host must do before the first walk
   *  (iCloud: materialize evicted items, bounded). */
  init(): Promise<void>
  /** A stable key per local vault for the Cloud link and sync state. It must
   *  survive app updates and restores, so not an absolute container path
   *  whose UUID the OS rotates (iPhone keys on `ZenNotes/<name>`, Android on
   *  its root URI; changing either orphans every existing link). */
  readonly syncKey: string
  /** A label for the root, for logs and the vault's own description. */
  readonly rootLabel: string
  writeGeneration: number

  readText(relPath: string): Promise<string>
  readTextOrNull(relPath: string): Promise<string | null>
  /** Any file as base64, so sync hashes the exact bytes, text included. */
  readBase64(relPath: string): Promise<string>
  writeText(relPath: string, body: string): Promise<void>
  writeBase64(relPath: string, base64Data: string): Promise<void>
  statOrNull(relPath: string): Promise<VaultStat | null>
  statVerified(relPath: string): Promise<'file' | 'directory' | null>
  readdir(relPath: string): Promise<VaultDirEntry[]>
  readdirStrict(relPath: string): Promise<VaultDirEntry[]>
  mkdir(relPath: string): Promise<void>
  rename(fromRel: string, toRel: string): Promise<void>
  copy(fromRel: string, toRel: string): Promise<void>
  deleteFile(relPath: string): Promise<void>
  rmdir(relPath: string): Promise<void>
  /** Fails on a folder holding anything, where rmdir takes it all. */
  rmdirIfEmpty(relPath: string): Promise<void>
  exists(relPath: string): Promise<boolean>
  /** True when an error from this file system means the path does not exist,
   *  the only failure allowed to read as absence. */
  isNotFound(error: unknown): boolean
}

/** A native SHA-256, length and UTF-8 check without bringing the bytes into
 *  JavaScript. Small files also come back inline. */
export interface CloudFileFingerprint {
  uri: string
  sha256: string
  byteLength: number
  utf8: boolean
  inlineBase64?: string
  /** The file is a Cloud stub (cloud-sync-stubs.ts): the fingerprint is the
   *  one it records for the attachment it stands for, and no bytes of that
   *  attachment are here. */
  stub?: { mediaType: string }
}

/** Base64 of the 74-byte ZNE1 header, the 32-byte per-object key and
 *  SHA-256(header followed by context): what the native chunk loop needs.
 *  JavaScript derives all three; native code never sees a parent key. */
export interface Zne1NativeKeys {
  header: string
  objectKey: string
  aad: string
}

/** A file sealed for an encrypted upload, in a private temp the caller discards. */
export interface Zne1NativeSealedFile {
  uri: string
  /** The whole ciphertext file, header included. */
  byteLength: number
  sha256: string
  plaintextByteLength: number
  plaintextSha256: string
  discard(): Promise<void>
}

export interface CloudDownloadToFile {
  url: string
  headers: Record<string, string>
  to: string
  byteLength: number
  sha256: string
}

/**
 * The native sync path: large files are fingerprinted, copied, downloaded,
 * opened and sealed by the host's own code, so their bytes never cross into
 * JavaScript. Optional. A vault file system that implements it (the phones'
 * NativeFs does) gets the scan cache and streamed transfers; one that does not
 * (the browser) syncs through shared-domain's PortableCloudSyncRepository,
 * which reads every file as base64.
 */
export interface SyncFastPath {
  readForSync(relPath: string, textCandidate: boolean, knownUri?: string): Promise<CloudFileFingerprint>
  /** Verified copy into a new staging path. */
  copyForSync(fromRel: string, toRel: string, byteLength: number): Promise<void>
  /** Streams a signed Cloud revision to a staging file, verified before it resolves. */
  download(options: CloudDownloadToFile): Promise<void>
  /** Base64 of up to `length` leading bytes of a vault file: a ZNE1 header. */
  readHeader(relPath: string, length: number): Promise<string>
  /** Opens a staged ZNE1 file into another vault path with the native chunk loop. */
  decryptFile(options: { from: string; to: string } & Zne1NativeKeys): Promise<{ byteLength: number; sha256: string }>
  /** Seals a vault file for an encrypted vault's direct upload. */
  sealForUpload(sourceUri: string, keys: Zne1NativeKeys): Promise<Zne1NativeSealedFile>
  /** Attachments on open (cloud-sync-stubs.ts), where the host stubs them:
   *  writes a stub file, reads one back (null for any other file), and
   *  replaces one with downloaded bytes only while it is still that stub. */
  writeCloudStub?(relPath: string, stub: import('./cloud-stub-format').CloudStubRecord): Promise<void>
  readCloudStub?(relPath: string): Promise<import('./cloud-stub-format').CloudStubRecord | null>
  replaceCloudStub?(fromRel: string, toRel: string, expected: import('./cloud-stub-format').CloudStubRecord): Promise<boolean>
}

export function hasSyncFastPath<F extends VaultFileSystem>(fs: F): fs is F & SyncFastPath {
  const candidate = fs as Partial<SyncFastPath>
  return typeof candidate.readForSync === 'function' &&
    typeof candidate.copyForSync === 'function' &&
    typeof candidate.download === 'function'
}

/** A loadable URL for a vault file (images, PDFs): `convertFileSrc` on the
 *  phones, a service-worker URL in the browser. Synchronous, because the
 *  bridge contract's resolveVaultAssetUrl/resolveLocalAssetUrl are. */
export interface AssetUrls {
  fileSrc(relPath: string): string | null
}

/** What the host hands PortableVault: the file system, its asset URLs, and
 *  optionally the native sync path on the same object. */
export type PortableVaultFiles = VaultFileSystem & AssetUrls

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Text by key, with slash-separated keys (`zennotes-cloud-sync/links/<id>.json`).
 * `read` answers null only for a key that is verifiably absent; any other
 * failure throws, because a link or sync state that read as missing would
 * re-bootstrap the vault and forget acknowledged offline deletions.
 * Phones keep the durable store as files in Capacitor's Directory.Data and
 * preferences in Capacitor Preferences; the browser keeps both in IndexedDB.
 */
export interface HostStorage {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  /** Removing an absent key is not an error. */
  remove(key: string): Promise<void>
}

/**
 * The Cloud credential, the pending sign-in and the E2EE account key. Phones
 * use the Keychain / Keystore through capacitor-secure-storage; the browser
 * has its own rules (docs/ideas/cloud-in-browser.md).
 */
export interface SecretStorage {
  /** False where nothing can be kept (a phone build in a plain browser): reads
   *  answer null, removals do nothing and writes refuse. */
  available(): boolean
  /** Runs before the first read or write, and again after a failure (the
   *  iPhone configures its Keychain access and migrates an old key prefix). */
  prepare?(): Promise<void>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One request, in CapacitorHttp's shape so the phones pass their native
 * transport straight through (it is outside CORS and sends the Bearer
 * header). `dataType: 'file'` means `data` is a base64 body; `'formData'`
 * means `data` is CapacitorHttp's entry list (HttpTransportFormEntry), which a
 * browser host turns back into a FormData. The package sizes `connectTimeout`
 * and `readTimeout` itself (cloud-sync-stall.ts).
 */
export interface HttpTransportRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  params?: Record<string, string | string[]>
  data?: unknown
  dataType?: 'file' | 'formData'
  responseType?: 'arraybuffer' | 'blob' | 'json' | 'text' | 'document'
  connectTimeout?: number
  readTimeout?: number
  disableRedirects?: boolean
}

/** One part of a `dataType: 'formData'` body: both native layers decode a
 *  `base64File` value and write the raw bytes into the part. */
export interface HttpTransportFormEntry {
  key: string
  value: string
  type: 'base64File' | 'string'
  contentType?: string
  fileName?: string
}

export interface HttpTransportResponse {
  status: number
  headers: Record<string, string>
  data: any
  url?: string
}

/**
 * Resolves with any HTTP answer, error statuses included. A rejection means
 * no answer came at all (no connection, a stall past the timeout), which the
 * Cloud client treats as a transport failure it may retry.
 */
export interface HttpTransport {
  request(options: HttpTransportRequest): Promise<HttpTransportResponse>
  /** PUTs a file by its native URI to a signed object-storage URL, streamed
   *  and verified against `sha256` by native code. Present where the sync
   *  fast path is (its fingerprints hand out those URIs); rejects when no
   *  answer came, resolves with the status otherwise. With
   *  `putsInMemoryBodies`, it also takes in-memory bodies as `base64`. */
  putFile?(options: {
    url: string
    headers: Record<string, string>
    byteLength: number
  } & ({ uri: string; sha256: string; base64?: never } | { base64: string; sha256?: string; uri?: never })): Promise<{ status: number }>
  /** Android's native PUT sends every object-storage body, in-memory ones
   *  included; the iPhone's takes only files and sends in-memory bodies
   *  through `request` (dataType 'file'). */
  putsInMemoryBodies?: boolean
  /**
   * The connect and read timeouts for one Cloud API request. The platforms
   * time out differently: iOS applies connectTimeout to the whole URLRequest
   * and bytes going out never restart it, so the default gives both the time
   * the body takes on a slow uplink plus the stall bound
   * (cloudSendTimeoutMs); Android's read timeout starts over with every byte
   * that arrives, so it is how long a request may go silent (Android passes
   * its own: a short connect, then the stall bound or the request's own).
   */
  cloudTimeouts?(request: { timeoutMs?: number; bodyBytes: number }): { connectTimeout: number; readTimeout: number }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface HostCloudConfig {
  /** The `platform` the sign-in exchange reports. */
  platform: 'ios' | 'android' | 'web'
  deviceName: string
  /** The page the website returns a sign-in to, sent as `callback_url`; the
   *  code and state arrive in its fragment. Absent on the phones, which get
   *  the `zennotes://auth` link. */
  callbackUrl?: string
  /** How long a started sign-in waits for its callback; the shared flow's
   *  five minutes when absent (the browser waits longer, see
   *  CloudAuthFlowDependencies.authLifetimeMs). */
  authLifetimeMs?: number
  /** A development service (VITE_ZENNOTES_CLOUD_DEV_URL in the phones'
   *  builds), allowed over plain http and used as the default base URL. */
  developmentBaseUrl?: string
  allowInsecureLoopback: boolean
  /** How this host names an account's unlocked E2EE key in SecretStorage:
   *  'labeled' (`cloud-e2ee:<base url>#<email>`, the iPhone's, the default)
   *  or 'hashed' (`e2ee-account-key.<sha256>`, Android's). A host keeps the
   *  scheme it shipped, or every unlocked device asks for its passphrase. */
  accountKeyScheme?: 'labeled' | 'hashed'
}

export interface HostShell {
  /** Read per call: the version can arrive from native code during boot. */
  appInfo(): ZenAppInfo
  platform: Awaited<ReturnType<ZenBridge['platform']>>
  /** Merged over the portable defaults (portable-bridge.ts). */
  capabilities?: Partial<ZenCapabilities>
  listSystemFonts(): Promise<string[]>
  /** Shown where a desktop build would offer an update. */
  updatesMessage: string
  /** Where TikZJax's files are served, ending in a slash. Default
   *  `tikzjax/`, beside the page (the phones); the browser build serves its
   *  release files under a base of their own. */
  tikzAssetBase?: string
  /** Ends "zen.x is not available …", e.g. "on iPhone". */
  unavailableWhere: string
  /** The last sentence of "Could not connect to the ZenNotes server at …":
   *  what on this platform most often stops a connection a browser on the
   *  same device makes (remote-client.ts has the iPhone's and Android's). */
  remoteConnectionHint?(baseUrl: string): string
  /** Whether a drawing opens view-only (no editing chrome). Asked on every read. */
  drawingsViewOnly(): boolean
  writeClipboard(text: string): Promise<void>
  /** Opens a page outside the app (Cloud sign-in). Without one the package
   *  calls window.open, which the phones' WebViews hand to the system browser. */
  openExternal?(url: string): Promise<void>
  /** Shares or saves a file the service streams (a backup archive). A
   *  dismissed share sheet resolves; any other failure throws. */
  saveDownload(options: {
    url: string
    headers: Record<string, string>
    fileName: string
    title: string
    connectTimeout: number
    readTimeout: number
  }): Promise<void>
  cloud: HostCloudConfig
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * The app's own events, which Cloud sign-in and the request lifetime follow:
 * on the phones Capacitor's App plugin (`appUrlOpen`, `getLaunchUrl`,
 * `appStateChange`) and background-sync.ts's final-sync hooks; in the
 * browser, the page's URL and visibility.
 */
export interface AppLifecycle {
  /** Deep links the app receives while running (Cloud sign-in callbacks). */
  onOpenUrl(listener: (url: string) => void): Promise<void>
  /** The deep link the app was launched with, if any. */
  launchUrl(): Promise<string | null>
  /** Foreground and background. The package records the state, then calls
   *  `returnedToApp` / `leftApp`, which own what follows (the phones' final
   *  background sync, then stopping Cloud requests). */
  onActiveChange(listener: (active: boolean) => void): Promise<void>
  leftApp(): void
  returnedToApp(): void
}

// ---------------------------------------------------------------------------
// Where vaults live
// ---------------------------------------------------------------------------

/**
 * The host's own vault tiers: on-device, iCloud, a picked Files-app folder,
 * an Android SAF tree, the browser's OPFS. Each opens a vault by calling
 * `openPortableVault(name, files)` from portable-bridge.ts, which makes it the
 * active one. The remote-workspace parts of the same bridge methods stay in
 * the package.
 */
export interface HostVaults {
  /** Boot, and the way back from a remote workspace: open the remembered
   *  vault or create the first one. */
  openDefault(): Promise<void>
  list(): Promise<LocalVaultEntry[]>
  open(root: string): Promise<VaultInfo>
  pick(): Promise<VaultInfo | null>
  select(path: string): Promise<VaultInfo>
  browse(path: string): Promise<DirectoryBrowseResult>
  /** Where the vault lives, in words, for Settings ("On My iPhone › …"). */
  describeRoot(vault: { name: string; fs: VaultFileSystem }): string
  /** Opens an attachment in another app (share sheet, Quick Look, an intent). */
  openAssetExternally(relPath: string): Promise<{ ok: boolean; error?: string }>
}

/**
 * Whether Cloud attachments arrive as stubs on this host and hydrate on open
 * (the browser; docs/ideas/cloud-in-browser.md, "Notes first, attachments on
 * open"). Absent, every file is mirrored in full, as on the phones.
 */
export interface CloudAttachmentStubs {
  /** Read for every revision that arrives; the browser's "Keep attachments
   *  in this browser" setting turns it off. */
  enabled(): boolean
  /** Binary attachments above this many bytes are stubbed (default
   *  CLOUD_STUB_THRESHOLD_BYTES). */
  thresholdBytes?: number
}

export interface PortableHost {
  shell: HostShell
  lifecycle: AppLifecycle
  http: HttpTransport
  /** Durable JSON: the Cloud link, sync state and scan cache. */
  storage: HostStorage
  /** Small settings: saved remote-workspace profiles and the workspace mode. */
  preferences: HostStorage
  secrets: SecretStorage
  vaults: HostVaults
  cloudStubs?: CloudAttachmentStubs
}

let installed: PortableHost | null = null

export function installPortableHost(host: PortableHost): void {
  installed = host
}

export function portableHost(): PortableHost {
  if (!installed) throw new Error('The ZenNotes vault host is not installed yet.')
  return installed
}

/** For tests: forget the installed host. */
export function resetPortableHost(): void {
  installed = null
}
