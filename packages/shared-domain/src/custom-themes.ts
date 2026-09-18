/**
 * Custom user themes (Obsidian-style).
 *
 * A theme is a folder dropped into `~/.config/zennotes/themes/<slug>/`:
 *
 *   <slug>/
 *     manifest.json   — name, author, version, description, modes, preview
 *     theme.css       — arbitrary CSS (may embed fonts/images)
 *     <assets…>       — optional font/image files referenced as
 *                       url(zen-theme://<slug>/<file>)
 *
 * The app injects only the *active* theme's `theme.css` (so an inactive theme's
 * arbitrary/global CSS never leaks), sets `data-theme="custom-<slug>"` plus a
 * resolved `data-theme-mode="light|dark"` on <html>, and the theme keys its
 * dark overrides off `:root[data-theme-mode="dark"]`. Authors therefore never
 * hardcode their slug into selectors.
 *
 * This module is pure (no DOM / fs) so it's shared between the main-process
 * loader, the renderer, and the one-time `.toml` → folder migration. The
 * palette helpers (`parseColor`, `deriveThemeTokens`) survive from the old
 * TOML-palette format: they now power `scaffoldThemeCss` (the "New theme"
 * starter + the migration), not live rendering.
 */

import type {
  CustomThemeMode,
  CustomThemeModes,
  ThemeManifest,
  CustomTheme
} from '@zennotes/bridge-contract/custom-themes'
export type {
  CustomThemeMode,
  CustomThemeModes,
  ThemeManifest,
  CustomTheme
} from '@zennotes/bridge-contract/custom-themes'

/**
 * The semantic palette of the old TOML format. Retained only as the input to
 * `scaffoldThemeCss` (the "New theme" starter and the `.toml` migration).
 */
export interface CustomThemePalette {
  /** Page background. Required. */
  bg: string
  /** Primary text. Required. */
  text: string
  /** Accent / interactive color. Required. */
  accent: string
  chrome?: string
  surface?: string
  border?: string
  muted?: string
  faint?: string
  accentSoft?: string
  accentMuted?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  purple?: string
  aqua?: string
  shadow?: string
}

type Rgb = [number, number, number]

const clampChannel = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/** Parse `#rgb`, `#rrggbb`, `rgb(r,g,b)`, or `r g b` / `r, g, b`. */
export function parseColor(input: string | undefined | null): Rgb | null {
  if (!input) return null
  const s = String(input).trim()
  let m = /^#?([0-9a-f]{3})$/i.exec(s)
  if (m) {
    const h = m[1]
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ]
  }
  m = /^#?([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const h = m[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const body = /^rgba?\(([^)]+)\)$/i.exec(s)?.[1] ?? s
  const parts = body
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    return [parts[0], parts[1], parts[2]]
  }
  return null
}

/** Linear blend from `a` to `b`; `t=0` → a, `t=1` → b. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  clampChannel(a[0] + (b[0] - a[0]) * t),
  clampChannel(a[1] + (b[1] - a[1]) * t),
  clampChannel(a[2] + (b[2] - a[2]) * t)
]

/** Space-separated triplet so Tailwind's `rgb(var(--x) / <alpha>)` works. */
const triplet = (c: Rgb): string => `${c[0]} ${c[1]} ${c[2]}`

const BLACK: Rgb = [0, 0, 0]

const SEMANTIC_DEFAULTS: Record<CustomThemeMode, Record<string, Rgb>> = {
  light: {
    red: [193, 74, 74],
    green: [108, 120, 46],
    yellow: [180, 113, 9],
    blue: [69, 112, 122],
    purple: [148, 94, 128],
    aqua: [76, 122, 93]
  },
  dark: {
    red: [251, 73, 52],
    green: [184, 187, 38],
    yellow: [250, 189, 47],
    blue: [131, 165, 152],
    purple: [211, 134, 155],
    aqua: [142, 192, 124]
  }
}

const DARK_GLASS = { a1: '0.58', a2: '0.46', a3: '0.32', a4: '0.22' }
const LIGHT_GLASS = { a1: '0.62', a2: '0.5', a3: '0.35', a4: '0.25' }

/**
 * Derive the full `--z-*` token map from a palette. Returns null when a
 * required color (bg / text / accent) is missing or unparseable.
 */
export function deriveThemeTokens(
  palette: CustomThemePalette,
  mode: CustomThemeMode
): Record<string, string> | null {
  const bg = parseColor(palette.bg)
  const text = parseColor(palette.text)
  const accent = parseColor(palette.accent)
  if (!bg || !text || !accent) return null

  const surface = parseColor(palette.surface) ?? mix(bg, text, 0.05)
  const chrome = parseColor(palette.chrome) ?? mix(bg, surface, 0.5)
  const border = parseColor(palette.border) ?? mix(bg, text, 0.16)
  const muted = parseColor(palette.muted) ?? mix(text, bg, 0.3)
  const faint = parseColor(palette.faint) ?? mix(text, bg, 0.52)
  const accentSoft = parseColor(palette.accentSoft) ?? mix(accent, bg, 0.3)
  const accentMuted = parseColor(palette.accentMuted) ?? mix(accent, muted, 0.4)
  const shadow = parseColor(palette.shadow) ?? (mode === 'dark' ? BLACK : mix(text, BLACK, 0.4))
  const sem = SEMANTIC_DEFAULTS[mode]
  const semantic = (key: keyof typeof sem, raw: string | undefined): Rgb =>
    parseColor(raw) ?? sem[key]

  const glass = mode === 'dark' ? DARK_GLASS : LIGHT_GLASS

  return {
    'color-scheme': mode,
    '--z-bg': triplet(bg),
    '--z-bg-softer': triplet(chrome),
    '--z-bg-1': triplet(surface),
    '--z-bg-2': triplet(mix(surface, border, 0.5)),
    '--z-bg-3': triplet(border),
    '--z-bg-4': triplet(mix(border, faint, 0.45)),
    '--z-fg': triplet(mix(text, muted, 0.12)),
    '--z-fg-1': triplet(text),
    '--z-fg-2': triplet(muted),
    '--z-grey-2': triplet(muted),
    '--z-grey-1': triplet(mix(muted, faint, 0.5)),
    '--z-grey-0': triplet(faint),
    '--z-grey-dim': triplet(mix(faint, border, 0.5)),
    '--z-accent': triplet(accent),
    '--z-accent-soft': triplet(accentSoft),
    '--z-accent-muted': triplet(accentMuted),
    '--z-red': triplet(semantic('red', palette.red)),
    '--z-green': triplet(semantic('green', palette.green)),
    '--z-yellow': triplet(semantic('yellow', palette.yellow)),
    '--z-blue': triplet(semantic('blue', palette.blue)),
    '--z-purple': triplet(semantic('purple', palette.purple)),
    '--z-aqua': triplet(semantic('aqua', palette.aqua)),
    '--z-shadow': triplet(shadow),
    '--z-glass-a1': glass.a1,
    '--z-glass-a2': glass.a2,
    '--z-glass-a3': glass.a3,
    '--z-glass-a4': glass.a4
  }
}

/** The `data-theme` value for a custom theme, e.g. `custom-soft-paper`. */
export function customThemeId(slug: string): string {
  return `custom-${slug}`
}

const CUSTOM_ID_RE = /^custom-(.+)$/

/** Slug embedded in a `custom-<slug>` theme id, or null for built-ins. */
export function customThemeSlugFromId(themeId: string): string | null {
  const m = CUSTOM_ID_RE.exec(themeId)
  return m ? m[1] : null
}

/** Whether a theme id refers to a custom theme. */
export function isCustomThemeId(themeId: string): boolean {
  return CUSTOM_ID_RE.test(themeId)
}

/** Whether a theme provides the given mode (single-mode themes pin their one). */
export function customThemeSupportsMode(
  theme: Pick<CustomTheme, 'modes'>,
  mode: CustomThemeMode
): boolean {
  return theme.modes === 'both' || theme.modes === mode
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Map a free-form `modes` value (`"both"`, `"light"`, `["light","dark"]`, …)
 *  onto the {@link CustomThemeModes} union, defaulting to `both`. */
function normalizeModes(raw: unknown): CustomThemeModes {
  if (raw === 'light' || raw === 'dark' || raw === 'both') return raw
  if (Array.isArray(raw)) {
    const light = raw.includes('light')
    const dark = raw.includes('dark')
    if (light && dark) return 'both'
    if (light) return 'light'
    if (dark) return 'dark'
  }
  return 'both'
}

/**
 * Validate a parsed `manifest.json` into a {@link ThemeManifest}. Lenient by
 * design — a missing/garbage manifest still yields a usable theme named after
 * its folder, so a typo doesn't make the whole theme vanish.
 */
export function parseThemeManifest(raw: unknown, slug: string): ThemeManifest {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const previewRaw =
    obj.preview && typeof obj.preview === 'object' ? (obj.preview as Record<string, unknown>) : null
  const preview = previewRaw
    ? { light: asString(previewRaw.light), dark: asString(previewRaw.dark) }
    : undefined
  return {
    name: asString(obj.name) ?? slug,
    author: asString(obj.author),
    version: asString(obj.version),
    description: asString(obj.description),
    modes: normalizeModes(obj.modes),
    preview: preview && (preview.light || preview.dark) ? preview : undefined
  }
}

const SCAFFOLD_HEADER = (name: string, slug?: string): string =>
  `/* ${name} — a ZenNotes theme.
 *
 * Only this file's CSS is active while the theme is selected, so :root is safe
 * to use unscoped. Put dark-mode overrides under [data-theme-mode="dark"].
 * Tokens are space-separated RGB triplets, e.g. --z-bg: 255 255 255;
 *
 * Ship fonts/images beside this file and reference them theme-relative, e.g.
 *   @font-face { font-family: "My Font";
 *     src: url(zen-theme://${slug ?? '<this-folder>'}/my-font.woff2) format("woff2"); }
 */`

const tokensToBlock = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n')

/**
 * Generate a starter `theme.css` from one or both palettes. Used by the
 * "New theme" command and the one-time `.toml` migration — light tokens go in
 * `:root {}`, dark tokens in `:root[data-theme-mode="dark"] {}`.
 */
export function scaffoldThemeCss(opts: {
  name?: string
  slug?: string
  light?: CustomThemePalette
  dark?: CustomThemePalette
}): string {
  const parts: string[] = [SCAFFOLD_HEADER(opts.name ?? 'Custom theme', opts.slug)]
  if (opts.light) {
    const tokens = deriveThemeTokens(opts.light, 'light')
    if (tokens) parts.push(`:root {\n${tokensToBlock(tokens)}\n}`)
  }
  if (opts.dark) {
    const tokens = deriveThemeTokens(opts.dark, 'dark')
    if (tokens) parts.push(`:root[data-theme-mode="dark"] {\n${tokensToBlock(tokens)}\n}`)
  }
  return parts.join('\n\n') + '\n'
}

const PALETTE_KEYS: Array<keyof CustomThemePalette> = [
  'bg',
  'text',
  'accent',
  'chrome',
  'surface',
  'border',
  'muted',
  'faint',
  'accentSoft',
  'accentMuted',
  'red',
  'green',
  'yellow',
  'blue',
  'purple',
  'aqua',
  'shadow'
]

/** Map a single TOML table (snake_case keys) to a CustomThemePalette. */
function readPalette(raw: unknown): CustomThemePalette | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const get = (camel: string): string | undefined => {
    const snake = camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
    const v = obj[snake] ?? obj[camel]
    return typeof v === 'string' ? v : undefined
  }
  const palette: Partial<CustomThemePalette> = {}
  for (const key of PALETTE_KEYS) {
    const value = get(key)
    if (value !== undefined) palette[key] = value
  }
  if (!palette.bg || !palette.text || !palette.accent) return null
  return palette as CustomThemePalette
}

/**
 * Pull the `name` + `[light]`/`[dark]` palettes out of a parsed legacy `.toml`
 * theme. Used only by the one-time migration to folder/CSS themes.
 */
export function readTomlPalettes(raw: unknown): {
  name?: string
  light?: CustomThemePalette
  dark?: CustomThemePalette
} {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const light = readPalette(obj.light)
  const dark = readPalette(obj.dark)
  return {
    name: asString(obj.name),
    ...(light ? { light } : {}),
    ...(dark ? { dark } : {})
  }
}
