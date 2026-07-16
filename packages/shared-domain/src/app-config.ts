// Portable application config — the subset of user preferences that travel
// between machines via a plain-text config file (config.toml). This is the
// single source of truth for *which* preference keys are portable; both the
// renderer (to extract/apply the subset) and the desktop main process (to
// read/write the file) import from here so the two never drift.
//
// Machine-local UI state (pane widths, collapsed folders, pinned reference,
// onboarding flag, last-opened vault, window geometry) is deliberately NOT
// listed here — it stays in localStorage / the runtime config so a synced
// dotfile doesn't churn on every drag and never carries machine-specific
// layout state.

/** Bumped when the on-disk config layout changes in a way that needs a
 *  migration. Written as `config_version` at the top of the file. */
export const CONFIG_VERSION = 1

/** Clock format for the `@time` macro (and any future time insertions). */
export type TimeFormat = '12h' | '24h'

/**
 * How the text of a completed task (`- [x]`) is styled in the editor and
 * preview. `none` keeps the original appearance (just the checked box).
 */
export type CompletedTaskStyle = 'none' | 'strikethrough' | 'gray' | 'gray-strikethrough'

/**
 * The host locale's 12/24-hour convention, used as the `timeFormat` default so a
 * fresh install matches the operating system out of the box. Reads only the
 * resolved format options (no `Date`), so it is safe to evaluate at module load.
 */
export function defaultTimeFormat(): TimeFormat {
  try {
    const resolved = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()
    if (typeof resolved.hour12 === 'boolean') return resolved.hour12 ? '12h' : '24h'
    if (resolved.hourCycle) {
      return resolved.hourCycle === 'h11' || resolved.hourCycle === 'h12' ? '12h' : '24h'
    }
  } catch {
    /* fall through to the 24-hour default */
  }
  return '24h'
}

/**
 * Preference keys (matching the renderer's `Prefs` shape) persisted to the
 * portable config file. Keep this list in sync with `Prefs` in
 * `packages/app-core/src/store.ts`; new portable settings should be added
 * here AND given a TOML mapping in `apps/desktop/src/main/app-config.ts`.
 */
export const PORTABLE_PREF_KEYS = [
  // vim
  'vimMode',
  'vimInsertEscape',
  'vimYankToClipboard',
  'whichKeyHints',
  'whichKeyHintMode',
  'whichKeyHintTimeoutMs',
  // keymaps (overrides only)
  'keymapOverrides',
  // search
  'vaultTextSearchBackend',
  'ripgrepBinaryPath',
  'fzfBinaryPath',
  // editor
  'livePreview',
  'renderTablesInLivePreview',
  'completedTaskStyle',
  'keepViewModeAcrossNotes',
  'markdownSnippets',
  'hideBuiltinTemplates',
  'tabsEnabled',
  'wrapTabs',
  'editorFontSize',
  'editorLineHeight',
  'editorScrollOff',
  'timeFormat',
  'previewMaxWidth',
  'editorMaxWidth',
  'lineNumberMode',
  'lineNumberPosition',
  'viewSettingsScope',
  'wordWrap',
  'previewSmoothScroll',
  'pdfEmbedInEditMode',
  'pdfExportUseTheme',
  // appearance
  'themeId',
  'themeFamily',
  'themeMode',
  'enabledOverrides',
  'themeTweaks',
  'darkSidebar',
  'showSidebarChevrons',
  'contentAlign',
  'unifiedSidebar',
  // typography
  'interfaceFont',
  'textFont',
  'monoFont',
  // view
  'systemFolderLabels',
  'noteSortOrder',
  'groupByKind',
  'autoReveal',
  'quickNoteDateTitle',
  'quickNoteTitlePrefix',
  'autoCalendarPanel',
  'calendarWeekStart',
  'calendarShowWeekNumbers',
  'tasksViewMode',
  'kanbanGroupBy',
  'kanbanColumnTitles',
  'kanbanStatuses'
] as const

export type PortablePrefKey = (typeof PORTABLE_PREF_KEYS)[number]

/**
 * Transport shape for the portable config across the IPC boundary. Values are
 * `unknown` on purpose — the file is user-editable plain text, so the renderer
 * funnels everything through `normalizePrefs()` for validation rather than
 * trusting compile-time types here.
 */
export type AppConfigPortable = Partial<Record<PortablePrefKey, unknown>>

const PORTABLE_KEY_SET: ReadonlySet<string> = new Set(PORTABLE_PREF_KEYS)

/** True when `key` is one of the portable preference keys. */
export function isPortablePrefKey(key: string): key is PortablePrefKey {
  return PORTABLE_KEY_SET.has(key)
}

/** Extract just the portable preference keys from a full prefs-like object. */
export function pickPortablePrefs(prefs: Record<string, unknown>): AppConfigPortable {
  const out: AppConfigPortable = {}
  for (const key of PORTABLE_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(prefs, key)) {
      out[key] = prefs[key]
    }
  }
  return out
}

/**
 * Default value for every portable preference. The config writer fills any
 * option the user hasn't set with these so the file always lists every
 * available setting (self-documenting). MUST stay in sync with `DEFAULT_PREFS`
 * in `packages/app-core/src/store.ts` — a test in app-core asserts they match.
 */
export const PORTABLE_DEFAULTS: Record<PortablePrefKey, unknown> = {
  vimMode: true,
  vimInsertEscape: '',
  vimYankToClipboard: false,
  whichKeyHints: true,
  whichKeyHintMode: 'timed',
  whichKeyHintTimeoutMs: 900,
  keymapOverrides: {},
  vaultTextSearchBackend: 'auto',
  ripgrepBinaryPath: null,
  fzfBinaryPath: null,
  livePreview: true,
  renderTablesInLivePreview: true,
  completedTaskStyle: 'none',
  keepViewModeAcrossNotes: false,
  markdownSnippets: true,
  hideBuiltinTemplates: false,
  tabsEnabled: true,
  wrapTabs: false,
  editorFontSize: 16,
  editorLineHeight: 1.7,
  editorScrollOff: 0,
  timeFormat: defaultTimeFormat(),
  previewMaxWidth: 920,
  editorMaxWidth: 920,
  lineNumberMode: 'off',
  lineNumberPosition: 'text',
  viewSettingsScope: 'global',
  wordWrap: true,
  previewSmoothScroll: true,
  pdfEmbedInEditMode: 'compact',
  pdfExportUseTheme: false,
  themeId: 'dark-hard',
  themeFamily: 'gruvbox',
  themeMode: 'dark',
  enabledOverrides: {},
  themeTweaks: {},
  darkSidebar: true,
  showSidebarChevrons: true,
  contentAlign: 'center',
  unifiedSidebar: true,
  interfaceFont: null,
  textFont: null,
  monoFont: null,
  systemFolderLabels: {},
  noteSortOrder: 'none',
  groupByKind: true,
  autoReveal: false,
  quickNoteDateTitle: false,
  quickNoteTitlePrefix: 'Quick Note',
  autoCalendarPanel: true,
  calendarWeekStart: 'monday',
  calendarShowWeekNumbers: true,
  tasksViewMode: 'list',
  kanbanGroupBy: 'status',
  kanbanColumnTitles: {},
  kanbanStatuses: []
}
