const ASSET_TAB_PREFIX = 'zen://asset/'

export function assetTabPath(assetPath: string): string {
  const normalized = assetPath.replace(/^\/+/, '')
  return `${ASSET_TAB_PREFIX}${encodeURIComponent(normalized)}`
}

export function isAssetTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(ASSET_TAB_PREFIX)
}

export function assetPathFromTab(path: string | null | undefined): string | null {
  if (!path || !isAssetTabPath(path)) return null
  const encoded = path.slice(ASSET_TAB_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

export function assetTitleFromPath(path: string | null | undefined): string {
  if (!path) return 'Asset'
  const clean = path.split('#')[0]?.split('?')[0] ?? path
  const last = clean.split('/').filter(Boolean).pop() ?? clean
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}
