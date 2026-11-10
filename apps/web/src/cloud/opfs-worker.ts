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
}

const dispatcher = createOpfsDispatcher({
  root: originOpfsRoot,
  currentGeneration: readFenceGeneration,
  randomId: () => crypto.randomUUID()
})

scope.onmessage = (event: MessageEvent<OpfsRequest>) => {
  void dispatcher.handle(event.data).then((response) => {
    if (response.ok && response.value instanceof Uint8Array) {
      const bytes = response.value
      scope.postMessage(response, [bytes.buffer])
      return
    }
    // A fingerprint carries a small file's bytes along.
    const inline = response.ok ? (response.value as { inline?: unknown } | null)?.inline : undefined
    if (inline instanceof Uint8Array) {
      scope.postMessage(response, [inline.buffer])
      return
    }
    scope.postMessage(response)
  })
}
