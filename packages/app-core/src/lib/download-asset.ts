/**
 * Trigger a browser download of a vault asset (#716).
 *
 * Resolves the asset's URL exactly the way embedded images do —
 * same-origin HTTP on web, the `zen-asset://` privileged scheme in the
 * desktop app (local or remote vault) — fetches it as a blob, and clicks a
 * hidden `<a download>` anchor so the browser saves it under the asset's
 * own name. Works in the renderer without any bridge-contract change.
 */
export async function downloadAsset(
  vaultRoot: string | null,
  assetPath: string
): Promise<void> {
  const url = window.zen.resolveVaultAssetUrl(vaultRoot ?? '', assetPath)
  if (!url) throw new Error('Asset path is invalid.')
  const response = await fetch(url)
  if (!response.ok) throw new Error('Asset could not be read.')
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = assetPath.split('/').pop() ?? assetPath
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}
