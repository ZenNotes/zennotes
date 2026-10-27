import { parse } from 'smol-toml'
import { PORTABLE_DEFAULTS } from '@shared/app-config'
import { findTheme, resolveAuto, type ThemeFamily, type ThemeOption } from '@renderer/lib/themes'

/** The look the preview borrows from the user's ZenNotes settings. */
export interface QuickLookPrefs {
  themeFamily: ThemeFamily
  themeMode: 'light' | 'dark' | 'auto'
  themeId: string
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
  editorFontSize: number
  mathFontScale: number
  editorLineHeight: number
  previewMaxWidth: number
  contentAlign: 'center' | 'left'
  completedTaskStyle: string
  /** Hidden keeps a note's cover out of the preview, as in the app. */
  noteCoverPlacement: 'scroll' | 'pinned' | 'hidden'
  vimMode: boolean
}

/** Where each preference lives in config.toml: the same sections and keys the
 *  desktop writes (apps/desktop/src/main/app-config.ts). */
const TOML_KEYS: Record<keyof QuickLookPrefs, [section: string, key: string]> = {
  themeFamily: ['appearance', 'theme_family'],
  themeMode: ['appearance', 'theme_mode'],
  themeId: ['appearance', 'theme_id'],
  contentAlign: ['appearance', 'content_align'],
  noteCoverPlacement: ['appearance', 'note_cover_placement'],
  interfaceFont: ['typography', 'interface_font'],
  textFont: ['typography', 'text_font'],
  monoFont: ['typography', 'mono_font'],
  editorFontSize: ['editor', 'font_size'],
  mathFontScale: ['editor', 'math_font_scale'],
  editorLineHeight: ['editor', 'line_height'],
  previewMaxWidth: ['editor', 'preview_max_width'],
  completedTaskStyle: ['editor', 'completed_task_style'],
  vimMode: ['vim', 'enabled']
}

export function defaultQuickLookPrefs(): QuickLookPrefs {
  const defaults = PORTABLE_DEFAULTS as Record<string, unknown>
  const prefs = {} as Record<keyof QuickLookPrefs, unknown>
  for (const key of Object.keys(TOML_KEYS) as Array<keyof QuickLookPrefs>) prefs[key] = defaults[key]
  return prefs as unknown as QuickLookPrefs
}

/**
 * The preferences in a config.toml, each falling back to the app's default
 * when it is missing or of the wrong type. A file that does not parse yields
 * the defaults: a preview never fails over settings.
 */
export function readQuickLookPrefs(configText: string): QuickLookPrefs {
  const prefs = defaultQuickLookPrefs()
  let doc: Record<string, unknown>
  try {
    doc = configText.trim() ? (parse(configText) as Record<string, unknown>) : {}
  } catch {
    return prefs
  }
  for (const [name, [section, key]] of Object.entries(TOML_KEYS) as Array<[keyof QuickLookPrefs, [string, string]]>) {
    const table = doc[section]
    const value = table && typeof table === 'object' ? (table as Record<string, unknown>)[key] : undefined
    const fallback = prefs[name]
    if (value === undefined) continue
    if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      ;(prefs as unknown as Record<string, unknown>)[name] = value
    } else if (typeof fallback === 'boolean' && typeof value === 'boolean') {
      ;(prefs as unknown as Record<string, unknown>)[name] = value
    } else if ((typeof fallback === 'string' || fallback === null) && typeof value === 'string') {
      // An empty font name means the platform default, as in the app.
      ;(prefs as unknown as Record<string, unknown>)[name] = value === '' && fallback === null ? null : value
    }
  }
  if (prefs.themeMode !== 'light' && prefs.themeMode !== 'dark' && prefs.themeMode !== 'auto') {
    prefs.themeMode = defaultQuickLookPrefs().themeMode
  }
  if (prefs.contentAlign !== 'left') prefs.contentAlign = 'center'
  if (!['scroll', 'pinned', 'hidden'].includes(prefs.noteCoverPlacement)) {
    prefs.noteCoverPlacement = defaultQuickLookPrefs().noteCoverPlacement
  }
  for (const font of ['interfaceFont', 'textFont', 'monoFont'] as const) {
    if (prefs[font] === '') prefs[font] = null
  }
  return prefs
}

/**
 * The theme the preview draws with. A custom theme's stylesheet lives with
 * the app, so its family falls back to the built-in light or dark look of the
 * same mode.
 */
export function quickLookTheme(prefs: QuickLookPrefs, prefersDark: boolean): ThemeOption {
  const family: ThemeFamily = prefs.themeFamily === 'custom' ? 'apple' : prefs.themeFamily
  if (prefs.themeMode === 'auto') return findTheme(resolveAuto(family, prefersDark, prefs.themeId))
  const chosen = findTheme(prefs.themeId)
  if (chosen.id === prefs.themeId && prefs.themeFamily !== 'custom') return chosen
  return findTheme(resolveAuto(family, prefs.themeMode === 'dark', prefs.themeId))
}
