// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const views: EditorView[] = []

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { getCapabilities: () => ({}) }
  })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

async function setup() {
  const api = await import('./editor')
  const { useStore } = await import('./store')
  const { noteEditorHostExtension } = await import('./lib/editor-host')
  const { registerNoteEditor } = await import('./lib/note-editor-context')
  function createView() {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'hello',
        selection: { anchor: 5 },
        extensions: [noteEditorHostExtension()]
      })
    })
    views.push(view)
    registerNoteEditor(view, () => 'one.md', useStore.getState().activePaneId)
    useStore.setState({
      vault: { root: '/test', name: 'Test' },
      selectedPath: 'one.md',
      editorViewRef: view,
      activeNote: { path: 'one.md', body: 'hello' } as NonNullable<
        ReturnType<typeof useStore.getState>['activeNote']
      >
    })
    return view
  }
  return { ...api, useStore, createView }
}

function typingAttributes(view: EditorView) {
  return ['autocorrect', 'autocapitalize', 'spellcheck', 'writingsuggestions'].map((name) =>
    view.contentDOM.getAttribute(name)
  )
}

function measureQueue(view: EditorView) {
  const queue: NonNullable<Parameters<EditorView['requestMeasure']>[0]>[] = []
  vi.spyOn(view, 'requestMeasure').mockImplementation((request) => {
    if (request) queue.push(request)
  })
  vi.spyOn(view.dom, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 400, 300))
  vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockImplementation(() => {
    const layout =
      Number.parseFloat(view.dom.style.getPropertyValue('--zen-editor-host-bottom-inset')) || 0
    return new DOMRect(0, 0, 400, 300 - layout)
  })
  return async () => {
    for (let count = 0; queue.length; count++) {
      if (count > 10) throw new Error('Host layout did not stabilize')
      const request = queue.shift()!
      request.write?.(request.read(view), view)
    }
    await Promise.resolve()
  }
}

describe('public editor host integration', () => {
  it('installs native typing before newly created editors can receive focus', async () => {
    const s = await setup()
    const registration = s.installEditorHost({ nativeTyping: true })
    const first = s.createView()
    const second = s.createView()
    expect(typingAttributes(first)).toEqual(['on', 'sentences', 'true', 'true'])
    expect(typingAttributes(second)).toEqual(typingAttributes(first))
    expect(first.hasFocus).toBe(false)
    registration.dispose()
    expect(typingAttributes(first)).toEqual(['off', 'off', 'false', 'false'])
    expect(typingAttributes(s.createView())).toEqual(typingAttributes(first))
  })

  it('configures existing views without changing their document, selection, or focus', async () => {
    const s = await setup()
    const view = s.createView()
    const before = view.state
    s.installEditorHost({ nativeTyping: true })
    expect(typingAttributes(view)).toEqual(['on', 'sentences', 'true', 'true'])
    expect(view.state.doc).toBe(before.doc)
    expect(view.state.selection).toBe(before.selection)
    expect(view.hasFocus).toBe(false)
  })

  it('does not call a host measurer for a destroyed editor', async () => {
    const s = await setup()
    const view = s.createView()
    const measure = vi.fn(() => ({ scroll: 20 }))
    const host = s.installEditorHost({ measureBottomInsets: measure })
    const flush = measureQueue(view)
    host.refresh()
    view.destroy()
    await flush()
    expect(measure).not.toHaveBeenCalled()
  })

  it('lets only the latest registration refresh or dispose the host configuration', async () => {
    const s = await setup()
    const old = s.installEditorHost({ nativeTyping: true })
    const view = s.createView()
    const measure = vi.fn(() => ({ scroll: 10 }))
    const current = s.installEditorHost({ nativeTyping: true, measureBottomInsets: measure })
    const flush = measureQueue(view)
    old.dispose()
    old.refresh()
    await flush()
    expect(measure).not.toHaveBeenCalled()
    expect(typingAttributes(view)).toEqual(['on', 'sentences', 'true', 'true'])
    current.refresh()
    await flush()
    expect(measure).toHaveBeenCalled()
    current.dispose()
    current.dispose()
    expect(typingAttributes(view)).toEqual(['off', 'off', 'false', 'false'])
  })

  it('remeasures the shrunken scroller and avoids counting the overlay twice', async () => {
    const s = await setup()
    const view = s.createView()
    const seen: number[] = []
    const host = s.installEditorHost({
      measureBottomInsets: (viewport) => {
        expect(Object.isFrozen(viewport)).toBe(true)
        expect(Object.isFrozen(viewport.editor)).toBe(true)
        seen.push(viewport.scroll.bottom)
        return { layout: 80, scroll: Math.max(0, viewport.scroll.bottom - 250) }
      }
    })
    const flush = measureQueue(view)
    host.refresh()
    await flush()
    expect(seen).toEqual([300, 220])
    expect(view.dom.style.getPropertyValue('--zen-editor-host-bottom-inset')).toBe('80px')
    expect(view.state.facet(EditorView.scrollMargins).map((source) => source(view))).toContainEqual(
      { bottom: 0 }
    )
    host.dispose()
    expect(view.dom.style.getPropertyValue('--zen-editor-host-bottom-inset')).toBe('')
  })

  it('clamps invalid insets and recovers from host measurement failures', async () => {
    const s = await setup()
    const view = s.createView()
    const measure = vi.fn(() => ({ layout: -10, scroll: Infinity }))
    const host = s.installEditorHost({ measureBottomInsets: measure })
    const flush = measureQueue(view)
    host.refresh()
    await flush()
    expect(view.dom.style.getPropertyValue('--zen-editor-host-bottom-inset')).toBe('0px')
    measure.mockImplementation(() => {
      throw new Error('Host UI was disposed')
    })
    host.refresh()
    await expect(flush()).resolves.toBeUndefined()
    measure.mockImplementation(() => ({ layout: 0, scroll: 9999 }))
    host.refresh()
    await flush()
    expect(view.state.facet(EditorView.scrollMargins).map((source) => source(view))).toContainEqual(
      { bottom: 300 }
    )
  })

  it('reveals only a focused, still-current editor after measurement', async () => {
    const s = await setup()
    const view = s.createView()
    s.installEditorHost({ measureBottomInsets: () => ({ scroll: 20 }) })
    const flush = measureQueue(view)
    expect(s.revealEditorCaret()).toBe(false)
    view.focus()
    const dispatch = vi.spyOn(view, 'dispatch')
    expect(s.revealEditorCaret()).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    await flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toBe('hello')
    expect(view.state.selection.main.head).toBe(5)
  })

  for (const change of ['note', 'vault', 'focus', 'dispose', 'destroy'] as const) {
    it(`cancels a queued caret reveal after ${change} changes`, async () => {
      const s = await setup()
      const view = s.createView()
      const host = s.installEditorHost({ measureBottomInsets: () => ({ scroll: 20 }) })
      const flush = measureQueue(view)
      view.focus()
      expect(s.revealEditorCaret()).toBe(true)
      if (change === 'note') s.useStore.setState({ selectedPath: 'two.md' })
      if (change === 'vault') s.useStore.setState({ vault: { root: '/other', name: 'Other' } })
      if (change === 'focus') view.contentDOM.blur()
      if (change === 'dispose') host.dispose()
      if (change === 'destroy') view.destroy()
      const dispatch = vi.spyOn(view, 'dispatch')
      await flush()
      expect(dispatch).not.toHaveBeenCalled()
    })
  }
})
