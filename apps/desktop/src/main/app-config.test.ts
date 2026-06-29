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
import { CONFIG_VERSION, type AppConfigPortable } from '@shared/app-config'

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
      editorFontSize: 18,
      editorLineHeight: 1.6,
      themeFamily: 'nord',
      themeMode: 'dark',
      vaultTextSearchBackend: 'ripgrep',
      ripgrepBinaryPath: null,
      interfaceFont: null,
      quickNoteTitlePrefix: 'Quick Note',
      keymapOverrides: { 'global.searchNotes': 'Mod+P' },
      kanbanColumnTitles: { 'status:todo': 'To Do' },
      systemFolderLabels: { inbox: 'In' }
    }

    const text = serializeConfig(portable)
    expect(text).toContain(`config_version = ${CONFIG_VERSION}`)
    expect(text).toContain('[keymaps]')

    const { version, portable: round } = deserializeConfig(text)
    expect(version).toBe(CONFIG_VERSION)
    expect(round.vimMode).toBe(false)
    expect(round.editorFontSize).toBe(18)
    expect(round.editorLineHeight).toBeCloseTo(1.6)
    expect(round.themeFamily).toBe('nord')
    expect(round.vaultTextSearchBackend).toBe('ripgrep')
    expect(round.keymapOverrides).toEqual({ 'global.searchNotes': 'Mod+P' })
    expect(round.kanbanColumnTitles).toEqual({ 'status:todo': 'To Do' })
    expect(round.systemFolderLabels).toEqual({ inbox: 'In' })
  })

  it('persists null as empty string and reads it back as null', () => {
    const text = serializeConfig({ ripgrepBinaryPath: null, fzfBinaryPath: null, monoFont: null })
    const { portable } = deserializeConfig(text)
    expect(portable.ripgrepBinaryPath).toBeNull()
    expect(portable.fzfBinaryPath).toBeNull()
    expect(portable.monoFont).toBeNull()
  })

  it('always lists every option with allowed-value comments, even from empty input', () => {
    const text = serializeConfig({})
    // Scalars present with values + inline allowed-value comments.
    expect(text).toContain('theme_mode = "dark"  # light | dark | auto')
    expect(text).toContain('backend = "auto"  # auto | builtin | ripgrep | fzf')
    expect(text).toContain('font_size = 16')
    expect(text).toContain('[vim]')
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
    // And it must still parse back cleanly to the defaults.
    const { portable } = deserializeConfig(text)
    expect(portable.themeMode).toBe('dark')
    expect(portable.editorFontSize).toBe(16)
    expect(portable.ripgrepBinaryPath).toBeNull()
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
