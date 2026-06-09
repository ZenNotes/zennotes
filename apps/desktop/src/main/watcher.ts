import path from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import type { NoteFolder, VaultChangeEvent, VaultChangeKind } from '@shared/ipc'
import { databaseCsvPathFor } from '@shared/databases'
import { folderForRelativePath } from './vault'

const ATTACHMENTS_DIRS = new Set(['attachements', '_assets'])
const INTERNAL_VAULT_DIR = '.zennotes'
const VAULT_SETTINGS_RELATIVE_PATH = `${INTERNAL_VAULT_DIR}/vault.json`
const NOTE_COMMENTS_PREFIX = `${INTERNAL_VAULT_DIR}/comments/`
const NOTE_COMMENTS_SUFFIX = '.comments.json'

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function folderOf(root: string, abs: string): NoteFolder | null {
  const rel = toPosix(path.relative(root, abs))
  const folder = folderForRelativePath(rel)
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

export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private root: string | null = null

  start(root: string, onEvent: (ev: VaultChangeEvent) => void): void {
    this.stop()
    this.root = root
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => {
        if (this.root && isVaultSettingsPath(this.root, p)) return false
        if (this.root && relativeVaultPath(this.root, p) === INTERNAL_VAULT_DIR) return false
        const base = path.basename(p)
        return base.startsWith('.') || base === 'node_modules'
      },
      awaitWriteFinish: {
        stabilityThreshold: 120,
        pollInterval: 40
      }
    })

    const handler = (kind: VaultChangeKind) => (absPath: string) => {
      const base = path.basename(absPath)
      if (!this.root) return
      if (isVaultSettingsPath(this.root, absPath)) {
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
        onEvent({
          kind,
          path: commentsPath,
          folder: folderForRelativePath(commentsPath) ?? 'inbox',
          scope: 'comments'
        })
        return
      }
      // A `.csv` data file or its `.csv.base.json` sidecar — normalize both to
      // the canonical `.csv` path so the renderer re-hydrates the right database.
      const dbCsvPath = databaseCsvPathFor(toPosix(path.relative(this.root, absPath)))
      if (dbCsvPath) {
        onEvent({
          kind,
          path: dbCsvPath,
          folder: folderForRelativePath(dbCsvPath) ?? 'inbox',
          scope: 'database'
        })
        return
      }
      if (base.startsWith('.')) return
      const folder = folderOf(this.root, absPath)
      if (!folder) return
      onEvent({
        kind,
        path: toPosix(path.relative(this.root, absPath)),
        folder
      })
    }

    this.watcher
      .on('add', handler('add'))
      .on('change', handler('change'))
      .on('unlink', handler('unlink'))
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
      this.root = null
    }
  }
}
