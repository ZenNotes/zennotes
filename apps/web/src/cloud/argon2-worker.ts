/**
 * Argon2id for the account's passphrase, in a worker of its own: 64 MiB and
 * about 100 ms the page should not spend. The worker runs one derivation and
 * the page ends it at once, which is what gives the memory back
 * (argon2-client.ts).
 */
import { CloudE2eeError, derivePassphraseKey, type CloudE2eeKdfParams } from '@zennotes/shared-domain/cloud-e2ee'

export interface Argon2Request {
  passphrase: string
  kdf: CloudE2eeKdfParams
}

export type Argon2Response =
  | { ok: true; key: Uint8Array }
  | { ok: false; code: string | null; message: string }

// Typed by hand: the webworker lib cannot sit beside the DOM lib this
// project compiles with.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Argon2Request>) => void) | null
  postMessage(message: Argon2Response, transfer?: Transferable[]): void
}

scope.onmessage = (event: MessageEvent<Argon2Request>) => {
  void derivePassphraseKey(event.data.passphrase, event.data.kdf).then(
    (key) => scope.postMessage({ ok: true, key }, [key.buffer]),
    (error: unknown) =>
      scope.postMessage({
        ok: false,
        code: error instanceof CloudE2eeError ? error.code : null,
        message: error instanceof Error ? error.message : String(error)
      })
  )
}
