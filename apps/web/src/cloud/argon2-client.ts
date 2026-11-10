/**
 * Runs Argon2id off the page (docs/ideas/cloud-in-browser.md, "End-to-end
 * encryption in the tab"): one worker per derivation, ended as soon as it
 * answers so its 64 MiB is freed at once. The worker runs shared-domain's
 * derivePassphraseKey, so its bytes are the apps'.
 */
import { CloudE2eeError, type CloudE2eeErrorCode, type CloudE2eeKdfParams } from '@zennotes/shared-domain/cloud-e2ee'
import type { Argon2Request, Argon2Response } from './argon2-worker'

type KdfWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>

function argon2Worker(): KdfWorker {
  return new Worker(new URL('./argon2-worker.ts', import.meta.url), { type: 'module', name: 'zennotes-unlock' })
}

export function deriveInWorker(
  passphrase: string,
  kdf: CloudE2eeKdfParams,
  makeWorker: () => KdfWorker = argon2Worker
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = makeWorker()
    worker.onmessage = (event: MessageEvent<Argon2Response>) => {
      worker.terminate()
      if (event.data.ok) resolve(event.data.key)
      else if (event.data.code) reject(new CloudE2eeError(event.data.code as CloudE2eeErrorCode, event.data.message))
      else reject(new Error(event.data.message))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(`The unlock worker stopped: ${event.message || 'unknown error'}`))
    }
    worker.postMessage({ passphrase, kdf } satisfies Argon2Request)
  })
}
