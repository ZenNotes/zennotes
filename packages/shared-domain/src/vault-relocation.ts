/** Host-owned filesystem operations. All paths remain vault-relative. */
export interface VaultRelocationIO {
  stat(path: string): Promise<'file' | 'directory' | null>
  mkdir(path: string): Promise<void>
  /** Must either complete or leave the source in place; uncertain failures must say so. */
  rename(from: string, to: string): Promise<void>
}

export interface VaultRelocation {
  from: string
  to: string
  required?: boolean
}

function validatePath(path: string): void {
  if (!path || path.startsWith('/') || /[\\\u0000]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Expected a vault-relative path')
}

/**
 * Relocate content and its parallel comments together. Preflight every target,
 * including orphan comments, before changing anything. Restore earlier moves
 * in reverse order if a later move or the metadata commit fails.
 */
export async function relocateVaultEntries(
  io: VaultRelocationIO,
  entries: readonly VaultRelocation[],
  commit: () => Promise<unknown> = async () => {}
): Promise<void> {
  const present: VaultRelocation[] = []
  for (const entry of entries) {
    validatePath(entry.from); validatePath(entry.to)
    if (entry.from === entry.to) continue
    if (entry.to.startsWith(`${entry.from}/`)) throw new Error('Cannot move a folder into itself')
    const source = await io.stat(entry.from)
    if (entry.required && source === null) throw new Error(`Missing source: ${entry.from}`)
    if (await io.stat(entry.to) !== null) throw new Error(`Destination already exists: ${entry.to}`)
    if (source !== null) present.push(entry)
  }
  const moved: VaultRelocation[] = []
  try {
    for (const entry of present) {
      const parent = entry.to.slice(0, entry.to.lastIndexOf('/'))
      if (entry.to.includes('/')) await io.mkdir(parent)
      await io.rename(entry.from, entry.to)
      moved.push(entry)
    }
    await commit()
  } catch (error) {
    const failures: unknown[] = [error]
    for (const entry of moved.reverse()) {
      try {
        if (await io.stat(entry.from) !== null) throw new Error(`Rollback path is occupied: ${entry.from}`)
        await io.rename(entry.to, entry.from)
      } catch (rollbackError) { failures.push(rollbackError) }
    }
    if (failures.length > 1) throw new AggregateError(failures,
      'FOLDER_STATE_UNCERTAIN: Could not restore a failed file operation; reload the vault before editing')
    throw error
  }
}
