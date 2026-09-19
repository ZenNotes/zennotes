import { app, BrowserWindow, net, Notification, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fetchLatestRelease, isNewerVersion } from './update-feed'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo
} from 'electron-updater'
import { IPC, type AppUpdateState } from '@shared/ipc'

const { autoUpdater } = electronUpdater
const execFileAsync = promisify(execFile)
const UPDATE_CHECK_MAX_ATTEMPTS = 3
const UPDATE_CHECK_RETRY_DELAY_MS = 1500
const BACKGROUND_UPDATE_CHECK_DELAY_MS = 8000
/** How often a check that found no network looks at the link again. */
export const OFFLINE_POLL_MS = 15_000
/** First wait before re-checking when the link is up but GitHub still could
 *  not be reached; doubles per failure up to the cap. */
export const OFFLINE_RETRY_BASE_MS = 30_000
export const OFFLINE_RETRY_MAX_MS = 15 * 60_000

let initialized = false
let updater: AppUpdater | null = null
/** True when this install belongs to a package manager (AUR, a tarball): the
 *  app checks the release feed itself and only reports, never installs. */
let managedInstall = false
let lastInfo: UpdateInfo | null = null
let startupCheckTimer: NodeJS.Timeout | null = null
let backgroundCheckScheduled = false
let notifiedAvailableVersion: string | null = null
let notifiedDownloadedVersion: string | null = null
let downloadedFilePath: string | null = null
let updateState: AppUpdateState = makeState({
  phase: 'unsupported',
  message: 'Updates are only available in packaged builds.'
})

function makeState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'idle',
    installable: !managedInstall,
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    message: 'Check GitHub releases for a newer ZenNotes build.',
    ...overrides
  }
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (!notes) return null
  if (typeof notes === 'string') {
    const trimmed = notes.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const merged = notes
    .map((note) => {
      const version = note.version ? `Version ${note.version}` : ''
      const body = note.note?.trim() ?? ''
      return [version, body].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return merged.length > 0 ? merged : null
}

function nextStateFromInfo(
  phase: AppUpdateState['phase'],
  info: UpdateInfo | null,
  message: string,
  extra: Partial<AppUpdateState> = {}
): AppUpdateState {
  return makeState({
    phase,
    availableVersion: info?.version ?? null,
    releaseName: info?.releaseName ?? null,
    releaseDate: info?.releaseDate ?? null,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
    message,
    ...extra
  })
}

/**
 * Every message and code along an error's `cause` chain, innermost last.
 * undici's fetch reports the network as `TypeError: fetch failed` and keeps
 * the part worth reading (`getaddrinfo ENOTFOUND github.com`) in `cause`;
 * Electron's net module puts it in the message (`net::ERR_INTERNET_DISCONNECTED`).
 */
function errorChainText(error: unknown): string[] {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      const { code, cause } = current as { code?: unknown; cause?: unknown }
      if (typeof code === 'string') parts.push(code)
      current = cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.map((part) => part.trim()).filter(Boolean)
}

const NETWORK_UNREACHABLE_PATTERN =
  /\b(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|TIMED_OUT|CONNECTION_(REFUSED|RESET|CLOSED|ABORTED|FAILED|TIMED_OUT))\b|^fetch failed$/i

/**
 * True when the check never reached GitHub: no route, no DNS, nothing
 * listening. GitHub answering badly (a 5xx, a 404) is not this; those are
 * errors to show, not a connection to wait for.
 */
export function isNetworkUnreachableError(error: unknown): boolean {
  return errorChainText(error).some((part) => NETWORK_UNREACHABLE_PATTERN.test(part))
}

/** The most specific line of an error chain, for the message the user reads:
 *  `getaddrinfo ENOTFOUND github.com` rather than `fetch failed`. */
function describeError(error: unknown): string {
  const parts = errorChainText(error).filter((part) => !/^fetch failed$/i.test(part))
  const messages = parts.filter((part) => /\s|::/.test(part))
  return messages.at(-1) ?? parts.at(-1) ?? 'Unknown updater error.'
}

function humanizeUpdateError(error: unknown): string {
  const message = describeError(error)
  if (isNetworkUnreachableError(error)) {
    return `${message} ZenNotes could not reach GitHub. Check the connection and try again.`
  }
  if (/5\d\d|gateway time-?out|timed out|econnreset|eai_again|socket hang up/i.test(message)) {
    return `${message} GitHub returned a temporary network or server error while checking for updates. Try again in a moment, or open the latest release directly.`
  }
  if (/404|401|403|forbidden|unauthorized/i.test(message)) {
    return `${message} GitHub-hosted end-user updates require public releases, or a special private-repo token setup.`
  }
  if (process.platform === 'darwin' && /sign|signature/i.test(message)) {
    return `${message} macOS auto-updates require a signed app build.`
  }
  return message
}

function isRetryableUpdateError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error)
  return /5\d\d|gateway time-?out|timed out|econnreset|eai_again|socket hang up/i.test(
    message
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function broadcastUpdateState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.APP_UPDATER_ON_STATE, updateState)
  }
}

function setUpdateState(next: AppUpdateState): void {
  updateState = next
  // The wait for the network lives exactly as long as the phase it explains.
  // A check in flight keeps it (its failure count carries into the next
  // wait); any other outcome, from either a timer or the user, ends it.
  if (next.phase !== 'offline' && next.phase !== 'checking') stopWaitingForNetwork()
  broadcastUpdateState()
}

/**
 * A check that could not reach GitHub at all (issue #812: the app launched
 * offline, the startup check failed, and nothing ever tried again until the
 * user pressed Check for Updates). Instead of reporting an error, wait for
 * the network and check again on our own.
 *
 * Two triggers, both cheap: the link coming back (Chromium's own network
 * change notifier, read through `net.isOnline()` every OFFLINE_POLL_MS; no
 * request is made), and a retry timer for the case the link is up but GitHub
 * still cannot be reached (captive portal, the router's WAN side down). The
 * retry delay doubles per failure up to OFFLINE_RETRY_MAX_MS.
 *
 * `isOnline()` answering false is trusted enough to skip retries while the
 * link is down, but never for good: a real attempt happens at least every
 * OFFLINE_RETRY_MAX_MS, so a notifier that is wrong about this machine
 * cannot silence the check forever.
 */
interface NetworkWait {
  timer: NodeJS.Timeout
  failures: number
  lastAttemptAt: number
  linkWasUp: boolean
}

let networkWait: NetworkWait | null = null

export function offlineRetryDelayMs(failures: number): number {
  const doublings = Math.max(0, Math.min(failures - 1, 30))
  return Math.min(OFFLINE_RETRY_BASE_MS * 2 ** doublings, OFFLINE_RETRY_MAX_MS)
}

function stopWaitingForNetwork(): void {
  if (!networkWait) return
  clearInterval(networkWait.timer)
  networkWait = null
}

function waitForNetwork(error: unknown): void {
  const failures = (networkWait?.failures ?? 0) + 1
  stopWaitingForNetwork()
  networkWait = {
    failures,
    lastAttemptAt: Date.now(),
    linkWasUp: net.isOnline(),
    timer: setInterval(pollForNetwork, OFFLINE_POLL_MS)
  }
  setUpdateState(
    nextStateFromInfo(
      'offline',
      lastInfo,
      `ZenNotes can't reach GitHub right now (${describeError(error)}). It will check for updates again on its own once the connection is back.`,
      { availableVersion: lastInfo?.version ?? updateState.availableVersion }
    )
  )
}

function pollForNetwork(): void {
  const wait = networkWait
  if (!wait) return
  if (updateState.phase !== 'offline') {
    // A check the user started is running, or something else owns the state.
    if (updateState.phase !== 'checking') stopWaitingForNetwork()
    return
  }
  const linkUp = net.isOnline()
  const linkRestored = linkUp && !wait.linkWasUp
  wait.linkWasUp = linkUp
  const sinceAttempt = Date.now() - wait.lastAttemptAt
  const retryDue = sinceAttempt >= offlineRetryDelayMs(wait.failures)
  const overdue = sinceAttempt >= OFFLINE_RETRY_MAX_MS
  if (linkRestored || (retryDue && linkUp) || overdue) {
    wait.lastAttemptAt = Date.now()
    void checkForAppUpdates()
  }
}

function focusAppAndOpenSettings(): void {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  const target = BrowserWindow.getFocusedWindow() ?? windows[0] ?? null
  if (!target) return
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.focus()
  for (const win of windows) {
    win.webContents.send(IPC.APP_OPEN_SETTINGS)
  }
}

function showNativeUpdateNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title,
    body
  })
  notification.on('click', focusAppAndOpenSettings)
  notification.show()
}

function handleDownloadProgress(progress: ProgressInfo): void {
  const version = lastInfo?.version ?? updateState.availableVersion ?? 'update'
  setUpdateState(
    nextStateFromInfo(
      'downloading',
      lastInfo,
      `Downloading ZenNotes ${version}… ${Math.round(progress.percent)}%.`,
      {
        progressPercent: progress.percent,
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
    )
  )
}

export function getAppUpdateState(): AppUpdateState {
  return { ...updateState }
}

export function initAppUpdater(): void {
  if (initialized) return
  initialized = true

  // A development or perf run may force the package-manager path so the
  // notify-only check can be driven on any platform (with
  // ZENNOTES_UPDATE_FEED_URL pointing at a served feed).
  const forcedManaged =
    process.env.ZENNOTES_UPDATER_FORMAT === 'managed' &&
    (!app.isPackaged || process.env.ZEN_PERF === '1')
  if (!app.isPackaged && !forcedManaged) {
    setUpdateState(
      makeState({
        phase: 'unsupported',
        message: 'Update checks only work in packaged ZenNotes builds.'
      })
    )
    return
  }

  const chosen = forcedManaged
    ? 'managed'
    : process.platform === 'linux'
      ? linuxUpdater()
      : autoUpdater
  if (chosen === 'managed') {
    // No updater can install here, and the one these installs used to fall
    // into (AppImage) refused to run without an APPIMAGE marker and never
    // said so: the About page sat on "Checking…" for good. Report only.
    managedInstall = true
    updater = null
    setUpdateState(
      makeState({
        message:
          'This copy of ZenNotes was installed by a package manager. Check GitHub for a newer version here and install it the way you installed ZenNotes.'
      })
    )
    return
  }
  updater = chosen
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true

  updater.on('checking-for-update', () => {
    setUpdateState(
      nextStateFromInfo('checking', lastInfo, 'Checking GitHub releases for updates…')
    )
  })
  updater.on('update-available', (info) => {
    lastInfo = info
    setUpdateState(
      nextStateFromInfo(
        'available',
        info,
        `ZenNotes ${info.version} is available. Download it from inside the app.`
      )
    )
    if (notifiedAvailableVersion !== info.version) {
      notifiedAvailableVersion = info.version
      showNativeUpdateNotification(
        'ZenNotes Update Available',
        `ZenNotes ${info.version} is available. Click to open Settings and download it.`
      )
    }
  })
  updater.on('update-not-available', (info) => {
    lastInfo = info
    setUpdateState(
      nextStateFromInfo(
        'not-available',
        info,
        `You're already on ZenNotes ${app.getVersion()}.`
      )
    )
  })
  updater.on('download-progress', handleDownloadProgress)
  updater.on('update-downloaded', (info) => {
    lastInfo = info
    downloadedFilePath = info.downloadedFile ?? null
    // deb/rpm/pacman installs need root. electron-updater's on-quit auto-install
    // shells out to a non-interactive `sudo`, which fails in a GUI session with
    // no graphical askpass (issue #60). We install those formats ourselves from
    // installAppUpdate(), so suppress the broken on-quit path for them.
    if (process.platform === 'linux' && linuxNeedsRootInstall(downloadedFilePath)) {
      updater!.autoInstallOnAppQuit = false
    }
    setUpdateState(
      nextStateFromInfo(
        'downloaded',
        info,
        `ZenNotes ${info.version} is ready. Restart to install the update.`
      )
    )
    if (notifiedDownloadedVersion !== info.version) {
      notifiedDownloadedVersion = info.version
      showNativeUpdateNotification(
        'ZenNotes Update Ready',
        `ZenNotes ${info.version} is downloaded and ready to install. Click to open Settings.`
      )
    }
  })
  updater.on('error', (error) => {
    // electron-updater emits this and rejects the same promise. Let the check
    // or download that owns the promise decide what an unreachable network
    // means (a wait, not an error); reporting it here first would flash the
    // error state through the renderer on the way.
    if (isNetworkUnreachableError(error)) return
    setUpdateState(
      nextStateFromInfo('error', lastInfo, humanizeUpdateError(error))
    )
  })

  setUpdateState(makeState())
}

export async function checkForAppUpdates(): Promise<AppUpdateState> {
  initAppUpdater()
  if (managedInstall) return await checkManagedInstallForUpdates()
  if (!updater) return getAppUpdateState()
  if (updateState.phase === 'checking' || updateState.phase === 'installing') return getAppUpdateState()

  setUpdateState(
    nextStateFromInfo('checking', lastInfo, 'Checking GitHub releases for updates…')
  )

  for (let attempt = 1; attempt <= UPDATE_CHECK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await updater.checkForUpdates()
      return getAppUpdateState()
    } catch (error) {
      const retryable = isRetryableUpdateError(error)
      const hasAttemptsLeft = attempt < UPDATE_CHECK_MAX_ATTEMPTS
      if (retryable && hasAttemptsLeft) {
        setUpdateState(
          nextStateFromInfo(
            'checking',
            lastInfo,
            `GitHub update check hit a temporary server error. Retrying (${attempt + 1}/${UPDATE_CHECK_MAX_ATTEMPTS})…`
          )
        )
        await sleep(UPDATE_CHECK_RETRY_DELAY_MS)
        continue
      }

      if (isNetworkUnreachableError(error)) {
        waitForNetwork(error)
        break
      }
      setUpdateState(
        nextStateFromInfo('error', lastInfo, humanizeUpdateError(error))
      )
      break
    }
  }

  return getAppUpdateState()
}

/**
 * The notify-only check for a package-manager install: read the release feed,
 * compare, say the answer. The same retry policy as the real updaters, the
 * same native notification once per version, and never a download.
 */
async function checkManagedInstallForUpdates(): Promise<AppUpdateState> {
  if (updateState.phase === 'checking') return getAppUpdateState()
  const current = app.getVersion()
  setUpdateState(
    makeState({
      phase: 'checking',
      availableVersion: updateState.availableVersion,
      message: 'Checking GitHub releases for updates…'
    })
  )
  for (let attempt = 1; attempt <= UPDATE_CHECK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const latest = await fetchLatestRelease(undefined, managedFeedUrl())
      if (isNewerVersion(latest.version, current)) {
        setUpdateState(
          makeState({
            phase: 'available',
            availableVersion: latest.version,
            releaseDate: latest.releaseDate,
            message: `ZenNotes ${latest.version} is available. This copy is managed by your package manager, so update it there (the AUR package updates with yay -Syu or paru -Syu).`
          })
        )
        if (notifiedAvailableVersion !== latest.version) {
          notifiedAvailableVersion = latest.version
          showNativeUpdateNotification(
            'ZenNotes Update Available',
            `ZenNotes ${latest.version} is available. Update it with your package manager.`
          )
        }
      } else {
        setUpdateState(
          makeState({
            phase: 'not-available',
            message: `You're already on ZenNotes ${current}.`
          })
        )
      }
      return getAppUpdateState()
    } catch (error) {
      if (isRetryableUpdateError(error) && attempt < UPDATE_CHECK_MAX_ATTEMPTS) {
        setUpdateState(
          makeState({
            phase: 'checking',
            message: `GitHub update check hit a temporary server error. Retrying (${attempt + 1}/${UPDATE_CHECK_MAX_ATTEMPTS})…`
          })
        )
        await sleep(UPDATE_CHECK_RETRY_DELAY_MS)
        continue
      }
      if (isNetworkUnreachableError(error)) {
        waitForNetwork(error)
        return getAppUpdateState()
      }
      setUpdateState(makeState({ phase: 'error', message: humanizeUpdateError(error) }))
      return getAppUpdateState()
    }
  }
  return getAppUpdateState()
}

/** Development and perf runs may point the notify-only check at a local feed
 *  (a served `latest-linux.yml`) to exercise every state without a release. */
function managedFeedUrl(): string | undefined {
  const override = process.env.ZENNOTES_UPDATE_FEED_URL?.trim()
  if (override && (!app.isPackaged || process.env.ZEN_PERF === '1')) return override
  return undefined
}

export function scheduleBackgroundAppUpdateCheck(
  delayMs: number = BACKGROUND_UPDATE_CHECK_DELAY_MS
): void {
  initAppUpdater()
  if ((!updater && !managedInstall) || backgroundCheckScheduled) return
  backgroundCheckScheduled = true
  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null
    // A manual check/download/install owns its result once the user starts it.
    if (updateState.phase === 'idle') void checkForAppUpdates()
  }, Math.max(0, delayMs))
}

export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!updater || updateState.phase !== 'available') return getAppUpdateState()

  setUpdateState(
    nextStateFromInfo(
      'downloading',
      lastInfo,
      `Downloading ZenNotes ${updateState.availableVersion ?? ''}…`,
      {
        progressPercent: 0,
        transferredBytes: 0,
        totalBytes: null,
        bytesPerSecond: null
      }
    )
  )

  try {
    await updater.downloadUpdate()
  } catch (error) {
    setUpdateState(
      nextStateFromInfo('error', lastInfo, humanizeUpdateError(error))
    )
  }

  return getAppUpdateState()
}

export function installAppUpdate(): void {
  if (!updater || updateState.phase !== 'downloaded') return
  // On Linux, deb/rpm/pacman packages require root to install. electron-updater's
  // quitAndInstall() shells out to a non-interactive `sudo`, which fails with
  // "Command sudo exited with code 1" in a desktop session that has no graphical
  // askpass (issue #60). Install those formats ourselves via a graphical prompt.
  if (process.platform === 'linux' && linuxNeedsRootInstall(downloadedFilePath)) {
    void installLinuxPackageUpdate(downloadedFilePath as string)
    return
  }
  updater.quitAndInstall()
}

export type LinuxPackageFormat = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'managed' | 'unknown'

export function linuxPackageFormat(file: string | null): LinuxPackageFormat {
  if (!file) return 'unknown'
  const lower = file.toLowerCase()
  if (lower.endsWith('.appimage')) return 'appimage'
  if (lower.endsWith('.deb')) return 'deb'
  if (lower.endsWith('.rpm')) return 'rpm'
  if (lower.endsWith('.pacman') || /\.pkg\.tar\.(zst|xz|gz)$/.test(lower)) return 'pacman'
  return 'unknown'
}

// AppImage updates run from userspace and need no elevation; only the system
// package formats do.
export function linuxNeedsRootInstall(file: string | null): boolean {
  const format = linuxPackageFormat(file)
  return format === 'deb' || format === 'rpm' || format === 'pacman'
}

// Which package format this machine can actually install.
//
// electron-updater picks its Linux updater (and therefore which release asset
// an update downloads, and which installer runs it) from a `package-type` file
// electron-builder stamps into the install. That stamp cannot be trusted: every
// Linux target is cut from ONE shared staging directory, the targets build
// concurrently, and only the deb and rpm targets write the file, so a package
// ships whichever value another target happened to leave behind. Our published
// 2.39.0 .pacman carried `deb`, which is why Arch users were handed a .deb and
// a root prompt to run dpkg, a command their system does not have (reported on
// Discord by Kelv, on CachyOS). It cannot be fixed reliably in the build for
// the same reason it broke: there is one file and five racing writers.
//
// So the format is decided here instead, from the running system.
const DISTRO_FAMILY_FORMATS: Array<[LinuxPackageFormat, string[]]> = [
  ['pacman', ['arch', 'archarm', 'artix', 'cachyos', 'endeavouros', 'garuda', 'manjaro']],
  [
    'deb',
    ['debian', 'devuan', 'elementary', 'kali', 'linuxmint', 'pop', 'raspbian', 'ubuntu', 'zorin']
  ],
  [
    'rpm',
    [
      'almalinux',
      'centos',
      'fedora',
      'mageia',
      'opensuse',
      'opensuse-leap',
      'opensuse-tumbleweed',
      'rhel',
      'rocky',
      'sles',
      'suse'
    ]
  ]
]

/** Read ID and ID_LIKE out of an /etc/os-release body. ID names the distro,
 *  ID_LIKE its space-separated ancestors, which is what carries derivatives
 *  (CachyOS declares `ID_LIKE=arch`) we would otherwise have to enumerate. */
export function linuxFormatFromOsRelease(osRelease: string): LinuxPackageFormat {
  const declared: Partial<Record<'ID' | 'ID_LIKE', string[]>> = {}
  for (const line of osRelease.split('\n')) {
    const match = /^\s*(ID|ID_LIKE)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2]
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
    declared[match[1] as 'ID' | 'ID_LIKE'] = value.split(/\s+/).filter(Boolean)
  }
  // A distro's own ID is authoritative if it conflicts with an ancestor.
  // os-release is a set of assignments and does not require either key first.
  const ids = [...(declared.ID ?? []), ...(declared.ID_LIKE ?? [])]
  for (const id of ids) {
    const family = DISTRO_FAMILY_FORMATS.find(([, members]) => members.includes(id))
    if (family) return family[0]
  }
  return 'unknown'
}

/** The format this install can install, or 'unknown' when we cannot tell (in
 *  which case nothing is blocked). */
export function installedLinuxFormat(
  readOsRelease: () => string = defaultReadOsRelease
): LinuxPackageFormat {
  // An AppImage updates itself in userspace and never needs a system package.
  if (process.env.APPIMAGE) return 'appimage'
  try {
    return linuxFormatFromOsRelease(readOsRelease())
  } catch {
    return 'unknown'
  }
}

function defaultReadOsRelease(): string {
  return readFileSync('/etc/os-release', 'utf8')
}

/**
 * Which updater this Linux install needs, given what we can observe about it.
 *
 * The `package-type` stamp's VALUE is unreliable (see above). Its presence is
 * useful only together with electron-builder's fixed `/opt/ZenNotes` install
 * path: the shared staging directory can leak the stamp into tar.gz, which the
 * AUR repackages under `/opt/zennotes-bin`. The path check keeps those installs
 * owned by their package manager even when that race occurs.
 *
 * A non-system install that is not an AppImage (the AUR package, a tarball
 * unpacked by hand) is `managed`: nothing here may write into it, so the app
 * only reads the release feed and reports. Those installs used to be handed
 * the AppImage updater, which refuses to run without an APPIMAGE marker and
 * never reports that it refused, so their update check sat on "Checking…"
 * forever (reported on Discord by unyanda, on the AUR package).
 */
export function linuxUpdaterFormat(input: {
  isAppImage: boolean
  isOfficialSystemPackage: boolean
  osRelease: string | null
}): LinuxPackageFormat {
  if (input.isAppImage) return 'appimage'
  if (!input.isOfficialSystemPackage) return 'managed'
  return input.osRelease === null ? 'unknown' : linuxFormatFromOsRelease(input.osRelease)
}

const OFFICIAL_LINUX_RESOURCES_PATH = posix.join('/opt', 'ZenNotes', 'resources')

/** True only for the fixed install layout emitted by this app's official
 *  deb/rpm/pacman targets. The stamp alone is not enough because it is written
 *  into a staging directory shared with tar.gz. */
export function isOfficialLinuxSystemPackage(
  resourcesPath: string,
  hasPackageStamp: boolean
): boolean {
  return hasPackageStamp && posix.normalize(resourcesPath) === OFFICIAL_LINUX_RESOURCES_PATH
}

/** True when running `downloaded`'s installer on a machine that is `installed`
 *  cannot work. Unknowns never block: a distro we do not recognize is not a
 *  reason to refuse an update that would have worked. */
export function linuxInstallMismatch(
  downloaded: LinuxPackageFormat,
  installed: LinuxPackageFormat
): boolean {
  if (installed === 'unknown' || downloaded === 'unknown') return false
  return downloaded !== installed
}

const DOWNLOAD_PAGE_BY_FORMAT: Record<string, string> = {
  deb: 'https://zennotes.org/download/linux-deb',
  rpm: 'https://zennotes.org/download/linux-rpm',
  pacman: 'https://zennotes.org/download/linux-pacman',
  appimage: 'https://zennotes.org/download/linux-appimage'
}

export function mismatchedUpdateMessage(
  downloaded: LinuxPackageFormat,
  installed: LinuxPackageFormat,
  version: string | null
): string {
  const name = version ? `ZenNotes ${version}` : 'The update'
  const page = DOWNLOAD_PAGE_BY_FORMAT[installed] ?? 'https://zennotes.org/download'
  const wanted = installed === 'appimage' ? 'an AppImage' : `a .${installed} package`
  return `${name} was downloaded as a .${downloaded} package, but this copy of ZenNotes was installed as ${wanted}, so installing it here would fail. Download ${wanted} from ${page} and install it the way you installed ZenNotes. This build now detects the right package type from your system, so the next update installs itself.`
}

/** The updater matching what this machine actually runs, rather than the one
 *  electron-updater chose from the stamp when the module was loaded. */
function linuxUpdater(): AppUpdater | 'managed' {
  try {
    const format = linuxUpdaterFormat({
      isAppImage: Boolean(process.env.APPIMAGE),
      isOfficialSystemPackage: isOfficialLinuxSystemPackage(
        process.resourcesPath,
        existsSync(join(process.resourcesPath, 'package-type'))
      ),
      osRelease: readOsReleaseOrNull()
    })
    if (format === 'managed') return 'managed'
    return linuxUpdaterForFormat(format)
  } catch {
    // Any surprise here means we know nothing extra; electron-updater's own
    // choice is no worse than it was before.
    return autoUpdater
  }
}

export function linuxUpdaterForFormat(format: Exclude<LinuxPackageFormat, 'managed'>): AppUpdater {
  switch (format) {
    case 'appimage':
      return new electronUpdater.AppImageUpdater()
    case 'deb':
      return new electronUpdater.DebUpdater()
    case 'rpm':
      return new electronUpdater.RpmUpdater()
    case 'pacman':
      return new electronUpdater.PacmanUpdater()
    default:
      return autoUpdater
  }
}

function readOsReleaseOrNull(): string | null {
  try {
    return defaultReadOsRelease()
  } catch {
    return null
  }
}

/** How this copy was installed, in the words a bug report wants (#814). The
 *  Linux answer reuses the detection the updater itself relies on, so what
 *  `:version` prints is the format the updater will act on. */
export function installLabel(input: {
  isPackaged: boolean
  platform: NodeJS.Platform
  mas: boolean
  windowsStore: boolean
  portableExecutableDir: string | undefined
  linuxFormat: () => LinuxPackageFormat
}): string {
  if (!input.isPackaged) return 'development build'
  switch (input.platform) {
    case 'darwin':
      return input.mas ? 'Mac App Store' : 'macOS app bundle'
    case 'win32':
      if (input.windowsStore) return 'Microsoft Store'
      return input.portableExecutableDir ? 'portable exe' : 'NSIS installer'
    case 'linux':
      switch (input.linuxFormat()) {
        case 'appimage':
          return 'AppImage'
        case 'deb':
          return 'deb package'
        case 'rpm':
          return 'rpm package'
        case 'pacman':
          return 'pacman package'
        case 'managed':
          return 'package manager or tarball (updates are reported, not installed)'
        default:
          return 'Linux package (format unknown)'
      }
    default:
      return input.platform
  }
}

/** PRETTY_NAME from os-release, e.g. `Ubuntu 24.04.1 LTS`, or null. */
export function osReleasePrettyName(osRelease: string | null): string | null {
  if (!osRelease) return null
  for (const line of osRelease.split('\n')) {
    const match = /^\s*PRETTY_NAME\s*=\s*(.*)$/.exec(line)
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value) return value
    }
  }
  return null
}

/** Operating system and install format for the app info the preload hands
 *  to the renderer (#814). Reads os-release once; nothing here may throw,
 *  because the preload asks for it synchronously while the window boots. */
export function describeInstall(): { os: string; install: string } {
  const systemVersion = (() => {
    try {
      return process.getSystemVersion()
    } catch {
      return ''
    }
  })()
  const osRelease = process.platform === 'linux' ? readOsReleaseOrNull() : null
  const os =
    process.platform === 'darwin'
      ? `macOS ${systemVersion}`.trim()
      : process.platform === 'win32'
        ? `Windows ${systemVersion}`.trim()
        : process.platform === 'linux'
          ? `${osReleasePrettyName(osRelease) ?? 'Linux'} (kernel ${systemVersion || 'unknown'})`
          : `${process.platform} ${systemVersion}`.trim()
  let install: string
  try {
    install = installLabel({
      isPackaged: app.isPackaged,
      platform: process.platform,
      mas: Boolean(process.mas),
      windowsStore: Boolean(process.windowsStore),
      portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      linuxFormat: () =>
        linuxUpdaterFormat({
          isAppImage: Boolean(process.env.APPIMAGE),
          isOfficialSystemPackage: isOfficialLinuxSystemPackage(
            process.resourcesPath,
            existsSync(join(process.resourcesPath, 'package-type'))
          ),
          osRelease
        })
    })
  } catch {
    install = 'unknown'
  }
  return { os, install }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function elevatedInstallScript(format: LinuxPackageFormat, file: string): string | null {
  const target = shellQuote(file)
  switch (format) {
    case 'deb':
      // Install directly; if dependencies are missing, let apt resolve them.
      return `dpkg -i ${target} || apt-get install -f -y`
    case 'rpm':
      return `rpm -U --force ${target}`
    case 'pacman':
      return `pacman -U --noconfirm ${target}`
    default:
      return null
  }
}

export function manualInstallHint(format: LinuxPackageFormat, file: string): string {
  switch (format) {
    case 'deb':
      return `sudo dpkg -i "${file}"`
    case 'rpm':
      return `sudo rpm -U "${file}"`
    case 'pacman':
      return `sudo pacman -U "${file}"`
    default:
      return `install "${file}" with your package manager`
  }
}

function revealDownloadedPackage(file: string): void {
  try {
    shell.showItemInFolder(file)
  } catch {
    // Best effort — the path is already included in the message.
  }
}

async function installLinuxPackageUpdate(file: string): Promise<void> {
  const format = linuxPackageFormat(file)
  const script = elevatedInstallScript(format, file)
  if (!script) {
    // Unknown format — defer to electron-updater's own handling.
    updater?.quitAndInstall()
    return
  }

  // Never ask for a root password to run an installer this system does not
  // have. Point at the right download instead of failing inside pkexec.
  const installed = installedLinuxFormat()
  if (linuxInstallMismatch(format, installed)) {
    revealDownloadedPackage(file)
    setUpdateState(
      nextStateFromInfo(
        'error',
        lastInfo,
        mismatchedUpdateMessage(format, installed, lastInfo?.version ?? null)
      )
    )
    return
  }

  setUpdateState(
    nextStateFromInfo(
      'installing',
      lastInfo,
      `Installing ZenNotes ${lastInfo?.version ?? ''}… approve the administrator prompt to finish.`
    )
  )

  try {
    // Require a graphical agent; a hidden terminal prompt cannot be answered here.
    await execFileAsync('pkexec', ['--disable-internal-agent', 'sh', '-c', script])
  } catch (error) {
    handleLinuxInstallFailure(format, file, error)
    return
  }

  // The package was replaced on disk; relaunch into the new version.
  app.relaunch()
  app.quit()
}

function handleLinuxInstallFailure(
  format: LinuxPackageFormat,
  file: string,
  error: unknown
): void {
  const code = (error as { code?: string | number }).code
  const hint = manualInstallHint(format, file)

  // pkexec isn't installed (no graphical askpass available).
  if (code === 'ENOENT') {
    revealDownloadedPackage(file)
    setUpdateState(
      nextStateFromInfo(
        'error',
        lastInfo,
        `Couldn't install automatically: pkexec (graphical sudo) isn't available on this system. The update was downloaded to ${file}; install it manually with: ${hint}, then reopen ZenNotes.`
      )
    )
    return
  }

  // Only 126 means the user dismissed the authorization dialog.
  if (code === 126) {
    setUpdateState(
      nextStateFromInfo(
        'downloaded',
        lastInfo,
        'Update install was canceled. Click “Install and Relaunch” to try again.'
      )
    )
    return
  }

  if (code === 127) {
    revealDownloadedPackage(file)
    setUpdateState(nextStateFromInfo(
      'error', lastInfo,
      `Administrator authorization failed. Make sure a graphical polkit agent is running, or install the downloaded package with: ${hint}, then reopen ZenNotes.`
    ))
    return
  }

  // dpkg/apt (or rpm/pacman) failed.
  revealDownloadedPackage(file)
  const detail = error instanceof Error ? error.message.trim() : String(error)
  setUpdateState(
    nextStateFromInfo(
      'error',
      lastInfo,
      `Update install failed: ${detail || 'unknown error'}. The package is at ${file}; you can install it manually with: ${hint}.`
    )
  )
}
