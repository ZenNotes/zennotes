/**
 * The Notion import as the app runs it: sent from main the way the Unsplash
 * search and Cloud are, because the renderer's CSP keeps connect-src to the
 * app's own schemes and this side decides what leaves. Credentials sit in the
 * system's secure storage (secret-store) and only ever go to Notion: file
 * downloads are signed links and carry none.
 *
 * Signing in is the main route, since it reaches everything the person can
 * read. A token still works, for whoever would rather share page by page.
 *
 * One run at a time. It keeps its vault for the whole run, so switching vaults
 * partway doesn't change where the import lands.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, net, Notification, shell } from 'electron'
import {
  NotionAbortError,
  NotionApiError,
  NOTION_API_BASE_URL,
  createNotionClient,
  type NotionClient
} from '@shared/notion-import/client'
import { createMcpNotionClient } from '@shared/notion-import/mcp-source'
import { NOTION_MCP_BASE_URL, createNotionMcpTransport } from '@shared/notion-import/mcp-transport'
import { notionTreeChildren, notionTreeRoots } from '@shared/notion-import/tree'
import { IPC } from '@shared/ipc'
import type {
  NotionImportProgress,
  NotionImportStatus,
  NotionImportTokenResult,
  NotionImportTree,
  NotionTreeItem
} from '@zennotes/bridge-contract/notion-import'
import { createStagingStore, runNotionImport } from './notion-import-run'
import { createNotionSignIn } from './notion-sign-in'
import {
  canStoreSecretsSecurely,
  deleteNotionSessionSecret,
  deleteNotionTokenSecret,
  getNotionSessionSecret,
  getNotionTokenSecret,
  setNotionSessionSecret,
  setNotionTokenSecret
} from './secret-store'
import { folderRoot } from './vault'

/** Notion's address, or the stand-in an override names for a test run. As with
 *  the other overrides, a packaged app honors it only with ZEN_PERF=1. */
function overridable(name: string, fallback: string): string {
  const override = process.env[name]?.trim()
  if (override && (!app.isPackaged || process.env.ZEN_PERF === '1')) return override.replace(/\/+$/, '')
  return fallback
}
const apiBaseUrl = (): string => overridable('ZENNOTES_NOTION_API_URL', NOTION_API_BASE_URL)
const mcpBaseUrl = (): string => overridable('ZENNOTES_NOTION_MCP_URL', NOTION_MCP_BASE_URL)
const usingStandIn = (): boolean => apiBaseUrl() !== NOTION_API_BASE_URL || mcpBaseUrl() !== NOTION_MCP_BASE_URL

const signIn = createNotionSignIn({
  get baseUrl() {
    return mcpBaseUrl()
  },
  fetch: (url, init) => net.fetch(url, init),
  openExternal: (url) => shell.openExternal(url),
  load: getNotionSessionSecret,
  save: setNotionSessionSecret,
  remove: deleteNotionSessionSecret
})

function notionErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) {
    if (error.isAuth) return 'Notion refused this sign-in. Sign in again.'
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

let controller: AbortController | null = null
let lastProgress: NotionImportProgress | null = null
let lastSent = 0

function broadcast(progress: NotionImportProgress): void {
  lastProgress = progress
  const settled = progress.phase === 'done' || progress.phase === 'stopped' || progress.phase === 'failed'
  // A big workspace reports per page. The window needs a few frames a second.
  const now = Date.now()
  if (!settled && now - lastSent < 150) return
  lastSent = now
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.NOTION_IMPORT_ON_PROGRESS, progress)
  }
}

/** A run can take hours, and nobody watches a progress bar that long. */
function notifyIfAway(title: string, body: string): void {
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
  new Notification({ title, body }).show()
}

/** Per vault, so two vaults' half-finished imports can't mix. */
function stagingDirFor(root: string): string {
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)
  return path.join(app.getPath('userData'), 'notion-import', id)
}

async function isResumable(root: string): Promise<boolean> {
  const entries = await fs.readdir(path.join(stagingDirFor(root), 'records')).catch(() => [] as string[])
  return entries.length > 0
}

async function clientFor(signal?: AbortSignal): Promise<NotionClient> {
  if (await signIn.signedIn()) {
    return createMcpNotionClient(
      createNotionMcpTransport({
        fetch: (url, init) => net.fetch(url, init),
        baseUrl: mcpBaseUrl(),
        accessToken: () => signIn.accessToken(),
        refreshToken: () => signIn.refresh(),
        signal,
        clientVersion: app.getVersion()
      })
    )
  }
  const token = await getNotionTokenSecret()
  if (!token) throw new Error('Sign in to Notion first.')
  return createNotionClient({
    fetch: (url, init) => net.fetch(url, init),
    token,
    baseUrl: apiBaseUrl(),
    signal
  })
}

/** A client kept between picker calls: reading the workspace a level at a
 *  time is one conversation, and a new one per click would redo its setup. */
let pickerClient: NotionClient | null = null

export const notionImport = {
  async status(root: string | null, remote: boolean): Promise<NotionImportStatus> {
    return {
      signedIn: await signIn.signedIn(),
      tokenSet: !!(await getNotionTokenSecret()),
      canStore: canStoreSecretsSecurely(),
      remote,
      running: controller !== null,
      resumable: root ? await isResumable(root) : false,
      progress: lastProgress
    }
  },

  async signIn(): Promise<void> {
    if (!canStoreSecretsSecurely()) throw new Error('This system has no secure storage to keep a sign-in in.')
    pickerClient = null
    await signIn.signIn()
    BrowserWindow.getAllWindows()[0]?.show()
    BrowserWindow.getAllWindows()[0]?.focus()
  },

  cancelSignIn(): void {
    signIn.cancelSignIn()
  },

  async signOut(): Promise<void> {
    pickerClient = null
    await signIn.signOut()
    await deleteNotionTokenSecret()
  },

  async saveToken(token: unknown): Promise<NotionImportTokenResult> {
    const value = typeof token === 'string' ? token.trim() : ''
    if (!value) return { ok: false, error: 'Paste a token first.' }
    if (!canStoreSecretsSecurely()) {
      return { ok: false, error: 'This system has no secure storage to keep a token in.' }
    }
    // Checked before it's kept, so a bad paste fails here and not an hour in.
    const client = createNotionClient({
      fetch: (url, init) => net.fetch(url, init),
      token: value,
      baseUrl: apiBaseUrl()
    })
    try {
      await client.me()
    } catch (error) {
      if (error instanceof NotionApiError && error.isAuth) {
        return { ok: false, error: 'Notion refused this token. Check it and save it again.' }
      }
      return { ok: false, error: notionErrorMessage(error) }
    }
    pickerClient = null
    return (await setNotionTokenSecret(value))
      ? { ok: true }
      : { ok: false, error: 'The token could not be saved.' }
  },

  async tree(): Promise<NotionImportTree> {
    try {
      pickerClient = await clientFor()
      const me = await pickerClient.me()
      return {
        workspace: me.bot?.workspace_name?.trim() || 'Notion',
        items: await notionTreeRoots(pickerClient)
      }
    } catch (error) {
      throw new Error(notionErrorMessage(error))
    }
  },

  async treeChildren(pageId: unknown): Promise<NotionTreeItem[]> {
    if (typeof pageId !== 'string' || !/^[0-9a-f-]{32,36}$/i.test(pageId)) throw new Error('Not a page.')
    try {
      pickerClient ??= await clientFor()
      return await notionTreeChildren(pickerClient, pageId)
    } catch (error) {
      throw new Error(notionErrorMessage(error))
    }
  },

  /** Starts in the background: progress arrives on NOTION_IMPORT_ON_PROGRESS. */
  async start(root: string, options: { includeTasks?: unknown; excluded?: unknown }): Promise<void> {
    if (controller) throw new Error('An import is already running.')
    const running = new AbortController()
    controller = running
    const stagingDir = stagingDirFor(root)
    lastProgress = null
    try {
      const client = await clientFor(running.signal)
      const store = createStagingStore(stagingDir, (url, init) => net.fetch(url, init), {
        signal: running.signal,
        allowInsecureFiles: usingStandIn()
      })
      const notesRoot = await folderRoot(root, 'inbox')
      const excluded = Array.isArray(options.excluded)
        ? options.excluded.filter((id): id is string => typeof id === 'string')
        : []
      void runNotionImport({
        client,
        store,
        stagingDir,
        root,
        notesRoot,
        includeTasks: options.includeTasks === true,
        excluded,
        today: new Date().toISOString().slice(0, 10),
        onProgress: broadcast,
        signal: running.signal
      })
        .then((result) => {
          broadcast({ phase: 'done', done: 1, total: 1, result })
          notifyIfAway('Notion import finished', `Your notes are in ${result.folder}.`)
        })
        .catch((error: unknown) => {
          const stopped = error instanceof NotionAbortError || running.signal.aborted
          if (!stopped) notifyIfAway('Notion import stopped', notionErrorMessage(error))
          broadcast(
            stopped
              ? { phase: 'stopped', done: 0, total: 0 }
              : { phase: 'failed', done: 0, total: 0, error: notionErrorMessage(error) }
          )
        })
        .finally(() => {
          controller = null
        })
    } catch (error) {
      controller = null
      throw new Error(notionErrorMessage(error))
    }
  },

  stop(): void {
    controller?.abort()
  },

  /** Throws away what a stopped run read, so the next one starts fresh. */
  async discard(root: string): Promise<void> {
    if (controller) throw new Error('Stop the import first.')
    lastProgress = null
    await fs.rm(stagingDirFor(root), { recursive: true, force: true })
  }
}
