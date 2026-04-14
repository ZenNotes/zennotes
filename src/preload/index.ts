import { contextBridge, ipcRenderer, webUtils } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import type {
  AssetMeta,
  FolderEntry,
  ImportedAsset,
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultChangeEvent,
  VaultInfo
} from '@shared/ipc'

const api = {
  platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke(IPC.APP_PLATFORM),
  listSystemFonts: (): Promise<string[]> => ipcRenderer.invoke(IPC.APP_LIST_FONTS),

  getCurrentVault: (): Promise<VaultInfo | null> => ipcRenderer.invoke(IPC.VAULT_GET_CURRENT),
  pickVault: (): Promise<VaultInfo | null> => ipcRenderer.invoke(IPC.VAULT_PICK),

  listNotes: (): Promise<NoteMeta[]> => ipcRenderer.invoke(IPC.VAULT_LIST_NOTES),
  listFolders: (): Promise<FolderEntry[]> =>
    ipcRenderer.invoke(IPC.VAULT_LIST_FOLDERS),
  listAssets: (): Promise<AssetMeta[]> => ipcRenderer.invoke(IPC.VAULT_LIST_ASSETS),
  hasAssetsDir: (): Promise<boolean> => ipcRenderer.invoke(IPC.VAULT_HAS_ASSETS_DIR),
  readNote: (relPath: string): Promise<NoteContent> =>
    ipcRenderer.invoke(IPC.VAULT_READ_NOTE, relPath),
  writeNote: (relPath: string, body: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_WRITE_NOTE, relPath, body),
  createNote: (
    folder: NoteFolder,
    title?: string,
    subpath?: string
  ): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_NOTE, folder, title, subpath),
  renameNote: (relPath: string, nextTitle: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_NOTE, relPath, nextTitle),
  deleteNote: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_NOTE, relPath),
  moveToTrash: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_TO_TRASH, relPath),
  restoreFromTrash: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_RESTORE_FROM_TRASH, relPath),
  emptyTrash: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_EMPTY_TRASH),
  archiveNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_ARCHIVE_NOTE, relPath),
  unarchiveNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_UNARCHIVE_NOTE, relPath),
  duplicateNote: (relPath: string): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_NOTE, relPath),
  revealNote: (relPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_NOTE, relPath),
  moveNote: (
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<NoteMeta> =>
    ipcRenderer.invoke(IPC.VAULT_MOVE_NOTE, relPath, targetFolder, targetSubpath),
  importFilesToNote: (notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]> =>
    ipcRenderer.invoke(IPC.VAULT_IMPORT_FILES, notePath, sourcePaths),
  createFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_CREATE_FOLDER, folder, subpath),
  renameFolder: (
    folder: NoteFolder,
    oldSubpath: string,
    newSubpath: string
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_RENAME_FOLDER, folder, oldSubpath, newSubpath),
  deleteFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_DELETE_FOLDER, folder, subpath),
  duplicateFolder: (folder: NoteFolder, subpath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.VAULT_DUPLICATE_FOLDER, folder, subpath),
  revealFolder: (folder: NoteFolder, subpath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VAULT_REVEAL_FOLDER, folder, subpath),
  revealAssetsDir: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_REVEAL_ASSETS_DIR),
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  resolveLocalAssetUrl: (vaultRoot: string, notePath: string, href: string): string | null => {
    const trimmed = href.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

    const stripQueryAndHash = (value: string): string => {
      const hashIdx = value.indexOf('#')
      const queryIdx = value.indexOf('?')
      const cutIdx =
        hashIdx === -1
          ? queryIdx
          : queryIdx === -1
            ? hashIdx
            : Math.min(hashIdx, queryIdx)
      return cutIdx === -1 ? value : value.slice(0, cutIdx)
    }
    const decodeHrefPath = (value: string): string => {
      const cleaned = stripQueryAndHash(value)
      try {
        return decodeURIComponent(cleaned)
      } catch {
        return cleaned
      }
    }

    const normalizedNotePath = notePath.split(path.sep).join('/')
    const noteDir = path.posix.dirname(normalizedNotePath)
    const decodedHref = decodeHrefPath(trimmed)
    const relativeTarget = decodedHref.startsWith('/')
      ? decodedHref.replace(/^\/+/, '')
      : path.posix.normalize(path.posix.join(noteDir === '.' ? '' : noteDir, decodedHref))
    const resolved = path.resolve(vaultRoot, relativeTarget.split('/').join(path.sep))
    const rootAbs = path.resolve(vaultRoot)
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null
    return `zen-asset://local?path=${encodeURIComponent(resolved)}`
  },
  resolveVaultAssetUrl: (vaultRoot: string, assetPath: string): string | null => {
    const trimmed = assetPath.trim()
    if (!trimmed) return null
    const resolved = path.resolve(vaultRoot, trimmed.split('/').join(path.sep))
    const rootAbs = path.resolve(vaultRoot)
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null
    return `zen-asset://local?path=${encodeURIComponent(resolved)}`
  },

  onVaultChange: (cb: (ev: VaultChangeEvent) => void): (() => void) => {
    const listener = (_: unknown, ev: VaultChangeEvent): void => cb(ev)
    ipcRenderer.on(IPC.VAULT_ON_CHANGE, listener)
    return () => ipcRenderer.removeListener(IPC.VAULT_ON_CHANGE, listener)
  },

  windowMinimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowToggleMaximize: (): void => ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE),
  windowClose: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE)
}

export type ZenApi = typeof api

contextBridge.exposeInMainWorld('zen', api)
