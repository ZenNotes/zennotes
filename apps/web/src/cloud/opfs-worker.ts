/**
 * The one dedicated worker that owns the open vault's files. Writes use
 * `createSyncAccessHandle()`, which every engine offers only in a dedicated
 * worker; other tabs and the service worker read with `getFile()`, which
 * works while this worker holds handles (spike F1a).
 */
import { readFenceGeneration } from './idb'
import { createOpfsDispatcher, type OpfsRequest } from './opfs-dispatch'
import { originOpfsRoot } from './opfs-handles'

// Typed by hand: the webworker lib cannot sit beside the DOM lib this
// project compiles with.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<OpfsRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  location: { readonly origin: string }
}

const dispatcher = createOpfsDispatcher({
  root: originOpfsRoot,
  currentGeneration: readFenceGeneration,
  randomId: () => crypto.randomUUID()
})

scope.onmessage = (event: MessageEvent<OpfsRequest>) => {
  // Only the page that created a dedicated worker can post to it, and that
  // message carries an empty origin. Anything naming another origin is
  // refused, so a future message path cannot widen who drives the vault.
  if (event.origin !== '' && event.origin !== scope.location.origin) return
  void dispatcher.handle(event.data).then((response) => {
    if (response.ok && response.value instanceof Uint8Array) {
      const bytes = response.value
      scope.postMessage(response, [bytes.buffer])
      return
    }
    scope.postMessage(response)
  })
}
