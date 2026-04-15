import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import type { NoteFolder, VaultChangeEvent, VaultInfo } from '@shared/ipc'
import {
  absolutePath,
  archiveNote,
  assetsAbsolutePath,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  duplicateFolder,
  duplicateNote,
  emptyTrash,
  ensureVaultLayout,
  folderAbsolutePath,
  hasAssetsDir,
  importFiles,
  listAssets,
  listFolders,
  listNotes,
  loadConfig,
  moveNote,
  moveToTrash,
  readNote,
  renameFolder,
  renameNote,
  restoreFromTrash,
  saveConfig,
  unarchiveNote,
  vaultInfo,
  writeNote
} from './vault'
import { scanAllTasks, scanTasksForPath } from './tasks'
import { VaultWatcher } from './watcher'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_ASSET_SCHEME = 'zen-asset'

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let currentVault: VaultInfo | null = null
const watcher = new VaultWatcher()

function isMac(): boolean {
  return process.platform === 'darwin'
}

function decodeLocalAssetRequestPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LOCAL_ASSET_SCHEME}:`) return null
    const encoded = parsed.searchParams.get('path')
    if (!encoded) return null
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function isPathInsideVault(absPath: string): boolean {
  if (!currentVault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(currentVault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function mimeTypeForPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase()
  switch (ext) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.m4a':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.m4v':
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.ogv':
      return 'video/ogg'
    case '.webm':
      return 'video/webm'
    default:
      return 'application/octet-stream'
  }
}

function createWindow(): void {
  const mac = isMac()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    // Apple Liquid Glass: we want system materials to show through the
    // window chrome. On macOS 26+ Electron maps `vibrancy: 'fullscreen-ui'`
    // to the new glass material; older macOS versions fall back to the
    // traditional vibrancy behaviour automatically.
    ...(mac
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
          transparent: true
        }
      : {
          backgroundColor: '#faf7f0',
          icon: path.join(__dirname, '../../build/icon.png')
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideVault(abs)) {
        void shell.openPath(abs)
      }
      return { action: 'deny' }
    }
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function setVault(root: string): Promise<VaultInfo> {
  await ensureVaultLayout(root)
  currentVault = vaultInfo(root)
  await saveConfig({ vaultRoot: root })
  watcher.start(root, (ev: VaultChangeEvent) => {
    // Broadcast to every open window — the main window, all floating
    // note windows — so each can refresh its in-memory state.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.VAULT_ON_CHANGE, ev)
    }
  })
  return currentVault
}

function requireVault(): VaultInfo {
  if (!currentVault) throw new Error('No vault is open')
  return currentVault
}

/**
 * Enumerate installed font families for the font picker.
 *
 * On macOS we call `system_profiler SPFontsDataType -json` and pull the
 * `typefaces[].family` field out of each entry — that's the actual
 * family name users see in Font Book (`JetBrains Mono`, `SF Mono`),
 * not the raw filename. Falls back to the `font-list` package on other
 * platforms.
 */
function listFontFamiliesMac(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/system_profiler',
      ['SPFontsDataType', '-json'],
      { maxBuffer: 200 * 1024 * 1024 },
      async (err, stdout) => {
        if (err) {
          console.error('system_profiler failed', err)
          resolve([])
          return
        }
        try {
          const data = JSON.parse(stdout) as {
            SPFontsDataType: Array<{
              _name?: string
              typefaces?: Array<{ family?: string; _name?: string }>
            }>
          }
          const entries = data.SPFontsDataType || []
          const families = new Set<string>()
          for (const entry of entries) {
            const faces = entry.typefaces || []
            for (const f of faces) {
              const name = f.family?.trim()
              if (!name) continue
              // Skip macOS private system fonts (leading dot, e.g.
              // `.SF NS`, `.SF Arabic`) — they're meant for the OS,
              // not user-selectable text.
              if (name.startsWith('.')) continue
              families.add(name)
            }
          }
          // Also include every file name that might not appear as a
          // registered typeface — rare but gives us an extra safety net
          // for fonts that were activated after boot and aren't yet in
          // the system_profiler cache.
          try {
            const homeFonts = path.join(app.getPath('home'), 'Library', 'Fonts')
            const files = await fsp.readdir(homeFonts)
            for (const f of files) {
              if (/\.(ttf|otf|ttc|otc)$/i.test(f)) {
                // Not a family name but a filename — only add if we
                // can't find any family that shares its stem.
                const stem = f.replace(/\.(ttf|otf|ttc|otc)$/i, '')
                const guess = stem.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
                if (guess && ![...families].some((fam) => guess.toLowerCase().startsWith(fam.toLowerCase()))) {
                  // leave unmatched file stems out of the picker — they
                  // rarely map cleanly to a family the user would pick.
                }
              }
            }
          } catch {
            /* ignore */
          }
          resolve(
            [...families].sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: 'base' })
            )
          )
        } catch (e) {
          console.error('failed to parse system_profiler JSON', e)
          resolve([])
        }
      }
    )
  })
}

async function listFontFamilies(): Promise<string[]> {
  if (process.platform === 'darwin') {
    const list = await listFontFamiliesMac()
    if (list.length > 0) return list
  }
  // Cross-platform fallback via the `font-list` package.
  try {
    const mod = (await import('font-list')) as unknown as {
      getFonts?: () => Promise<string[]>
      default?: { getFonts?: () => Promise<string[]> }
    }
    const getFonts = mod.getFonts ?? mod.default?.getFonts
    if (!getFonts) return []
    const raw = await getFonts()
    const unique = new Set<string>()
    for (const f of raw) {
      const name = f.replace(/^"|"$/g, '').trim()
      if (name) unique.add(name)
    }
    return [...unique].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  } catch (err) {
    console.error('font-list fallback failed', err)
    return []
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.APP_PLATFORM, () => process.platform)

  ipcMain.handle(IPC.APP_LIST_FONTS, async () => {
    const list = await listFontFamilies()
    console.log(`listFontFamilies: returning ${list.length} families`)
    return list
  })

  ipcMain.handle(IPC.VAULT_GET_CURRENT, async () => {
    if (currentVault) return currentVault
    const cfg = await loadConfig()
    if (cfg.vaultRoot) {
      try {
        return await setVault(cfg.vaultRoot)
      } catch {
        return null
      }
    }
    return null
  })

  ipcMain.handle(IPC.VAULT_PICK, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a vault folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Vault'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return await setVault(result.filePaths[0])
  })

  ipcMain.handle(IPC.VAULT_LIST_NOTES, async () => {
    const v = requireVault()
    return await listNotes(v.root)
  })

  ipcMain.handle(IPC.VAULT_LIST_FOLDERS, async () => {
    const v = requireVault()
    return await listFolders(v.root)
  })

  ipcMain.handle(IPC.VAULT_LIST_ASSETS, async () => {
    const v = requireVault()
    return await listAssets(v.root)
  })

  ipcMain.handle(IPC.VAULT_HAS_ASSETS_DIR, async () => {
    const v = requireVault()
    return await hasAssetsDir(v.root)
  })

  ipcMain.handle(IPC.VAULT_READ_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    return await readNote(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_SCAN_TASKS, async () => {
    const v = requireVault()
    return await scanAllTasks(v.root)
  })

  ipcMain.handle(IPC.VAULT_SCAN_TASKS_FOR, async (_e, relPath: string) => {
    const v = requireVault()
    return await scanTasksForPath(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_WRITE_NOTE, async (_e, relPath: string, body: string) => {
    const v = requireVault()
    return await writeNote(v.root, relPath, body)
  })

  ipcMain.handle(
    IPC.VAULT_CREATE_NOTE,
    async (_e, folder: NoteFolder, title?: string, subpath = '') => {
      const v = requireVault()
      return await createNote(v.root, folder, title, subpath)
    }
  )

  ipcMain.handle(IPC.VAULT_RENAME_NOTE, async (_e, relPath: string, nextTitle: string) => {
    const v = requireVault()
    return await renameNote(v.root, relPath, nextTitle)
  })

  ipcMain.handle(IPC.VAULT_DELETE_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    await deleteNote(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_MOVE_TO_TRASH, async (_e, relPath: string) => {
    const v = requireVault()
    return await moveToTrash(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_RESTORE_FROM_TRASH, async (_e, relPath: string) => {
    const v = requireVault()
    return await restoreFromTrash(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_EMPTY_TRASH, async () => {
    const v = requireVault()
    await emptyTrash(v.root)
  })

  ipcMain.handle(IPC.VAULT_ARCHIVE_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    return await archiveNote(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_UNARCHIVE_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    return await unarchiveNote(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_DUPLICATE_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    return await duplicateNote(v.root, relPath)
  })

  ipcMain.handle(IPC.VAULT_REVEAL_NOTE, async (_e, relPath: string) => {
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    shell.showItemInFolder(abs)
  })

  ipcMain.handle(
    IPC.VAULT_MOVE_NOTE,
    async (_e, relPath: string, targetFolder: NoteFolder, targetSubpath: string) => {
      const v = requireVault()
      return await moveNote(v.root, relPath, targetFolder, targetSubpath)
    }
  )

  ipcMain.handle(
    IPC.VAULT_IMPORT_FILES,
    async (_e, notePath: string, sourcePaths: string[]) => {
      const v = requireVault()
      return await importFiles(v.root, notePath, sourcePaths)
    }
  )

  ipcMain.handle(
    IPC.VAULT_CREATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      const v = requireVault()
      await createFolder(v.root, folder, subpath)
    }
  )

  ipcMain.handle(
    IPC.VAULT_RENAME_FOLDER,
    async (_e, folder: NoteFolder, oldSubpath: string, newSubpath: string) => {
      const v = requireVault()
      return await renameFolder(v.root, folder, oldSubpath, newSubpath)
    }
  )

  ipcMain.handle(
    IPC.VAULT_DELETE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      const v = requireVault()
      await deleteFolder(v.root, folder, subpath)
    }
  )

  ipcMain.handle(
    IPC.VAULT_DUPLICATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      const v = requireVault()
      return await duplicateFolder(v.root, folder, subpath)
    }
  )

  ipcMain.handle(
    IPC.VAULT_REVEAL_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      const v = requireVault()
      const abs = folderAbsolutePath(v.root, folder, subpath)
      await shell.openPath(abs)
    }
  )

  ipcMain.handle(IPC.VAULT_REVEAL_ASSETS_DIR, async () => {
    const v = requireVault()
    const abs = assetsAbsolutePath(v.root)
    await shell.openPath(abs)
  })

  // Route window chrome controls to the window that actually sent the
  // IPC (via `e.sender`) so that floating note windows can minimize /
  // maximize / close themselves without hijacking the main window.
  ipcMain.on(IPC.WINDOW_MINIMIZE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.on(IPC.WINDOW_TOGGLE_MAXIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.WINDOW_CLOSE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  ipcMain.handle(IPC.WINDOW_OPEN_NOTE, async (_e, relPath: string) => {
    openFloatingNoteWindow(relPath)
  })
}

/**
 * Pop a note out into a standalone always-visible window. The same
 * note is reused if a floating window is already showing it — we just
 * focus the existing one rather than spawning duplicates.
 */
const floatingNoteWindows = new Map<string, BrowserWindow>()
function openFloatingNoteWindow(relPath: string): void {
  const existing = floatingNoteWindows.get(relPath)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const mac = isMac()
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 360,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(mac
      ? {
          backgroundColor: '#00000000',
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          transparent: true
        }
      : {
          backgroundColor: '#faf7f0'
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  floatingNoteWindows.set(relPath, win)
  win.on('closed', () => {
    floatingNoteWindows.delete(relPath)
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  const params = `?floating=1&note=${encodeURIComponent(relPath)}`
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }
}

// Set the app name before the ready event so the dock / menu bar /
// About panel all show "ZenNotes" instead of the default "Electron"
// during dev. electron-builder handles this for packaged builds via
// `productName`, but in `npm run dev` we have to announce it ourselves.
app.setName('ZenNotes')
if (isMac()) {
  app.setAboutPanelOptions({
    applicationName: 'ZenNotes',
    applicationVersion: app.getVersion()
  })
}

function installAppMenu(): void {
  if (!isMac()) {
    // On Windows/Linux we keep `autoHideMenuBar: true` and skip the menu.
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ZenNotes',
      submenu: [
        { label: 'About ZenNotes', role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send('menu:open-settings')
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide ZenNotes' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ZenNotes' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  protocol.handle(LOCAL_ASSET_SCHEME, async (request) => {
    const abs = decodeLocalAssetRequestPath(request.url)
    if (!abs || !isPathInsideVault(abs)) {
      throw new Error(`Invalid local asset URL: ${request.url}`)
    }
    const data = await fsp.readFile(abs)
    return new Response(data, {
      headers: {
        'content-type': mimeTypeForPath(abs),
        'cache-control': 'no-cache'
      }
    })
  })

  // Auto-grant the Local Font Access permission so `queryLocalFonts()`
  // can enumerate system fonts without a prompt. This is our own app
  // talking to our own vault — no third-party surface.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // 'local-fonts' is not in Electron's published permission union yet,
    // but Chromium emits it when the renderer calls `queryLocalFonts()`.
    if ((permission as string) === 'local-fonts') return callback(true)
    callback(false)
  })

  // macOS dock icon. `BrowserWindow.icon` has no effect on macOS — the
  // dock picks up whatever the running binary advertises. During
  // `npm run dev` that's Electron's default, so we force our own.
  if (isMac() && app.dock) {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png')
      app.dock.setIcon(iconPath)
    } catch (err) {
      console.error('Failed to set dock icon', err)
    }
  }

  installAppMenu()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher.stop()
  if (!isMac()) app.quit()
})

app.on('before-quit', () => {
  watcher.stop()
})
