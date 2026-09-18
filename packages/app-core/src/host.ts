import type { ZenCapabilities, ZenAppInfo } from '@bridge-contract/bridge'

export type HostKind = NonNullable<ZenAppInfo['hostKind']>
export interface HostInfo {
  readonly kind: HostKind
  readonly name: string
  readonly version: string
  readonly capabilities: Readonly<ZenCapabilities>
}
/** Capabilities are authoritative; OS names and renderer families are not feature flags. */
export function getHostInfo(): HostInfo {
  const info = window.zen.getAppInfo()
  return Object.freeze({ kind: info.hostKind ?? (info.runtime === 'desktop' ? 'desktop' : 'browser'),
    name: info.productName, version: info.version,
    capabilities: Object.freeze({ ...window.zen.getCapabilities() }) })
}
