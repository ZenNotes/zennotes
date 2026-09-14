const HEADINGS = 'h1, h2, h3, h4, h5, h6'
const FORCED_BREAKS = new Set(['page', 'left', 'right', 'recto', 'verso', 'column', 'all'])
const MIN_IMAGE_SCALE = 0.5

/**
 * Fit standalone images into otherwise wasted space at the end of a page.
 *
 * A continuous DOM's y % pageHeight ignores earlier page breaks. Instead, let
 * Chromium fragment the export into page-sized columns, then measure the last
 * fragment of the preceding block. Columns use the same break/keep rules as
 * pages. Reflow after each image so subsequent images see the updated pages.
 * Only image widths survive this pass; the measurement layout is always removed.
 */
export function fitExportImagesToPages(
  article: HTMLElement,
  page: { width: number; height: number }
): void {
  const images = Array.from(article.querySelectorAll<HTMLImageElement>('img'))
  if (!images.length) return

  const originalStyle = article.getAttribute('style')
  const restoreBreaks: (() => void)[] = []
  try {
    // Keep the measuring column identical to the final printable column. The
    // export stylesheet supplies the same typography and break rules in both.
    Object.assign(article.style, {
      display: 'block',
      width: `${page.width}px`,
      minWidth: '0',
      maxWidth: 'none',
      height: `${page.height}px`,
      minHeight: '0',
      maxHeight: 'none',
      columnWidth: `${page.width}px`,
      columnCount: '1',
      columnGap: '0',
      columnFill: 'auto',
      margin: '0',
      padding: '0',
      overflow: 'visible'
    })

    // Explicit page breaks and page-only keep rules must also participate in
    // this measurement. Restore each property separately so fitted image widths
    // aren't rolled back along with these temporary changes.
    for (const element of Array.from(article.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(element)
      for (const property of ['break-before', 'break-after', 'break-inside']) {
        const value = style.getPropertyValue(property)
        const replacement =
          value === 'avoid-page'
            ? 'avoid'
            : FORCED_BREAKS.has(value) && value !== 'column' && value !== 'all'
              ? 'column'
              : null
        if (!replacement) continue
        const original = element.style.getPropertyValue(property)
        const priority = element.style.getPropertyPriority(property)
        element.style.setProperty(property, replacement, 'important')
        restoreBreaks.push(() => {
          if (original) element.style.setProperty(property, original, priority)
          else element.style.removeProperty(property)
        })
      }
    }

    const origin = article.getBoundingClientRect()
    const rtl = getComputedStyle(article).direction === 'rtl'
    const pageOf = (rect: DOMRect): number =>
      Math.floor(((rtl ? origin.right - rect.right : rect.left - origin.left) + 0.5) / page.width)

    for (const image of images) {
      if (!image.naturalWidth || !image.naturalHeight) continue
      const figure = image.closest('figure')
      const parent = image.parentElement
      const block =
        figure ??
        (parent?.tagName === 'P' && parent.childElementCount === 1 && !parent.textContent?.trim()
          ? parent
          : null)
      // Inline icons and figures containing multiple pictures aren't one image
      // block; changing their dimensions could rearrange unrelated content.
      if (!block || block.querySelectorAll('img').length !== 1) continue
      let first: Element = block
      while (first.previousElementSibling?.matches(HEADINGS)) {
        if (!getComputedStyle(first.previousElementSibling).breakAfter.startsWith('avoid')) break
        first = first.previousElementSibling
      }
      const previous = first.previousElementSibling
      if (!previous) continue
      if (
        FORCED_BREAKS.has(getComputedStyle(first).breakBefore) ||
        FORCED_BREAKS.has(getComputedStyle(previous).breakAfter)
      )
        continue

      const precedingRects = previous.getClientRects()
      const firstRects = first.getClientRects()
      if (!precedingRects.length || !firstRects.length) continue
      const targetPage = pageOf(precedingRects[precedingRects.length - 1])
      if (pageOf(firstRects[0]) !== targetPage + 1) continue

      const originalWidth = image.getBoundingClientRect().width
      // Preserve small graphics at their chosen size. Large pictures can shrink
      // at most by half, avoiding excessive reduction to fill a tiny remainder.
      if (originalWidth < 160) continue
      const savedWidth = image.style.getPropertyValue('width')
      const savedPriority = image.style.getPropertyPriority('width')
      const restoreWidth = (): void => {
        if (savedWidth) image.style.setProperty('width', savedWidth, savedPriority)
        else image.style.removeProperty('width')
      }
      const fits = (): boolean => {
        const start = first.getClientRects()
        const end = block.getClientRects()
        return (
          start.length > 0 &&
          end.length > 0 &&
          pageOf(start[0]) === targetPage &&
          pageOf(end[end.length - 1]) === targetPage &&
          end[end.length - 1].bottom <= origin.top + page.height
        )
      }

      let fitted = false
      try {
        let low = originalWidth * MIN_IMAGE_SCALE
        let high = originalWidth
        image.style.width = `${low}px`
        if (!fits()) continue
        // Find the largest readable size that fits, including caption wrapping,
        // heading spacing, borders, and collapsed margins measured by Chromium.
        for (let attempt = 0; attempt < 10 && high - low > 0.5; attempt++) {
          const width = (low + high) / 2
          image.style.width = `${width}px`
          if (fits()) low = width
          else high = width
        }
        image.style.width = `${Math.max(originalWidth * MIN_IMAGE_SCALE, Math.floor(low) - 1)}px`
        fitted = fits()
      } finally {
        if (!fitted) restoreWidth()
      }
    }
  } finally {
    for (const restore of restoreBreaks) restore()
    if (originalStyle === null) article.removeAttribute('style')
    else article.setAttribute('style', originalStyle)
  }
}
