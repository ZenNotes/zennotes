/**
 * The Obsidian import as the app runs it. The folder is chosen in main, through
 * the system's own dialog, and kept here: the renderer can ask about "the vault
 * that was picked" but can't name a folder to read, the same way no handler
 * takes a vault root from it.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { NotionAbortError } from '@shared/notion-import/client'
import { IPC } from '@shared/ipc'
import type {
  NotionImportProgress,
  ObsidianImportScan
} from '@zennotes/bridge-contract/notion-import'
import { isInside, runObsidianImport, scanObsidianVault } from './obsidian-import-run'
import { folderRoot, listAssets, listNotes } from './vault'

let source: string | null = null
let controller: AbortController | null = null
let lastProgress: NotionImportProgress | null = null
let lastSent = 0

function broadcast(progress: NotionImportProgress): void {
  lastProgress = progress
  const settled = progress.phase === 'done' || progress.phase === 'stopped' || progress.phase === 'failed'
  const now = Date.now()
  if (!settled && now - lastSent < 100) return
  lastSent = now
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.OBSIDIAN_IMPORT_ON_PROGRESS, progress)
  }
}

export const obsidianImport = {
  status(): { running: boolean; progress: NotionImportProgress | null } {
    return { running: controller !== null, progress: lastProgress }
  },

  /** Null when the person cancels the dialog. */
  async pick(window: BrowserWindow | null, root: string | null): Promise<ObsidianImportScan | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose your Obsidian vault',
      properties: ['openDirectory'],
      buttonLabel: 'Choose Vault'
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (root && (isInside(picked, root) || isInside(root, picked))) {
      throw new Error('That folder holds this vault, or sits inside it. Choose a vault somewhere else.')
    }
    source = picked
    lastProgress = null
    return await scanObsidianVault(picked)
  },

  async start(root: string, options: { includeTasks?: unknown; excluded?: unknown }): Promise<void> {
    if (controller) throw new Error('An import is already running.')
    if (!source) throw new Error('Choose a vault first.')
    const picked = source
    const running = new AbortController()
    controller = running
    lastProgress = null
    const excluded = Array.isArray(options.excluded)
      ? options.excluded.filter((id): id is string => typeof id === 'string')
      : []
    const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)
    try {
      const [notes, assets, notesRoot] = await Promise.all([
        listNotes(root),
        listAssets(root),
        folderRoot(root, 'inbox')
      ])
      void runObsidianImport({
        source: picked,
        stagingDir: path.join(app.getPath('userData'), 'obsidian-import', id),
        root,
        notesRoot,
        existingNotes: notes.map((note) => note.path),
        existingAssets: assets.map((asset) => asset.path),
        excluded,
        includeTasks: options.includeTasks !== false,
        today: new Date().toISOString().slice(0, 10),
        onProgress: broadcast,
        signal: running.signal
      })
        .then((result) => {
          broadcast({ phase: 'done', done: 1, total: 1, result })
          source = null
        })
        .catch((error: unknown) => {
          const stopped = error instanceof NotionAbortError || running.signal.aborted
          broadcast(
            stopped
              ? { phase: 'stopped', done: 0, total: 0 }
              : { phase: 'failed', done: 0, total: 0, error: error instanceof Error ? error.message : String(error) }
          )
        })
        .finally(() => {
          controller = null
        })
    } catch (error) {
      controller = null
      throw error
    }
  },

  stop(): void {
    controller?.abort()
  },

  /** A finished result has been seen. */
  dismiss(): void {
    if (!controller) lastProgress = null
  }
}
