export type { Override } from '@zennotes/bridge-contract/overrides'

/**
 * Whether a override is enabled, per the persisted `[overrides]` map. Only enabled
 * overrides are stored (`"name.css" = "on"`); a missing key means off. Tolerant
 * of a hand-edited config that wrote an explicit off-ish value.
 */
export function isOverrideEnabled(
  enabled: Record<string, string> | undefined,
  name: string
): boolean {
  const v = enabled?.[name]
  return v !== undefined && v !== 'off' && v !== 'false' && v !== '0' && v !== ''
}

/**
 * Visual tweaks — the no-code companion to overrides. A small UI lets users
 * recolor individual `--z-*` tokens with a color picker; the picks are stored
 * as a `slug → color` map (portable config `[tweaks]`) and rendered to a single
 * `:root[data-theme]` block, injected after overrides so an explicit pick wins.
 *
 * Only direct-set, readability-safe tokens are exposed here. Backgrounds/text
 * have derived scales and belong to a full custom theme, not a one-token tweak.
 */
import { parseColor } from './custom-themes'

export type TweakKind = 'color' | 'preset'

export interface TweakableToken {
  /** Stable key stored in config (e.g. "accent"). */
  slug: string
  /** The `--z-*` custom property this controls. */
  token: string
  /** Short UI label. */
  label: string
  /** Grouping for the UI. */
  group: 'accent' | 'syntax' | 'layout'
  /** How the value is stored + rendered. Defaults to `color` (a swatch). */
  kind?: TweakKind
  /** `preset` only: the segmented options, and the CSS vars each value sets
   *  (a value with no entry — e.g. "default" — emits nothing → CSS defaults). */
  options?: { value: string; label: string }[]
  presets?: Record<string, Record<string, string>>
}

/**
 * Interface density. `default` = the metrics baked into `styles/index.css`
 * `:root` (and the Sidebar/NoteList virtualizer fallbacks); `compact` /
 * `comfortable` override them via the density preset below.
 */
export type DensityLevel = 'compact' | 'default' | 'comfortable'

/**
 * The single source of truth for every density-driven metric. The density
 * preset emits these as CSS vars, and the list virtualizers read the *same*
 * numbers for their `itemSize` — so the windowing math can never drift from
 * what's painted. Sidebar rows are uniform (`h-9` = 36px by default); a
 * note-list row is the slot height (NoteRow/FolderAssetRow sit 4px shorter).
 */
export interface DensityMetrics {
  /** Editor tab strip height → `--z-tab-height`. */
  tabHeight: number
  /** Editor tab horizontal padding → `--z-tab-pad-x` (a CSS length). */
  tabPadX: string
  /** Every sidebar row → `--z-sidebar-row-h`, and the leaf-list `itemSize`. */
  sidebarRow: number
  /** Note-list row slot → `--z-note-row-h`, and the folder-entry `itemSize`. */
  noteRow: number
}
export const DENSITY: Record<DensityLevel, DensityMetrics> = {
  compact: { tabHeight: 32, tabPadX: '0.375rem', sidebarRow: 30, noteRow: 64 },
  default: { tabHeight: 40, tabPadX: '0.5rem', sidebarRow: 36, noteRow: 76 },
  comfortable: { tabHeight: 48, tabPadX: '0.75rem', sidebarRow: 44, noteRow: 92 }
}

/** Resolve the active density level from the persisted `[tweaks]` map. */
export function densityFromTweaks(tweaks: Record<string, string> | undefined): DensityLevel {
  const v = tweaks?.density
  return v === 'compact' || v === 'comfortable' ? v : 'default'
}

/** The CSS vars a non-default level sets — derived from DENSITY so the preset
 *  and the virtualizers can't fall out of sync. */
function densityVars(level: 'compact' | 'comfortable'): Record<string, string> {
  const m = DENSITY[level]
  return {
    '--z-tab-height': `${m.tabHeight}px`,
    '--z-tab-pad-x': m.tabPadX,
    '--z-sidebar-row-h': `${m.sidebarRow}px`,
    '--z-note-row-h': `${m.noteRow}px`
  }
}

/** The tokens the visual tweak UI exposes, in display order. */
export const TWEAKABLE_TOKENS: TweakableToken[] = [
  { slug: 'accent', token: '--z-accent', label: 'Accent', group: 'accent', kind: 'color' },
  { slug: 'red', token: '--z-red', label: 'Red', group: 'syntax', kind: 'color' },
  { slug: 'green', token: '--z-green', label: 'Green', group: 'syntax', kind: 'color' },
  { slug: 'yellow', token: '--z-yellow', label: 'Yellow', group: 'syntax', kind: 'color' },
  { slug: 'blue', token: '--z-blue', label: 'Blue', group: 'syntax', kind: 'color' },
  { slug: 'purple', token: '--z-purple', label: 'Purple', group: 'syntax', kind: 'color' },
  { slug: 'aqua', token: '--z-aqua', label: 'Aqua', group: 'syntax', kind: 'color' },
  {
    // Interface density — one control that scales the editor tab strip *and*
    // the sidebar / note-list rows together. Each level sets the height +
    // padding vars (from DENSITY); the list virtualizers read the matching
    // DENSITY numbers so the windowing stays exact. "default" emits nothing.
    slug: 'density',
    token: '',
    label: 'Density',
    group: 'layout',
    kind: 'preset',
    options: [
      { value: 'compact', label: 'Compact' },
      { value: 'default', label: 'Default' },
      { value: 'comfortable', label: 'Comfortable' }
    ],
    presets: {
      compact: densityVars('compact'),
      comfortable: densityVars('comfortable')
    }
  },
  {
    // Corner roundness as a global `--z-radius-scale` multiplier: square = 0,
    // default = 1 (the `:root` value, so it emits nothing), rounded = 1.5× softer.
    // Pills/circles use `rounded-full`, which stays round regardless.
    slug: 'cornerRadius',
    token: '',
    label: 'Corners',
    group: 'layout',
    kind: 'preset',
    options: [
      { value: 'square', label: 'Square' },
      { value: 'default', label: 'Default' },
      { value: 'rounded', label: 'Rounded' }
    ],
    presets: {
      square: { '--z-radius-scale': '0' },
      rounded: { '--z-radius-scale': '1.5' }
    }
  }
]

/**
 * Render the visual-tweak map into a single `:root[data-theme]` block.
 * Colors → an RGB triplet; presets → the CSS-var set their value maps to.
 * Unknown/invalid entries are skipped; returns '' when nothing is set.
 */
export function buildTweaksCss(tweaks: Record<string, string> | undefined): string {
  if (!tweaks) return ''
  const decls: string[] = []
  for (const t of TWEAKABLE_TOKENS) {
    const raw = tweaks[t.slug]
    if (raw == null || raw === '') continue
    if (t.kind === 'preset') {
      const vars = t.presets?.[raw]
      if (vars) {
        for (const [cssVar, value] of Object.entries(vars)) decls.push(`  ${cssVar}: ${value};`)
      }
    } else {
      const rgb = parseColor(raw)
      if (rgb) decls.push(`  ${t.token}: ${rgb.join(' ')};`)
    }
  }
  return decls.length ? `:root[data-theme] {\n${decls.join('\n')}\n}\n` : ''
}
