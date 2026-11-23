/**
 * Asking before a quit or a window close throws away edits that could not be
 * saved (#1108).
 *
 * A remote vault keeps nothing on this machine. While its server is
 * unreachable a save fails, the renderer keeps the edit in its buffer and
 * retries, and the buffer is the only copy. Closing the window destroys it.
 * The renderer reports how many such notes each window holds; main asks here,
 * BEFORE `before-quit` tears anything down, because cancelling a quit any
 * later (from the page's beforeunload) would leave the remote watcher and
 * Cloud sync already stopped in an app that keeps running.
 */

/** Notes with a failed save, per renderer (webContents id). */
export class UnsavedNotesLedger {
  private readonly counts = new Map<number, number>()

  report(webContentsId: number, count: unknown): void {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0
    if (n > 0) this.counts.set(webContentsId, Math.min(n, 100_000))
    else this.counts.delete(webContentsId)
  }

  forget(webContentsId: number): void {
    this.counts.delete(webContentsId)
  }

  countFor(webContentsId: number): number {
    return this.counts.get(webContentsId) ?? 0
  }

  total(): number {
    let sum = 0
    for (const n of this.counts.values()) sum += n
    return sum
  }
}

export interface UnsavedNotesPrompt {
  message: string
  detail: string
  buttons: [string, string]
}

/** The question, for a quit (`quit`) or for closing one window. Button 0
 *  keeps the app open and is the default; button 1 leaves anyway. */
export function unsavedNotesPrompt(count: number, action: 'quit' | 'close'): UnsavedNotesPrompt {
  const notes = count === 1 ? '1 note has' : `${count} notes have`
  const these = count === 1 ? 'Its changes are' : 'Their changes are'
  return {
    message: `${notes} changes that are not saved.`,
    detail:
      `ZenNotes could not save them, most likely because the server is unreachable, ` +
      `and keeps trying while it stays open. ${these} only in this window. ` +
      (action === 'quit' ? 'If you quit now, they are lost.' : 'If you close it now, they are lost.'),
    buttons: ['Keep ZenNotes Open', action === 'quit' ? 'Quit Anyway' : 'Close Anyway']
  }
}
