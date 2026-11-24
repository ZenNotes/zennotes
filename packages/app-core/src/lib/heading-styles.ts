/**
 * The app side of per-level heading styles: the data rules live in
 * shared-domain (`@shared/heading-styles`), this turns them into CSS on the
 * document root for the editor, Preview, the floating windows and the PDF
 * export window.
 */
import { HEADING_LEVELS, headingStyleKey, headingSwatch, normalizeHeadingStyles } from '@shared/heading-styles'
import type { HeadingStyles } from '@shared/heading-styles'

export {
  HEADING_LEVELS,
  HEADING_COLOR_SWATCHES,
  LEVEL_PRESET_SWATCH,
  headingStyleKey,
  parseHeadingColor,
  parseHeadingFont,
  normalizeHeadingStyles,
  withHeadingStyle,
  headingSwatch,
  HEADING_PRINT_HEX,
  printHeadingLook,
} from '@shared/heading-styles'
export type {
  HeadingLevel,
  HeadingStyleProp,
  HeadingStyles,
  HeadingSwatch,
  PrintHeadingLook,
} from '@shared/heading-styles'

/** The CSS color for a stored value: a swatch reads the active theme's token
 *  (falling back to the text color in a custom theme that leaves it out), a
 *  hex color is used as is. */
export function headingColorCss(value: string): string {
  const swatch = headingSwatch(value)
  return swatch ? `rgb(var(${swatch.token}, var(--z-fg)))` : value
}

/** A label for a stored color: the swatch's name, or the hex itself. */
export function headingColorLabel(value: string | null | undefined): string {
  if (!value) return 'Default'
  return headingSwatch(value)?.label ?? value
}

export function headingFontCss(name: string): string {
  return `"${name}", ui-sans-serif, system-ui, sans-serif`
}

/** Puts the styles on the document root: a variable per level and property,
 *  plus an attribute the stylesheet keys on, so a level with nothing set keeps
 *  the theme's look untouched. */
export function applyHeadingStyles(root: HTMLElement, styles: HeadingStyles | undefined): void {
  const normalized = normalizeHeadingStyles(styles)
  for (const level of HEADING_LEVELS) {
    const color = normalized[headingStyleKey(level, 'color')]
    const font = normalized[headingStyleKey(level, 'font')]
    if (color) {
      root.style.setProperty(`--z-heading-${level}-color`, headingColorCss(color))
      root.setAttribute(`data-heading-${level}-color`, '')
    } else {
      root.style.removeProperty(`--z-heading-${level}-color`)
      root.removeAttribute(`data-heading-${level}-color`)
    }
    if (font) {
      root.style.setProperty(`--z-heading-${level}-font`, headingFontCss(font))
      root.setAttribute(`data-heading-${level}-font`, '')
    } else {
      root.style.removeProperty(`--z-heading-${level}-font`)
      root.removeAttribute(`data-heading-${level}-font`)
    }
  }
}
