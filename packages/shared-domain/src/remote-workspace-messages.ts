/**
 * Wording shared by the desktop and web remote clients for the one failure
 * a self-hosted vault produces on its own: the server answers 404 for a
 * note the app still lists. That is not a broken server; it is a list that
 * fell behind because another device moved, renamed, or trashed the note
 * and the change feed did not reach this app (a reverse proxy without
 * WebSocket support does exactly that, #734). Both clients refresh the list
 * when they raise this, so the sentence can promise it.
 */
export function stalePathMessage(path: string): string {
  return `The server has nothing at ${path} any more: it was moved, renamed, or deleted from another device. The list has been refreshed.`
}

/** How often a remote client re-pulls the vault while its change feed is down. */
export const REMOTE_CHANGE_POLL_MS = 30_000
