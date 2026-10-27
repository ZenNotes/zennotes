/**
 * The reference the pane shows beside the open note: that note's own pin,
 * else the global one. The app shell and the Reference commands read it the
 * same way, so Hide Reference Pane is offered whenever a pane is showing,
 * including the per-note pin a PDF card makes (the phones close their
 * reference sheet through that command).
 */
export function activeReferencePath(state: {
  selectedPath: string | null
  noteRefs: Record<string, { path: string }>
  pinnedRefPath: string | null
}): string | null {
  return (state.selectedPath ? state.noteRefs[state.selectedPath]?.path : null) ?? state.pinnedRefPath
}
