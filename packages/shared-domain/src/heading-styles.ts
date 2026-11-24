/**
 * A color and a font per heading level, picked in Settings → Typography →
 * Headings instead of written as an override. Pure data, shared by the app
 * (which turns it into CSS in app-core's lib/heading-styles.ts) and the
 * desktop main process (which writes it into a Word export's heading styles). Stored as one flat map so it
 * travels in config.toml as a `[heading_styles]` table a person can read and
 * edit: `"h1.color" = "red"`, `"h2.color" = "#e06c75"`, `"h1.font" = "Georgia"`.
 *
 * A color is either one of the theme's own hues, stored by name so it follows
 * the theme and light or dark, or a fixed `#rrggbb`. A level with nothing set
 * keeps what the theme (or Color headings by level) gives it.
 */

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const
export type HeadingLevel = (typeof HEADING_LEVELS)[number]
export type HeadingStyleProp = 'color' | 'font'
export type HeadingStyles = Record<string, string>

export const HEADING_COLOR_SWATCHES = [
  { id: 'red', label: 'Red', token: '--z-red' },
  { id: 'yellow', label: 'Yellow', token: '--z-yellow' },
  { id: 'green', label: 'Green', token: '--z-green' },
  { id: 'teal', label: 'Teal', token: '--z-aqua' },
  { id: 'blue', label: 'Blue', token: '--z-blue' },
  { id: 'purple', label: 'Purple', token: '--z-purple' },
  { id: 'accent', label: 'Accent', token: '--z-accent' },
  { id: 'gray', label: 'Gray', token: '--z-grey-1' }
] as const

export type HeadingSwatch = (typeof HEADING_COLOR_SWATCHES)[number]['id']

/** The swatch each level takes under Color headings by level; the stylesheet
 *  holds the same order. */
export const LEVEL_PRESET_SWATCH: Record<HeadingLevel, HeadingSwatch> = {
  1: 'red',
  2: 'yellow',
  3: 'green',
  4: 'teal',
  5: 'blue',
  6: 'purple'
}

// The other spellings a person may type in config.toml.
const ALIASES: Record<string, HeadingSwatch> = { aqua: 'teal', grey: 'gray' }

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function headingStyleKey(level: HeadingLevel, prop: HeadingStyleProp): string {
  return `h${level}.${prop}`
}

/** A color as stored or typed (`Red`, ` aqua `, `#E06C75`, `#e6c`), or null
 *  when it is neither a swatch nor a hex color. Hex comes back lower case and
 *  six digits long, which is also what a color input reads. */
export function parseHeadingColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (!value) return null
  if (HEX.test(value)) {
    if (value.length === 4) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    }
    return value
  }
  const swatch = HEADING_COLOR_SWATCHES.find((entry) => entry.id === value)
  return swatch ? swatch.id : (ALIASES[value] ?? null)
}

/** A font family name, or null when blank. Quotes are dropped because the name
 *  is written into a quoted CSS string. */
export function parseHeadingFont(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/["\\]/g, '').trim()
  return name ? name.slice(0, 200) : null
}

/** Keeps only `h1.color` … `h6.font` entries with a usable value, in a fixed
 *  order, so an unknown or broken line in config.toml is dropped rather than
 *  half applied. */
export function normalizeHeadingStyles(raw: unknown): HeadingStyles {
  const out: HeadingStyles = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  // `h1.color = "red"` written without quotes is a nested TOML table, so read
  // `{ h1: { color } }` the same as the quoted `"h1.color"` key.
  const read = (level: HeadingLevel, prop: HeadingStyleProp): unknown => {
    const flat = source[headingStyleKey(level, prop)]
    if (flat !== undefined) return flat
    const nested = source[`h${level}`]
    return nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[prop] : undefined
  }
  for (const level of HEADING_LEVELS) {
    const color = parseHeadingColor(read(level, 'color'))
    if (color) out[headingStyleKey(level, 'color')] = color
    const font = parseHeadingFont(read(level, 'font'))
    if (font) out[headingStyleKey(level, 'font')] = font
  }
  return out
}

/** The map with one entry set, or removed when `value` is null or unusable. */
export function withHeadingStyle(
  styles: HeadingStyles,
  level: HeadingLevel,
  prop: HeadingStyleProp,
  value: string | null
): HeadingStyles {
  const next: HeadingStyles = { ...styles }
  const key = headingStyleKey(level, prop)
  const parsed = value === null ? null : prop === 'color' ? parseHeadingColor(value) : parseHeadingFont(value)
  if (parsed) next[key] = parsed
  else delete next[key]
  return normalizeHeadingStyles(next)
}

export function headingSwatch(id: string): (typeof HEADING_COLOR_SWATCHES)[number] | undefined {
  return HEADING_COLOR_SWATCHES.find((entry) => entry.id === id)
}

/** The theme hues on paper: the GitHub Light shades the clean PDF export
 *  prints with, so a Word export (main process, no theme to read) and that PDF
 *  color a heading the same. Six hex digits, no `#`, as Word takes them. */
export const HEADING_PRINT_HEX: Record<HeadingSwatch, string> = {
  red: 'D1242F',
  yellow: '9A6700',
  green: '1A7F37',
  teal: '1B7C83',
  blue: '0969DA',
  purple: '8250DF',
  accent: '0969DA',
  gray: '656D76'
}

export interface PrintHeadingLook {
  level: HeadingLevel
  /** RRGGBB, no `#`. */
  color?: string
  font?: string
}

/** What each level looks like on paper: a color picked for it, else the
 *  preset's swatch while Color headings by level is on, and a font picked for
 *  it. Levels with neither are left out, so an export with no heading styles
 *  stays exactly as it was. */
export function printHeadingLook(
  styles: unknown,
  colorHeadings: boolean
): PrintHeadingLook[] {
  const normalized = normalizeHeadingStyles(styles)
  const out: PrintHeadingLook[] = []
  for (const level of HEADING_LEVELS) {
    const picked = normalized[headingStyleKey(level, 'color')]
    const value = picked ?? (colorHeadings ? LEVEL_PRESET_SWATCH[level] : undefined)
    const swatch = value ? headingSwatch(value) : undefined
    const color = swatch
      ? HEADING_PRINT_HEX[swatch.id]
      : value
        ? value.slice(1).toUpperCase()
        : undefined
    const font = normalized[headingStyleKey(level, 'font')]
    if (color || font) out.push({ level, ...(color ? { color } : {}), ...(font ? { font } : {}) })
  }
  return out
}
