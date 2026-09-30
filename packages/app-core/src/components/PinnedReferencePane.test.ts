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
