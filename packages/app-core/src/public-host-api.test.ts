// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultTask } from '@bridge-contract/tasks'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
async function setup() {
  Object.defineProperty(window, 'zen', { configurable: true, value: {
    getCapabilities: () => ({}), getAppInfo: () => ({ runtime: 'web' }), platformSync: () => 'linux'
  } })
  const { useStore } = await import('./store')
  return { useStore, tasks: await import('./tasks'), settings: await import('./settings'), workspace: await import('./workspace') }
}
function task(): VaultTask {
  return { id: 'inbox/One.md#0', sourcePath: 'inbox/One.md', noteTitle: 'One', noteFolder: 'inbox',
    lineNumber: 0, taskIndex: 0, rawText: '- [/] Write #work @status:ready', content: 'Write',
    checked: false, forwarded: false, cancelled: false, inProgress: true, waiting: false,
    tags: ['work'], fields: { status: 'ready' } }
}
describe('public host APIs', () => {
  it('publishes frozen task data and ignores unrelated updates; disposal stops notifications', async () => {
    const s = await setup(), original = task()
    s.useStore.setState({ vaultTasks: [original] })
    const first = s.tasks.getTasksSnapshot(), listener = vi.fn()
    const dispose = s.tasks.subscribeTasks(listener)
    expect(() => (first.tasks[0].tags as string[]).push('wrong')).toThrow()
    expect(() => Object.assign(first.tasks[0].fields!, { status: 'wrong' })).toThrow()
    s.useStore.setState({ searchOpen: true })
    expect(s.tasks.getTasksSnapshot()).toBe(first)
    s.useStore.setState({ tasksLoading: true })
    expect(listener).toHaveBeenCalledTimes(1)
    dispose(); s.useStore.setState({ tasksLoading: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(original.tags).toEqual(['work'])
  })
  it('moves the current task with desktop semantics and rejects stale host/grouping', async () => {
    const s = await setup(), applyTaskMutation = vi.fn().mockResolvedValue(undefined), original = task()
    s.useStore.setState({ vault: { root: '/test', name: 'Test' }, vaultTasks: [original], kanbanGroupBy: 'status', applyTaskMutation })
    expect(await s.tasks.moveTaskToColumn({ isCurrent: () => false }, original.id, 'status', 'today')).toBe(false)
    expect(await s.tasks.moveTaskToColumn({ isCurrent: () => true }, original.id, 'priority', 'high')).toBe(false)
    expect(applyTaskMutation).not.toHaveBeenCalled()
    expect(await s.tasks.moveTaskToColumn({ isCurrent: () => true }, original.id, 'status', 'today')).toBe(true)
    const changes = applyTaskMutation.mock.calls[0][1]
    expect(changes).toContainEqual({ kind: 'set-in-progress', inProgress: false })
    expect(changes).toContainEqual({ kind: 'set-checked', checked: false })
    const today = new Date()
    expect(changes).toContainEqual({ kind: 'set-due', due: `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}` })
  })
  it('exposes profile display fields without retaining credentials or mutable entries', async () => {
    const s = await setup()
    const profile = { id: 'one', name: 'Private server', baseUrl: 'https://example.test', vaultPath: null,
      lastConnectedAt: null, hasCredential: true, authToken: 'never expose' }
    s.useStore.setState({ remoteWorkspaceProfiles: [profile] })
    const publicProfile = s.workspace.getWorkspaceSnapshot().remoteProfiles[0]
    expect(publicProfile).not.toHaveProperty('authToken')
    expect(Object.isFrozen(publicProfile)).toBe(true)
    expect(publicProfile).not.toBe(profile)
  })
  it('clamps finite font gestures and publishes only changed settings', async () => {
    const s = await setup(), setEditorFontSize = vi.fn()
    s.useStore.setState({ setEditorFontSize })
    s.settings.setEditorFontSize(Number.NaN)
    s.settings.setEditorFontSize(Infinity)
    expect(setEditorFontSize).not.toHaveBeenCalled()
    s.settings.setEditorFontSize(100); s.settings.setEditorFontSize(1)
    expect(setEditorFontSize.mock.calls).toEqual([[28],[12]])
    const first = s.settings.getSettingsSnapshot()
    s.useStore.setState({ sidebarOpen: false })
    expect(s.settings.getSettingsSnapshot()).toBe(first)
    s.settings.setSettingsVisible(true)
    expect(s.settings.getSettingsSnapshot().open).toBe(true)
  })
  it('does not let a second host dialog replace an unresolved prompt', async () => {
    await setup()
    const dialogs = await import('./dialogs'), requests = await import('./lib/prompt-requests')
    const pending = dialogs.prompt({ title: 'First' }), request = requests.getPromptRequest()!
    expect(await dialogs.prompt({ title: 'Second' })).toBeNull()
    expect(await dialogs.confirm({ title: 'Second' })).toBe(false)
    expect(requests.getPromptRequest()).toBe(request)
    requests.settlePromptRequest(request, 'answer')
    expect(await pending).toBe('answer')
  })
  it('publishes frozen favorites and ignores a settings save that keeps them (#810)', async () => {
    const s = await setup(), shell = await import('./shell')
    const settings = () => s.useStore.getState().vaultSettings
    s.useStore.setState({ vaultSettings: { ...settings(), favorites: ['inbox/One.md', 'inbox:Work'] } })
    const first = shell.getShellSnapshot(), listener = vi.fn()
    const dispose = shell.subscribeShell(listener)
    expect(first.favorites).toEqual(['inbox/One.md', 'inbox:Work'])
    expect(() => (first.favorites as string[]).push('wrong')).toThrow()
    // A folder color save rebuilds vault settings, favorites array included.
    s.useStore.setState({ vaultSettings: { ...settings(), favorites: [...settings().favorites], folderColors: { 'inbox:Work': 'red' } } })
    expect(shell.getShellSnapshot()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
    s.useStore.setState({ vaultSettings: { ...settings(), favorites: ['inbox:Work'] } })
    expect(shell.getShellSnapshot().favorites).toEqual(['inbox:Work'])
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
  })
  it('rechecks command availability at invocation instead of retaining stale closures', async () => {
    const s = await setup(), commands = await import('./commands')
    expect(await commands.runAppCommand('not-a-command')).toBe(false)
    const archiveActive = vi.fn()
    s.useStore.setState({ archiveActive })
    expect(commands.getAppCommands().find(c => c.id === 'note.archive')?.available).toBe(false)
    expect(await commands.runAppCommand('note.archive')).toBe(false)
    expect(archiveActive).not.toHaveBeenCalled()
    commands.showSearch()
    expect(s.useStore.getState().searchOpen).toBe(true)
  })
})

describe('workspace transition reservation', () => {
  it('reserves the entire save drain and bridge selection against competing transitions', async () => {
    const s = await setup()
    let release!: () => void
    const drain = new Promise<void>(resolve => { release = resolve })
    const open = vi.fn().mockResolvedValue(null), disconnect = vi.fn()
    Object.assign(window.zen, { openLocalVault: open, disconnectRemoteWorkspace: disconnect })
    s.useStore.setState({ vault: { root: '/current', name: 'Current' }, flushDirtyNotes: () => drain })
    const pending = s.workspace.openLocalVault('/first')
    await s.workspace.openLocalVault('/second')
    await s.workspace.disconnectRemoteWorkspace()
    expect(open).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    release(); await pending
    expect(open.mock.calls).toEqual([['/first']])
    await s.workspace.openLocalVault('/second')
    expect(open.mock.calls).toEqual([['/first'], ['/second']])
  })
  it('does not dispatch navigation during a pending host switch or resume a read after cancellation', async () => {
    const s = await setup(), navigation = await import('./navigation')
    let release!: () => void
    const selection = new Promise<null>(resolve => { release = () => resolve(null) })
    const read = vi.fn()
    Object.assign(window.zen, { openLocalVault: () => selection, readNote: read })
    s.useStore.setState({ vault: { root: '/current', name: 'Current' }, flushDirtyNotes: async () => {} })
    const pending = s.workspace.openLocalVault('/next')
    await navigation.openNote('inbox/One.md')
    expect(read).not.toHaveBeenCalled()
    release(); await pending
  })
  it('previews font size in memory and persists once when the gesture completes', async () => {
    const s = await setup(), persist = vi.fn()
    s.useStore.setState({ setEditorFontSize: persist })
    s.settings.setEditorFontSize(17.5, { persist: false })
    s.settings.setEditorFontSize(30, { persist: false })
    expect(s.settings.getSettingsSnapshot().editorFontSize).toBe(28)
    expect(persist).not.toHaveBeenCalled()
    s.settings.setEditorFontSize(s.settings.getSettingsSnapshot().editorFontSize)
    expect(persist.mock.calls).toEqual([[28]])
  })
})

describe('workspace input safety', () => {
  it('locks editor and database input through a cancelled picker, then releases it', async () => {
    const s = await setup(), locks = await import('./lib/note-lifecycle-lock')
    const vault = { root: '/current', name: 'Current' }
    let release!: () => void
    const picker = new Promise<null>(resolve => { release = () => resolve(null) })
    Object.assign(window.zen, { openLocalVault: vi.fn(() => picker) })
    s.useStore.setState({ vault, flushDirtyNotes: async () => {} })
    const pending = s.workspace.openLocalVault('/next')
    await vi.waitFor(() => expect(window.zen.openLocalVault).toHaveBeenCalled())
    expect(locks.isNoteEditingLocked(vault, 'inbox/Newly opened.md')).toBe(true)
    expect(locks.isNoteEditingLocked(vault, 'inbox/Projects.base/data.csv')).toBe(true)
    expect(s.workspace.getWorkspaceSnapshot().transitioning).toBe(true)
    release(); await pending
    expect(locks.isNoteEditingLocked(vault, 'inbox/Newly opened.md')).toBe(false)
    expect(s.workspace.getWorkspaceSnapshot().transitioning).toBe(false)
  })
  it('clears invalidated navigation markers even if the host picker cancels', async () => {
    const s = await setup(), navigation = await import('./navigation')
    let finishRead!: (value: unknown) => void
    const read = new Promise(resolve => { finishRead = resolve })
    Object.assign(window.zen, { readNote: vi.fn(() => read), openLocalVault: async () => null })
    s.useStore.setState({ vault: { root: '/current', name: 'Current' }, flushDirtyNotes: async () => {} })
    const pending = navigation.openNote('inbox/One.md')
    expect(s.useStore.getState().loadingNote).toBe(true)
    await s.workspace.openLocalVault('/next')
    finishRead({ path: 'inbox/One.md', body: 'Old body' })
    await pending
    expect(s.useStore.getState()).toMatchObject({ loadingNote: false, pendingJumpLocation: null, selectedPath: null })
  })
  it('leaves back, Home, daily creation and app pages alone while a transition is reserved', async () => {
    const s = await setup(), navigation = await import('./navigation')
    let release!: () => void
    const picker = new Promise<null>(resolve => { release = () => resolve(null) })
    Object.assign(window.zen, { openLocalVault: () => picker, readNote: vi.fn() })
    const daily = vi.fn(), tasks = vi.fn()
    s.useStore.setState({ vault: { root: '/current', name: 'Current' }, flushDirtyNotes: async () => {},
      selectedPath: 'inbox/Current.md', noteBackstack: [{ path: 'inbox/Old.md' } as never],
      openTodayDailyNote: daily, openTasksView: tasks })
    const pending = s.workspace.openLocalVault('/next')
    await navigation.goBack(); navigation.goHome()
    await navigation.openTodayDailyNote(); await navigation.openAppPage('tasks')
    expect(s.useStore.getState().selectedPath).toBe('inbox/Current.md')
    expect(window.zen.readNote).not.toHaveBeenCalled()
    expect(daily).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled()
    release(); await pending
  })
})

describe('comments during workspace selection', () => {
  it('drains an existing comment write and rejects new comments while the host switches', async () => {
    const s = await setup()
    let finishWrite!: (value: unknown[]) => void, finishOpen!: () => void
    const write = new Promise<unknown[]>(resolve => { finishWrite = resolve })
    const opening = new Promise<null>(resolve => { finishOpen = () => resolve(null) })
    Object.assign(window.zen, { writeNoteComments: vi.fn(() => write), openLocalVault: vi.fn(() => opening) })
    s.useStore.setState({ vault: { root: '/current', name: 'Current' }, noteComments: { 'inbox/One.md': [] } })
    const comment = s.useStore.getState().addNoteComment({ notePath: 'inbox/One.md', body: 'Keep this comment', anchor: null } as never)
    const switching = s.workspace.openLocalVault('/next')
    await Promise.resolve()
    expect(window.zen.openLocalVault).not.toHaveBeenCalled()
    finishWrite([]); await comment
    await vi.waitFor(() => expect(window.zen.openLocalVault).toHaveBeenCalled())
    expect(await s.useStore.getState().addNoteComment({ notePath: 'inbox/One.md', body: 'Too late', anchor: null } as never)).toBeNull()
    expect(window.zen.writeNoteComments).toHaveBeenCalledTimes(1)
    finishOpen(); await switching
  })
})

describe('host vault relocation', () => {
  it('reserves before draining saves and locks input until native relocation finishes', async () => {
    const s = await setup(), locks = await import('./lib/note-lifecycle-lock')
    const vault = { root: '/old', name: 'Old' }, events: string[] = []
    let finishDrain!: () => void, finishMove!: () => void
    const drain = new Promise<void>(resolve => { finishDrain = resolve })
    const moving = new Promise<void>(resolve => { finishMove = resolve })
    s.useStore.setState({ vault, flushDirtyNotes: async () => { events.push('drain'); await drain } })
    const open = vi.fn().mockResolvedValue(null)
    Object.assign(window.zen, { openLocalVault: open })
    const pending = s.workspace.relocateLocalVault({
      move: async () => { events.push('move'); await moving }, rollback: vi.fn()
    })
    await s.workspace.openLocalVault('/other')
    expect(open).not.toHaveBeenCalled()
    expect(events).toEqual(['drain'])
    finishDrain()
    await vi.waitFor(() => expect(events).toContain('move'))
    expect(events).toEqual(['drain', 'drain', 'move'])
    expect(locks.isNoteEditingLocked(vault, 'inbox/One.md')).toBe(true)
    await expect(s.workspace.relocateLocalVault({ move: vi.fn(), rollback: vi.fn() })).rejects.toThrow('Wait')
    finishMove(); await pending
    expect(locks.isNoteEditingLocked(vault, 'inbox/One.md')).toBe(false)
  })
  it('rolls native storage back and restores the saved workspace when reopening fails', async () => {
    const s = await setup(), events: string[] = []
    const vault = { root: '/old', name: 'Old' }
    s.useStore.setState({ vault, selectedPath: 'inbox/Keep.md', noteContents: { 'inbox/Keep.md': { body: 'Exact café  \n' } as never },
      flushDirtyNotes: async () => {}, refreshLocalVaults: async () => [] })
    Object.assign(window.zen, { openLocalVault: async (root: string) => {
      events.push(`open:${root}`)
      if (root === 'new-token') throw new Error('Provider unavailable')
      return vault
    } })
    await expect(s.workspace.relocateLocalVault({
      reopen: { source: 'old-token', destination: 'new-token' },
      move: async () => { events.push('move') }, rollback: async () => { events.push('rollback') }
    })).rejects.toThrow('Provider unavailable')
    expect(events).toEqual(['move', 'open:new-token', 'rollback', 'open:old-token'])
    expect(s.useStore.getState().vault).toBe(vault)
    expect(s.useStore.getState().selectedPath).toBe('inbox/Keep.md')
    expect(s.useStore.getState().noteContents['inbox/Keep.md'].body).toBe('Exact café  \n')
    expect(s.workspace.getWorkspaceSnapshot().transitioning).toBe(false)
  })
  it('stops active vault writers and surfaces both errors when native rollback fails', async () => {
    const s = await setup()
    s.useStore.setState({ vault: { root: '/old', name: 'Old' }, flushDirtyNotes: async () => {} })
    Object.assign(window.zen, { openLocalVault: async () => { throw new Error('reopen failed') } })
    await expect(s.workspace.relocateLocalVault({
      reopen: { source: 'old', destination: 'new' }, move: async () => {},
      rollback: async () => { throw new Error('rollback failed') }
    })).rejects.toThrow('relocation and recovery failed')
    expect(s.useStore.getState().vault).toBeNull()
    expect(s.workspace.getWorkspaceSnapshot().restored).toBe(false)
    expect(s.useStore.getState().workspaceSetupError).toContain('checking its storage location')
  })
  it('keeps host generation invalidated after a cancelled or failed switch', async () => {
    const s = await setup()
    s.useStore.setState({ vault: { root: '/old', name: 'Old' }, flushDirtyNotes: async () => {} })
    const original = s.workspace.getWorkspaceSnapshot()
    Object.assign(window.zen, { openLocalVault: async () => null })
    await s.workspace.openLocalVault('/cancelled')
    const cancelled = s.workspace.getWorkspaceSnapshot()
    expect(cancelled.generation).toBeGreaterThan(original.generation)
    expect(cancelled.transitioning).toBe(false)
    Object.assign(window.zen, { openLocalVault: async () => { throw new Error('failed') } })
    await s.workspace.openLocalVault('/failed')
    expect(s.workspace.getWorkspaceSnapshot().generation).toBeGreaterThan(cancelled.generation)
  })
})
