/**
 * How far Indent sections moves each level in, in spaces (Settings →
 * Typography → Headings → Indent width). A space here is the same column the
 * Tab size setting and nested list levels count in (`1ch` of the text font at
 * the text size), so 4 lines a section up with a list nested at Tab size 4.
 * The stylesheet turns the count into a length; every window that renders
 * notes (main, floating, Quick Capture, the PDF export) sets it on `<html>`
 * through `applySectionIndent`.
 */
export const DEFAULT_SECTION_INDENT_WIDTH = 3
export const MIN_SECTION_INDENT_WIDTH = 1
export const MAX_SECTION_INDENT_WIDTH = 8

export function normalizeSectionIndentWidth(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_SECTION_INDENT_WIDTH
  return Math.min(
    MAX_SECTION_INDENT_WIDTH,
    Math.max(MIN_SECTION_INDENT_WIDTH, Math.round(parsed))
  )
}

export function applySectionIndent(root: HTMLElement, on: boolean, width: unknown): void {
  root.toggleAttribute('data-indent-sections', on)
  root.style.setProperty('--z-section-indent-width', String(normalizeSectionIndentWidth(width)))
}
