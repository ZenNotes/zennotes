import path from 'node:path'

/**
 * The vault root a renderer asked for, if the main process already knows it.
 *
 * The renderer is untrusted, and `shell.openPath` launches whatever it is
 * given: a free-form path would let a compromised page run any file on disk.
 * So the argument only ever picks from the list main keeps, and what comes
 * back is main's own copy of the path, not the renderer's.
 */
export function resolveKnownVaultRoot(
  requested: unknown,
  knownRoots: readonly string[],
): string | null {
  if (typeof requested !== 'string' || requested.trim() === '') return null
  const wanted = path.resolve(requested)
  for (const root of knownRoots) {
    const known = path.resolve(root)
    if (known === wanted) return known
  }
  return null
}
