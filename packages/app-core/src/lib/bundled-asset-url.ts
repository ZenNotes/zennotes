/**
 * The URL to `fetch()` for an asset Vite bundled next to the renderer's chunks
 * (a wasm engine, a font). On the packaged desktop app the renderer loads over
 * `file://`, whose opaque origin makes the strict CSP reject a `file://` fetch,
 * so the request is routed through one of the app's privileged schemes, each
 * served by the main process from `out/renderer/assets` and each listed in the
 * renderer's `connect-src`. On web and on the desktop dev server the asset is a
 * same-origin http URL that `connect-src 'self'` already allows, so it is used
 * verbatim.
 */
export type BundledAssetScheme = 'zen-typst' | 'zen-harper'

export function bundledAssetUrl(url: string, scheme: BundledAssetScheme): string {
  if (url.startsWith('file:')) {
    const filename = url.split('/').pop()?.split('?')[0] ?? ''
    return `${scheme}://asset/${filename}`
  }
  return url
}
