export type CustomThemeMode = 'light' | 'dark'

/** Which modes a theme provides; drives the mode toggle + auto resolution. */
export type CustomThemeModes = 'light' | 'dark' | 'both'

/** Parsed `manifest.json`. */
export interface ThemeManifest {
  /** Display name (falls back to the slug). */
  name: string
  author?: string
  version?: string
  description?: string
  /** Modes this theme styles. Default `both`. */
  modes: CustomThemeModes
  /** Optional swatch hint for the Settings card (we can't cheaply render
   *  arbitrary CSS into a preview). */
  preview?: { light?: string; dark?: string }
}

/** A loaded custom theme: its manifest fields + the raw `theme.css` to inject. */
export interface CustomTheme {
  /** Stable id from the folder name, e.g. `soft-paper`. */
  slug: string
  name: string
  author?: string
  version?: string
  description?: string
  modes: CustomThemeModes
  /** Raw `theme.css` text, injected verbatim when this theme is active. */
  css: string
  preview?: { light?: string; dark?: string }
  /** Set when the folder couldn't be used; surfaced in the UI. */
  error?: string
}
