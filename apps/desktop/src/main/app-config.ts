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
const SECTION_ORDER = ['vim', 'search', 'editor', 'appearance', 'typography', 'view'] as const

// Scalar (string / number / boolean) portable prefs → [section].key (snake_case).
const SCALAR_FIELDS: Partial<Record<PortablePrefKey, ScalarFieldMap>> = {
  // vim
  vimMode: { section: 'vim', tomlKey: 'enabled', comment: 'true | false — CodeMirror Vim bindings' },
  vimInsertEscape: {
    section: 'vim',
    tomlKey: 'insert_escape',
    comment: 'key sequence to leave insert mode, e.g. "jk"; empty disables'
  },
  vimYankToClipboard: {
    section: 'vim',
    tomlKey: 'yank_to_clipboard',
    comment: 'also copy Vim yank/delete/change to the system clipboard'
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
  // editor
  livePreview: {
    section: 'editor',
    tomlKey: 'live_preview',
    comment: 'hide markdown syntax on inactive lines'
  },
  renderTablesInLivePreview: {
    section: 'editor',
    tomlKey: 'render_tables',
    comment: 'render tables as widgets in live preview; off keeps them as plain text'
  },
  markdownSnippets: {
    section: 'editor',
    tomlKey: 'markdown_snippets',
    comment: 'auto-close markdown delimiters while typing'
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
  editorLineHeight: { section: 'editor', tomlKey: 'line_height', comment: 'line-height multiplier' },
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
  themeFamily: {
    section: 'appearance',
    tomlKey: 'theme_family',
    comment:
      'apple | gruvbox | catppuccin | github | solarized | one | nord | tokyo-night | kanagawa | black-metal'
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
  showSidebarChevrons: {
    section: 'appearance',
    tomlKey: 'show_sidebar_chevrons',
    comment: 'show disclosure arrows in the sidebar'
  },
  contentAlign: { section: 'appearance', tomlKey: 'content_align', comment: 'center | left' },
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
  noteSortOrder: {
    section: 'view',
    tomlKey: 'note_sort_order',
    comment:
      'none | manual | updated-desc | updated-asc | created-desc | created-asc | name-asc | name-desc'
  },
  groupByKind: { section: 'view', tomlKey: 'group_by_kind', comment: 'group notes by kind in the list' },
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
  kanbanGroupBy: {
    section: 'view',
    tomlKey: 'kanban_group_by',
    comment: 'status | priority | folder'
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
      'Keymap overrides — only list the bindings you want to change.',
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
# ZenNotes but safe to hand-edit — changes apply live, no restart needed.
#
# Every available option is listed below with its current value; the inline
# comment shows the allowed values. Edit a value to customize it — ZenNotes
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

  for (const section of SECTION_ORDER) {
    const keys = scalarKeys.filter((key) => SCALAR_FIELDS[key]?.section === section)
    if (keys.length === 0) continue
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
    '[keymaps]'
  ]

  for (const [key, value] of Object.entries(overrides)) {
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
  }

  lines.push('', '# --- All actions (defaults shown; uncomment + edit to override) ---')
  for (const group of KEYMAP_GROUP_ORDER) {
    const entries = KEYMAP_CATALOG.filter(
      (entry) => entry.group === group && !(entry.id in overrides)
    )
    if (entries.length === 0) continue
    lines.push(`# ${KEYMAP_GROUP_LABELS[group] ?? group}`)
    for (const entry of entries) {
      lines.push(`# ${tomlKey(entry.id)} = ${tomlValue(entry.defaultBinding)}  # ${entry.title}`)
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
    console.warn('Failed to parse config.toml — keeping last good config', err)
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
  watcher = chokidar.watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  const handle = debounce(() => {
    void (async () => {
      const res = await readConfigFile()
      if (!res) return
      // Our own writes (and no-op saves) match lastKnownText — skip them so we
      // never feed our writes back into the renderer.
      if (res.text === lastKnownText) return
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
      try {
        await writeFileAtomic(getConfigFilePath(), canonical)
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
      try {
        await writeFileAtomic(getConfigFilePath(), text)
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
  await watcher?.close().catch(() => {})
  watcher = null
}
