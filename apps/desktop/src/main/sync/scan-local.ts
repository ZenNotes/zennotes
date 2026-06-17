import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isNeverSync, type FileState } from './reconcile'

/** sha256 content hash matching the server's hashContent(). */
export function hashBytes(body: Buffer): string {
  return 'sha256:' + createHash('sha256').update(body).digest('hex')
}

const INTERNAL_DIR = '.zennotes'

async function walkAll(
  vaultRoot: string,
  dir: string,
  out: Map<string, FileState>
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry.name
    const full = path.join(dir, name)
    if (entry.isDirectory()) {
      // Walk into `.zennotes` (for vault.json + comments); skip other dot-dirs.
      if (name !== INTERNAL_DIR && name.startsWith('.')) continue
      await walkAll(vaultRoot, full, out)
      continue
    }
    if (name.startsWith('.')) continue // dotfiles (.DS_Store, etc.)
    if (name.endsWith('.tmp') || name.endsWith('.synctmp')) continue
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
 * Walk and hash every syncable file in a vault — notes, drawings, databases,
 * assets, comments, and vault settings — mirroring the server's collectSyncFiles
 * (the whole tree, excluding the per-device sync-state, the meta cache, dotfiles,
 * unrelated dot-dirs, and temp files).
 */
export async function scanLocalVault(root: string): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>()
  await walkAll(root, root, out)
  return out
}
