import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron so app-config (and the writeFileAtomic it pulls in from
// vault.ts) can resolve a home dir without touching the real one. Path tests
// drive resolution through env vars, which take priority over app.getPath.
let homeDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home' || name === 'userData') return homeDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
    getName: () => 'ZenNotes'
  }
}))

// A gate on the atomic writer, so a test can hold one of the module's own
// writes mid-flight: the moment a watcher read can still observe the write
// before it. Every other write goes straight through.
const writeGate: { hold: Promise<void> | null } = { hold: null }
vi.mock('./vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vault')>()
  return {
    ...actual,
    writeFileAtomic: async (absPath: string, data: string): Promise<void> => {
      if (writeGate.hold) await writeGate.hold
      return actual.writeFileAtomic(absPath, data)
    }
  }
})

import {
  getConfigDir,
  getConfigFilePath,
  serializeConfig,
  deserializeConfig,
  initAppConfig,
  getPortableConfigSnapshot,
  setPortableConfig,
  ensureConfigFile,
  stopAppConfigWatcher
} from './app-config'
import { CONFIG_VERSION, PORTABLE_PREF_KEYS, type AppConfigPortable } from '@shared/app-config'
import { parse as parseToml } from 'smol-toml'

const tempDirs: string[] = []
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const ENV_KEYS = ['ZENNOTES_CONFIG_DIR', 'XDG_CONFIG_HOME', 'APPDATA'] as const
let savedEnv: Record<string, string | undefined> = {}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await delay(50)
  }
}

beforeEach(async () => {
  homeDir = await tmp('zen-home-')
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  writeGate.hold = null
  await stopAppConfigWatcher()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('config directory resolution', () => {
  it('honors $ZENNOTES_CONFIG_DIR above everything', () => {
    process.env.ZENNOTES_CONFIG_DIR = '/tmp/zen-custom'
    process.env.XDG_CONFIG_HOME = '/tmp/xdg'
    expect(getConfigDir()).toBe('/tmp/zen-custom')
  })

  it('uses $XDG_CONFIG_HOME/zennotes when set', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg'
    expect(getConfigDir()).toBe(path.join('/tmp/xdg', 'zennotes'))
  })

  it('falls back to a platform-native default', () => {
    if (process.platform === 'win32') {
      process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming'
      expect(getConfigDir()).toBe(path.join('C:\\Users\\test\\AppData\\Roaming', 'zennotes'))
    } else {
      expect(getConfigDir()).toBe(path.join(homeDir, '.config', 'zennotes'))
    }
    expect(getConfigFilePath().endsWith(path.join('zennotes', 'config.toml'))).toBe(true)
  })
})

describe('TOML serialization', () => {
  it('round-trips portable prefs, including nullable and map fields', () => {
    const portable: AppConfigPortable = {
      vimMode: false,
      vimWrappedLineMotions: 'logical',
      editorFontSize: 18,
      editorLineHeight: 1.6,
      themeFamily: 'nord',
      themeMode: 'dark',
      showWindowTitleBar: false,
      showStatusBar: false,
      autoPairs: false,
      autoPairQuotesInProse: true,
      showHeadingLevelLabels: true,
      editorTabSize: 2,
      textReplacementsEnabled: true,
      textReplacements: { '->': '→', '(c)': '©' },
      vaultTextSearchBackend: 'ripgrep',
      ripgrepBinaryPath: null,
      interfaceFont: null,
      quickNoteTitlePrefix: 'Quick Note',
      keymapOverrides: { 'global.searchNotes': 'Mod+P' },
      kanbanColumnTitles: { 'status:todo': 'To Do' },
      systemFolderLabels: { inbox: 'In' },
      savedTaskFilters: { 'Project alpha': '@project:alpha', Blocked: '@status:blocked' },
      kanbanGroupBy: 'folder',
      kanbanCardSort: 'due',
      kanbanLanes: 'field:sprint',
      hideEmptyTasks: false,
      kanbanWipLimits: { 'status:in-progress': 3, 'field:status:review': 2 },
      kanbanColumnColors: { 'status:in-progress': 'blue', 'field:status:done': 'green' },
      tasksListOrder: 'priority',
      timelineRange: 'month',
      gallerySort: 'title',
      galleryIncludeSubfolders: true,
      kanbanFolderRoot: 'Projects',
      externalApplicationSchemes: ['zotero', 'obsidian'],
      ignoredKeys: ['KanaMode', 'F24']
    }

    const text = serializeConfig(portable)
    expect(text).toContain(`config_version = ${CONFIG_VERSION}`)
    expect(text).toContain('[keymaps]')

    const { version, portable: round } = deserializeConfig(text)
    expect(version).toBe(CONFIG_VERSION)
    expect(round.vimMode).toBe(false)
    expect(round.vimWrappedLineMotions).toBe('logical')
    expect(round.editorFontSize).toBe(18)
    expect(round.editorLineHeight).toBeCloseTo(1.6)
    expect(round.themeFamily).toBe('nord')
    expect(text).toContain('show_window_title_bar = false')
    expect(round.showWindowTitleBar).toBe(false)
    // Piotr's status bar switch travels as [appearance].show_status_bar.
    expect(text).toMatch(/\[appearance\][^[]*show_status_bar = false/)
    expect(round.showStatusBar).toBe(false)
    expect(round.autoPairs).toBe(false)
    expect(round.autoPairQuotesInProse).toBe(true)
    expect(round.showHeadingLevelLabels).toBe(true)
    expect(round.editorTabSize).toBe(2)
    expect(round.textReplacementsEnabled).toBe(true)
    expect(round.textReplacements).toEqual({ '->': '→', '(c)': '©' })
    expect(round.vaultTextSearchBackend).toBe('ripgrep')
    expect(round.keymapOverrides).toEqual({ 'global.searchNotes': 'Mod+P' })
    expect(round.kanbanColumnTitles).toEqual({ 'status:todo': 'To Do' })
    expect(round.systemFolderLabels).toEqual({ inbox: 'In' })
    // The [saved_filters] table keeps the order the chips show (#731).
    expect(text).toContain('kanban_folder_root = "Projects"')
    expect(round.kanbanGroupBy).toBe('folder')
    expect(text).toContain('kanban_card_sort = "due"')
    expect(round.kanbanCardSort).toBe('due')
    // #1027: the lane field travels like the card order.
    expect(text).toContain('kanban_lanes = "field:sprint"')
    expect(round.kanbanLanes).toBe('field:sprint')
    // #1026 and #1025: the empty-task switch and the WIP limits travel too,
    // the limits as plain numbers a person can edit.
    expect(text).toContain('hide_empty_tasks = false')
    expect(round.hideEmptyTasks).toBe(false)
    expect(text).toMatch(/\[kanban_wip_limits\]\n"status:in-progress" = 3\n"field:status:review" = 2/)
    expect(round.kanbanWipLimits).toEqual({ 'status:in-progress': 3, 'field:status:review': 2 })
    // #1037: column colours travel as palette names, next to the titles.
    expect(text).toMatch(
      /\[kanban_column_colors\]\n"status:in-progress" = "blue"\n"field:status:done" = "green"/
    )
    expect(round.kanbanColumnColors).toEqual({
      'status:in-progress': 'blue',
      'field:status:done': 'green'
    })
    expect(text).toContain('tasks_list_order = "priority"')
    expect(round.tasksListOrder).toBe('priority')
    // The Timeline panel's reach travels as [view].timeline_range (#1007).
    expect(text).toMatch(/\[view\][^[]*timeline_range = "month"/)
    expect(round.timelineRange).toBe('month')
    // A folder Gallery's order and reach travel under [view] too.
    expect(text).toMatch(/\[view\][^[]*gallery_sort = "title"/)
    expect(text).toMatch(/\[view\][^[]*gallery_include_subfolders = true/)
    expect(round.gallerySort).toBe('title')
    expect(round.galleryIncludeSubfolders).toBe(true)
    expect(round.kanbanFolderRoot).toBe('Projects')
    expect(text).toContain('ignored_keys = ["KanaMode", "F24"]')
    expect(round.externalApplicationSchemes).toEqual(['zotero', 'obsidian'])
    expect(round.ignoredKeys).toEqual(['KanaMode', 'F24'])
    expect(text).toContain('[saved_filters]')
    expect(text).toContain('"Project alpha" = "@project:alpha"')
    expect(Object.entries(round.savedTaskFilters as Record<string, string>)).toEqual([
      ['Project alpha', '@project:alpha'],
      ['Blocked', '@status:blocked']
    ])
  })

  it('persists null as empty string and reads it back as null', () => {
    const text = serializeConfig({
      ripgrepBinaryPath: null,
      fzfBinaryPath: null,
      monoFont: null,
      quickNoteTitlePrefix: null
    })
    expect(text).toContain('quick_note_title_prefix = ""')
    const { portable } = deserializeConfig(text)
    expect(portable.ripgrepBinaryPath).toBeNull()
    expect(portable.fzfBinaryPath).toBeNull()
    expect(portable.monoFont).toBeNull()
    // A cleared Quick Note prefix stays cleared across machines (#1008).
    expect(portable.quickNoteTitlePrefix).toBeNull()
  })

  it('always lists every option with allowed-value comments, even from empty input', () => {
    const text = serializeConfig({})
    // Scalars present with values + inline allowed-value comments.
    expect(text).toContain('theme_mode = "dark"  # light | dark | auto')
    expect(text).toContain('backend = "auto"  # auto | builtin | ripgrep | fzf')
    expect(text).toContain('font_size = 16')
    expect(text).toContain('auto_pairs = true  # auto-insert matching [] () and {} while typing')
    expect(text).toContain(
      'auto_pair_quotes_in_prose = false  # also auto-insert matching quotes outside Markdown code'
    )
    expect(text).toContain('[vim]')
    expect(text).toContain(
      'wrapped_line_motions = "display"  # display | logical: how $, I, A and dependent operators treat soft-wrapped lines'
    )
    expect(text).toContain('[view]')
    // Keymaps: every action listed as a commented, grouped default reference.
    expect(text).toContain('[keymaps]')
    expect(text).toContain('# Global')
    expect(text).toContain('# Vim')
    expect(text).toContain('# "global.searchNotes" = "Mod+P"  # Search notes')
    // Other map tables always shown with a format example, even when empty.
    expect(text).toContain('[folder_labels]')
    expect(text).toContain('# Example: inbox = "Notes"')
    expect(text).toContain('[kanban_column_titles]')
    expect(text).toContain('[tweaks]')
    expect(text).toContain('[text_replacements]')
    expect(text).toContain('# Example: "->" = "→"')
    // And it must still parse back cleanly to the defaults.
    const { portable } = deserializeConfig(text)
    expect(portable.themeMode).toBe('dark')
    expect(portable.editorFontSize).toBe(16)
    expect(portable.ripgrepBinaryPath).toBeNull()
  })

  // `keepViewModeAcrossNotes` sat in PORTABLE_PREF_KEYS for months with no
  // field mapping, so it was "portable" in name only and never reached the
  // file. Every portable key has to come back out of a freshly written config.
  it('maps every portable preference into the file, so none stays on one machine', () => {
    const { portable } = deserializeConfig(serializeConfig({}))
    expect(PORTABLE_PREF_KEYS.filter((key) => !(key in portable))).toEqual([])
  })

  it('carries both keep-across-notes preferences', () => {
    const text = serializeConfig({ keepPanelsAcrossNotes: false, keepViewModeAcrossNotes: true })
    expect(text).toContain('keep_panels_across_notes = false')
    expect(text).toContain('keep_view_mode_across_notes = true')
    const { portable } = deserializeConfig(text)
    expect(portable.keepPanelsAcrossNotes).toBe(false)
    expect(portable.keepViewModeAcrossNotes).toBe(true)
  })

  it('round-trips visual tweaks (colors + sliders) through the [tweaks] table', () => {
    const tweaks = { accent: '#ff3b30', density: 'comfortable', cornerRadius: 'rounded' }
    const text = serializeConfig({ themeTweaks: tweaks })
    expect(text).toContain('[tweaks]')
    expect(text).toContain('"#ff3b30"')
    expect(deserializeConfig(text).portable.themeTweaks).toEqual(tweaks)
  })
})

describe('persistence + cache', () => {
  it('writes to disk and reflects the merge in the snapshot', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-')
    await initAppConfig(() => {})

    await setPortableConfig({ themeMode: 'light', editorFontSize: 20 })
    await setPortableConfig({ vimMode: false })

    const snap = getPortableConfigSnapshot()
    expect(snap.editorFontSize).toBe(20)
    expect(snap.themeMode).toBe('light')
    expect(snap.vimMode).toBe(false)

    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text).toContain('font_size = 20')
    expect(deserializeConfig(text).portable.themeMode).toBe('light')
  })

  it('does not let a stale watcher read of an earlier own-write clobber the cache', async () => {
    // Regression for a Windows CI flake: with two writes in a row, the watcher
    // can read the file while the second is still landing and see the FIRST.
    // With only a single-value loop-guard that read counted as an external
    // edit and reverted the freshly-merged cache.
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-stale-')
    const changes: AppConfigPortable[] = []
    await initAppConfig((next) => changes.push(next))

    await setPortableConfig({ editorFontSize: 18 })
    const earlierText = await readFile(getConfigFilePath(), 'utf8')
    // Let that write settle, so only the second one being in flight is what
    // makes the read below stale.
    await delay(1800)

    // Hold the second write mid-flight, and let the watcher read the file
    // meanwhile: it still holds the earlier own-write.
    let release = (): void => {}
    writeGate.hold = new Promise<void>((resolve) => (release = resolve))
    const second = setPortableConfig({ editorFontSize: 22 })
    await writeFile(getConfigFilePath(), earlierText)
    await delay(800)
    expect(getPortableConfigSnapshot().editorFontSize).toBe(22)

    writeGate.hold = null
    release()
    await second
    // Past the settle window the file holds the newer write, so the re-check
    // finds nothing to apply either.
    await delay(2500)
    expect(getPortableConfigSnapshot().editorFontSize).toBe(22)
    expect(changes).toHaveLength(0)
    expect(await readFile(getConfigFilePath(), 'utf8')).toContain('font_size = 22')
  }, 10000)

  it('ensureConfigFile creates the file when missing', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg2-')
    await initAppConfig(() => {})
    const file = await ensureConfigFile()
    await expect(access(file)).resolves.toBeUndefined()
  })

  it('loads an existing file at init', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg3-')
    await writeFile(getConfigFilePath(), serializeConfig({ editorFontSize: 24 }), 'utf8')
    await initAppConfig(() => {})
    expect(getPortableConfigSnapshot().editorFontSize).toBe(24)
  })

  it('upgrades an old sparse file on init, preserving the user values', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg5-')
    // Old-format file: values but no inline comments and no map-table sections.
    const sparse = 'config_version = 1\n\n[appearance]\ntheme_mode = "light"\n\n[editor]\nfont_size = 19\n'
    await writeFile(getConfigFilePath(), sparse, 'utf8')

    await initAppConfig(() => {})

    const upgraded = await readFile(getConfigFilePath(), 'utf8')
    // User values preserved, now with documentation comments.
    expect(upgraded).toContain('theme_mode = "light"  # light | dark | auto')
    expect(upgraded).toContain('font_size = 19')
    // Previously-missing options + example map tables now present.
    expect(upgraded).toContain('[vim]')
    expect(upgraded).toContain('[folder_labels]')
    expect(upgraded).toContain('# Example:')
    expect(getPortableConfigSnapshot().themeMode).toBe('light')
  })
})

describe('file watching', () => {
  it('applies a hand edit that puts back an earlier version of the file', async () => {
    // The user changes a setting in the app, then sets it back in config.toml:
    // the file is now byte for byte a text the app wrote before. It is still
    // the user's edit, and the file is the source of truth.
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-putback-')
    const changes: AppConfigPortable[] = []
    await initAppConfig((next) => changes.push(next))

    await setPortableConfig({ editorFontSize: 18 })
    const earlierText = await readFile(getConfigFilePath(), 'utf8')
    await setPortableConfig({ editorFontSize: 22 })
    await delay(2000)

    await writeFile(getConfigFilePath(), earlierText)
    await waitFor(() => changes.length > 0, 4000)
    expect(changes.at(-1)?.editorFontSize).toBe(18)
    expect(getPortableConfigSnapshot().editorFontSize).toBe(18)
  }, 10000)

  it('applies a put-back that lands while the app is still writing, once its writes settle', async () => {
    // Right after the app's own write, the watcher cannot tell a stale read of
    // that earlier text from the user putting it back. It waits for the writes
    // to settle and looks again; a text still in the file then is the user's.
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-putback-early-')
    const changes: AppConfigPortable[] = []
    await initAppConfig((next) => changes.push(next))

    await setPortableConfig({ editorFontSize: 18 })
    const earlierText = await readFile(getConfigFilePath(), 'utf8')
    await setPortableConfig({ editorFontSize: 22 })
    await writeFile(getConfigFilePath(), earlierText)

    // First read: possibly stale, so the cache holds.
    await delay(700)
    expect(getPortableConfigSnapshot().editorFontSize).toBe(22)
    // The re-check after the writes settle finds it still there.
    await waitFor(() => changes.length > 0, 6000)
    expect(changes.at(-1)?.editorFontSize).toBe(18)
    expect(getPortableConfigSnapshot().editorFontSize).toBe(18)
  }, 10000)

  it('notifies on external edits but not on its own writes', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg4-')
    const changes: AppConfigPortable[] = []
    await initAppConfig((next) => changes.push(next))

    // Our own write must not loop back through the watcher.
    await setPortableConfig({ editorFontSize: 14 })
    await delay(700)
    expect(changes).toHaveLength(0)

    // A genuine external edit (synced dotfile / hand-edit) should propagate.
    await writeFile(
      getConfigFilePath(),
      serializeConfig({ editorFontSize: 22, themeMode: 'light' }),
      'utf8'
    )
    await waitFor(() => changes.length > 0, 3000)
    expect(changes.at(-1)?.editorFontSize).toBe(22)
  }, 10000)
})

describe('unbound keymaps in config.toml', () => {
  it('writes an unbind as an empty binding, marks it, and reads it back as ""', () => {
    const text = serializeConfig({ keymapOverrides: { 'global.zoomIn': '' } })
    expect(text).toContain('"global.zoomIn" = ""  # unbound')
    // The reference list explains the convention and no longer repeats the
    // overridden action as a commented default.
    expect(text).toContain('# An empty binding ("") removes the key entirely')
    expect(text).not.toContain('# "global.zoomIn" = "Mod+="')

    const { portable } = deserializeConfig(text)
    expect(portable.keymapOverrides).toEqual({ 'global.zoomIn': '' })
  })
})

describe('keymap reference across platforms (#901)', () => {
  const realPlatform = process.platform
  const renderOn = (platform: NodeJS.Platform, portable: AppConfigPortable = {}): string => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      return serializeConfig(portable)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  }

  it('renders the same bytes on macOS, Linux and Windows, so a synced file stays put', () => {
    const portable: AppConfigPortable = { keymapOverrides: { 'global.searchNotes': 'Mod+K' } }
    const mac = renderOn('darwin', portable)
    expect(renderOn('linux', portable)).toBe(mac)
    expect(renderOn('win32', portable)).toBe(mac)
  })

  it('shows the cross-platform default and notes the Mac one where it differs', () => {
    const text = renderOn('darwin')
    expect(text).toContain('# "tabs.select1" = "Alt+1"  # Go to tab 1 (macOS: "Ctrl+1")')
    expect(text).toContain('# "global.toggleRecentNote" = "Mod+Tab"  # Switch to previous note (macOS: "Ctrl+Tab")')
    // An action with one default everywhere carries no note.
    expect(text).toContain('# "global.searchNotes" = "Mod+P"  # Search notes\n')
    // Every line is still a comment: the reference adds no binding.
    expect(deserializeConfig(text).portable.keymapOverrides ?? {}).toEqual({})
  })
})

describe('command keys in [keymaps.commands] (#971)', () => {
  it('round-trips command bindings, unbinds included, beside the action overrides', () => {
    const portable: AppConfigPortable = {
      keymapOverrides: { 'global.zoomIn': 'Mod+K' },
      commandKeymaps: { 'note.trash': 'Mod+Backspace', 'note.archive': 'Leader x a', 'note.restore': '' }
    }
    const text = serializeConfig(portable)
    expect(text).toContain('[keymaps.commands]\n"note.trash" = "Mod+Backspace"\n"note.archive" = "Leader x a"\n"note.restore" = ""  # unbound\n')
    const { portable: back } = deserializeConfig(text)
    expect(back.keymapOverrides).toEqual({ 'global.zoomIn': 'Mod+K' })
    expect(back.commandKeymaps).toEqual(portable.commandKeymaps)
    // Canonical: writing what was read gives the same bytes.
    expect(serializeConfig(back)).toBe(text)
  })

  it('lists every bindable command with its title, and only commented', () => {
    const text = serializeConfig({})
    expect(text).toContain('# "note.trash" = ""  # Note: Move Note to Trash\n')
    expect(text).toContain('# "note.favorite" = ""  # Note: Toggle Note Favorite\n')
    // The id that is also an action is listed in both, each in its own table.
    expect(text).toContain('# "nav.back" = ""  # Tabs: Go Back\n')
    expect(text).toContain('# "nav.back" = "h"  # Back out\n')
    // Runtime-made commands are not in the list.
    expect(text).not.toContain('"workflow.run.')
    const { portable } = deserializeConfig(text)
    expect(portable.commandKeymaps).toEqual({})
    expect(portable.keymapOverrides).toEqual({})
  })

  it('reads a command id written straight under [keymaps], and the next write moves it', () => {
    const handWritten = [
      'config_version = 1',
      '',
      '[keymaps]',
      '"global.zoomIn" = "Mod+K"',
      '"note.trash" = "Mod+Backspace"',
      '"nav.back" = "Ctrl+H"',
      ''
    ].join('\n')
    const { portable } = deserializeConfig(handWritten)
    // nav.back is an action id first: it stays the back-out action.
    expect(portable.keymapOverrides).toEqual({ 'global.zoomIn': 'Mod+K', 'nav.back': 'Ctrl+H' })
    expect(portable.commandKeymaps).toEqual({ 'note.trash': 'Mod+Backspace' })
    const rewritten = serializeConfig(portable)
    expect(rewritten).toContain('[keymaps.commands]\n"note.trash" = "Mod+Backspace"\n')
    expect(rewritten.split('[keymaps.commands]')[0]).not.toMatch(/^"note\.trash"/m)
  })

  it('lets the canonical table win over a stray line for the same command', () => {
    const text = [
      '[keymaps]',
      '"note.trash" = "F6"',
      '',
      '[keymaps.commands]',
      '"note.trash" = "Mod+Backspace"',
      ''
    ].join('\n')
    expect(deserializeConfig(text).portable.commandKeymaps).toEqual({ 'note.trash': 'Mod+Backspace' })
  })

  it('renders the same bytes on every OS', () => {
    const realPlatform = process.platform
    const portable: AppConfigPortable = { commandKeymaps: { 'note.trash': 'Mod+Backspace' } }
    const renders = (['darwin', 'linux', 'win32'] as const).map((platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      try {
        return serializeConfig(portable)
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      }
    })
    expect(new Set(renders).size).toBe(1)
  })

  it('moves a bare command id into its table when the app opens the file', async () => {
    const dir = await tmp('zen-cfg-')
    process.env.ZENNOTES_CONFIG_DIR = dir
    await writeFile(
      getConfigFilePath(),
      'config_version = 1\n\n[keymaps]\n"note.trash" = "Mod+Backspace"\n',
      'utf8'
    )
    await initAppConfig(() => {})
    expect(getPortableConfigSnapshot().commandKeymaps).toEqual({ 'note.trash': 'Mod+Backspace' })
    const onDisk = await readFile(getConfigFilePath(), 'utf8')
    expect(onDisk).toContain('[keymaps.commands]\n"note.trash" = "Mod+Backspace"\n')
    expect(onDisk.split('[keymaps.commands]')[0]).not.toMatch(/^"note\.trash"/m)
  })
})

// zn, the terminal app, reads config.toml too and keeps settings of its own
// there. The app rebuilt the file from the options it knows, so zn's
// [terminal] table and keys like [vim] motions vanished at every launch and
// every settings change.
describe('settings the app does not write, for zn', () => {
  const sharedFile = [
    'config_version = 1',
    'zn_only = "kept"  # a root key only zn reads',
    '',
    '[vim]',
    'enabled = false',
    '# zn: vim | helix',
    'motions = "helix"  # Helix-style selections in zn tui',
    '',
    '[editor]',
    'font_size = 19',
    '',
    '[keymaps]',
    '"global.searchNotes" = "Mod+K"',
    '',
    '# zn tui only',
    '[terminal]',
    '# preview_style is a Glamour style name, or "zen"',
    'preview_style = "dracula"',
    'mouse = false',
    'banner = """',
    '[not.a.table]',
    'just text"""',
    'images = [',
    '  "kitty",  # first choice',
    '  "off",',
    ']',
    '  [terminal.view_mode_rules]',
    '    "page-status=done" = "preview"',
    '',
    '[[terminal.profiles]]',
    'name = "work"',
    ''
  ].join('\n')

  const terminalBlock = [
    '# zn tui only',
    '[terminal]',
    '# preview_style is a Glamour style name, or "zen"',
    'preview_style = "dracula"',
    'mouse = false',
    'banner = """',
    '[not.a.table]',
    'just text"""',
    'images = [',
    '  "kitty",  # first choice',
    '  "off",',
    ']'
  ].join('\n')

  const sharedTerminal = {
    preview_style: 'dracula',
    mouse: false,
    banner: '[not.a.table]\njust text',
    images: ['kitty', 'off'],
    view_mode_rules: { 'page-status=done': 'preview' },
    profiles: [{ name: 'work' }]
  }

  it('keeps them through a launch, as written, comments included', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-')
    await writeFile(getConfigFilePath(), sharedFile, 'utf8')
    await initAppConfig(() => {})

    const snap = getPortableConfigSnapshot()
    expect(snap.vimMode).toBe(false)
    expect(snap.editorFontSize).toBe(19)
    expect(snap.keymapOverrides).toEqual({ 'global.searchNotes': 'Mod+K' })

    const text = await readFile(getConfigFilePath(), 'utf8')
    // The file is the app's canonical one again, every option documented...
    expect(text).toContain('theme_mode = "dark"  # light | dark | auto')
    // ...with zn's tables after its own, as they were written.
    expect(text).toContain(`${terminalBlock}\n\n  [terminal.view_mode_rules]\n    "page-status=done" = "preview"\n\n[[terminal.profiles]]\nname = "work"\n`)
    expect(text.indexOf('# zn tui only')).toBeGreaterThan(text.indexOf('[saved_filters]'))
    // A key zn keeps in a table the app writes stays in that table, with its comments.
    expect(text).toMatch(
      /\n\[vim\]\n(?:[a-z_]+ = .*\n)+# zn: vim \| helix\nmotions = "helix"  # Helix-style selections in zn tui\n/
    )
    expect(text).toContain('config_version = 1\nzn_only = "kept"  # a root key only zn reads\n')

    const parsed = parseToml(text) as Record<string, any>
    expect(parsed.terminal).toEqual(sharedTerminal)
    expect(parsed.vim.motions).toBe('helix')
    expect(parsed.zn_only).toBe('kept')

    // The next launch finds nothing to change: no rewrite on every start.
    await stopAppConfigWatcher()
    await initAppConfig(() => {})
    expect(await readFile(getConfigFilePath(), 'utf8')).toBe(text)
  })

  it('keeps them when a setting changes in the app', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-set-')
    await writeFile(getConfigFilePath(), sharedFile, 'utf8')
    await initAppConfig(() => {})

    await setPortableConfig({ editorFontSize: 22, vimMode: true })

    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text).toContain('font_size = 22')
    expect(text).toContain(terminalBlock)
    const parsed = parseToml(text) as Record<string, any>
    expect(parsed.vim).toMatchObject({ enabled: true, motions: 'helix' })
    expect(parsed.terminal).toEqual(sharedTerminal)
  })

  it('keeps what zn saved after the app last read the file', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-race-')
    await writeFile(getConfigFilePath(), serializeConfig({ editorFontSize: 18 }), 'utf8')
    await initAppConfig(() => {})

    // zn's writer (BurntSushi/toml) sorts keys, indents, and drops comments.
    // A settings change lands before the watcher has read this.
    await writeFile(
      getConfigFilePath(),
      [
        'config_version = 1',
        '',
        '[editor]',
        '  font_size = 18',
        '',
        '[terminal]',
        '  math = "latex"',
        '  view_mode_field = "view-mode"',
        '  [terminal.view_mode_rules]',
        '    "page-status=done" = "preview"',
        '',
        '[vim]',
        '  enabled = true',
        ''
      ].join('\n'),
      'utf8'
    )
    await setPortableConfig({ themeMode: 'light' })

    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text).toContain('theme_mode = "light"')
    expect(text).toContain(
      '[terminal]\n  math = "latex"\n  view_mode_field = "view-mode"\n\n  [terminal.view_mode_rules]\n    "page-status=done" = "preview"\n'
    )
  })

  it('still loads when a table it does not use is broken, and leaves that table for zn', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-broken-')
    const broken = [
      'config_version = 1',
      '',
      '[editor]',
      'font_size = 19',
      '',
      '[terminal]',
      'mouse = yes',
      'math = "latex"',
      ''
    ].join('\n')
    expect(() => parseToml(broken)).toThrow()
    await writeFile(getConfigFilePath(), broken, 'utf8')

    await initAppConfig(() => {})
    expect(getPortableConfigSnapshot().editorFontSize).toBe(19)
    expect(await readFile(getConfigFilePath(), 'utf8')).toContain('[terminal]\nmouse = yes\nmath = "latex"\n')

    await setPortableConfig({ editorFontSize: 21 })
    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text).toContain('font_size = 21')
    expect(text).toContain('[terminal]\nmouse = yes\nmath = "latex"\n')
    // Fixing the typo by hand makes the file plain TOML again.
    expect(() => parseToml(text.replace('mouse = yes', 'mouse = true'))).not.toThrow()
  })

  it('keeps zn tables through the next save when the app options themselves are broken', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-own-broken-')
    await writeFile(
      getConfigFilePath(),
      'config_version = 1\n\n[editor]\nfont_size = 1 9\n\n[terminal]\nmouse = false\n',
      'utf8'
    )
    // As before: a typo in the app's own options leaves them unread.
    await initAppConfig(() => {})
    expect(getPortableConfigSnapshot()).toEqual({})

    await setPortableConfig({ editorFontSize: 20 })
    const parsed = parseToml(await readFile(getConfigFilePath(), 'utf8')) as Record<string, any>
    expect(parsed.editor.font_size).toBe(20)
    expect(parsed.terminal).toEqual({ mouse: false })
  })

  it('carries a dotted key into a table it writes as data, inside that table', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-dotted-')
    await writeFile(
      getConfigFilePath(),
      'config_version = 1\nvim.motions = "helix"\nterminal.mouse = false\n\n[editor]\nfont_size = 18\n',
      'utf8'
    )
    await initAppConfig(() => {})

    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text.match(/^\[vim\]$/gm)).toHaveLength(1)
    const parsed = parseToml(text) as Record<string, any>
    expect(parsed.vim.motions).toBe('helix')
    expect(parsed.terminal).toEqual({ mouse: false })
    expect(parsed.editor.font_size).toBe(18)
  })

  // The scan reads only the layout, so it must not take a bracket or a hash
  // inside a value for a table or a comment.
  it.each([
    [
      'literal strings',
      `[terminal]\na = 'C:\\path #not a comment [x]'\nb = "say \\"hi\\" # still the string"\nc = '''\n[not.a.table]\n# not a comment\n'''`
    ],
    ['a multi-line array', `[terminal]\nlist = [\n  "a]", # ]\n  'b[',\n  """c\n]""",\n]\nafter = 1`],
    [
      'headers with comments and quoted keys',
      `[ terminal ] # zn\nmouse = true\n\n[ terminal . "rules.x" ]  # sub\n"k=v" = 1`
    ],
    ['dates and special numbers', `[terminal]\nd = 1979-05-27T07:32:00Z\nt = 07:32:00\nf = inf\nn = nan\nh = 0xff`]
  ])('carries %s as written', async (_name, block) => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-shape-')
    await writeFile(getConfigFilePath(), `config_version = 1\n\n${block}\n`, 'utf8')
    await initAppConfig(() => {})
    await setPortableConfig({ editorLineHeight: 1.7 })
    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text.endsWith(`\n\n${block}\n`)).toBe(true)
    expect(() => parseToml(text)).not.toThrow()
  })

  it('lets an entry set in the app replace a carried one with the same key', async () => {
    process.env.ZENNOTES_CONFIG_DIR = await tmp('zen-cfg-zn-collide-')
    await writeFile(
      getConfigFilePath(),
      'config_version = 1\n\n[folder_labels]\ninbox = true\narchive = "Old"\n',
      'utf8'
    )
    await initAppConfig(() => {})
    // Not a string, so not a label the app writes: carried as it is.
    expect(await readFile(getConfigFilePath(), 'utf8')).toMatch(/\[folder_labels\]\narchive = "Old"\ninbox = true\n/)

    await setPortableConfig({ systemFolderLabels: { inbox: 'Notes', archive: 'Old' } })
    const text = await readFile(getConfigFilePath(), 'utf8')
    expect(text).not.toContain('inbox = true')
    expect((parseToml(text) as Record<string, any>).folder_labels).toEqual({
      inbox: 'Notes',
      archive: 'Old'
    })
  })
})
