/**
 * Settle every image in a rendered note before a PDF export prints.
 *
 * The reading preview marks local images `loading="lazy"`: on screen a long
 * note only fetches what scrolls into view. The export window is hidden and
 * never scrolls, so an image below its viewport never starts loading, and the
 * print captures an empty frame with the caption underneath (#769). The
 * export therefore flips every deferred image to eager (which starts its load
 * at once) and waits for the loads to finish, success or failure alike, so the
 * page prints whatever the images turn out to be.
 *
 * Capped, so one dead remote URL can never hang the export. The desktop main
 * process gives the export window 15 s in total; this stays well inside it.
 */
export const EXPORT_IMAGE_SETTLE_TIMEOUT_MS = 8000

/**
 * Collapse the unused space around an object-fit: contain image before printing.
 * A |WxH hint sets both dimensions inline. When max-width constrains a wide
 * screenshot to the page, its fixed height survives: Chromium paginates that
 * oversized box even though the picture inside it is much shorter.
 * Keep the visible picture's size and let its height follow its aspect ratio,
 * including if printing narrows the column further. When given the printable
 * page height, leave room for the figure's caption and any preceding headings.
 * Call after images and fonts settle, at the printable column width.
 */
export function fitExportImageBoxes(root: ParentNode, pageHeight = Infinity): void {
  const margins = (element: Element): number => {
    const style = getComputedStyle(element)
    return (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
  }
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    if (!img.naturalWidth || !img.naturalHeight) continue
    const { width, height } = img.getBoundingClientRect()
    if (width <= 0 || height <= 0) continue
    let availableHeight = pageHeight
    const figure = img.closest('figure')
    if (figure) {
      availableHeight -=
        Math.max(0, figure.getBoundingClientRect().height - height) + margins(figure)
      let previous = figure.previousElementSibling
      while (previous?.matches('h1, h2, h3, h4, h5, h6')) {
        availableHeight -= previous.getBoundingClientRect().height + margins(previous)
        previous = previous.previousElementSibling
      }
    }
    // An exceptionally long caption/heading cannot fit even without the image;
    // leave that case to Chromium's fragmentation fallback instead of hiding it.
    const fittedHeight = availableHeight > 0 ? Math.min(height, availableHeight) : height
    const fittedWidth = Math.min(width, (fittedHeight * img.naturalWidth) / img.naturalHeight)
    img.style.width = `${fittedWidth}px`
    img.style.height = 'auto'
  }
}

export function settleExportImages(
  root: ParentNode,
  timeoutMs = EXPORT_IMAGE_SETTLE_TIMEOUT_MS
): Promise<void> {
  const pending: Promise<void>[] = []
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    if (img.getAttribute('loading') === 'lazy') img.setAttribute('loading', 'eager')
    // `complete` is true once the load ended either way, and for an image with
    // no source, which has nothing to wait for.
    if (img.complete) continue
    pending.push(
      new Promise<void>((resolve) => {
        const done = (): void => {
          img.removeEventListener('load', done)
          img.removeEventListener('error', done)
          resolve()
        }
        img.addEventListener('load', done)
        img.addEventListener('error', done)
      })
    )
  }
  if (pending.length === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void Promise.all(pending).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
