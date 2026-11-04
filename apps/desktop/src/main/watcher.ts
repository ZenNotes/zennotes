import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { NoteFolder, VaultChangeEvent, VaultChangeKind, VaultSettings } from '@shared/ipc'
import { databaseCsvPathFor } from '@shared/databases'
import { AGENT_EDITS_DIR, AGENT_EDITS_SUFFIX } from '@shared/agent-edits'
import { folderForRelativePath, getVaultSettings, isAtomicWriteTempPath } from './vault'
import { vaultFingerprint } from './vault-fingerprint'

const ATTACHMENTS_DIRS = new Set(['assets', 'attachements', '_assets'])
const INTERNAL_VAULT_DIR = '.zennotes'
const VAULT_SETTINGS_RELATIVE_PATH = `${INTERNAL_VAULT_DIR}/vault.json`
const NOTE_COMMENTS_PREFIX = `${INTERNAL_VAULT_DIR}/comments/`
const NOTE_COMMENTS_SUFFIX = '.comments.json'
const TEMPLATES_PREFIX = `${INTERNAL_VAULT_DIR}/templates/`
const AGENT_EDITS_PREFIX = `${INTERNAL_VAULT_DIR}/${AGENT_EDITS_DIR}/`

/** The system ran out of watch handles: file descriptors (EMFILE, ENFILE) or,
 *  on Linux, inotify watches (ENOSPC). Every folder after the first failure
 *  fails the same way, so the watcher cannot go on reporting the vault. */
const WATCH_HANDLES_EXHAUSTED = new Set(['EMFILE', 'ENFILE', 'ENOSPC'])

/** What a vault on a Windows network share (a UNC path or a mapped drive) gets
 *  from `fs.watch`: UNKNOWN, at once (#1023). Nothing would ever report a
 *  change, and the vault gave no sign of it. Chokidar's polling is no way out:
 *  on Samba it missed new top-level folders in 6 of 8 runs, and it held 25% of
 *  a core idle at 2,000 notes. So this vault gets re-read instead. */
const WATCH_UNSUPPORTED_HERE = 'UNKNOWN'
/** Each re-read stats every file, over the network here. */
export const NETWORK_RESCAN_INTERVAL_MS = 30_000
/** Focus can arrive in bursts, and a re-read is not free. */
const NETWORK_RESCAN_FOCUS_GAP_MS = 5_000
const RESYNC_EVENT: VaultChangeEvent = { kind: 'change', path: '', folder: 'inbox', scope: 'resync' }

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function folderOf(root: string, abs: string, settings: VaultSettings | null): NoteFolder | null {
  const rel = toPosix(path.relative(root, abs))
  const folder = folderForRelativePath(rel, settings)
  if (folder) return folder
  const top = rel.split('/')[0]
  return ATTACHMENTS_DIRS.has(top) ? 'inbox' : null
}

function relativeVaultPath(root: string, abs: string): string {
  return toPosix(path.relative(root, abs))
}

function isVaultSettingsPath(root: string, abs: string): boolean {
  return relativeVaultPath(root, abs) === VAULT_SETTINGS_RELATIVE_PATH
}

function commentsNotePath(root: string, abs: string): string | null {
  const rel = relativeVaultPath(root, abs)
  if (!rel.startsWith(NOTE_COMMENTS_PREFIX) || !rel.endsWith(NOTE_COMMENTS_SUFFIX)) return null
  return rel.slice(NOTE_COMMENTS_PREFIX.length, -NOTE_COMMENTS_SUFFIX.length)
}

/** The note an agent edit record belongs to. A record being written is a
 *  `.tmp` beside it and stays out until it is renamed into place. */
function agentEditNotePath(root: string, abs: string): string | null {
  const rel = relativeVaultPath(root, abs)
  if (!rel.startsWith(AGENT_EDITS_PREFIX) || !rel.endsWith(AGENT_EDITS_SUFFIX)) return null
  return rel.slice(AGENT_EDITS_PREFIX.length, -AGENT_EDITS_SUFFIX.length) || null
}

/** A custom template: a `.md` file directly inside `.zennotes/templates/`,
 *  the flat directory the template module serves. Dotfiles and nested paths
 *  are not templates there either. Mirrors templatePath in the Go watcher. */
function templatePath(root: string, abs: string): string | null {
  const rel = relativeVaultPath(root, abs)
  if (!rel.startsWith(TEMPLATES_PREFIX)) return null
  const name = rel.slice(TEMPLATES_PREFIX.length)
  if (!name || name.includes('/') || name.startsWith('.') || !name.toLowerCase().endsWith('.md')) {
    return null
  }
  return rel
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private root: string | null = null
  /** Settings snapshot for classification; refreshed when vault.json changes,
   *  mirroring the Go watcher's reload. */
  private settings: VaultSettings | null = null
  /** Events that arrived before the first settings load landed. Classifying
   *  them against the default folder names would file a remapped folder's
   *  notes under the wrong one (or drop them), and the window is wide open:
   *  chokidar starts reporting the moment `start()` returns. Null once the
   *  load has settled, so steady-state events pay nothing. */
  private pending: (() => void)[] | null = null
  /** Set once this vault's folder refused native events: see rescanNow. */
  private rescan: {
    root: string
    onEvent: (ev: VaultChangeEvent) => void
    timer: ReturnType<typeof setInterval>
    fingerprint: string | null
    running: boolean
    lastRanAt: number
  } | null = null

  constructor(
    private readonly loadSettings: (root: string) => Promise<VaultSettings> = getVaultSettings
  ) {}

  private refreshSettings(root: string): void {
    void this.loadSettings(root)
      .then((settings) => {
        if (this.root === root) this.settings = settings
      })
      .catch(() => {})
      .finally(() => {
        // Even a failed load ends the wait: classification falls back to the
        // default names, which beats never reporting a change at all.
        if (this.root === root) this.flushPending()
      })
  }

  private flushPending(): void {
    const queued = this.pending
    this.pending = null
    if (!queued) return
    for (const emit of queued) emit()
  }

  /** Emit now, or once the first settings load has settled. */
  private classified(emit: () => void): void {
    if (this.pending) this.pending.push(emit)
    else emit()
  }

  /** `onExhausted` runs once if the watcher shuts itself down because the
   *  system ran out of watch handles. It is stopped by then; nothing restarts
   *  it on its own. */
  start(
    root: string,
    onEvent: (ev: VaultChangeEvent) => void,
    onExhausted: () => void = () => {}
  ): void {
    void this.stop()
    this.root = root
    this.settings = null
    this.pending = []
    this.refreshSettings(root)
    // Chokidar 6 uses native recursive watching on macOS and Windows, avoiding
    // a file handle for every note and asset in a large vault.
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      // A folder the app cannot read (`lost+found` at the top of a mounted
      // drive, a folder another user owns) is one the vault listing skips as
      // well. Linux watches folder by folder, and without this its EACCES
      // reached the error handler below as a failure of the whole watcher.
      ignorePermissionErrors: true,
      ignored: (p: string) => {
        if (this.root && isVaultSettingsPath(this.root, p)) return false
        if (this.root && relativeVaultPath(this.root, p) === INTERNAL_VAULT_DIR) return false
        const base = path.basename(p)
        // writeFileAtomic's scratch file (note saves, database saves). Its
        // add/unlink pair is not a vault change; without this filter every save
        // also fired an asset refresh.
        if (isAtomicWriteTempPath(p)) return true
        return base.startsWith('.') || base === 'node_modules'
      },
      awaitWriteFinish: {
        stabilityThreshold: 120,
        pollInterval: 40
      }
    })
    this.watcher = watcher

    const handler = (kind: VaultChangeKind) => (absPath: string) => {
      const base = path.basename(absPath)
      if (!this.root) return
      if (isVaultSettingsPath(this.root, absPath)) {
        this.refreshSettings(this.root)
        onEvent({
          kind,
          path: VAULT_SETTINGS_RELATIVE_PATH,
          folder: 'inbox',
          scope: 'vault-settings'
        })
        return
      }
      const commentsPath = commentsNotePath(this.root, absPath)
      if (commentsPath) {
        this.classified(() =>
          onEvent({
            kind,
            path: commentsPath,
            folder: folderForRelativePath(commentsPath, this.settings) ?? 'inbox',
            scope: 'comments'
          })
        )
        return
      }
      // An assistant edited a note through MCP, or a review moved on: the
      // note's banner and the review list follow the record.
      const agentEditPath = agentEditNotePath(this.root, absPath)
      if (agentEditPath) {
        this.classified(() =>
          onEvent({
            kind,
            path: agentEditPath,
            folder: folderForRelativePath(agentEditPath, this.settings) ?? 'inbox',
            scope: 'agent-edits'
          })
        )
        return
      }
      // A template is not a note: its own scope has the renderer re-list
      // templates instead of the note tree (#723). Another window on this
      // vault, or a synced dotfile, is how one changes behind the app's back.
      const templateSourcePath = templatePath(this.root, absPath)
      if (templateSourcePath) {
        onEvent({ kind, path: templateSourcePath, folder: 'inbox', scope: 'templates' })
        return
      }
      // Any database file — `<Name>.base/data.csv` or `schema.json` (or a legacy
      // loose `.csv`/sidecar) — normalizes to the canonical `data.csv` path so
      // the renderer re-hydrates the right database. (Record-page `.md` notes in
      // a `.base` folder return null here and ride the normal note path below.)
      const dbCsvPath = databaseCsvPathFor(toPosix(path.relative(this.root, absPath)))
      if (dbCsvPath) {
        this.classified(() =>
          onEvent({
            kind,
            path: dbCsvPath,
            folder: folderForRelativePath(dbCsvPath, this.settings) ?? 'inbox',
            scope: 'database'
          })
        )
        return
      }
      if (base.startsWith('.')) return
      const root = this.root
      this.classified(() => {
        const folder = folderOf(root, absPath, this.settings)
        if (!folder) return
        onEvent({
          kind,
          path: toPosix(path.relative(root, absPath)),
          folder
        })
      })
    }

    // Directory create/remove. An empty folder produces no file event, so
    // surface it explicitly — otherwise another client sharing this vault
    // (e.g. the web app) wouldn't see the folder until a manual refresh.
    const dirHandler = (kind: VaultChangeKind) => (absPath: string) => {
      if (!this.root) return
      if (path.basename(absPath).startsWith('.')) return
      const rel = toPosix(path.relative(this.root, absPath))
      this.classified(() => {
        const folder = folderForRelativePath(rel, this.settings)
        if (!folder) return
        onEvent({ kind, path: rel, folder, scope: 'folder' })
      })
    }

    watcher
      .on('error', (error) => {
        if (this.watcher !== watcher) return
        // Chokidar reports a path it could not watch and goes on watching the
        // rest, so most errors cost that one path. Running out of handles is
        // the exception: the flood of failures that follows is what froze the
        // app on a large vault, so that one closes the watcher and tells the
        // owner, which decides when to try again.
        const code = (error as NodeJS.ErrnoException).code
        if (code && WATCH_HANDLES_EXHAUSTED.has(code)) {
          console.error('Vault watcher ran out of watch handles; live updates have stopped', error)
          void this.stop()
          onExhausted()
          return
        }
        if (code === WATCH_UNSUPPORTED_HERE) {
          console.warn('Vault folder cannot report changes; re-reading it instead', error)
          this.watcher = null
          void watcher.close().catch(() => {})
          this.startRescanning(root, onEvent)
          return
        }
        console.error('Vault watcher could not watch a path', error)
      })
      .on('add', handler('add'))
      .on('change', handler('change'))
      .on('unlink', handler('unlink'))
      .on('addDir', dirHandler('add'))
      .on('unlinkDir', dirHandler('unlink'))
  }

  private startRescanning(root: string, onEvent: (ev: VaultChangeEvent) => void): void {
    const timer = setInterval(() => void this.rescanNow(true), NETWORK_RESCAN_INTERVAL_MS)
    timer.unref?.()
    this.rescan = { root, onEvent, timer, fingerprint: null, running: false, lastRanAt: 0 }
    // Nothing reported what changed between opening the vault and now.
    onEvent(RESYNC_EVENT)
    void this.rescanNow(true)
  }

  /** Re-read a vault whose folder cannot report changes, and have its windows
   *  refresh only if something moved. The window gaining focus asks too, which
   *  is when a person expects to see what arrived. Does nothing for a vault
   *  that native events cover. */
  async rescanNow(force = false): Promise<void> {
    const rescan = this.rescan
    if (!rescan || rescan.running) return
    const now = Date.now()
    if (!force && now - rescan.lastRanAt < NETWORK_RESCAN_FOCUS_GAP_MS) return
    rescan.running = true
    rescan.lastRanAt = now
    try {
      const next = await vaultFingerprint(
        rescan.root,
        (name) => name === 'node_modules' || isAtomicWriteTempPath(name)
      )
      if (this.rescan !== rescan || next === null) return
      const before = rescan.fingerprint
      rescan.fingerprint = next
      if (before !== null && before !== next) rescan.onEvent(RESYNC_EVENT)
    } finally {
      rescan.running = false
    }
  }

  async stop(): Promise<void> {
    if (this.rescan) clearInterval(this.rescan.timer)
    this.rescan = null
    const watcher = this.watcher
    this.watcher = null
    this.root = null
    // Anything still waiting on the first load belongs to the vault we just
    // stopped watching; nobody wants it now.
    this.pending = null
    this.settings = null
    try {
      await watcher?.close()
    } catch (error) {
      console.error('Failed to close vault watcher', error)
    }
  }
}
