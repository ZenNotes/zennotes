/**
 * The Logseq import as the app runs it. As with Obsidian, the graph folder is
 * chosen in main, through the system's own dialog, and kept here: the renderer
 * can ask about "the graph that was picked" but can't name a folder to read.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { NotionAbortError } from '@shared/notion-import/client'
import { IPC } from '@shared/ipc'
import type {
  LogseqDailyNotePlace,
  LogseqImportScan,
  NotionImportProgress
} from '@zennotes/bridge-contract/notion-import'
import { isInside } from './obsidian-import-run'
import { LOGSEQ_IMPORT_FOLDER, runLogseqImport, scanLogseqGraph } from './logseq-import-run'
import { folderRoot, listNotes } from './vault'

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
    if (!win.isDestroyed()) win.webContents.send(IPC.LOGSEQ_IMPORT_ON_PROGRESS, progress)
  }
}

/** The renderer's daily-note places, as plain data; main checks each path again. */
function readDailyNotes(value: unknown): Record<string, LogseqDailyNotePlace> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, LogseqDailyNotePlace> = {}
  for (const [date, place] of Object.entries(value as Record<string, unknown>)) {
    if (!place || typeof place !== 'object') continue
    const { subpath, title, exists } = place as Record<string, unknown>
    if (typeof subpath !== 'string' || typeof title !== 'string') continue
    out[date] = { subpath, title, exists: exists === true }
  }
  return out
}

export const logseqImport = {
  status(): { running: boolean; progress: NotionImportProgress | null } {
    return { running: controller !== null, progress: lastProgress }
  },

  /** Null when the person cancels the dialog. */
  async pick(window: BrowserWindow | null, root: string | null): Promise<LogseqImportScan | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose your Logseq graph',
      message: 'Choose the folder that holds pages and journals.',
      properties: ['openDirectory'],
      buttonLabel: 'Choose Graph'
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (root && (isInside(picked, root) || isInside(root, picked))) {
      throw new Error('That folder holds this vault, or sits inside it. Choose a graph somewhere else.')
    }
    const scan = await scanLogseqGraph(picked)
    source = picked
    lastProgress = null
    return scan
  },

  async start(
    root: string,
    options: { folder?: unknown; dailyNotes?: unknown; bullets?: unknown; includeTasks?: unknown }
  ): Promise<void> {
    if (controller) throw new Error('An import is already running.')
    if (!source) throw new Error('Choose a graph first.')
    const picked = source
    const running = new AbortController()
    controller = running
    lastProgress = null
    const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)
    try {
      const [notes, notesRoot] = await Promise.all([listNotes(root), folderRoot(root, 'inbox')])
      void runLogseqImport({
        source: picked,
        stagingDir: path.join(app.getPath('userData'), 'logseq-import', id),
        root,
        notesRoot,
        existingNotes: notes.map((note) => note.path),
        folder: typeof options.folder === 'string' && options.folder.trim() ? options.folder : LOGSEQ_IMPORT_FOLDER,
        dailyNotes: readDailyNotes(options.dailyNotes),
        bullets: options.bullets === true,
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
