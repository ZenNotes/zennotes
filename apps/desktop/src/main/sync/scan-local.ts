import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isNeverSync, type FileState } from './reconcile'

/** sha256 content hash matching the server's hashContent(). */
export function hashBytes(body: Buffer): string {
  return 'sha256:' + createHash('sha256').update(body).digest('hex')
}

// Top-level names hidden from the vault-root walk in root mode (mirrors the Go
// shouldHidePrimaryRootName) so they aren't double-listed.
const HIDDEN_PRIMARY_ROOT_NAMES = new Set([
  'quick',
  'archive',
  'trash',
  'assets',
  'attachements',
  '_assets',
  '.zennotes'
])
const TOP_FOLDERS = ['quick', 'archive', 'trash']

function isNoteFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.excalidraw')
}

function isFormDir(name: string): boolean {
  return name.toLowerCase().endsWith('.base')
}

async function walkFolder(
  vaultRoot: string,
  folderRoot: string,
  primaryRoot: boolean,
  out: Map<string, FileState>
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(folderRoot, { withFileTypes: true })
  } catch {
    return // folder may not exist (e.g. no quick/ yet)
  }
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.')) continue // hidden, incl. .zennotes
    if (primaryRoot && HIDDEN_PRIMARY_ROOT_NAMES.has(name.toLowerCase())) continue
    const full = path.join(folderRoot, name)
    if (entry.isDirectory()) {
      if (isFormDir(name)) continue // database folder — synced as a unit later
      await walkFolder(vaultRoot, full, false, out)
      continue
    }
    if (!isNoteFile(name)) continue
    const rel = path.relative(vaultRoot, full).split(path.sep).join('/')
    if (isNeverSync(rel)) continue
    try {
      const body = await fs.readFile(full)
      out.set(rel, { hash: hashBytes(body), size: body.length })
    } catch {
      // skip unreadable file
    }
  }
}

/**
 * Walk every synced note/.excalidraw file in a vault and hash it, mirroring the
 * server's collectNoteFiles: the primary notes area (root in root mode, else
 * `inbox/`) plus `quick`/`archive`/`trash`, excluding databases, hidden files,
 * and `.zennotes/`.
 */
export async function scanLocalVault(
  root: string,
  primaryNotesAtRoot: boolean
): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>()
  const inboxRoot = primaryNotesAtRoot ? root : path.join(root, 'inbox')
  await walkFolder(root, inboxRoot, primaryNotesAtRoot, out)
  for (const folder of TOP_FOLDERS) {
    await walkFolder(root, path.join(root, folder), false, out)
  }
  return out
}

/** Read primaryNotesLocation from the local vault settings; defaults to inbox. */
export async function readPrimaryNotesAtRoot(root: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')
    const parsed = JSON.parse(raw) as { primaryNotesLocation?: string }
    return parsed.primaryNotesLocation === 'root'
  } catch {
    return false
  }
}
