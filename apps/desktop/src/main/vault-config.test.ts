import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron so vault.ts can compute a config path under our temp dir
// instead of touching the real ~/Library/Application Support/ZenNotes/.
let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
    getName: () => 'ZenNotes'
  }
}))

import { loadConfig, saveConfig, updateConfig } from './vault'

const tempDirs: string[] = []
const configFile = (): string => path.join(userDataDir, 'zennotes.config.json')
const backupFile = (): string => `${configFile()}.bak`

// `localVaults` entries go through `path.resolve()` in normalizePersistedConfig,
// which on Windows turns `/Users/test/MyVault` into `D:\Users\test\MyVault`.
// Resolve up front so expectations match across platforms.
const VAULT_A = path.resolve('/Users/test/MyVault')
const VAULT_B = path.resolve('/Users/test/AnotherVault')

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-cfg-'))
  tempDirs.push(userDataDir)
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('config persistence', () => {
  it('writes and reads back the same config', async () => {
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [{ root: VAULT_A, name: 'MyVault', lastOpenedAt: 100 }],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })

    const cfg = await loadConfig()
    expect(cfg.vaultRoot).toBe(VAULT_A)
    expect(cfg.localVaults).toHaveLength(1)
    expect(cfg.localVaults[0]?.root).toBe(VAULT_A)
  })

  it('returns defaults on first run (no config file)', async () => {
    const cfg = await loadConfig()
    expect(cfg.vaultRoot).toBeNull()
    expect(cfg.localVaults).toEqual([])
  })

  it('falls back to the backup when the primary file is corrupt', async () => {
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [{ root: VAULT_A, name: 'MyVault', lastOpenedAt: 100 }],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    // Second save triggers the rotation: the first config is copied to .bak,
    // then the new payload replaces the primary.
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_B,
      localVaults: [{ root: VAULT_B, name: 'AnotherVault', lastOpenedAt: 200 }],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    // Backup now holds the first config; corrupt the primary.
    await writeFile(configFile(), '{ not valid json', 'utf8')

    const cfg = await loadConfig()
    // We recovered from the backup, which has the FIRST saved config.
    expect(cfg.vaultRoot).toBe(VAULT_A)
  })

  it('refuses to clobber an unreadable primary when no backup exists', async () => {
    // Simulate a crash that left a half-written, parse-failing primary with
    // no backup yet (first launch crashed mid-write).
    await writeFile(configFile(), '{ "vaultRoot": "/Users/test/MyVault"', 'utf8')

    // updateConfig should NOT write a default config over the bad primary —
    // doing so would silently lose the user's vault path.
    await updateConfig((cfg) => ({ ...cfg, zoomFactor: 1.25 }))

    // Primary file untouched (the broken JSON is still there, awaiting a
    // human or recovery path — but at least we didn't make it worse).
    const raw = await readFile(configFile(), 'utf8')
    expect(raw).toBe('{ "vaultRoot": "/Users/test/MyVault"')
  })

  it('preserves vaultRoot across many small persistWindowState-style updates', async () => {
    // Save a config with a real vault, then simulate the
    // `persistWindowState` flow that only spreads `windowState` into a
    // re-read config many times. The vault path must survive.
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [{ root: VAULT_A, name: 'MyVault', lastOpenedAt: 100 }],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })

    for (let i = 0; i < 5; i += 1) {
      await updateConfig((cfg) => ({
        ...cfg,
        windowState: { x: i * 10, y: i * 10, width: 1200, height: 800, isMaximized: false }
      }))
    }

    const cfg = await loadConfig()
    expect(cfg.vaultRoot).toBe(VAULT_A)
    expect(cfg.localVaults).toHaveLength(1)
    expect(cfg.windowState).toEqual({ x: 40, y: 40, width: 1200, height: 800, isMaximized: false })
  })

  it('writes atomically — no half-written file is observable as the primary', async () => {
    // The atomic-write contract: any moment the primary file exists, it
    // parses. The temp file may exist alongside but never collides with
    // configPath().
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    const raw = await readFile(configFile(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('falls back to the backup when the primary is missing', async () => {
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    // Delete the primary — but the backup from the previous save survives.
    await rm(configFile())

    const cfg = await loadConfig()
    expect(cfg.vaultRoot).toBe(VAULT_A)
  })

  it('does not throw when chmod denies reads (silently degrades to defaults)', async () => {
    // This is the read path used by display callers — it tolerates a stale
    // view. Only updateConfig is strict.
    if (process.platform === 'win32') return // chmod semantics differ on Windows
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    await chmod(configFile(), 0o000)
    try {
      const cfg = await loadConfig()
      expect(cfg.vaultRoot).toBeNull() // tolerated as defaults
    } finally {
      await chmod(configFile(), 0o644)
    }
  })

  it('does not write a stale config when reading fails inside updateConfig', async () => {
    if (process.platform === 'win32') return
    // Seed a valid primary so we have something to "lose".
    await saveConfig({
      workspaceMode: 'local',
      vaultRoot: VAULT_A,
      localVaults: [{ root: VAULT_A, name: 'MyVault', lastOpenedAt: 100 }],
      remoteWorkspace: null,
      remoteWorkspaceProfileId: null,
      remoteWorkspaceProfiles: [],
      windowState: null,
      zoomFactor: 1,
      quickCaptureHotkey: 'CommandOrControl+Shift+Space',
      quickCapturePinned: false
    })
    // Corrupt the primary AND delete the backup so loadConfigSafely() must
    // return `readable: false` — the dangerous state where the old code
    // would silently overwrite the user's vault path.
    await writeFile(configFile(), 'corrupt', 'utf8')
    await rm(backupFile(), { force: true })

    await updateConfig((cfg) => ({
      ...cfg,
      windowState: { x: 0, y: 0, width: 100, height: 100, isMaximized: false }
    }))

    // Primary unchanged: the corrupt bytes still on disk. The win here is
    // that we did NOT replace them with a fresh "default" config — leaving
    // the corrupt file gives the user (or a future recovery path) a chance
    // to fix it manually.
    const raw = await readFile(configFile(), 'utf8')
    expect(raw).toBe('corrupt')
  })
})
