// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASKS_TAB_PATH, type VaultTask } from '@shared/tasks'

function makeTask(content: string, taskIndex = 0): VaultTask {
  return {
    id: `inbox/Note.md#${taskIndex}`,
    sourcePath: 'inbox/Note.md',
    noteTitle: 'Note',
    noteFolder: 'inbox',
    lineNumber: taskIndex,
    taskIndex,
    rawText: `- [ ] ${content}`,
    content,
    checked: false,
    waiting: false,
    tags: []
  }
}

function makeNote(body: string) {
  return {
    path: 'inbox/Note.md',
    title: 'Note',
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    excerpt: body,
    body
  }
}

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      scanTasks: vi.fn().mockResolvedValue([]),
      scanTasksForPath: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn().mockResolvedValue([makeNote('- [ ] old task')]),
      listFolders: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      readNote: vi.fn().mockResolvedValue(makeNote('- [ ] old task')),
      ...overrides
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  return import('./store')
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('tasks cache freshness', () => {
  it('refreshes tasks when focusing an existing Tasks tab', async () => {
    const freshTasks = [makeTask('new task')]
    const scanTasks = vi.fn().mockResolvedValue(freshTasks)
    installZen({ scanTasks })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    await useStore.getState().openNoteInPane(paneId, TASKS_TAB_PATH)
    await useStore.getState().openNoteInPane(paneId, 'inbox/Note.md')
    useStore.setState({ vaultTasks: [makeTask('stale task')] })

    await useStore.getState().focusTabInPane(paneId, TASKS_TAB_PATH)
    await flushAsyncWork()

    expect(scanTasks).toHaveBeenCalledTimes(1)
    expect(useStore.getState().vaultTasks).toEqual(freshTasks)
  })

  it('rescans changed notes while the Tasks tab is open but inactive', async () => {
    const freshTasks = [makeTask('new task')]
    const scanTasksForPath = vi.fn().mockResolvedValue(freshTasks)
    installZen({ scanTasksForPath })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    await useStore.getState().openNoteInPane(paneId, TASKS_TAB_PATH)
    await useStore.getState().openNoteInPane(paneId, 'inbox/Note.md')
    useStore.setState({ vaultTasks: [makeTask('stale task')] })

    await useStore.getState().applyChange({
      kind: 'change',
      path: 'inbox/Note.md',
      folder: 'inbox',
      scope: 'content'
    })

    expect(scanTasksForPath).toHaveBeenCalledWith('inbox/Note.md')
    expect(useStore.getState().vaultTasks).toEqual(freshTasks)
  })
})
