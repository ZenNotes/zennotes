// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { closeSearchPanel, searchPanelOpen } from '@codemirror/search'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteContent } from '@shared/ipc'
import { useStore } from '../store'
import { PinnedReferencePane } from './PinnedReferencePane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note: NoteContent = {
  path: 'inbox/Reference.md',
  title: 'Reference',
  folder: 'inbox',
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 10,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: 'alpha beta',
  body: 'alpha beta'
}

describe('PinnedReferencePane search bindings (#860)', () => {
  let host: HTMLDivElement
  let root: Root
  let view: EditorView
  let originalState: ReturnType<typeof useStore.getState>

  beforeEach(async () => {
    // jsdom has no layout; CodeMirror still measures the caret after a key.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => []
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect()
    })
    originalState = useStore.getState()
    useStore.setState({
      vault: { root: '/vault', name: 'Vault' },
      selectedPath: note.path,
      pinnedRefPath: note.path,
      pinnedRefKind: 'note',
      pinnedRefVisible: true,
      pinnedRefMode: 'edit',
      noteRefs: {},
      noteContents: { [note.path]: note },
      noteDirty: {},
      vimMode: false,
      livePreview: false,
      keymapOverrides: {},
      searchOpen: false,
      updateNoteBody: vi.fn()
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(createElement(PinnedReferencePane)))
    view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  async function press(key: string, modifiers: KeyboardEventInit = {}): Promise<void> {
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, ...modifiers
      }))
    })
  }

  it('hands an unbound Mod+F to the find bar without replacing the editor or its undo history', async () => {
    await press('f', { ctrlKey: true })
    expect(useStore.getState().searchOpen).toBe(true)
    act(() => {
      useStore.getState().setSearchOpen(false)
      view.dispatch({ changes: { from: note.body.length, insert: ' draft' }, selection: { anchor: 16 } })
    })
    const selection = view.state.selection

    await act(async () => useStore.setState({ keymapOverrides: { 'global.searchNotesNonVim': '' } }))

    expect(EditorView.findFromDOM(host.querySelector('.cm-editor')!)).toBe(view)
    expect(view.state.doc.toString()).toBe('alpha beta draft')
    expect(view.state.selection.eq(selection)).toBe(true)
    await press('f', { ctrlKey: true })
    expect(useStore.getState().searchOpen).toBe(false)
    expect(searchPanelOpen(view.state)).toBe(true)
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe(note.body)
  })

  it('uses the new shortcut immediately and releases it when the default is restored', async () => {
    await act(async () => useStore.setState({ keymapOverrides: { 'global.searchNotesNonVim': 'F6' } }))
    await press('F6')
    expect(useStore.getState().searchOpen).toBe(true)
    act(() => useStore.getState().setSearchOpen(false))

    await press('f', { ctrlKey: true })
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(useStore.getState().searchOpen).toBe(false)
    act(() => { closeSearchPanel(view) })

    await act(async () => useStore.setState({ keymapOverrides: {} }))
    await press('F6')
    expect(useStore.getState().searchOpen).toBe(false)
    await press('f', { ctrlKey: true })
    expect(useStore.getState().searchOpen).toBe(true)
    expect(searchPanelOpen(view.state)).toBe(false)
  })
})

describe('PinnedReferencePane reveal in the sidebar', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>

  // Revealing focuses the sidebar with retries, on timers that must not outlive the
  // test's window: there is no sidebar here for them to settle on.
  const focusRetriesDone = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

  beforeEach(() => {
    originalState = useStore.getState()
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => []
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect()
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await focusRetriesDone()
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  async function reveal(
    path: string,
    settings: Record<string, unknown>,
    layout: { unifiedSidebar: boolean; noteListOpen: boolean } = {
      unifiedSidebar: true,
      noteListOpen: false
    }
  ): Promise<void> {
    const pinned = { ...note, path }
    useStore.setState({
      vault: { root: '/vault', name: 'Vault' },
      selectedPath: 'inbox/Open.md',
      pinnedRefPath: path,
      pinnedRefKind: 'note',
      pinnedRefVisible: true,
      pinnedRefMode: 'edit',
      noteRefs: {},
      noteContents: { [path]: pinned },
      noteDirty: {},
      vimMode: false,
      livePreview: false,
      keymapOverrides: {},
      searchOpen: false,
      updateNoteBody: vi.fn(),
      sidebarOpen: true,
      vaultSettings: { ...originalState.vaultSettings, ...settings },
      collapsedFolders: ['inbox:', 'inbox:Projects', 'inbox:Projects/Deep', 'archive:Sub', 'other:'],
      ...layout
    } as never)
    await act(async () => root.render(createElement(PinnedReferencePane)))
    const button = host.querySelector<HTMLButtonElement>('button[title^="Reveal "]')!
    await act(async () => button.click())
  }

  it('finds the folders of a note in a vault that keeps notes at its root', async () => {
    await reveal('Projects/Deep/Reference.md', { primaryNotesLocation: 'root' })
    const state = useStore.getState()
    expect(state.collapsedFolders).toEqual(['archive:Sub', 'other:'])
    expect(state.focusedPanel).toBe('sidebar')
    expect(state.selectedPath).toBe('inbox/Open.md')
  })

  it('finds the folders of a note under a moved system folder', async () => {
    await reveal('99 Old/Sub/Reference.md', {
      primaryNotesLocation: 'inbox',
      systemFolderPaths: { archive: '99 Old' }
    })
    expect(useStore.getState().collapsedFolders).not.toContain('archive:Sub')
    expect(useStore.getState().collapsedFolders).toContain('inbox:')
  })

  it('shows the right folder in the note list layout', async () => {
    await reveal(
      'Projects/Deep/Reference.md',
      { primaryNotesLocation: 'root' },
      { unifiedSidebar: false, noteListOpen: true }
    )
    expect(useStore.getState().view).toEqual({
      kind: 'folder',
      folder: 'inbox',
      subpath: 'Projects/Deep'
    })
  })
})
