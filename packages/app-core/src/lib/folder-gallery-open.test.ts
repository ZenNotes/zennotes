// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteContent, NoteMeta } from '@shared/ipc'

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
  const open = await import('./folder-gallery-open')
  const { galleryTabPath } = await import('./folder-gallery')
  const { makeLeaf } = await import('./pane-layout')
  return { useStore, ...open, galleryTabPath, makeLeaf }
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

describe('contextGalleryFolder', () => {
  it('takes the folder row under the sidebar cursor while the sidebar has focus', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'folder', 'data-sidebar-folder': 'inbox', 'data-sidebar-subpath': 'Recipes' })
    s.useStore.setState({ focusedPanel: 'sidebar', sidebarOpen: true, sidebarCursorIndex: 0 })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'inbox', subpath: 'Recipes' })
  })

  it('takes a note row’s own folder, and the Archive row as the archive', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'note', 'data-sidebar-path': 'inbox/Recipes/Desserts/Cake.md' })
    sidebarRow(1, { 'data-sidebar-type': 'archive' })
    s.useStore.setState({
      notes: [note('inbox/Recipes/Desserts/Cake.md')],
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 0
    })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'inbox', subpath: 'Recipes/Desserts' })
    s.useStore.setState({ sidebarCursorIndex: 1 })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'archive', subpath: '' })
  })

  it('takes the open note’s folder when the sidebar does not have focus', async () => {
    const s = await load()
    sidebarRow(0, { 'data-sidebar-type': 'folder', 'data-sidebar-folder': 'inbox', 'data-sidebar-subpath': 'Recipes' })
    const active: NoteContent = { ...note('inbox/Projects/Website/Plan.md'), body: '' }
    s.useStore.setState({ focusedPanel: 'editor', sidebarCursorIndex: 0, activeNote: active })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'inbox', subpath: 'Projects/Website' })
  })

  it('stays on an open Gallery’s folder, and falls back to the notes area', async () => {
    const s = await load()
    const leaf = s.makeLeaf([s.galleryTabPath('archive', '2025')], s.galleryTabPath('archive', '2025'))
    s.useStore.setState({ focusedPanel: 'editor', activeNote: null, paneLayout: leaf, activePaneId: leaf.id })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'archive', subpath: '2025' })
    const empty = s.makeLeaf()
    s.useStore.setState({ paneLayout: empty, activePaneId: empty.id })
    expect(s.contextGalleryFolder()).toEqual({ folder: 'inbox', subpath: '' })
  })
})

describe('openGalleryFromArgument', () => {
  it('opens the folder an argument names, and says so when none does', async () => {
    const s = await load()
    const openFolderGallery = vi.fn().mockResolvedValue(undefined)
    s.useStore.setState({
      folders: [{ folder: 'inbox', subpath: 'Projects', siblingOrder: 0 }],
      openFolderGallery
    })
    await s.openGalleryFromArgument('projects')
    expect(openFolderGallery).toHaveBeenCalledWith('inbox', 'Projects')
    const { useToastStore } = await import('./toast')
    await s.openGalleryFromArgument('Nowhere')
    expect(openFolderGallery).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('No folder called "Nowhere" in this vault')
  })
})
