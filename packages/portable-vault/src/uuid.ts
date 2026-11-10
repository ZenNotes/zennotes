/** crypto.randomUUID needs WebKit 15.4; the deployment floor is iOS 15.0,
 *  so 15.0 to 15.3 devices take the getRandomValues path. */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return uuidFromRandomBytes(crypto)
}

/**
 * Gives a WebView without crypto.randomUUID one built from getRandomValues,
 * for code outside this app that calls it directly. A WebView that has its
 * own keeps it.
 */
export function installRandomUUIDPolyfill(target: Crypto = globalThis.crypto): void {
  if (typeof target.randomUUID === 'function') return
  Object.defineProperty(target, 'randomUUID', {
    value: () => uuidFromRandomBytes(target),
    configurable: true,
    writable: true
  })
}

function uuidFromRandomBytes(source: Crypto): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
