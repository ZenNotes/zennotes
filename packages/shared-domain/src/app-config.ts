import type { PortablePrefKey, AppConfigPortable } from '@zennotes/bridge-contract/app-config'
import { PORTABLE_PREF_KEYS } from '@zennotes/bridge-contract/app-config'
export type { PortablePrefKey, AppConfigPortable } from '@zennotes/bridge-contract/app-config'
export { PORTABLE_PREF_KEYS } from '@zennotes/bridge-contract/app-config'

// Portable preferences are defined by the bridge contract and re-exported here
// for existing consumers. This module owns normalization, defaults, and selection.
// Machine-local layout and session state remain outside portable config.

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
 * Which typesetter renders `$…$` / `$$…$$` math. KaTeX (default) parses the
 * body as LaTeX; Typst parses it as Typst markup, so a note's math is written
 * for whichever engine is selected, not interchangeable between them.
 */
export type MathRenderer = 'katex' | 'typst'

/** How Vim's unprefixed line-boundary motions treat soft-wrapped lines. */
export type VimWrappedLineMotionMode = 'display' | 'logical'

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
  vimBlockImeInNormalMode: true,
  vimWrappedLineMotions: 'display',
  whichKeyHints: true,
  whichKeyHintMode: 'timed',
  whichKeyHintTimeoutMs: 900,
  keymapOverrides: {},
  commandKeymaps: {},
  ignoredKeys: [],
  externalApplicationSchemes: [],
  vaultTextSearchBackend: 'auto',
  ripgrepBinaryPath: null,
  fzfBinaryPath: null,
  searchTaggedBlocks: true,
  livePreview: true,
  showHeadingLevelLabels: false,
  listIndentGuides: true,
  linkPopoverOnHover: true,
  renderTablesInLivePreview: true,
  detectCodeLanguages: true,
  completedTaskStyle: 'none',
  mathRenderer: 'katex',
  typstTagPreambles: false,
  harperEnabled: false,
  harperDialect: 'american',
  looseMathDelimiters: false,
  keepViewModeAcrossNotes: false,
  keepPanelsAcrossNotes: true,
  persistUndoHistory: false,
  defaultPaneMode: 'edit',
  syncTitleHeadingOnRename: true,
  // Keep what a note said before an assistant edits it through MCP, so the
  // edit can be reviewed (docs/ideas/agent-edit-review.md). The MCP server
  // reads it from config.toml, without the app running.
  reviewAgentEdits: true,
  // The desktop app's anonymous count of installs and updates: version, OS,
  // architecture and install kind, with no identifier (lib/whats-new.ts sends
  // it with the first launch of each version). Settings > About turns it off.
  usageCount: true,
  markdownSnippets: true,
  textReplacementsEnabled: true,
  textReplacements: { '->': '→' },
  autoPairs: true,
  autoPairQuotesInProse: false,
  hideBuiltinTemplates: false,
  tabsEnabled: true,
  wrapTabs: false,
  editorFontSize: 16,
  mathFontScale: 100,
  editorLineHeight: 1.7,
  editorTabSize: 4,
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
  showWindowTitleBar: true,
  showStatusBar: true,
  showSidebarChevrons: true,
  contentAlign: 'center',
  noteCoverPlacement: 'scroll',
  unifiedSidebar: true,
  interfaceFont: null,
  textFont: null,
  monoFont: null,
  workflowsEnabled: false,
  workflowEventTriggers: true,
  hiddenWorkflowPresets: [],
  atlasEnabled: true,
  systemFolderLabels: {},
  noteSortOrder: 'none',
  assetSortOrder: 'name-asc',
  groupByKind: true,
  nestedTags: true,
  autoReveal: false,
  quickNoteDateTitle: false,
  quickNoteTitlePrefix: 'Quick Note',
  autoCalendarPanel: true,
  calendarWeekStart: 'monday',
  calendarShowWeekNumbers: true,
  tasksViewMode: 'list',
  showArchivedTasks: false,
  kanbanGroupBy: 'status',
  kanbanCardSort: 'manual',
  tasksListOrder: 'note',
  timelineRange: 'two-weeks',
  gallerySort: 'updated',
  galleryIncludeSubfolders: false,
  kanbanFolderRoot: '',
  kanbanColumnTitles: {},
  kanbanStatuses: [],
  savedTaskFilters: {}
}
