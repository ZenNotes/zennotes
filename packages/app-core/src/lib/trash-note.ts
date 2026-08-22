import type { NoteMeta } from '@shared/ipc'
import { humanIpcError } from './ipc-error'
import { useToastStore } from './toast'

/**
 * Move a note to the Trash and say so when that could not happen. Every
 * surface with a Move to Trash action routes through here: a rejected move
 * used to end in console.error and a note that quietly stayed put (#650).
 * Returns the moved note's meta, or null when the host refused.
 *
 * A temporary folder session (a folder opened with `zn open` or dropped on the
 * app) keeps no trash folder of its own, so the host sends the file to the
 * system Trash instead. That deserves a word, because the app's Trash view
 * will not list it. Callers pass the session kind; this module stays free of
 * the store so the store can import it.
 */
export async function moveNoteToTrash(
  path: string,
  options: { temporarySession?: boolean } = {}
): Promise<NoteMeta | null> {
  try {
    const meta = await window.zen.moveToTrash(path)
    if (options.temporarySession) {
      useToastStore
        .getState()
        .addToast(
          'Moved to the system Trash. A temporary folder session keeps no Trash folder of its own.',
          'info'
        )
    }
    return meta
  } catch (err) {
    useToastStore
      .getState()
      .addToast(
        `Could not move to Trash: ${humanIpcError(err, 'the note could not be moved.')}`,
        'error'
      )
    return null
  }
}
