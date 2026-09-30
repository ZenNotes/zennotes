// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VAULT_SETTINGS, type VaultSettings } from '@shared/ipc'

// A vault's display name (#692): saved into vault.json through the ordinary
// settings write, reflected on the open vault without treating it as a
// different vault, and offered only where a vault.json can be written.

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop', version: 'test' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      scanTasks: vi.fn().mockResolvedValue([]),
      scanTasksForPath: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      // Echo the save back the way main does: normalized by the bridge, so a
      // blank name comes back absent.
      setVaultSettings: vi.fn().mockImplementation(async (settings: VaultSettings) => {
        const { displayName, ...rest } = settings
        const trimmed = displayName?.trim()
        return trimmed ? { ...rest, displayName: trimmed } : rest
      }),
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined),
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined),
      ...overrides
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  const { useStore } = await import('./store')
  useStore.setState({
    vault: { root: '/Users/me/repos/acme/docs', name: 'docs' },
    workspaceMode: 'local',
    vaultSettings: DEFAULT_VAULT_SETTINGS,
    localVaults: [{ root: '/Users/me/repos/acme/docs', name: 'docs', lastOpenedAt: 1 }]
  } as never)
  return useStore
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('store.renameVault', () => {
  it('saves the name into vault.json, renames the open vault in place, and refreshes the remembered list', async () => {
    const useStore = await loadStore()
    const listLocalVaults = vi.fn().mockResolvedValue([
      { root: '/Users/me/repos/acme/docs', name: 'Acme API docs', lastOpenedAt: 1 }
    ])
    ;(window.zen as unknown as { listLocalVaults: unknown }).listLocalVaults = listLocalVaults
    useStore.setState({ closedTabStack: [{ path: 'inbox/A.md' }] } as never)

    expect(await useStore.getState().renameVault('  Acme   API docs ')).toBe(true)

    expect(window.zen.setVaultSettings).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Acme API docs' })
    )
    expect(useStore.getState().vaultSettings.displayName).toBe('Acme API docs')
    expect(useStore.getState().vault?.name).toBe('Acme API docs')
    expect(useStore.getState().vault?.root).toBe('/Users/me/repos/acme/docs')
    // The same vault: what it was holding is still there.
    expect(useStore.getState().closedTabStack).toHaveLength(1)
    expect(listLocalVaults).toHaveBeenCalled()
    expect(useStore.getState().localVaults[0].name).toBe('Acme API docs')
  })

  it('an empty name goes back to the folder name and leaves vault.json without the key', async () => {
    const useStore = await loadStore()
    useStore.setState({
      vault: { root: '/Users/me/repos/acme/docs', name: 'Acme API docs' },
      vaultSettings: { ...DEFAULT_VAULT_SETTINGS, displayName: 'Acme API docs' }
    } as never)

    expect(await useStore.getState().renameVault('   ')).toBe(true)

    const saved = (window.zen.setVaultSettings as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('displayName' in saved).toBe(false)
    expect(useStore.getState().vaultSettings.displayName).toBeUndefined()
    expect(useStore.getState().vault?.name).toBe('docs')
  })

  it('does not write when the name is unchanged, and refuses a temporary folder session', async () => {
    const useStore = await loadStore()
    useStore.setState({ vaultSettings: { ...DEFAULT_VAULT_SETTINGS, displayName: 'Acme API docs' } })
    expect(await useStore.getState().renameVault('Acme API docs')).toBe(true)
    expect(window.zen.setVaultSettings).not.toHaveBeenCalled()

    useStore.setState({ vault: { root: '/tmp/dropped', name: 'dropped', temporary: true } })
    expect(await useStore.getState().renameVault('Anything')).toBe(false)
    expect(window.zen.setVaultSettings).not.toHaveBeenCalled()
  })

  it('reports a failed save and keeps the old name', async () => {
    const useStore = await loadStore()
    ;(window.zen.setVaultSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('read-only'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await useStore.getState().renameVault('Acme API docs')).toBe(false)
    expect(useStore.getState().vault?.name).toBe('docs')
    errorSpy.mockRestore()
  })

  it('setVault treats a different name on the same root as the same vault', async () => {
    const useStore = await loadStore()
    useStore.setState({ closedTabStack: [{ path: 'inbox/A.md' }] } as never)
    useStore.getState().setVault({ root: '/Users/me/repos/acme/docs', name: 'Acme API docs' })
    expect(useStore.getState().closedTabStack).toHaveLength(1)
    useStore.getState().setVault({ root: '/Users/me/other', name: 'other' })
    expect(useStore.getState().closedTabStack).toHaveLength(0)
  })

  it('a host whose root is a label keeps the folder name it gave through every settings save', async () => {
    // The phone shells hand over a VaultInfo whose root reads
    // "On this device › ZenNotes › docs" and whose folderName is "docs".
    // Before folderName existed, the first settings save (a favorite toggled
    // is enough) renamed the vault to the whole label, because the fallback
    // took the root's last path segment and a label has none.
    const useStore = await loadStore()
    const phone = { root: 'On this device › ZenNotes › docs', name: 'docs', folderName: 'docs' }
    useStore.setState({ vault: phone } as never)

    await useStore.getState().setVaultSettings({ ...DEFAULT_VAULT_SETTINGS, favorites: ['inbox/a.md'] })
    expect(useStore.getState().vault?.name).toBe('docs')

    expect(await useStore.getState().renameVault('Acme API docs')).toBe(true)
    expect(useStore.getState().vault?.name).toBe('Acme API docs')

    expect(await useStore.getState().renameVault('')).toBe(true)
    expect(useStore.getState().vault?.name).toBe('docs')
  })

  it('an external vault.json change renames the open vault too', async () => {
    const useStore = await loadStore()
    ;(window.zen.getVaultSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_VAULT_SETTINGS,
      displayName: 'Renamed elsewhere'
    })
    await useStore.getState().applyChange({ kind: 'change', path: '.zennotes/vault.json', folder: 'inbox', scope: 'vault-settings' } as never)
    expect(useStore.getState().vault?.name).toBe('Renamed elsewhere')
  })
})

describe('renameVaultWithPrompt', () => {
  it('prefills the current name, names the folder, and saves the answer', async () => {
    const useStore = await loadStore()
    useStore.setState({ vaultSettings: { ...DEFAULT_VAULT_SETTINGS, displayName: 'Old name' } })
    const { renameVaultWithPrompt } = await import('./lib/rename-vault')
    const prompts = await import('./lib/prompt-requests')
    const renameVault = vi.fn(async () => true)
    useStore.setState({ renameVault } as never)

    const run = renameVaultWithPrompt()
    await new Promise((r) => setTimeout(r, 0))
    const request = prompts.getPromptRequest()
    expect(request?.options.initialValue).toBe('Old name')
    expect(request?.options.placeholder).toBe('docs')
    expect(request?.options.description).toContain('The folder stays docs on disk')
    expect(request?.options.allowEmptySubmit).toBe(true)
    prompts.settlePromptRequest(request!, 'Acme API docs')
    expect(await run).toBe(true)
    expect(renameVault).toHaveBeenCalledWith('Acme API docs')
  })

  it('a cancelled prompt saves nothing; an emptied one clears the name', async () => {
    const useStore = await loadStore()
    const { renameVaultWithPrompt } = await import('./lib/rename-vault')
    const prompts = await import('./lib/prompt-requests')
    const renameVault = vi.fn(async () => true)
    useStore.setState({ renameVault } as never)

    let run = renameVaultWithPrompt()
    await new Promise((r) => setTimeout(r, 0))
    prompts.settlePromptRequest(prompts.getPromptRequest()!, null)
    expect(await run).toBe(false)
    expect(renameVault).not.toHaveBeenCalled()

    run = renameVaultWithPrompt()
    await new Promise((r) => setTimeout(r, 0))
    prompts.settlePromptRequest(prompts.getPromptRequest()!, '')
    expect(await run).toBe(true)
    expect(renameVault).toHaveBeenCalledWith('')
  })

  it('is unavailable for a temporary folder session and a remote workspace', async () => {
    await loadStore()
    const { canRenameVault } = await import('./lib/rename-vault')
    expect(canRenameVault({ vault: { root: '/v', name: 'v' }, workspaceMode: 'local' })).toBe(true)
    expect(canRenameVault({ vault: { root: '/v', name: 'v', temporary: true }, workspaceMode: 'local' })).toBe(false)
    expect(canRenameVault({ vault: { root: '/v', name: 'v' }, workspaceMode: 'remote' })).toBe(false)
    expect(canRenameVault({ vault: null, workspaceMode: 'local' })).toBe(false)
  })
})

describe('the palette', () => {
  it('lists Rename Vault… for a local vault only', async () => {
    const useStore = await loadStore()
    const { buildCommands } = await import('./lib/commands')
    const ids = () => buildCommands().map((c) => c.id)
    expect(ids()).toContain('vault.rename')
    useStore.setState({ workspaceMode: 'remote' })
    expect(ids()).not.toContain('vault.rename')
    useStore.setState({ workspaceMode: 'local', vault: { root: '/tmp/x', name: 'x', temporary: true } })
    expect(ids()).not.toContain('vault.rename')
  })
})
