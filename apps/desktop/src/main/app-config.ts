// Portable app config persisted as plain-text TOML in an XDG-style config
// directory so users can sync their preferences across machines with git /
// stow / chezmoi (issue #203). The file holds only the *portable* subset of
// preferences (see `PORTABLE_PREF_KEYS` in @shared/app-config); machine-local
// state stays in the renderer's localStorage and the runtime config.json.
//
// The renderer talks to this module exclusively through IPC and only ever
// sees plain camelCase objects (`AppConfigPortable`). All TOML concerns —
// section layout, snake_case keys, null<->"" coercion — live here.

import { app } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { parse as parseToml } from 'smol-toml'
import {
  CONFIG_VERSION,
  PORTABLE_DEFAULTS,
  type AppConfigPortable,
  type PortablePrefKey
} from '@shared/app-config'
import {
  KEYMAP_CATALOG,
  KEYMAP_GROUP_ORDER,
  KEYMAP_GROUP_LABELS
} from '@shared/keymaps-catalog'
import { writeFileAtomic } from './vault'

const CONFIG_FILE_NAME = 'config.toml'

/** How a scalar preference maps onto a TOML `[section]` + key, plus the inline
 *  comment that documents its allowed values / meaning in the file. */
interface ScalarFieldMap {
  section: string
  tomlKey: string
  /** Inline `# comment` shown after the value — lists allowed values or a hint
   *  so the file is self-documenting. */
  comment: string
}

// Order sections are emitted in. Keeps the file stable across rewrites.
const SECTION_ORDER = ['vim', 'search', 'editor', 'appearance', 'typography', 'view', 'mcp', 'privacy'] as const

// Scalar (string / number / boolean) portable prefs → [section].key (snake_case).
const SCALAR_FIELDS: Partial<Record<PortablePrefKey, ScalarFieldMap>> = {
  // vim
  vimMode: { section: 'vim', tomlKey: 'enabled', comment: 'true | false: CodeMirror Vim bindings' },
  vimInsertEscape: {
    section: 'vim',
    tomlKey: 'insert_escape',
    comment: 'key sequence to leave insert mode, e.g. "jk"; empty disables'
  },
  vimYankToClipboard: {
    section: 'vim',
    tomlKey: 'yank_to_clipboard',
    comment: 'sync the system clipboard with Vim yank/delete/change and p/P paste'
  },
  vimBlockImeInNormalMode: {
    section: 'vim',
    tomlKey: 'block_ime_in_normal_mode',
    comment: 'keep the OS input method (a CJK IME) from composing in normal and visual mode, so hjkl stay motions'
  },
  vimWrappedLineMotions: {
    section: 'vim',
    tomlKey: 'wrapped_line_motions',
    comment: 'display | logical: how $, I, A and dependent operators treat soft-wrapped lines'
  },
  whichKeyHints: {
    section: 'vim',
    tomlKey: 'which_key_hints',
    comment: 'show the leader-key hint overlay (Vim only)'
  },
  whichKeyHintMode: {
    section: 'vim',
    tomlKey: 'which_key_hint_mode',
    comment: 'timed | sticky'
  },
  whichKeyHintTimeoutMs: {
    section: 'vim',
    tomlKey: 'which_key_hint_timeout_ms',
    comment: 'how long timed hints stay visible (ms)'
  },
  // search
  vaultTextSearchBackend: {
    section: 'search',
    tomlKey: 'backend',
    comment: 'auto | builtin | ripgrep | fzf'
  },
  ripgrepBinaryPath: {
    section: 'search',
    tomlKey: 'ripgrep_path',
    comment: 'absolute path to ripgrep; empty = look on $PATH'
  },
  fzfBinaryPath: {
    section: 'search',
    tomlKey: 'fzf_path',
    comment: 'absolute path to fzf; empty = look on $PATH'
  },
  searchTaggedBlocks: {
    section: 'search',
    tomlKey: 'tagged_blocks',
    comment: 'with a #tag in Search notes, list the tagged blocks under each note'
  },
  // editor
  livePreview: {
    section: 'editor',
    tomlKey: 'live_preview',
    comment: 'hide markdown syntax on inactive lines'
  },
  showHeadingLevelLabels: {
    section: 'editor',
    tomlKey: 'show_heading_level_labels',
    comment: 'show H1 through H6 badges before headings'
  },
  renderTablesInLivePreview: {
    section: 'editor',
    tomlKey: 'render_tables',
    comment: 'render tables as widgets in live preview; off keeps them as plain text'
  },
  syncTitleHeadingOnRename: {
    section: 'editor',
    tomlKey: 'sync_title_heading_on_rename',
    comment: "renaming a note rewrites its leading '# heading' to match"
  },
  reviewAgentEdits: {
    section: 'mcp',
    tomlKey: 'review_agent_edits',
    comment: 'keep what a note said before an assistant edits it through MCP, so you can review the change'
  },
  usageCount: {
    section: 'privacy',
    tomlKey: 'usage_count',
    comment: 'send an anonymous count when ZenNotes installs or updates: version, OS, architecture, install kind; no identifier'
  },
  markdownSnippets: {
    section: 'editor',
    tomlKey: 'markdown_snippets',
    comment: 'auto-close markdown delimiters while typing'
  },
  textReplacementsEnabled: {
    section: 'editor',
    tomlKey: 'text_replacements_enabled',
    comment: 'expand configured text triggers while typing'
  },
  autoPairs: {
    section: 'editor',
    tomlKey: 'auto_pairs',
    comment: 'auto-insert matching [] () and {} while typing'
  },
  autoPairQuotesInProse: {
    section: 'editor',
    tomlKey: 'auto_pair_quotes_in_prose',
    comment: 'also auto-insert matching quotes outside Markdown code'
  },
  hideBuiltinTemplates: {
    section: 'editor',
    tomlKey: 'hide_builtin_templates',
    comment: 'hide the shipped templates from the pickers'
  },
  tabsEnabled: { section: 'editor', tomlKey: 'tabs_enabled', comment: 'enable tab-based editing' },
  wrapTabs: {
    section: 'editor',
    tomlKey: 'wrap_tabs',
    comment: 'wrap the tab strip instead of scrolling it'
  },
  editorFontSize: {
    section: 'editor',
    tomlKey: 'font_size',
    comment: 'editor + preview font size (px)'
  },
  mathFontScale: {
    section: 'editor',
    tomlKey: 'math_font_scale',
    comment: 'math size as a percentage (50-200); scales $…$ and $$…$$ in editor and preview'
  },
  editorLineHeight: { section: 'editor', tomlKey: 'line_height', comment: 'line-height multiplier' },
  editorTabSize: {
    section: 'editor',
    tomlKey: 'tab_size',
    comment: 'tab width in columns, from 1 through 8'
  },
  listIndentGuides: {
    section: 'editor',
    tomlKey: 'list_indent_guides',
    comment: 'vertical guide lines at each nested list level'
  },
  linkPopoverOnHover: {
    section: 'editor',
    tomlKey: 'link_popover_on_hover',
    comment: 'resting the pointer on a [[wikilink]] opens the link popover'
  },
  editorScrollOff: {
    section: 'editor',
    tomlKey: 'scroll_off',
    comment: 'vim scrolloff: lines kept above/below the cursor (0 = off)'
  },
  timeFormat: {
    section: 'editor',
    tomlKey: 'time_format',
    comment: 'clock format for the @time macro (12h or 24h)'
  },
  previewMaxWidth: {
    section: 'editor',
    tomlKey: 'preview_max_width',
    comment: 'max reading width for the preview (px)'
  },
  editorMaxWidth: {
    section: 'editor',
    tomlKey: 'editor_max_width',
    comment: 'max width of the editor column (px)'
  },
  completedTaskStyle: {
    section: 'editor',
    tomlKey: 'completed_task_style',
    comment: 'none | strikethrough | gray | gray-strikethrough: style checked-task text'
  },
  mathRenderer: {
    section: 'editor',
    tomlKey: 'math_renderer',
    comment: 'katex | typst: typesetter for $…$ / $$…$$ math'
  },
  typstTagPreambles: {
    section: 'editor',
    tomlKey: 'typst_tag_preambles',
    comment: 'true | false: prepend Typst definitions from notes in a `typst` folder, chosen by a note\'s tags'
  },
  harperEnabled: {
    section: 'editor',
    tomlKey: 'harper_enabled',
    comment: 'true | false: grammar and spelling with Harper, checked on this device'
  },
  harperDialect: {
    section: 'editor',
    tomlKey: 'harper_dialect',
    comment: 'american | british | australian | canadian | indian'
  },
  looseMathDelimiters: {
    section: 'editor',
    tomlKey: 'loose_math_delimiters',
    comment: 'render $$…$$ display math even with text before/after the fences'
  },
  defaultPaneMode: {
    section: 'editor',
    tomlKey: 'default_view_mode',
    comment: 'edit | split | preview: the mode a note opens in before it has a remembered one'
  },
  keepViewModeAcrossNotes: {
    section: 'editor',
    tomlKey: 'keep_view_mode_across_notes',
    comment: 'true = stay in the current Edit / Split / Preview mode when opening another note; false = each note reopens in its own last mode'
  },
  persistUndoHistory: {
    section: 'editor',
    tomlKey: 'persist_undo_history',
    comment: "true = keep each note's undo history between launches, like Vim's undofile (stored with the app, never in the vault; holds deleted text; desktop only)"
  },
  lineNumberMode: {
    section: 'editor',
    tomlKey: 'line_number_mode',
    comment: 'off | absolute | relative'
  },
  lineNumberPosition: {
    section: 'editor',
    tomlKey: 'line_number_position',
    comment: 'text | edge'
  },
  wordWrap: {
    section: 'editor',
    tomlKey: 'word_wrap',
    comment: 'wrap long lines vs. scroll horizontally'
  },
  previewSmoothScroll: {
    section: 'editor',
    tomlKey: 'preview_smooth_scroll',
    comment: 'animate half-page scroll in the preview'
  },
  pdfEmbedInEditMode: {
    section: 'editor',
    tomlKey: 'pdf_embed_in_edit_mode',
    comment: 'compact | full'
  },
  // appearance
  pdfExportUseTheme: {
    section: 'appearance',
    tomlKey: 'pdf_export_use_theme',
    comment: 'true | false: export PDFs using the current theme instead of a clean light print theme'
  },
  themeFamily: {
    section: 'appearance',
    tomlKey: 'theme_family',
    comment:
      'apple | gruvbox | catppuccin | github | solarized | one | nord | tokyo-night | kanagawa | black-metal | custom'
  },
  themeMode: { section: 'appearance', tomlKey: 'theme_mode', comment: 'light | dark | auto' },
  themeId: {
    section: 'appearance',
    tomlKey: 'theme_id',
    comment: 'resolved theme id; normally set automatically from family + mode'
  },
  darkSidebar: {
    section: 'appearance',
    tomlKey: 'dark_sidebar',
    comment: 'tint the sidebar darker than the canvas'
  },
  showWindowTitleBar: {
    section: 'appearance',
    tomlKey: 'show_window_title_bar',
    comment: 'show the main window title bar and window controls'
  },
  showStatusBar: {
    section: 'appearance',
    tomlKey: 'show_status_bar',
    comment: 'show the bar along the bottom; while hidden it still appears when Cloud needs you'
  },
  showSidebarChevrons: {
    section: 'appearance',
    tomlKey: 'show_sidebar_chevrons',
    comment: 'show disclosure arrows in the sidebar'
  },
  contentAlign: { section: 'appearance', tomlKey: 'content_align', comment: 'center | left' },
  noteCoverPlacement: {
    section: 'appearance',
    tomlKey: 'note_cover_placement',
    comment: 'scroll | pinned | hidden: where a note cover image sits'
  },
  unifiedSidebar: {
    section: 'appearance',
    tomlKey: 'unified_sidebar',
    comment: 'merge the note list into the sidebar tree'
  },
  // typography
  interfaceFont: {
    section: 'typography',
    tomlKey: 'interface_font',
    comment: 'app chrome font; empty = system default'
  },
  textFont: {
    section: 'typography',
    tomlKey: 'text_font',
    comment: 'editor + preview font; empty = system default'
  },
  monoFont: {
    section: 'typography',
    tomlKey: 'mono_font',
    comment: 'code / monospace font; empty = system default'
  },
  // view
  atlasEnabled: {
    section: 'view',
    tomlKey: 'atlas_enabled',
    comment: 'the Atlas map view of the vault (sidebar row, command, Space g); on by default'
  },
  workflowsEnabled: {
    section: 'view',
    tomlKey: 'workflows_enabled',
    comment:
      'opt in to the Workflows view, its sidebar row, command, and leader shortcut (off by default)'
  },
  workflowEventTriggers: {
    section: 'view',
    tomlKey: 'workflow_event_triggers',
    comment:
      'let active workflows with "trigger: on <event>" run on this device when you save, create, move or tag a note (on by default; needs workflows_enabled)'
  },
  assetSortOrder: {
    section: 'view',
    tomlKey: 'asset_sort_order',
    comment: 'Assets view sort: name | used | type | size | modified, each -asc or -desc'
  },
  noteSortOrder: {
    section: 'view',
    tomlKey: 'note_sort_order',
    comment:
      'none | manual | updated-desc | updated-asc | created-desc | created-asc | name-asc | name-desc'
  },
  groupByKind: { section: 'view', tomlKey: 'group_by_kind', comment: 'group notes by kind in the list' },
  nestedTags: {
    section: 'view',
    tomlKey: 'nested_tags',
    comment: 'show /-separated tags as a collapsible tree (sidebar + Tags view)'
  },
  viewSettingsScope: {
    section: 'view',
    tomlKey: 'view_settings_scope',
    comment: 'apply note/list view settings globally or per vault (global | vault)'
  },
  autoReveal: {
    section: 'view',
    tomlKey: 'auto_reveal',
    comment: 'auto-expand the sidebar to the active note'
  },
  quickNoteDateTitle: {
    section: 'view',
    tomlKey: 'quick_note_date_title',
    comment: 'title quick notes by date instead of a timestamp'
  },
  quickNoteTitlePrefix: {
    section: 'view',
    tomlKey: 'quick_note_title_prefix',
    comment: 'prefix for new quick-note titles; empty = bare timestamp'
  },
  autoCalendarPanel: {
    section: 'view',
    tomlKey: 'auto_calendar_panel',
    comment: 'auto-show the calendar for daily / weekly notes'
  },
  keepPanelsAcrossNotes: {
    section: 'view',
    tomlKey: 'keep_panels_across_notes',
    comment: 'true = Connections / Outline / Comments / Calendar / Timeline stay as set while you switch notes; false = each note remembers its own panels (saved with the workspace, so they survive a restart)'
  },
  calendarWeekStart: {
    section: 'view',
    tomlKey: 'calendar_week_start',
    comment: 'monday | sunday | locale'
  },
  calendarShowWeekNumbers: {
    section: 'view',
    tomlKey: 'calendar_show_week_numbers',
    comment: 'show ISO week numbers in the calendar'
  },
  tasksViewMode: { section: 'view', tomlKey: 'tasks_view_mode', comment: 'list | calendar | kanban' },
  showArchivedTasks: {
    section: 'view',
    tomlKey: 'show_archived_tasks',
    comment: 'keep tasks from archived notes in the Tasks views'
  },
  kanbanGroupBy: {
    section: 'view',
    tomlKey: 'kanban_group_by',
    comment: 'status | priority | folder (each note\'s own folder; see kanban_folder_root) | field:<key>'
  },
  kanbanCardSort: {
    section: 'view',
    tomlKey: 'kanban_card_sort',
    comment: 'manual | due: cards in a Kanban column keep the order you drag them into, or follow their due dates'
  },
  tasksListOrder: {
    section: 'view',
    tomlKey: 'tasks_list_order',
    comment: 'note | priority: each Tasks list group keeps its notes\' line order, or puts high priority first'
  },
  timelineRange: {
    section: 'view',
    tomlKey: 'timeline_range',
    comment: 'two-weeks | month | all: how far ahead the Timeline panel reaches; overdue tasks always show'
  },
  kanbanFolderRoot: {
    section: 'view',
    tomlKey: 'kanban_folder_root',
    comment:
      'folder board: group by the children of this folder, e.g. "Projects" (deeper notes roll up, notes outside it share one column); "" = each note\'s own folder'
  }
}

/** A list-valued portable pref rendered as an inline TOML array of strings
 *  under a `[section]`, always emitted (even when empty) with an inline comment
 *  so the ordered list is self-documenting. */
interface ListFieldMap {
  section: string
  tomlKey: string
  comment: string
}

// List (ordered string[]) portable prefs → [section].key = ["a", "b"].
const LIST_FIELDS: Partial<Record<PortablePrefKey, ListFieldMap>> = {
  externalApplicationSchemes: {
    section: 'editor',
    tomlKey: 'external_application_schemes',
    comment: 'application links enabled for opening, e.g. ["zotero", "obsidian", "vscode"]'
  },
  ignoredKeys: {
    section: 'editor',
    tomlKey: 'ignored_keys',
    comment:
      'keys the app ignores entirely, by DOM key or code, e.g. ["KanaMode"] for the no-op a Kanata/QMK tap-hold layer sends with every keystroke'
  },
  kanbanStatuses: {
    section: 'view',
    tomlKey: 'kanban_statuses',
    comment: 'custom-status Kanban columns in order, e.g. ["backlog", "in_progress", "review", "done"]'
  },
  hiddenWorkflowPresets: {
    section: 'view',
    tomlKey: 'hidden_workflow_presets',
    comment: 'built-in workflow recipe ids hidden from the gallery, e.g. ["reading-log"]'
  }
}

/** A map-valued portable pref rendered as its own TOML table of string→string,
 *  always emitted (even when empty) with a header comment + example so users
 *  can discover the format. */
interface MapTableField {
  table: string
  /** Lines of `#` comment shown above the table header. */
  comment: string[]
  /** Example entry shown as a commented line. */
  example: string
}

const MAP_TABLE_FIELDS: Partial<Record<PortablePrefKey, MapTableField>> = {
  keymapOverrides: {
    table: 'keymaps',
    comment: [
      'Keymap overrides. Only list the bindings you want to change.',
      'Set a binding to "" to remove the key entirely.',
      'Find the full list of action IDs in Settings → Keymaps.'
    ],
    example: '"global.searchNotes" = "Mod+P"'
  },
  systemFolderLabels: {
    table: 'folder_labels',
    comment: ['Display-name overrides for the built-in folders (inbox, quick, archive, trash).'],
    example: 'inbox = "Notes"'
  },
  kanbanColumnTitles: {
    table: 'kanban_column_titles',
    comment: ['Kanban column title overrides, keyed by "<groupBy>:<columnId>".'],
    example: '"status:todo" = "To Do"'
  },
  enabledOverrides: {
    table: 'overrides',
    comment: ['Enabled CSS overrides. List the filenames you want active.'],
    example: '"focus.css" = "on"'
  },
  themeTweaks: {
    table: 'tweaks',
    comment: ['Visual color tweaks from Settings → Appearance (token slug = color).'],
    example: '"accent" = "#ff3b30"'
  },
  textReplacements: {
    table: 'text_replacements',
    comment: ['Text replacements expanded while typing, keyed by trigger.'],
    example: '"->" = "→"'
  },
  savedTaskFilters: {
    table: 'saved_filters',
    comment: [
      'Saved Tasks filters: a name you pick = the filter query it stands for.',
      'Recall one from the chips above the task list, the command palette,',
      'or `:filter <name>` in the Tasks view; `:savefilter <name>` adds one.'
    ],
    example: '"Project alpha" = "@project:alpha"'
  }
}

// Prefs whose value can legitimately be null. TOML has no null, so we persist
// these as an empty string and convert back on read.
const NULLABLE_FIELDS: ReadonlySet<PortablePrefKey> = new Set<PortablePrefKey>([
  'ripgrepBinaryPath',
  'fzfBinaryPath',
  'interfaceFont',
  'textFont',
  'monoFont',
  'quickNoteTitlePrefix'
])

const FILE_HEADER = `# ZenNotes configuration
# Docs: https://github.com/ZenNotes/zennotes
#
# Holds your portable preferences (theme, editor, vim, keymaps, …) so you can
# sync them across machines with git, stow, chezmoi, and friends. Managed by
# ZenNotes but safe to hand-edit: changes apply live, no restart needed.
#
# Every available option is listed below with its current value; the inline
# comment shows the allowed values. Edit a value to customize it. ZenNotes
# keeps this list complete, so a removed option reappears with its default.
# Note: comments you add yourself may be dropped when the app rewrites the file.

`

function isMissingFileError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

// ---------------------------------------------------------------------------
// Path resolution (cross-platform, XDG-aware)
// ---------------------------------------------------------------------------

/** Resolve the config directory, honoring overrides in priority order:
 *  $ZENNOTES_CONFIG_DIR → $XDG_CONFIG_HOME/zennotes → platform default. */
export function getConfigDir(): string {
  const explicit = process.env.ZENNOTES_CONFIG_DIR?.trim()
  if (explicit) return explicit

  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return path.join(xdg, 'zennotes')

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    const base = appData || path.join(app.getPath('home'), 'AppData', 'Roaming')
    return path.join(base, 'zennotes')
  }

  // Linux + macOS: ~/.config/zennotes (the issue explicitly asks for this on
  // macOS too, rather than ~/Library/Application Support).
  return path.join(app.getPath('home'), '.config', 'zennotes')
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), CONFIG_FILE_NAME)
}

// ---------------------------------------------------------------------------
// TOML (de)serialization
// ---------------------------------------------------------------------------

/** Render a single TOML value (basic string / int / float / bool). */
function tomlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  const s = typeof value === 'string' ? value : String(value ?? '')
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
}

/** Render an inline TOML array of strings, e.g. `["a", "b"]`. */
function tomlArray(values: string[]): string {
  return `[${values.map((v) => tomlValue(v)).join(', ')}]`
}

/** Bare key when it's a simple identifier, otherwise a quoted key (e.g. a
 *  KeymapId like "global.searchNotes" or a "status:todo" column id). */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key)
    ? key
    : `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Build the TOML document text from a portable config object. Always emits
 * every option (filling unset ones from defaults) with an inline comment, plus
 * the map tables with format examples, so the file documents itself.
 */
export function serializeConfig(portable: AppConfigPortable): string {
  const lines: string[] = [`config_version = ${CONFIG_VERSION}`]
  const scalarKeys = Object.keys(SCALAR_FIELDS) as PortablePrefKey[]

  const listKeys = Object.keys(LIST_FIELDS) as PortablePrefKey[]

  for (const section of SECTION_ORDER) {
    const keys = scalarKeys.filter((key) => SCALAR_FIELDS[key]?.section === section)
    const sectionListKeys = listKeys.filter((key) => LIST_FIELDS[key]?.section === section)
    if (keys.length === 0 && sectionListKeys.length === 0) continue
    lines.push('', `[${section}]`)
    for (const key of keys) {
      const map = SCALAR_FIELDS[key]
      if (!map) continue
      let value = Object.prototype.hasOwnProperty.call(portable, key)
        ? portable[key]
        : PORTABLE_DEFAULTS[key]
      if (value === undefined) value = PORTABLE_DEFAULTS[key]
      // TOML has no null — nullable fields persist as "".
      if (value === null) value = NULLABLE_FIELDS.has(key) ? '' : PORTABLE_DEFAULTS[key]
      lines.push(`${map.tomlKey} = ${tomlValue(value)}  # ${map.comment}`)
    }
    for (const key of sectionListKeys) {
      const map = LIST_FIELDS[key]
      if (!map) continue
      const raw = Object.prototype.hasOwnProperty.call(portable, key)
        ? portable[key]
        : PORTABLE_DEFAULTS[key]
      const arr = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
      lines.push(`${map.tomlKey} = ${tomlArray(arr)}  # ${map.comment}`)
    }
  }

  lines.push(...keymapSectionLines(portable.keymapOverrides))

  for (const key of Object.keys(MAP_TABLE_FIELDS) as PortablePrefKey[]) {
    if (key === 'keymapOverrides') continue // emitted with its full reference above
    const def = MAP_TABLE_FIELDS[key]
    if (!def) continue
    lines.push('')
    for (const line of def.comment) lines.push(`# ${line}`)
    lines.push(`# Example: ${def.example}`)
    lines.push(`[${def.table}]`)
    const value = portable[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entryValue === 'string') {
          lines.push(`${tomlKey(entryKey)} = ${tomlValue(entryValue)}`)
        }
      }
    }
  }

  return FILE_HEADER + lines.join('\n') + '\n'
}

/** Build the `[keymaps]` block: active overrides followed by every action's
 *  default binding as a commented, grouped reference so users can discover and
 *  uncomment what they want to remap. */
function keymapSectionLines(rawOverrides: unknown): string[] {
  const overrides: Record<string, string> = {}
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (typeof value === 'string') overrides[key] = value
    }
  }

  const lines = [
    '',
    '# Keymap overrides. Add or uncomment "<action.id>" = "<binding>" lines.',
    '# Binding syntax: "Mod+P" = Cmd/Ctrl+P, "Shift+Mod+K", "Ctrl+W", "Space",',
    '# or a two-key sequence like "g g". Uncomment a reference line to remap it.',
    '# An empty binding ("") removes the key entirely: nothing triggers that',
    '# action until you give it a key again or delete the line.',
    '[keymaps]'
  ]

  for (const [key, value] of Object.entries(overrides)) {
    const line = `${tomlKey(key)} = ${tomlValue(value)}`
    lines.push(value === '' ? `${line}  # unbound` : line)
  }

  // The reference must render the same bytes on every OS. Launch rewrites the
  // file whenever its canonical text differs, so a reference built from this
  // platform's defaults made a config synced between a Mac and a Linux box
  // flip back and forth on every launch (#901). Each line shows the
  // cross-platform default and notes the Mac one where it differs.
  lines.push(
    '',
    '# --- All actions (defaults shown; uncomment + edit to override) ---',
    '# A "(macOS: ...)" note marks an action whose Mac default differs.'
  )
  for (const group of KEYMAP_GROUP_ORDER) {
    const entries = KEYMAP_CATALOG.filter(
      (entry) => entry.group === group && !(entry.id in overrides)
    )
    if (entries.length === 0) continue
    lines.push(`# ${KEYMAP_GROUP_LABELS[group] ?? group}`)
    for (const entry of entries) {
      const mac =
        entry.defaultBindingMac !== undefined && entry.defaultBindingMac !== entry.defaultBinding
          ? ` (macOS: ${tomlValue(entry.defaultBindingMac)})`
          : ''
      lines.push(
        `# ${tomlKey(entry.id)} = ${tomlValue(entry.defaultBinding)}  # ${entry.title}${mac}`
      )
    }
  }

  return lines
}

/** Parse TOML text into a portable config object plus its version. Throws on
 *  malformed TOML — callers fall back to the last good config. */
export function deserializeConfig(text: string): { version: number; portable: AppConfigPortable } {
  const parsed = parseToml(text) as Record<string, unknown>
  const version =
    typeof parsed.config_version === 'number' ? parsed.config_version : 0
  const portable: AppConfigPortable = {}

  for (const [key, map] of Object.entries(SCALAR_FIELDS)) {
    if (!map) continue
    const section = parsed[map.section]
    if (!section || typeof section !== 'object') continue
    const raw = (section as Record<string, unknown>)[map.tomlKey]
    if (raw === undefined) continue
    if (NULLABLE_FIELDS.has(key as PortablePrefKey) && raw === '') {
      portable[key as PortablePrefKey] = null
      continue
    }
    portable[key as PortablePrefKey] = raw
  }

  for (const [key, def] of Object.entries(MAP_TABLE_FIELDS)) {
    if (!def) continue
    const value = parsed[def.table]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      portable[key as PortablePrefKey] = value
    }
  }

  for (const [key, map] of Object.entries(LIST_FIELDS)) {
    if (!map) continue
    const section = parsed[map.section]
    if (!section || typeof section !== 'object') continue
    const raw = (section as Record<string, unknown>)[map.tomlKey]
    if (!Array.isArray(raw)) continue
    portable[key as PortablePrefKey] = raw.filter((v): v is string => typeof v === 'string')
  }

  return { version, portable: migrateConfig(version, portable) }
}

/** Forward-migrate an older config layout. No migrations needed yet (v1). */
function migrateConfig(_version: number, portable: AppConfigPortable): AppConfigPortable {
  return portable
}

// ---------------------------------------------------------------------------
// Cache + persistence + watching
// ---------------------------------------------------------------------------

let cache: AppConfigPortable = {}
// Exact text of the last config we read or wrote. The watcher compares the
// file's current text against this to ignore our own writes (loop-guard) and
// no-op rewrites.
let lastKnownText: string | null = null
let onChangeCb: ((next: AppConfigPortable) => void) | null = null
let watcher: FSWatcher | null = null
let writeQueue: Promise<void> = Promise.resolve()

// Texts we've written ourselves. The watcher's loop-guard compares the file
// against `lastKnownText` (our latest write), but with two setPortableConfig
// calls in a row the watcher can read the file around the second write and see
// the FIRST (a Windows CI flake). Treating that stale read as an edit clobbered
// the freshly-merged in-memory cache and reverted settings to their defaults.
// Bounded so it can't grow unbounded.
const ownWrites = new Set<string>()
const MAX_OWN_WRITES = 16
function rememberOwnWrite(text: string): void {
  ownWrites.add(text)
  while (ownWrites.size > MAX_OWN_WRITES) {
    const oldest = ownWrites.values().next().value
    if (oldest === undefined) break
    ownWrites.delete(oldest)
  }
}

// A stale read can only happen while our writes are landing, so an earlier
// own-write counts as one only then: during a write, or briefly after the last
// one, for a read that began before it finished. Outside that window the same
// text is someone putting it back (a hand edit, a dotfile sync), and the file
// wins. Remembering the texts forever swallowed exactly that edit.
const OWN_WRITE_SETTLE_MS = 1500
let ownWritesInFlight = 0
let ownWritesSettledAt = 0
let recheckTimer: ReturnType<typeof setTimeout> | null = null

function ownWritesSettling(): boolean {
  return ownWritesInFlight > 0 || Date.now() - ownWritesSettledAt < OWN_WRITE_SETTLE_MS
}

/** writeFileAtomic for a text this module wrote, counted while it lands. */
async function writeOwnText(text: string): Promise<void> {
  ownWritesInFlight += 1
  try {
    await writeFileAtomic(getConfigFilePath(), text)
  } finally {
    ownWritesInFlight -= 1
    ownWritesSettledAt = Date.now()
  }
}

function clearRecheck(): void {
  if (recheckTimer) clearTimeout(recheckTimer)
  recheckTimer = null
}

const WATCH_DEBOUNCE_MS = 150

async function readConfigFile(): Promise<{ text: string; portable: AppConfigPortable } | null> {
  const file = getConfigFilePath()
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isMissingFileError(err)) return null
    console.warn('Failed to read config.toml', err)
    return null
  }
  try {
    const { portable } = deserializeConfig(text)
    return { text, portable }
  } catch (err) {
    console.warn('Failed to parse config.toml, keeping last good config', err)
    return null
  }
}

function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
}

function startWatching(): void {
  const file = getConfigFilePath()
  watcher?.close().catch(() => {})
  clearRecheck()
  const active = chokidar.watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  watcher = active
  const handle = debounce(() => {
    void (async () => {
      const res = await readConfigFile()
      // A read that outlived its watcher answers for a file nobody watches.
      if (!res || watcher !== active) return
      // Our latest write, or a save that changed nothing: never fed back.
      if (res.text === lastKnownText) return
      // An earlier own-write while ours are still landing may be a stale read
      // (see OWN_WRITE_SETTLE_MS): look again once they settle. If the text is
      // still there then, nothing of ours explains it, and it applies below.
      if (ownWrites.has(res.text) && ownWritesSettling()) {
        clearRecheck()
        const wait =
          ownWritesInFlight > 0
            ? OWN_WRITE_SETTLE_MS
            : ownWritesSettledAt + OWN_WRITE_SETTLE_MS - Date.now()
        recheckTimer = setTimeout(() => {
          recheckTimer = null
          handle()
        }, Math.max(0, wait))
        return
      }
      cache = res.portable
      lastKnownText = res.text
      onChangeCb?.({ ...cache })
    })()
  }, WATCH_DEBOUNCE_MS)
  watcher.on('add', handle).on('change', handle)
  // Intentionally ignore 'unlink': a deleted config shouldn't wipe the live
  // settings; the next save recreates the file from the in-memory cache.
}

/**
 * Load the config from disk and begin watching it. Must run before the first
 * renderer window is created so the synchronous `getPortableConfigSnapshot()`
 * the preload reads at startup returns real data.
 */
export async function initAppConfig(
  onChange: (next: AppConfigPortable) => void
): Promise<void> {
  onChangeCb = onChange
  const res = await readConfigFile()
  if (res) {
    cache = res.portable
    // Normalize an existing file to the canonical, fully-documented form. Files
    // written by older versions (or hand-trimmed) may be missing options,
    // comments, or the example map tables — re-render so every option is shown.
    // The user's set values are preserved; only presentation/missing keys change.
    const canonical = serializeConfig(cache)
    if (canonical !== res.text) {
      lastKnownText = canonical
      rememberOwnWrite(canonical)
      try {
        await writeOwnText(canonical)
      } catch (err) {
        console.error('Failed to normalize config.toml', err)
        lastKnownText = res.text
      }
    } else {
      lastKnownText = res.text
    }
  } else {
    cache = {}
    lastKnownText = null
  }
  startWatching()
}

/** Synchronous snapshot for the preload's `sendSync` getter. */
export function getPortableConfigSnapshot(): AppConfigPortable {
  return { ...cache }
}

/** Merge a partial portable config into the cache and persist it atomically. */
export function setPortableConfig(partial: AppConfigPortable): Promise<void> {
  cache = { ...cache, ...partial }
  const text = serializeConfig(cache)
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      if (text === lastKnownText) return
      // Set before writing so the watcher event this triggers is recognized
      // as our own and ignored.
      lastKnownText = text
      rememberOwnWrite(text)
      try {
        await writeOwnText(text)
      } catch (err) {
        console.error('Failed to write config.toml', err)
      }
    })
  return writeQueue
}

/** Ensure the file exists on disk (writing the current cache if missing) and
 *  return its path. Used by the "Reveal config file" action. */
export async function ensureConfigFile(): Promise<string> {
  const file = getConfigFilePath()
  try {
    await fs.access(file)
  } catch {
    await setPortableConfig({})
  }
  return file
}

/** Test/teardown hook: stop the file watcher. */
export async function stopAppConfigWatcher(): Promise<void> {
  clearRecheck()
  await watcher?.close().catch(() => {})
  watcher = null
}
