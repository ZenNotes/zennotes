// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      closeVault: vi.fn(),
      openVaultWindow: vi.fn()
    }
  })
}

async function loadCommands() {
  vi.resetModules()
  localStorage.clear()
  return {
    ...(await import('../store')),
    ...(await import('./commands'))
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})

describe('vault commands', () => {
  it('exposes one switch-vault picker command', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({
      workspaceMode: 'local',
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      localVaults: [
        { root: '/Users/test/Notes', name: 'Notes', lastOpenedAt: 2 },
        { root: '/Users/test/Work', name: 'Work', lastOpenedAt: 1 }
      ]
    })

    const commands = buildCommands()
    const switchCommand = commands.find((cmd) => cmd.id === 'app.vault.switch')
    const closeCommand = commands.find((cmd) => cmd.id === 'app.vault.close')

    expect(switchCommand?.title).toBe('Switch Vault…')
    expect(closeCommand?.title).toBe('Close Current Vault')
    expect(commands.some((cmd) => cmd.id.startsWith('app.vault.local.'))).toBe(false)
  })

  it('keeps the switch-vault picker available for remote workspace profiles', async () => {
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
        getCapabilities: vi.fn().mockReturnValue({
          supportsUpdater: false,
          supportsNativeMenus: false,
          supportsFloatingWindows: false,
          supportsLocalFilesystemPickers: false,
          supportsRemoteWorkspace: true,
          supportsCliInstall: false,
          supportsCustomTemplates: false
        }),
        openVaultWindow: vi.fn()
      }
    })

    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({
      workspaceMode: 'remote',
      remoteWorkspaceProfiles: [
        {
          id: 'remote-1',
          name: 'Remote Notes',
          baseUrl: 'https://notes.example.com',
          hasCredential: true,
          vaultPath: '/team',
          lastConnectedAt: 1
        }
      ]
    })

    const commands = buildCommands()

    expect(commands.some((cmd) => cmd.id === 'app.vault.switch')).toBe(true)
  })
})

describe('built-in template commands (#112)', () => {
  it('offers Remove when built-ins show, and Restore once they are hidden', async () => {
    const { buildCommands, useStore } = await loadCommands()

    useStore.setState({ hideBuiltinTemplates: false })
    const shown = buildCommands()
    expect(shown.find((c) => c.id === 'template.removeBuiltins')?.title).toBe(
      'Remove Built-in Templates'
    )
    expect(shown.some((c) => c.id === 'template.restoreBuiltins')).toBe(false)

    useStore.setState({ hideBuiltinTemplates: true })
    const hidden = buildCommands()
    expect(hidden.find((c) => c.id === 'template.restoreBuiltins')?.title).toBe(
      'Restore Built-in Templates'
    )
    expect(hidden.some((c) => c.id === 'template.removeBuiltins')).toBe(false)
  })

  it('Restore brings the built-ins back (no confirmation)', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ hideBuiltinTemplates: true })
    await buildCommands()
      .find((c) => c.id === 'template.restoreBuiltins')
      ?.run()
    expect(useStore.getState().hideBuiltinTemplates).toBe(false)
  })
})

describe('close-tab command shortcut', () => {
  // #242: in Vim mode Ctrl+W is the pane prefix, so the Mod+W label was wrong.
  it('shows :q in Vim mode and the Mod+W binding otherwise', async () => {
    const { buildCommands, useStore } = await loadCommands()

    useStore.setState({ vimMode: true, selectedPath: 'inbox/n.md' })
    expect(buildCommands().find((c) => c.id === 'tab.close')?.shortcut).toBe(':q')

    useStore.setState({ vimMode: false })
    const shortcut = buildCommands().find((c) => c.id === 'tab.close')?.shortcut
    expect(shortcut).not.toBe(':q')
    expect(shortcut).toMatch(/W/)
  })
})

describe('New Note in Current Folder (#403)', () => {
  it('creates in the active note folder, not the sidebar browse view', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const createAndOpen = vi.fn()
    useStore.setState({
      activeNote: { folder: 'inbox', path: 'inbox/ProjA/Alpha.md', title: 'Alpha', body: '' } as never,
      // The sidebar is browsing a different folder; the pre-#403 bug used this.
      view: { kind: 'folder', folder: 'archive', subpath: 'Old' },
      createAndOpen
    })
    const cmd = buildCommands().find((c) => c.id === 'note.new.here')
    expect(cmd?.when?.()).toBe(true)
    cmd?.run()
    expect(createAndOpen).toHaveBeenCalledWith('inbox', 'ProjA', { focusTitle: true })
  })

  it('falls back to the browsed folder when no note is open', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const createAndOpen = vi.fn()
    useStore.setState({
      activeNote: null,
      view: { kind: 'folder', folder: 'inbox', subpath: 'Projects' },
      createAndOpen
    })
    const cmd = buildCommands().find((c) => c.id === 'note.new.here')
    expect(cmd?.when?.()).toBe(true)
    cmd?.run()
    expect(createAndOpen).toHaveBeenCalledWith('inbox', 'Projects', { focusTitle: true })
  })

  it('does not target Trash even if the active note is in Trash', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const createAndOpen = vi.fn()
    useStore.setState({
      activeNote: { folder: 'trash', path: 'trash/Gone.md', title: 'Gone', body: '' } as never,
      view: { kind: 'folder', folder: 'inbox', subpath: '' },
      createAndOpen
    })
    const cmd = buildCommands().find((c) => c.id === 'note.new.here')
    cmd?.run()
    // Falls through to the (non-trash) browse view, never creates in trash.
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { focusTitle: true })
  })
})
