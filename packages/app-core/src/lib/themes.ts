/**
 * Registry of every theme variant the app supports. Each entry maps to a
 * `data-theme="..."` selector defined in `styles/index.css`.
 *
 * Three families, official palettes:
 *   - Gruvbox Material   (sainnhe/gruvbox-material) — light/dark × hard/medium/soft
 *   - Catppuccin         (catppuccin/nvim)           — latte / frappé / macchiato / mocha
 *   - GitHub             (projekt0n/github-nvim-theme) — light, light high-contrast,
 *                                                        dark, dark dimmed, dark high-contrast
 */

export type ThemeFamily =
  | 'apple'
  | 'gruvbox'
  | 'catppuccin'
  | 'github'
  | 'solarized'
  | 'one'
  | 'nord'
  | 'tokyo-night'
export type ThemeMode = 'light' | 'dark' | 'auto'

export interface ThemeOption {
  /** CSS data-theme attribute value. */
  id: string
  /** Short display label. */
  label: string
  /** Family this variant belongs to. */
  family: ThemeFamily
  /** Resolved mode. */
  mode: 'light' | 'dark'
  /** Optional sub-flavor label — Catppuccin flavor, GitHub contrast, Gruvbox contrast. */
  variant?: string
}

export const THEMES: ThemeOption[] = [
  // --- Apple (macOS system palette — the default) ----------------------
  { id: 'apple-light', label: 'Light', family: 'apple', mode: 'light' },
  { id: 'apple-dark', label: 'Dark', family: 'apple', mode: 'dark' },

  // --- Gruvbox Material -------------------------------------------------
  { id: 'light-hard', label: 'Gruvbox · Hard', family: 'gruvbox', mode: 'light', variant: 'hard' },
  { id: 'light-medium', label: 'Gruvbox · Medium', family: 'gruvbox', mode: 'light', variant: 'medium' },
  { id: 'light-soft', label: 'Gruvbox · Soft', family: 'gruvbox', mode: 'light', variant: 'soft' },
  { id: 'dark-hard', label: 'Gruvbox · Hard', family: 'gruvbox', mode: 'dark', variant: 'hard' },
  { id: 'dark-medium', label: 'Gruvbox · Medium', family: 'gruvbox', mode: 'dark', variant: 'medium' },
  { id: 'dark-soft', label: 'Gruvbox · Soft', family: 'gruvbox', mode: 'dark', variant: 'soft' },

  // --- Catppuccin -------------------------------------------------------
  { id: 'catppuccin-latte', label: 'Latte', family: 'catppuccin', mode: 'light', variant: 'latte' },
  { id: 'catppuccin-frappe', label: 'Frappé', family: 'catppuccin', mode: 'dark', variant: 'frappe' },
  { id: 'catppuccin-macchiato', label: 'Macchiato', family: 'catppuccin', mode: 'dark', variant: 'macchiato' },
  { id: 'catppuccin-mocha', label: 'Mocha', family: 'catppuccin', mode: 'dark', variant: 'mocha' },

  // --- GitHub (projekt0n/github-nvim-theme) ----------------------------
  { id: 'github-light', label: 'Light', family: 'github', mode: 'light', variant: 'default' },
  {
    id: 'github-light-high-contrast',
    label: 'Light · High Contrast',
    family: 'github',
    mode: 'light',
    variant: 'high-contrast'
  },
  { id: 'github-dark', label: 'Dark', family: 'github', mode: 'dark', variant: 'default' },
  {
    id: 'github-dark-dimmed',
    label: 'Dark · Dimmed',
    family: 'github',
    mode: 'dark',
    variant: 'dimmed'
  },
  {
    id: 'github-dark-high-contrast',
    label: 'Dark · High Contrast',
    family: 'github',
    mode: 'dark',
    variant: 'high-contrast'
  },

  // --- Solarized (ethanschoonover.com/solarized) ----------------------
  { id: 'solarized-light', label: 'Light', family: 'solarized', mode: 'light' },
  { id: 'solarized-dark', label: 'Dark', family: 'solarized', mode: 'dark' },

  // --- One (Atom One Light / One Dark) --------------------------------
  { id: 'one-light', label: 'Light', family: 'one', mode: 'light' },
  { id: 'one-dark', label: 'Dark', family: 'one', mode: 'dark' },

  // --- Nord (arcticicestudio) -----------------------------------------
  { id: 'nord-light', label: 'Light', family: 'nord', mode: 'light' },
  { id: 'nord-dark', label: 'Dark', family: 'nord', mode: 'dark' },

  // --- Tokyo Night (enkia) --------------------------------------------
  { id: 'tokyo-night-day', label: 'Day', family: 'tokyo-night', mode: 'light' },
  { id: 'tokyo-night-storm', label: 'Storm', family: 'tokyo-night', mode: 'dark' }
]

export const DEFAULT_THEME_ID = 'dark-hard'

export function findTheme(id: string): ThemeOption {
  return THEMES.find((t) => t.id === id) ?? THEMES[1] // fallback: light-medium
}

/**
 * Given a family and a system preference, pick a sensible default variant.
 * Used when the user selects "auto" — we pick the light or dark flavor of
 * the active family that feels most like its canonical default.
 */
export function resolveAuto(family: ThemeFamily, prefersDark: boolean): string {
  const targetMode: 'light' | 'dark' = prefersDark ? 'dark' : 'light'

  if (family === 'apple') {
    return targetMode === 'dark' ? 'apple-dark' : 'apple-light'
  }
  if (family === 'gruvbox') {
    return targetMode === 'dark' ? 'dark-medium' : 'light-medium'
  }
  if (family === 'catppuccin') {
    return targetMode === 'dark' ? 'catppuccin-mocha' : 'catppuccin-latte'
  }
  if (family === 'solarized') {
    return targetMode === 'dark' ? 'solarized-dark' : 'solarized-light'
  }
  if (family === 'one') {
    return targetMode === 'dark' ? 'one-dark' : 'one-light'
  }
  if (family === 'nord') {
    return targetMode === 'dark' ? 'nord-dark' : 'nord-light'
  }
  if (family === 'tokyo-night') {
    return targetMode === 'dark' ? 'tokyo-night-storm' : 'tokyo-night-day'
  }
  // github
  return targetMode === 'dark' ? 'github-dark' : 'github-light'
}
