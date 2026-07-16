import path from 'node:path'

// Roots opened as a *temporary folder session* (drag a folder onto the app to
// read it, without turning it into a vault). We must never write ZenNotes state
// into these folders: no vault layout (inbox/quick/archive/trash/Welcome), no
// `.zennotes/` settings, tab state, or note-meta cache. The user's own note
// edits still save to the real files; everything else is skipped while the
// root is registered here. The registry is in-memory only, so it clears when
// the app quits and the next launch opens the saved vault normally.
const ephemeralRoots = new Set<string>()

function key(root: string): string {
  return path.resolve(root)
}

export function registerEphemeralRoot(root: string): void {
  ephemeralRoots.add(key(root))
}

export function unregisterEphemeralRoot(root: string): void {
  ephemeralRoots.delete(key(root))
}

export function isEphemeralRoot(root: string): boolean {
  return ephemeralRoots.has(key(root))
}
