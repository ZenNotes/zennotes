import tls from 'node:tls'

/**
 * Trust the operating system's certificate store in this process, as Chromium
 * already does for the window.
 *
 * Node's TLS, which every request from the main process, the MCP server and
 * the bundled CLI goes through (fetch, the `ws` change feed), trusts only the
 * list bundled into Node. A self-hosted server whose certificate comes from a
 * private CA the system trusts (step-ca, a company root, a proxy that inspects
 * TLS) answered "fetch failed" while a browser on the same Mac opened it fine
 * (#1009). NODE_USE_SYSTEM_CA=1 cured it, but only when set before the process
 * starts, which nobody launching from the Dock can do.
 *
 * Reading the system store costs 20 to 30 ms on macOS, so it is read once and
 * never on the boot path: before the first request to a server, and a moment
 * after the window shows for everything else. Trust is only ever added: a
 * store that cannot be read, or a Node without these calls, keeps Node's list.
 */

export interface CertificateStore {
  getCACertificates(type: 'default' | 'system'): string[]
  setDefaultCACertificates(certificates: string[]): void
}

/** Make the default list Node's own plus the system's. False when nothing changed. */
export function addSystemCertificates(store: CertificateStore): boolean {
  if (
    typeof store.getCACertificates !== 'function' ||
    typeof store.setDefaultCACertificates !== 'function'
  ) {
    return false
  }
  try {
    const system = store.getCACertificates('system')
    if (system.length === 0) return false
    store.setDefaultCACertificates([...new Set([...store.getCACertificates('default'), ...system])])
    return true
  } catch (error) {
    console.warn("[tls] the system certificate store could not be read; keeping Node's list", error)
    return false
  }
}

let systemTrustRead = false

export function trustSystemCertificates(): void {
  if (systemTrustRead) return
  systemTrustRead = true
  addSystemCertificates(tls)
}
