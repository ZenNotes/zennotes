/**
 * Trigger a download of a vault asset (#716).
 *
 * Desktop: `window.zen.downloadAsset` opens the native save dialog and the
 * main process copies the file (local vault) or streams the server's
 * raw-asset response (remote/self-hosted vault).
 *
 * Web: resolves the asset's URL exactly the way embedded images do —
 * same-origin HTTP, cookie-authenticated — fetches it as a blob, and clicks
 * a hidden `<a download>` anchor so the browser saves it under the asset's
 * own name.
 */
export async function downloadAsset(
  vaultRoot: string | null,
  assetPath: string
): Promise<void> {
  const name = assetPath.split('/').pop() ?? assetPath
  if (typeof window.zen.downloadAsset === 'function') {
    await window.zen.downloadAsset(assetPath)
    return
  }
  const url = window.zen.resolveVaultAssetUrl(vaultRoot ?? '', assetPath)
  if (!url) throw new Error('Asset path is invalid.')
  const response = await fetch(url)
  if (!response.ok) throw new Error('Asset could not be read.')
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}
