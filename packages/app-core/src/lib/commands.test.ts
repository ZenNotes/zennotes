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

describe('Workflows feature switch', () => {
  it('offers view.workflows only while the feature is enabled', async () => {
    const { buildCommands, useStore } = await loadCommands()

    // buildCommands drops anything whose `when` guard rejects, so an off
    // switch removes the palette entry outright rather than greying it out.
    useStore.setState({ workflowsEnabled: true })
    expect(buildCommands().find((c) => c.id === 'view.workflows')?.title).toBe('Open Workflows')

    useStore.setState({ workflowsEnabled: false })
    expect(buildCommands().some((c) => c.id === 'view.workflows')).toBe(false)
  })
})

describe('Workflow run entries', () => {
  const INDEX = [
    {
      id: 'reading-log',
      name: 'Reading log',
      description: 'Keep the table in sync',
      status: 'active' as const,
      mutates: true
    },
    { id: 'half-idea', name: 'Half idea', description: '', status: 'draft' as const, mutates: false }
  ]

  it('lists one Run entry per active workflow and none for drafts', async () => {
    ;(window.zen as unknown as Record<string, unknown>).applyWorkflow = vi.fn()
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ workflowsEnabled: true, workspaceMode: 'local', workflowIndex: INDEX })

    const commands = buildCommands()
    const run = commands.find((c) => c.id === 'workflow.run.reading-log')
    expect(run?.title).toBe('Run: Reading log')
    expect(run?.category).toBe('Workflow')
    // A draft cannot run, so the palette does not offer to.
    expect(commands.some((c) => c.id === 'workflow.run.half-idea')).toBe(false)
    // The browsable picker rides along, in the Switch Vault… drill-down shape.
    expect(commands.find((c) => c.id === 'workflow.runPicker')?.title).toBe('Run Workflow…')
  })

  it('offers no Run entries where the bridge cannot apply a run', async () => {
    // The stub bridge has no applyWorkflow, which is the web app's shape.
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ workflowsEnabled: true, workspaceMode: 'local', workflowIndex: INDEX })
    expect(buildCommands().some((c) => c.id.startsWith('workflow.run.'))).toBe(false)
  })

  it('offers the tutorial even before the feature is enabled', async () => {
    ;(window.zen as unknown as Record<string, unknown>).applyWorkflow = vi.fn()
    const { buildCommands, useStore } = await loadCommands()
    // Workflows OFF: starting the tutorial is how someone opts in, so the
    // palette must surface it exactly like the button in Settings does.
    useStore.setState({ workflowsEnabled: false, workspaceMode: 'local' })
    expect(buildCommands().find((c) => c.id === 'workflow.tutorial')?.title).toBe(
      'Start Workflows Tutorial'
    )
  })

  it('offers no tutorial where workflows cannot run at all', async () => {
    // The stub bridge has no applyWorkflow, which is the web app's shape.
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ workflowsEnabled: true, workspaceMode: 'local' })
    expect(buildCommands().some((c) => c.id === 'workflow.tutorial')).toBe(false)
  })

  it('a captured Run command dies with the feature switch', async () => {
    ;(window.zen as unknown as Record<string, unknown>).applyWorkflow = vi.fn()
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ workflowsEnabled: true, workspaceMode: 'local', workflowIndex: INDEX })

    // The vim ex registry snapshots command objects at editor mount, then
    // re-checks only `when`. A Run entry must therefore carry the switch as
    // its `when`, or `:workflow_run_…` keeps writing after the toggle is off.
    const run = buildCommands().find((c) => c.id === 'workflow.run.reading-log')
    const picker = buildCommands().find((c) => c.id === 'workflow.runPicker')
    expect(run?.when?.()).toBe(true)
    expect(picker?.when?.()).toBe(true)

    useStore.setState({ workflowsEnabled: false })
    expect(run?.when?.()).toBe(false)
    expect(picker?.when?.()).toBe(false)
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

describe('note commands for a trashed note (#712)', () => {
  const note = {
    path: 'trash/Old idea.md',
    title: 'Old idea',
    folder: 'trash' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: 1,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: '',
    body: ''
  }

  it('offers Restore and Delete Permanently, not Move to Trash, while the active note is in the Trash', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ selectedPath: note.path, activeNote: note })
    const ids = buildCommands().map((cmd) => cmd.id)
    expect(ids).toContain('note.restore')
    expect(ids).toContain('note.delete-permanently')
    expect(ids).not.toContain('note.trash')
  })

  it('offers Move to Trash, not Delete Permanently, for a note outside the Trash', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ selectedPath: 'inbox/Idea.md', activeNote: { ...note, path: 'inbox/Idea.md', folder: 'inbox' as const } })
    const ids = buildCommands().map((cmd) => cmd.id)
    expect(ids).toContain('note.trash')
    expect(ids).not.toContain('note.delete-permanently')
  })

  it('runs the store action that deletes the active note for good', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const deleteActivePermanently = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ selectedPath: note.path, activeNote: note, deleteActivePermanently })
    await buildCommands().find((cmd) => cmd.id === 'note.delete-permanently')?.run()
    expect(deleteActivePermanently).toHaveBeenCalledTimes(1)
  })
})

