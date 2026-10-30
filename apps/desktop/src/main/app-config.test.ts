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
