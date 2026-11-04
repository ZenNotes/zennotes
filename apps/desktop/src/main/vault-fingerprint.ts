import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const VAULT_SETTINGS = path.join('.zennotes', 'vault.json')

/** Folders a person cannot read are ones the vault listing skips as well. */
const SKIPPED_READ_ERRORS = new Set(['EACCES', 'EPERM', 'ENOENT'])

/**
 * What the vault looks like, for a folder that cannot report its own changes:
 * every visible file's path, size and modified time, reduced to one hash. Null
 * when it could not read the vault, because a share that dropped mid-walk looks
 * like a vault that lost its notes, and nobody should act on that.
 *
 * It walks the files rather than trusting a folder's modified time: on a Samba
 * share that stayed frozen while new folders arrived.
 */
export async function vaultFingerprint(
  root: string,
  ignored: (name: string) => boolean
): Promise<string | null> {
  const lines: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignored(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      try {
        if (entry.isDirectory()) {
          lines.push(`${rel}/`)
          await walk(full)
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const stat = await fs.stat(full)
          lines.push(`${rel}\0${stat.size}\0${stat.mtimeMs}`)
        }
      } catch (error) {
        if (!SKIPPED_READ_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
  try {
    await walk(root)
    const settings = await fs.stat(path.join(root, VAULT_SETTINGS)).catch(() => null)
    if (settings) lines.push(`${VAULT_SETTINGS}\0${settings.size}\0${settings.mtimeMs}`)
  } catch {
    return null
  }
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
