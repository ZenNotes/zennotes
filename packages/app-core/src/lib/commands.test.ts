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

  it('offers the Cloud conflict queue only while files are waiting', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const { useCloudSyncStatusStore } = await import('./cloud-auto-sync')
    const summary = {
      cursor: 3,
      pulled: 0,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [],
      pending_conflicts: [
        {
          id: 'item-1',
          item_id: 'item-1',
          path: 'Plans/Trip.md',
          cloud_path: 'Plans/Trip.md',
          kind: 'content' as const,
          can_merge: true,
          has_base: true
        }
      ]
    }

    useCloudSyncStatusStore.setState({ lastSummary: summary })
    const command = buildCommands().find((c) => c.id === 'app.cloud.reviewConflicts')
    expect(command?.title).toBe('Review Cloud Sync Conflicts')
    // The leader only works with Vim on, so the palette names it only then.
    useStore.setState({ vimMode: true })
    expect(buildCommands().find((c) => c.id === 'app.cloud.reviewConflicts')?.shortcut).toBe('Space r')
    useStore.setState({ vimMode: false })
    expect(buildCommands().find((c) => c.id === 'app.cloud.reviewConflicts')?.shortcut).toBeUndefined()

    command?.run()
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true)

    useCloudSyncStatusStore.setState({
      lastSummary: { ...summary, pending_conflicts: [] },
      conflictReviewOpen: false
    })
    expect(buildCommands().some((c) => c.id === 'app.cloud.reviewConflicts')).toBe(false)
  })

  it("opens Settings → Cloud while this vault's Cloud vault is gone and nothing else waits", async () => {
    const { buildCommands, useStore } = await loadCommands()
    const { useCloudSyncStatusStore } = await import('./cloud-auto-sync')
    const { consumeSettingsTarget } = await import('./settings-navigation')
    useStore.setState({ settingsOpen: false })
    useCloudSyncStatusStore.setState({
      phase: 'unlinked',
      removedVault: { vaultName: 'Cloud QA iPhone', reason: 'deleted' }
    })

    const command = buildCommands().find((c) => c.id === 'app.cloud.reviewVaultRemoval')
    expect(command?.title).toBe('Review Cloud Vault')
    expect(buildCommands().some((c) => c.id === 'app.cloud.reviewConflicts')).toBe(false)
    command?.run()
    expect(useStore.getState().settingsOpen).toBe(true)
    expect(consumeSettingsTarget()).toBe('cloud')

    useCloudSyncStatusStore.setState({ removedVault: null })
    expect(buildCommands().some((c) => c.id === 'app.cloud.reviewVaultRemoval')).toBe(false)
  })
})

describe('Workflow run entries', () => {
  const INDEX = [
    {
      id: 'reading-log',
      name: 'Reading log',
      description: 'Keep the table in sync',
      status: 'active' as const,
      trigger: { type: 'manual' as const },
      mutates: true
    },
    {
      id: 'half-idea',
      name: 'Half idea',
      description: '',
      status: 'draft' as const,
      trigger: { type: 'manual' as const },
      mutates: false
    }
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

describe('template command shortcuts (#847)', () => {
  it('show the template shortcut once one is set, and the leader key only with Vim on', async () => {
    const { buildCommands, useStore } = await loadCommands()
    // Linux: the template shortcuts ship unbound there.
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { ...window.zen, platformSync: () => 'linux' }
    })
    const shortcutOf = (id: string) => buildCommands().find((c) => c.id === id)?.shortcut

    // Insert only exists with a note open.
    useStore.setState({
      vimMode: false,
      keymapOverrides: {},
      activeNote: { folder: 'inbox', path: 'inbox/Plan.md', title: 'Plan', body: '' } as never
    })
    expect(buildCommands().some((c) => c.id === 'template.insert')).toBe(true)
    expect(shortcutOf('template.create')).toBeFalsy()
    expect(shortcutOf('template.insert')).toBeFalsy()

    useStore.setState({ vimMode: true })
    expect(shortcutOf('template.create')).toMatch(/ t$/)
    expect(shortcutOf('template.insert')).toMatch(/ i$/)

    useStore.setState({
      vimMode: false,
      keymapOverrides: { 'global.newNoteFromTemplate': 'Alt+Mod+T', 'global.insertTemplate': 'Alt+Mod+Y' }
    })
    expect(shortcutOf('template.create')).toMatch(/T$/)
    expect(shortcutOf('template.insert')).toMatch(/Y$/)
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

describe('New Quick Note title (#1008)', () => {
  it('titles with the bare timestamp after the prefix field is cleared', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const createAndOpen = vi.fn()
    useStore.setState({ notes: [], quickNoteDateTitle: false, createAndOpen })
    // The Settings field calls the setter with null once it is empty.
    useStore.getState().setQuickNoteTitlePrefix(null)
    expect(useStore.getState().quickNoteTitlePrefix).toBeNull()
    buildCommands().find((c) => c.id === 'note.new.quick')?.run()
    const title = createAndOpen.mock.calls[0]?.[2]?.title as string
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{4}$/)
  })

  it('keeps the prefix the field holds', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const createAndOpen = vi.fn()
    useStore.setState({ notes: [], quickNoteDateTitle: true, createAndOpen })
    useStore.getState().setQuickNoteTitlePrefix('  Scratch  ')
    buildCommands().find((c) => c.id === 'note.new.quick')?.run()
    const title = createAndOpen.mock.calls[0]?.[2]?.title as string
    expect(title).toMatch(/^Scratch \d{4}-\d{2}-\d{2}$/)
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


describe('favorite command (#810)', () => {
  const note = { folder: 'inbox', path: 'inbox/Plan.md', title: 'Plan', body: '' } as never

  it('flips its title with the active note and runs the store toggle', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const toggleFavoriteActiveNote = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ activeNote: note, selectedPath: 'inbox/Plan.md', toggleFavoriteActiveNote })
    const add = buildCommands().find((c) => c.id === 'note.favorite')
    expect(add?.title).toBe('Add Note to Favorites')
    expect(add?.when?.()).toBe(true)
    await add?.run()
    expect(toggleFavoriteActiveNote).toHaveBeenCalledTimes(1)

    const settings = useStore.getState().vaultSettings
    useStore.setState({ vaultSettings: { ...settings, favorites: ['inbox:Work', 'inbox/Plan.md'] } })
    expect(buildCommands().find((c) => c.id === 'note.favorite')?.title).toBe(
      'Remove Note from Favorites'
    )
  })

  it('stays out of the palette with no note open or a trashed one, like the sidebar menu', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ activeNote: null, selectedPath: null })
    expect(buildCommands().some((c) => c.id === 'note.favorite')).toBe(false)
    useStore.setState({
      activeNote: { folder: 'trash', path: 'trash/Gone.md', title: 'Gone', body: '' } as never,
      selectedPath: 'trash/Gone.md'
    })
    expect(buildCommands().some((c) => c.id === 'note.favorite')).toBe(false)
  })
})

describe('saved Tasks filters (#731)', () => {
  it('lists one palette entry per saved filter, which opens Tasks and applies it', async () => {
    const { buildCommands, useStore } = await loadCommands()
    expect(buildCommands().some((c) => c.id.startsWith('tasks.savedFilter.'))).toBe(false)

    useStore.getState().saveTaskFilter('Blocked', '@status:blocked')
    useStore.getState().saveTaskFilter('Project alpha', '@project:alpha')
    const entries = buildCommands().filter((c) => c.id.startsWith('tasks.savedFilter.'))
    expect(entries.map((c) => c.title)).toEqual(['Tasks: Blocked', 'Tasks: Project alpha'])
    expect(entries[1].keywords).toContain('@project:alpha')

    const openTasksView = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openTasksView })
    await entries[1].run()
    expect(openTasksView).toHaveBeenCalledTimes(1)
    expect(useStore.getState().tasksFilter).toBe('@project:alpha')
  })
})

describe('reference pane commands with a per-note pin', () => {
  // A PDF card pins for its note only. The phones close their full-screen
  // reference sheet with Hide Reference Pane, and only saw the global pin, so
  // Done and Back did nothing over a PDF (Dave, Discord, 2026-10-27).
  it('offers Hide and Focus for a pin on the open note, and Hide hides it', async () => {
    const { buildCommands, runAppCommand, useStore } = {
      ...(await loadCommands()),
      ...(await import('../commands'))
    }
    useStore.setState({
      selectedPath: 'inbox/The trip.md',
      noteRefs: { 'inbox/The trip.md': { path: 'assets/Tourtickets.pdf', kind: 'asset' } },
      pinnedRefPath: null,
      pinnedRefVisible: true
    })
    const ids = buildCommands().map((c) => c.id)
    expect(ids).toContain('ref.toggle')
    expect(ids).toContain('ref.focus')

    expect(await runAppCommand('ref.toggle')).toBe(true)
    expect(useStore.getState().pinnedRefVisible).toBe(false)
  })

  it('stays out of the palette with no pin for the open note or globally', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({
      selectedPath: 'inbox/Other.md',
      noteRefs: { 'inbox/The trip.md': { path: 'assets/Tourtickets.pdf', kind: 'asset' } },
      pinnedRefPath: null
    })
    expect(buildCommands().some((c) => c.id === 'ref.toggle')).toBe(false)
  })
})

describe('commands that open a note to read', () => {
  const today = new Date()
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-')
  const daily = {
    path: `inbox/Daily Notes/${iso}.md`,
    title: iso,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  } as never

  async function commandsWith(notes: never[]) {
    const { buildCommands, useStore } = await loadCommands()
    const settings = useStore.getState().vaultSettings
    useStore.setState({
      notes,
      selectedPath: 'inbox/Plan.md',
      activeNote: { folder: 'inbox', path: 'inbox/Plan.md', title: 'Plan', body: '' } as never,
      closedTabStack: [{ path: 'inbox/Old.md' }] as never,
      vaultSettings: {
        ...settings,
        dailyNotes: { ...settings.dailyNotes, enabled: true, directory: 'Daily Notes' },
        weeklyNotes: { ...settings.weeklyNotes, enabled: true },
        monthlyNotes: { ...settings.monthlyNotes, enabled: true }
      }
    })
    return { commands: buildCommands({ includeUnavailable: true }), useStore }
  }

  it('marks only the commands that go to a note already there', async () => {
    const { commands } = await commandsWith([])
    const marked = commands.filter((c) => c.opensToRead).map((c) => c.id).sort()
    expect(marked).toEqual([
      'nav.back',
      'nav.forward',
      'nav.toggle-recent',
      'note.daily.rollover',
      'note.daily.today',
      'note.monthly.thisMonth',
      'note.weekly.thisWeek',
      'tab.close',
      'tab.next',
      'tab.previous',
      'tab.reopen'
    ])
    // History and tabs only ever land on notes that exist.
    const navigation = ['nav.back', 'nav.forward', 'nav.toggle-recent', 'tab.close', 'tab.next']
    for (const id of [...navigation, 'tab.previous', 'tab.reopen']) {
      expect(commands.find((c) => c.id === id)?.opensToRead?.()).toBe(true)
    }
    // Writing commands keep the editor focus.
    const writing = ['note.new.inbox', 'note.new.quick', 'note.new.here', 'task.new', 'template.create']
    for (const id of [...writing, 'database.new', 'drawing.new', 'embed.drawing.new', 'nav.focus.editor']) {
      expect(commands.find((c) => c.id === id)?.opensToRead).toBeUndefined()
    }
  })

  it("reads today's daily note when it is there, and writes in one the command creates", async () => {
    let { commands } = await commandsWith([])
    expect(commands.find((c) => c.id === 'note.daily.today')?.opensToRead?.()).toBe(false)
    expect(commands.find((c) => c.id === 'note.daily.rollover')?.opensToRead?.()).toBe(false)
    ;({ commands } = await commandsWith([daily]))
    expect(commands.find((c) => c.id === 'note.daily.today')?.opensToRead?.()).toBe(true)
    expect(commands.find((c) => c.id === 'note.daily.rollover')?.opensToRead?.()).toBe(true)
  })

  it('asks the periodic openers to open an existing note to read', async () => {
    const { commands, useStore } = await commandsWith([daily])
    const openTodayDailyNote = vi.fn().mockResolvedValue(undefined)
    const openThisWeekWeeklyNote = vi.fn().mockResolvedValue(undefined)
    const openThisMonthMonthlyNote = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openTodayDailyNote, openThisWeekWeeklyNote, openThisMonthMonthlyNote })
    await commands.find((c) => c.id === 'note.daily.today')?.run()
    await commands.find((c) => c.id === 'note.weekly.thisWeek')?.run()
    await commands.find((c) => c.id === 'note.monthly.thisMonth')?.run()
    expect(openTodayDailyNote).toHaveBeenCalledWith({ readIfExisting: true })
    expect(openThisWeekWeeklyNote).toHaveBeenCalledWith({ readIfExisting: true })
    expect(openThisMonthMonthlyNote).toHaveBeenCalledWith({ readIfExisting: true })
  })
})

describe('Toggle Status Bar (Piotr on Discord)', () => {
  it('flips the setting and saves it with the other preferences', async () => {
    const { buildCommands, useStore } = await loadCommands()
    expect(useStore.getState().showStatusBar).toBe(true)
    const toggle = buildCommands().find((c) => c.id === 'view.status-bar')
    expect(toggle?.title).toBe('Toggle Status Bar')
    await toggle?.run()
    expect(useStore.getState().showStatusBar).toBe(false)
    expect(JSON.parse(localStorage.getItem('zen:prefs:v2') ?? '{}').showStatusBar).toBe(false)
    await buildCommands().find((c) => c.id === 'view.status-bar')?.run()
    expect(useStore.getState().showStatusBar).toBe(true)
  })
})

describe('commands that give a phone editor the keyboard', () => {
  it('names only commands that exist', async () => {
    const { buildCommands } = await loadCommands()
    const { EDITOR_FOCUS_COMMAND_IDS } = await import('./command-landing')
    const ids = new Set(buildCommands({ includeUnavailable: true }).map((c) => c.id))
    for (const id of EDITOR_FOCUS_COMMAND_IDS) expect(ids.has(id), id).toBe(true)
  })
})

describe('a key the user gave a command (#971)', () => {
  const active = { folder: 'inbox', path: 'inbox/Plan.md', title: 'Plan', body: '' } as never

  it('shows on the palette row, ahead of the key the command already had', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ activeNote: active, commandKeymaps: { 'note.favorite': 'F5' } })
    const favorite = buildCommands().find((c) => c.id === 'note.favorite')
    expect(favorite?.shortcut).toBe('F5 / Space l s')
    expect(favorite?.builtinShortcut).toBe('Space l s')
    const trash = buildCommands().find((c) => c.id === 'note.trash')
    expect(trash?.shortcut).toBeUndefined()
  })

  it('shows a leader sequence only while Vim mode is on', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ activeNote: active, commandKeymaps: { 'note.trash': 'Leader x t' } })
    expect(buildCommands().find((c) => c.id === 'note.trash')?.shortcut).toBe('Space x t')
    useStore.setState({ vimMode: false })
    expect(buildCommands().find((c) => c.id === 'note.trash')?.shortcut).toBeUndefined()
  })

  it('gives the shared guards a reason, and the note family its own', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ activeNote: null, selectedPath: null, editorViewRef: null })
    const all = buildCommands({ includeUnavailable: true })
    const reason = (id: string): string | undefined =>
      all.find((c) => c.id === id)?.unavailableReason?.()
    expect(reason('note.rename')).toBe('Rename Note… needs an open note')
    expect(reason('editor.reflow-paragraph')).toBe('Reflow Paragraph needs a note open in the editor')
    expect(reason('note.trash')).toBe('Move Note to Trash needs an open note')
    useStore.setState({ activeNote: { ...(active as object), folder: 'trash' } as never })
    expect(reason('note.trash')).toBe('This note is already in the Trash')
    expect(reason('note.unarchive')).toBe('Unarchive Note only works on a note in the Archive')
  })
})

describe('Vim-only keys in the palette', () => {
  it('names no leader chord, pane prefix, ex command or Vim key with Vim mode off', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const { getKeymapDisplay } = await import('./keymaps')
    useStore.setState({ vimMode: false, activeNote: null })
    const overrides = useStore.getState().keymapOverrides
    const leader = getKeymapDisplay(overrides, 'vim.leaderPrefix')
    const pane = getKeymapDisplay(overrides, 'vim.panePrefix')
    // The commands whose key is a Vim-group key, checked by id: on Linux and
    // Windows a Vim key can read the same as a global one (Vim's Ctrl+O and
    // Open File's Mod+O both show as Ctrl+O), so a display match alone would
    // flag a key that works in both modes.
    const vimKeyed: Record<string, string> = {
      'fold.heading': getKeymapDisplay(overrides, 'vim.foldCurrent'),
      'fold.unfold-heading': getKeymapDisplay(overrides, 'vim.unfoldCurrent'),
      'fold.all': getKeymapDisplay(overrides, 'vim.foldAll'),
      'fold.unfold-all': getKeymapDisplay(overrides, 'vim.unfoldAll'),
      'nav.back': getKeymapDisplay(overrides, 'vim.historyBack'),
      'nav.forward': getKeymapDisplay(overrides, 'vim.historyForward')
    }
    const leaks = buildCommands({ includeUnavailable: true })
      .filter((command) => {
        const shown = command.shortcut ?? ''
        if (!shown) return false
        return (
          shown.startsWith(':') ||
          (!!leader && shown.startsWith(`${leader} `)) ||
          (!!pane && shown.startsWith(`${pane} `)) ||
          (command.id in vimKeyed && shown === vimKeyed[command.id])
        )
      })
      .map((command) => `${command.id}: ${command.shortcut}`)
    expect(leaks).toEqual([])
  })

  it('still names them with Vim mode on', async () => {
    const { buildCommands, useStore } = await loadCommands()
    useStore.setState({ vimMode: true })
    const shown = new Map(buildCommands({ includeUnavailable: true }).map((c) => [c.id, c.shortcut ?? '']))
    expect(shown.get('note.format')).toBe(':format')
    expect(shown.get('note.favorite')).toMatch(/\S+ \S+ \S+/)
  })
})

describe('Go Back and Go Forward keys', () => {
  it('show the global keys with Vim mode off', async () => {
    const { buildCommands, useStore } = await loadCommands()
    const { getKeymapDisplay } = await import('./keymaps')
    useStore.setState({ vimMode: false })
    const overrides = useStore.getState().keymapOverrides
    const shown = new Map(buildCommands({ includeUnavailable: true }).map((c) => [c.id, c.shortcut ?? '']))
    expect(shown.get('nav.back')).toBe(getKeymapDisplay(overrides, 'global.historyBack'))
    expect(shown.get('nav.forward')).toBe(getKeymapDisplay(overrides, 'global.historyForward'))
  })
})
