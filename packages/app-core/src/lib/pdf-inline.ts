/**
 * Whether this engine can draw a PDF inside the page, in an iframe.
 *
 * Desktop Chromium, desktop browsers and Safari can. Android's WebView cannot:
 * it has no PDF viewer, so an iframe pointed at a PDF stays an empty
 * `about:blank` page however right the file's URL is (Dave, Discord,
 * 2026-10-27: the embed, the reference pane and the asset tab all opened
 * blank on his phone). `navigator.pdfViewerEnabled` is the standard answer;
 * an engine too old to give one keeps the iframe it always had.
 */
export function canShowPdfInline(nav: Pick<Navigator, 'pdfViewerEnabled'> | undefined = globalThis.navigator): boolean {
  return nav?.pdfViewerEnabled !== false
}
