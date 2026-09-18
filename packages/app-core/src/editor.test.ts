// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedAsset } from '@bridge-contract/ipc'
import type { EditorInsertionTarget } from './editor'

const views: EditorView[] = []
const file = (name = 'one.pdf') => new File(['bytes'], name)
const asset = (name = 'one.pdf'): ImportedAsset => ({ name, path: `assets/${name}`, kind: 'pdf', markdown: `![[assets/${name}]]` })
const image = { data: new Uint8Array([1, 2]), mimeType: 'image/png' }

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  Object.defineProperty(window, 'zen', { configurable: true, value: { getCapabilities: () => ({}) } })
})
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

async function setup(body = 'before after', anchor = 7, head = anchor) {
  const { useStore } = await import('./store')
  const api = await import('./editor')
  const { registerNoteEditor } = await import('./lib/note-editor-context')
  let editorPath: string | null = 'one.md'
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: body, selection: EditorSelection.single(anchor, head) })
  })
  views.push(view)
  registerNoteEditor(view, () => editorPath, useStore.getState().activePaneId)
  useStore.setState({ vault: { root: '/test-vault', name: 'Test' }, selectedPath: 'one.md', editorViewRef: view,
    activeNote: { path: 'one.md', body } as NonNullable<ReturnType<typeof useStore.getState>['activeNote']> })
  const importer = {
    isCurrent: vi.fn(() => true),
    importFile: vi.fn(async (_path: string, input: File) => asset(input.name)),
    importPastedImage: vi.fn(async () => asset('paste.png'))
  }
  return { ...api, importer, view, useStore, setEditorPath: (path: string | null) => { editorPath = path } }
}

describe('public editor attachment insertion', () => {
  it('imports in order, inserts at the captured cursor, and returns the saved assets', async () => {
    const s = await setup()
    const target = s.captureEditorInsertion(s.importer)!
    const result = await s.attachFiles(target, [file(), file('two.pdf')])
    expect(result).toEqual({ status: 'inserted', assets: [asset(), asset('two.pdf')] })
    expect(s.importer.importFile.mock.calls.map(([path, input]) => [path, input.name])).toEqual([
      ['one.md', 'one.pdf'], ['one.md', 'two.pdf']
    ])
    expect(s.view.state.doc.toString()).toBe('before \n\n![[assets/one.pdf]]\n\n![[assets/two.pdf]]\n\nafter')
    expect(s.view.hasFocus).toBe(true)
  })

  it('preserves selected text for file attachment and replaces it for image paste', async () => {
    const s = await setup('before selected after', 7, 15)
    await s.attachFiles(s.captureEditorInsertion(s.importer)!, [file()])
    expect(s.view.state.doc.toString()).toBe('before selected\n\n![[assets/one.pdf]]\n\n after')
    const paste = await setup('before selected after', 15, 7)
    await paste.insertPastedImage(paste.captureEditorInsertion(paste.importer)!, image)
    expect(paste.view.state.doc.toString()).toBe('before \n\n![[assets/paste.png]]\n\n after')
    expect(paste.importer.importPastedImage).toHaveBeenCalledWith(image)
  })

  it('returns no target for unavailable, virtual, read-only, or transitioning editors', async () => {
    const s = await setup()
    s.useStore.setState({ vault: null })
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    s.useStore.setState({ vault: { root: '/test', name: 'Test' }, selectedPath: 'zen://tasks' })
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    s.useStore.setState({ selectedPath: 'other.md' })
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    s.useStore.setState({ selectedPath: 'one.md' })
    s.view.setState(EditorState.create({ doc: 'read only', extensions: EditorState.readOnly.of(true) }))
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    s.view.destroy()
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
  })

  for (const change of ['note', 'document', 'cursor', 'vault', 'editor', 'pane', 'host', 'registered path', 'read-only'] as const) {
    it(`rejects a changed ${change} before importing anything`, async () => {
      const s = await setup()
      const target = s.captureEditorInsertion(s.importer)!
      if (change === 'note') s.useStore.setState({ selectedPath: 'two.md' })
      if (change === 'document') s.view.dispatch({ changes: { from: 0, insert: 'edit' } })
      if (change === 'cursor') s.view.dispatch({ selection: { anchor: 0 } })
      if (change === 'vault') s.useStore.setState({ vault: { root: '/other', name: 'Other' } })
      if (change === 'editor') s.useStore.setState({ editorViewRef: null })
      if (change === 'pane') s.useStore.setState({ activePaneId: 'different-pane' })
      if (change === 'host') s.importer.isCurrent.mockReturnValue(false)
      if (change === 'registered path') s.setEditorPath('two.md')
      if (change === 'read-only') s.view.setState(EditorState.create({ doc: 'before after', extensions: EditorState.readOnly.of(true) }))
      expect(await s.attachFiles(target, [file()])).toEqual({ status: 'stale', assets: [] })
      expect(s.importer.importFile).not.toHaveBeenCalled()
    })
  }

  it('stops a multi-file import after a note switch and preserves already saved files', async () => {
    const s = await setup()
    const focus = vi.spyOn(s.view, 'focus')
    const original = s.view.state.doc.toString()
    s.importer.importFile.mockImplementationOnce(async () => {
      s.useStore.setState({ selectedPath: 'two.md' })
      return asset()
    })
    expect(await s.attachFiles(s.captureEditorInsertion(s.importer)!, [file(), file('two.pdf')]))
      .toEqual({ status: 'saved-only', assets: [asset()] })
    expect(s.importer.importFile).toHaveBeenCalledTimes(1)
    expect(s.view.state.doc.toString()).toBe(original)
    expect(focus).not.toHaveBeenCalled()
  })

  it('stops when the host switches vaults before the store catches up', async () => {
    const s = await setup()
    s.importer.importFile.mockImplementationOnce(async () => {
      s.importer.isCurrent.mockReturnValue(false)
      return asset()
    })
    expect(await s.attachFiles(s.captureEditorInsertion(s.importer)!, [file(), file('two.pdf')]))
      .toEqual({ status: 'saved-only', assets: [asset()] })
    expect(s.importer.importFile).toHaveBeenCalledTimes(1)
    expect(s.view.state.doc.toString()).toBe('before after')
  })

  it('reports partial storage failure without inserting incomplete references', async () => {
    const s = await setup()
    s.importer.importFile.mockResolvedValueOnce(asset()).mockRejectedValueOnce(new Error('Disk full'))
    expect(await s.attachFiles(s.captureEditorInsertion(s.importer)!, [file(), file('two.pdf')]))
      .toEqual({ status: 'failed', assets: [asset()], error: 'Disk full' })
    expect(s.view.state.doc.toString()).toBe('before after')
  })

  it('allows each target only once, including while its import is in flight', async () => {
    const s = await setup()
    let finish!: (value: ImportedAsset) => void
    s.importer.importFile.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const target = s.captureEditorInsertion(s.importer)!
    const first = s.attachFiles(target, [file()])
    expect(await s.attachFiles(target, [file()])).toEqual({ status: 'stale', assets: [] })
    finish(asset())
    expect((await first).status).toBe('inserted')
    expect(await s.attachFiles(target, [file()])).toEqual({ status: 'stale', assets: [] })
    expect(s.importer.importFile).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight insertion without deleting its saved asset', async () => {
    const s = await setup()
    const target = s.captureEditorInsertion(s.importer)!
    s.importer.importFile.mockImplementationOnce(async () => {
      s.cancelEditorInsertion(target)
      return asset()
    })
    expect(await s.attachFiles(target, [file()])).toEqual({ status: 'saved-only', assets: [asset()] })
    expect(s.view.state.doc.toString()).toBe('before after')
  })

  it('rejects stale image reads and image writes without inserting into another note', async () => {
    const s = await setup()
    const beforeRead = s.captureEditorInsertion(s.importer)!
    s.view.dispatch({ selection: { anchor: 0 } })
    expect(await s.insertPastedImage(beforeRead, image)).toEqual({ status: 'stale', assets: [] })
    expect(s.importer.importPastedImage).not.toHaveBeenCalled()
    s.importer.importPastedImage.mockImplementationOnce(async () => {
      s.setEditorPath('other.md')
      return asset('paste.png')
    })
    expect(await s.insertPastedImage(s.captureEditorInsertion(s.importer)!, image))
      .toEqual({ status: 'saved-only', assets: [asset('paste.png')] })
    expect(s.view.state.doc.toString()).toBe('before after')
  })

  it('supports focused clipboard capture while preserving targets through picker blur', async () => {
    const s = await setup()
    expect(s.captureEditorInsertion(s.importer, { requireFocus: true })).toBeNull()
    s.view.focus()
    const target = s.captureEditorInsertion(s.importer, { requireFocus: true })!
    s.view.contentDOM.blur()
    expect(s.view.hasFocus).toBe(false)
    expect((await s.attachFiles(target, [file()])).status).toBe('inserted')
  })

  it('treats host teardown as stale rather than throwing from validation', async () => {
    const s = await setup()
    const target = s.captureEditorInsertion(s.importer)!
    s.importer.isCurrent.mockImplementation(() => { throw new Error('No active vault') })
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    expect(await s.attachFiles(target, [file()])).toEqual({ status: 'stale', assets: [] })
    expect(s.importer.importFile).not.toHaveBeenCalled()
  })

  it('rejects a destroyed view and a cancelled target before calling the host', async () => {
    const s = await setup()
    const destroyed = s.captureEditorInsertion(s.importer)!
    const cancelled = s.captureEditorInsertion(s.importer)!
    s.cancelEditorInsertion(cancelled)
    expect(await s.attachFiles(cancelled, [file()])).toEqual({ status: 'stale', assets: [] })
    s.view.destroy()
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
    expect(await s.attachFiles(destroyed, [file()])).toEqual({ status: 'stale', assets: [] })
    expect(s.importer.importFile).not.toHaveBeenCalled()
  })

  it('rejects fabricated tokens and tokens from another package instance', async () => {
    const s = await setup()
    expect(await s.attachFiles({} as EditorInsertionTarget, [file()])).toEqual({ status: 'stale', assets: [] })
    const target = s.captureEditorInsertion(s.importer)!
    expect(Object.keys(target)).toEqual([])
    expect(Object.isFrozen(target)).toBe(true)
    vi.resetModules()
    const other = await import('./editor')
    expect(await other.attachFiles(target, [file()])).toEqual({ status: 'stale', assets: [] })
    expect(s.importer.importFile).not.toHaveBeenCalled()
  })

  it('snapshots the file list before awaiting storage', async () => {
    const s = await setup()
    const files = [file()]
    s.importer.importFile.mockImplementationOnce(async () => {
      files.push(file('unexpected.pdf'))
      return asset()
    })
    expect(await s.attachFiles(s.captureEditorInsertion(s.importer)!, files))
      .toEqual({ status: 'inserted', assets: [asset()] })
    expect(s.importer.importFile).toHaveBeenCalledTimes(1)
  })

  it('reports an empty batch without inserting text or calling storage', async () => {
    const s = await setup()
    expect(await s.attachFiles(s.captureEditorInsertion(s.importer)!, []))
      .toEqual({ status: 'empty', assets: [] })
    expect(s.view.state.doc.toString()).toBe('before after')
    expect(s.importer.importFile).not.toHaveBeenCalled()
  })

  it('rejects capture after switching panes before the editor reference catches up', async () => {
    const s = await setup()
    s.useStore.setState({ activePaneId: 'other-pane-showing-the-same-note' })
    expect(s.captureEditorInsertion(s.importer)).toBeNull()
  })
})
