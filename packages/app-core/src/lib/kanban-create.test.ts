// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({}),
      platformSync: () => 'darwin',
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false)
    }
  })
}

function note(path: string): NoteMeta {
  return {
    path,
    title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  }
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const kanban = await import('./kanban-create')
  const createKanban = vi.fn().mockResolvedValue(undefined)
  const newKanban = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ createKanban, newKanban })
  return { useStore, createKanban, newKanban, ...kanban }
}

/** A sidebar row the way Sidebar draws one, numbered for its Vim cursor. */
function sidebarRow(idx: number, attrs: Record<string, string>): void {
  const row = document.createElement('div')
  row.setAttribute('data-sidebar-idx', String(idx))
  for (const [name, value] of Object.entries(attrs)) row.setAttribute(name, value)
  document.body.appendChild(row)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('canHoldKanban', () => {
  it('takes notes-area folders, never a system folder or a database folder', async () => {
    const s = await load()
    expect(s.canHoldKanban({ folder: 'inbox', subpath: '' })).toBe(true)
    expect(s.canHoldKanban({ folder: 'inbox', subpath: 'School/Biology' })).toBe(true)
    expect(s.canHoldKanban({ folder: 'inbox', subpath: 'School/Grades.base' })).toBe(false)
    expect(s.canHoldKanban({ folder: 'quick', subpath: '' })).toBe(false)
    expect(s.canHoldKanban({ folder: 'archive', subpath: '2025' })).toBe(false)
    expect(s.canHoldKanban({ folder: 'trash', subpath: '' })).toBe(false)
  })
})

describe('newContextKanban', () => {
  it('creates in the folder row under the sidebar cursor while the sidebar has focus', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'folder', 'data-sidebar-folder': 'inbox', 'data-sidebar-subpath': 'Biology' })
    s.useStore.setState({ focusedPanel: 'sidebar', sidebarOpen: true, sidebarCursorIndex: 0 })
    await s.newContextKanban()
    expect(s.createKanban).toHaveBeenCalledWith('inbox', 'Biology')
    expect(s.newKanban).not.toHaveBeenCalled()
  })

  it('creates in a note row’s folder, but not inside a database', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'note', 'data-sidebar-path': 'inbox/History/Essay.md' })
    sidebarRow(1, { 'data-sidebar-type': 'note', 'data-sidebar-path': 'inbox/History/Grades.base/Alice.md' })
    s.useStore.setState({
      notes: [note('inbox/History/Essay.md'), note('inbox/History/Grades.base/Alice.md')],
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 0
    })
    await s.newContextKanban()
    expect(s.createKanban).toHaveBeenCalledWith('inbox', 'History')
    s.useStore.setState({ sidebarCursorIndex: 1 })
    await s.newContextKanban()
    expect(s.newKanban).toHaveBeenCalledTimes(1)
  })

  it('goes where new databases go when the sidebar does not have focus', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'folder', 'data-sidebar-folder': 'inbox', 'data-sidebar-subpath': 'Biology' })
    s.useStore.setState({ focusedPanel: 'editor', sidebarCursorIndex: 0 })
    await s.newContextKanban()
    expect(s.newKanban).toHaveBeenCalledTimes(1)
    expect(s.createKanban).not.toHaveBeenCalled()
  })
})

describe('newKanbanFromArgument', () => {
  it('creates in the folder an argument names, and says why when it cannot', async () => {
    const s = await load()
    s.useStore.setState({ folders: [{ folder: 'inbox', subpath: 'Biology', siblingOrder: 0 }] })
    await s.newKanbanFromArgument('biology')
    expect(s.createKanban).toHaveBeenCalledWith('inbox', 'Biology')
    const { useToastStore } = await import('./toast')
    await s.newKanbanFromArgument('Nowhere')
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('No folder called "Nowhere" in this vault')
    await s.newKanbanFromArgument('trash')
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('A Kanban can\'t go in "trash"')
    expect(s.createKanban).toHaveBeenCalledTimes(1)
  })
})
