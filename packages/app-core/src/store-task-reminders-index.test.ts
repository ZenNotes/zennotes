// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultTask } from '@shared/tasks'

// #1065: task reminders are computed from the shared task index, which the
// watcher used to keep fresh only while a task view was on screen. A task
// another program wrote (a script, Syncthing) reached the reminder schedule
// only when someone opened Tasks, late or never.

function task(sourcePath: string, content: string, taskIndex = 0): VaultTask {
  return {
    id: `${sourcePath}#${taskIndex}`,
    sourcePath,
    noteTitle: sourcePath.replace(/\.md$/, ''),
    noteFolder: 'inbox',
    lineNumber: taskIndex,
    taskIndex,
    rawText: `- [ ] ${content}`,
    content,
    checked: false,
    priority: null,
    tags: []
  } as unknown as VaultTask
}

let disk: Map<string, VaultTask[]>
let zen: Record<string, ReturnType<typeof vi.fn>>

function installZen(withReminderHost: boolean): void {
  disk = new Map()
  zen = {
    getCapabilities: vi.fn().mockReturnValue({}),
    listNotes: vi.fn(async () => []),
    listFolders: vi.fn(async () => []),
    listAssets: vi.fn(async () => []),
    hasAssetsDir: vi.fn(async () => false),
    getVaultSettings: vi.fn(async () => ({})),
    scanTasks: vi.fn(async () => [...disk.values()].flat()),
    scanTasksForPath: vi.fn(async (path: string) => disk.get(path) ?? []),
    readNote: vi.fn(async () => {
      throw new Error('not open')
    })
  }
  if (withReminderHost) zen.setTaskReminders = vi.fn()
  Object.defineProperty(window, 'zen', { configurable: true, value: zen })
}

async function loadStore(): Promise<typeof import('./store')> {
  vi.resetModules()
  localStorage.clear()
  const mod = await import('./store')
  const { makeLeaf } = await import('./lib/pane-layout')
  const leaf = makeLeaf(['Note A.md'], 'Note A.md')
  mod.useStore.setState({
    vault: { root: '/test', name: 'Test' },
    paneLayout: leaf,
    activePaneId: leaf.id,
    taskReminders: true
  })
  return mod
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('#1065: reminders keep the task index fresh with no task view open', () => {
  it('splices an externally written task into a loaded index', async () => {
    installZen(true)
    const { useStore } = await loadStore()
    useStore.setState({ vaultTasks: [task('Existing.md', 'old task')] })

    disk.set('reminder-test.md', [task('reminder-test.md', 'Reminder test due:2026-11-09 @remind:2335')])
    await useStore.getState().applyChange({ kind: 'add', path: 'reminder-test.md', folder: 'inbox' })

    expect(zen.scanTasksForPath).toHaveBeenCalledWith('reminder-test.md')
    expect(zen.scanTasks).not.toHaveBeenCalled()
    expect(useStore.getState().vaultTasks.map((t) => t.sourcePath).sort()).toEqual([
      'Existing.md',
      'reminder-test.md'
    ])
  })

  it('keeps the list as it is when a saved file’s tasks did not change', async () => {
    installZen(true)
    const { useStore } = await loadStore()
    const held = [task('Existing.md', 'old task'), task('Other.md', 'other task')]
    useStore.setState({ vaultTasks: held })
    disk.set('Existing.md', [task('Existing.md', 'old task')])
    await useStore.getState().applyChange({ kind: 'change', path: 'Existing.md', folder: 'inbox' })
    expect(zen.scanTasksForPath).toHaveBeenCalledWith('Existing.md')
    expect(useStore.getState().vaultTasks).toBe(held)

    disk.set('Existing.md', [task('Existing.md', 'renamed task')])
    await useStore.getState().applyChange({ kind: 'change', path: 'Existing.md', folder: 'inbox' })
    expect(useStore.getState().vaultTasks.map((t) => t.content).sort()).toEqual([
      'other task',
      'renamed task'
    ])
  })

  it('drops a deleted file’s tasks', async () => {
    installZen(true)
    const { useStore } = await loadStore()
    useStore.setState({
      vaultTasks: [task('Existing.md', 'old task'), task('gone.md', 'gone task')]
    })
    await useStore.getState().applyChange({ kind: 'unlink', path: 'gone.md', folder: 'inbox' })
    expect(useStore.getState().vaultTasks.map((t) => t.sourcePath)).toEqual(['Existing.md'])
  })

  it('loads an index that was never loaded whole, once a changed file has tasks', async () => {
    installZen(true)
    const { useStore } = await loadStore()
    disk.set('Existing.md', [task('Existing.md', 'old task')])

    // A file without tasks leaves the empty index alone: no full scan per change.
    await useStore.getState().applyChange({ kind: 'change', path: 'plain.md', folder: 'inbox' })
    expect(zen.scanTasks).not.toHaveBeenCalled()
    expect(useStore.getState().vaultTasks).toEqual([])

    // One with tasks must not be spliced into a list that may never have
    // loaded: it would pass for the whole vault and drop every other task.
    disk.set('reminder-test.md', [task('reminder-test.md', 'Reminder test')])
    await useStore.getState().applyChange({ kind: 'add', path: 'reminder-test.md', folder: 'inbox' })
    await vi.waitFor(() => expect(useStore.getState().tasksLoading).toBe(false))
    expect(zen.scanTasks).toHaveBeenCalledTimes(1)
    expect(useStore.getState().vaultTasks.map((t) => t.sourcePath).sort()).toEqual([
      'Existing.md',
      'reminder-test.md'
    ])
  })

  it('leaves the index alone with reminders off', async () => {
    installZen(true)
    const { useStore } = await loadStore()
    useStore.setState({ taskReminders: false, vaultTasks: [task('Existing.md', 'old task')] })
    disk.set('reminder-test.md', [task('reminder-test.md', 'Reminder test')])
    await useStore.getState().applyChange({ kind: 'add', path: 'reminder-test.md', folder: 'inbox' })
    expect(zen.scanTasksForPath).not.toHaveBeenCalled()
    expect(useStore.getState().vaultTasks.map((t) => t.sourcePath)).toEqual(['Existing.md'])
  })

  it('leaves the index alone on a host with no reminders (the web client)', async () => {
    installZen(false)
    const { useStore } = await loadStore()
    useStore.setState({ vaultTasks: [task('Existing.md', 'old task')] })
    disk.set('reminder-test.md', [task('reminder-test.md', 'Reminder test')])
    await useStore.getState().applyChange({ kind: 'add', path: 'reminder-test.md', folder: 'inbox' })
    expect(zen.scanTasksForPath).not.toHaveBeenCalled()
  })
})

describe('#1065: the reminder reporter loads the index when no task view has', () => {
  it('loads it shortly after the vault opens and sends the schedule', async () => {
    vi.useFakeTimers()
    installZen(true)
    const { useStore } = await loadStore()
    const runtime = await import('./lib/task-reminders-runtime')
    vi.setSystemTime(new Date(2026, 10, 9, 12, 0))
    const due = {
      ...task('reminder-test.md', 'Reminder test'),
      due: '2026-11-09',
      fields: { remind: '2335' }
    } as VaultTask
    disk.set('reminder-test.md', [due])
    useStore.setState({
      notes: [{ path: 'reminder-test.md', folder: 'inbox', title: 'reminder-test' } as never]
    })

    const stop = runtime.startTaskReminderReporter()
    try {
      await vi.advanceTimersByTimeAsync(runtime.REMINDER_INDEX_DELAY_MS - 100)
      expect(zen.scanTasks).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(zen.scanTasks).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1500)
      expect(useStore.getState().vaultTasks.map((t) => t.sourcePath)).toEqual(['reminder-test.md'])
      expect(zen.setTaskReminders).toHaveBeenCalled()
      const sent = zen.setTaskReminders.mock.calls.at(-1)![0] as Array<{ path: string }>
      expect(sent.map((r) => r.path)).toContain('reminder-test.md')
    } finally {
      stop()
    }
  })

  it('does not load it with reminders off, and loads it when they are turned on', async () => {
    vi.useFakeTimers()
    installZen(true)
    const { useStore } = await loadStore()
    const runtime = await import('./lib/task-reminders-runtime')
    useStore.setState({ taskReminders: false })
    const stop = runtime.startTaskReminderReporter()
    try {
      await vi.advanceTimersByTimeAsync(runtime.REMINDER_INDEX_DELAY_MS * 2)
      expect(zen.scanTasks).not.toHaveBeenCalled()
      useStore.setState({ taskReminders: true })
      await vi.advanceTimersByTimeAsync(runtime.REMINDER_INDEX_DELAY_MS + 100)
      expect(zen.scanTasks).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('does not scan again when a task view already loaded the index', async () => {
    vi.useFakeTimers()
    installZen(true)
    const { useStore } = await loadStore()
    const runtime = await import('./lib/task-reminders-runtime')
    useStore.setState({ vaultTasks: [task('Existing.md', 'old task')] })
    const stop = runtime.startTaskReminderReporter()
    try {
      await vi.advanceTimersByTimeAsync(runtime.REMINDER_INDEX_DELAY_MS * 2)
      expect(zen.scanTasks).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})
