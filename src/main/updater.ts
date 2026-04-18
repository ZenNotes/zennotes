import { app, BrowserWindow } from 'electron'
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo
} from 'electron-updater'
import { IPC, type AppUpdateState } from '@shared/ipc'

const { autoUpdater } = electronUpdater

let initialized = false
let updater: AppUpdater | null = null
let lastInfo: UpdateInfo | null = null
let updateState: AppUpdateState = makeState({
  phase: 'unsupported',
  message: 'Updates are only available in packaged builds.'
})

function makeState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'idle',
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

function humanizeUpdateError(error: unknown): string {
  const base =
    error instanceof Error ? error.message.trim() : String(error).trim()
  const message = base.length > 0 ? base : 'Unknown updater error.'
  if (/404|401|403|forbidden|unauthorized/i.test(message)) {
    return `${message} GitHub-hosted end-user updates require public releases, or a special private-repo token setup.`
  }
  if (process.platform === 'darwin' && /sign|signature/i.test(message)) {
    return `${message} macOS auto-updates require a signed app build.`
  }
  return message
}

function broadcastUpdateState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.APP_UPDATER_ON_STATE, updateState)
  }
}

function setUpdateState(next: AppUpdateState): void {
  updateState = next
  broadcastUpdateState()
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

  if (!app.isPackaged) {
    setUpdateState(
      makeState({
        phase: 'unsupported',
        message: 'Update checks only work in packaged ZenNotes builds.'
      })
    )
    return
  }

  updater = autoUpdater
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
    setUpdateState(
      nextStateFromInfo(
        'downloaded',
        info,
        `ZenNotes ${info.version} is ready. Restart to install the update.`
      )
    )
  })
  updater.on('error', (error) => {
    setUpdateState(
      nextStateFromInfo('error', lastInfo, humanizeUpdateError(error))
    )
  })

  setUpdateState(makeState())
}

export async function checkForAppUpdates(): Promise<AppUpdateState> {
  initAppUpdater()
  if (!updater) return getAppUpdateState()
  if (updateState.phase === 'checking') return getAppUpdateState()

  setUpdateState(
    nextStateFromInfo('checking', lastInfo, 'Checking GitHub releases for updates…')
  )

  try {
    await updater.checkForUpdates()
  } catch (error) {
    setUpdateState(
      nextStateFromInfo('error', lastInfo, humanizeUpdateError(error))
    )
  }

  return getAppUpdateState()
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
  updater.quitAndInstall()
}
