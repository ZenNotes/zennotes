// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'

const CSV = 'Projects.base/data.csv'
const PAGE = 'Projects.base/pages/One.md'
const TWO = 'Projects.base/pages/Two.md'
const body = '# One\n\nKeep café 日本語.  \n'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { vi.resetModules(); localStorage.clear() })
async function setup() {
  const files = new Map([[PAGE, body], [TWO, '# Two\n\nSecond.\n']])
  const metadata = (path: string) => ({ path, title: path.split('/').pop()!, folder: path.startsWith('trash/') ? 'trash' as const : 'inbox' as const,
    siblingOrder: 0, createdAt: 1, updatedAt: 1, size: 0, tags: [], wikilinks: [], assetEmbeds: [], hasAttachments: false, excerpt: '' })
  const doc: DatabaseDoc = {
    version: 1, path: CSV, title: 'Projects', idFieldId: 'id', activeViewId: 'table', views: [],
    fields: [{ id: 'id', name: 'ID', type: 'text' }, { id: 'name', name: 'Name', type: 'text' }, { id: 'status', name: 'Status', type: 'text' }],
    rows: [{ id: 'one', cells: { id: 'one', name: 'One', status: 'Pending' } }, { id: 'two', cells: { id: 'two', name: 'Two', status: 'Open' } }],
    pages: { one: PAGE, two: TWO }, pageHasContent: { one: true, two: true }
  }
  let diskDoc = structuredClone(doc)
  const bridge = {
    getCapabilities: () => ({}), listNotes: async () => [...files.keys()].map(metadata), listFolders: async () => [],
    scanTasks: async () => [], scanTasksForPath: async () => [], hasAssetsDir: async () => false,
    getRemoteWorkspaceInfo: async () => null, setVaultSettings: async (s: unknown) => s,
    readNote: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('Missing page')
      return { ...metadata(path), body: files.get(path)! }
    }),
    writeNote: vi.fn(async (path: string, text: string) => { files.set(path, text); return metadata(path) }),
    writeDatabaseRows: vi.fn(async (_path: string, rows: DatabaseDoc['rows']) => { diskDoc.rows = structuredClone(rows) }),
    writeDatabaseSchema: vi.fn(async (_path: string, schema: object, rows: DatabaseDoc['rows']) => {
      diskDoc = { ...diskDoc, ...structuredClone(schema), rows: structuredClone(rows) }
    }),
    moveToTrash: vi.fn(async (path: string) => {
      const next = `trash/${path.split('/').pop()}`
      files.set(next, files.get(path)!); files.delete(path); return metadata(next)
    })
  }
  Object.defineProperty(window, 'zen', { configurable: true, value: bridge })
  const { useStore } = await import('./store')
  const prompts = await import('./lib/confirm-requests')
  useStore.setState({ vault: { root: '/test', name: 'Test' }, databases: { [CSV]: doc }, notes: [...files.keys()].map(metadata), noteContents: {}, noteDirty: {} })
  const start = (ids = ['one'], trash = true) => {
    const running = useStore.getState().deleteDatabaseRows(CSV, ids)
    const request = prompts.getConfirmRequest()
    if (request) prompts.settleConfirmRequest(request, trash)
    return running
  }
  return { useStore, bridge, files, doc, metadata, prompts, start, disk: () => diskDoc }
}

describe('database row lifecycle', () => {
  it('materializes the latest properties and exact closed-page body before detaching', async () => {
    const s = await setup()
    const pending = s.useStore.getState().deleteDatabaseRows(CSV, ['one'])
    s.useStore.getState().updateDatabaseRows(CSV, { ...s.doc, rows: s.doc.rows.map(r => r.id === 'one' ? { ...r, cells: { ...r.cells, status: 'Ready' } } : r) })
    s.prompts.settleConfirmRequest(s.prompts.getConfirmRequest()!, false)
    await pending
    expect(s.files.get(PAGE)).toBe(`---\nStatus: Ready\n---\n${body}`)
    expect(s.disk().rows.map(r => r.id)).toEqual(['two'])
    expect(s.disk().pages).toEqual({ two: TWO })
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
  })
  it('saves the dirty open page and prevents edits until its move completes', async () => {
    const s = await setup(), gate = deferred()
    s.useStore.setState({ noteContents: { [PAGE]: { ...s.metadata(PAGE), body: body + 'Unsaved\n' } }, noteDirty: { [PAGE]: true } })
    const move = s.bridge.moveToTrash.getMockImplementation()!
    s.bridge.moveToTrash.mockImplementation(async p => { await gate.promise; return move(p) })
    const pending = s.start()
    await vi.waitFor(() => expect(s.bridge.moveToTrash).toHaveBeenCalled())
    s.useStore.getState().updateNoteBody(PAGE, 'must not overwrite')
    s.useStore.getState().updateDatabaseRows(CSV, s.doc)
    expect(s.useStore.getState().databases[CSV].rows.map(r => r.id)).toEqual(['two'])
    gate.resolve(); await pending
    expect(s.files.get('trash/One.md')).toBe(`---\nStatus: Pending\n---\n${body}Unsaved\n`)
    expect(s.useStore.getState().databasesDeletingRows[CSV]).toBe(false)
  })
  it('leaves rows intact and dispatches no trash when a page cannot be saved', async () => {
    const s = await setup()
    s.bridge.writeNote.mockRejectedValue(new Error('disk full'))
    await s.start()
    expect(s.useStore.getState().databases[CSV]).toEqual(s.doc)
    expect(s.bridge.writeDatabaseSchema).not.toHaveBeenCalled()
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
  })
  it('restores recoverable rows and dispatches no trash when the database commit fails', async () => {
    const s = await setup()
    s.bridge.writeDatabaseSchema.mockRejectedValueOnce(new Error('schema unavailable'))
    await s.start()
    expect(s.useStore.getState().databases[CSV]).toEqual(s.doc)
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
    await s.useStore.getState().flushDirtyNotes()
    expect(s.disk().rows).toEqual(s.doc.rows)
    expect(s.disk().pages).toEqual(s.doc.pages)
  })
  it('retains standalone remaining pages if a later move fails after the row commit', async () => {
    const s = await setup(), move = s.bridge.moveToTrash.getMockImplementation()!
    s.bridge.moveToTrash.mockImplementation(async p => { if (p === TWO) throw new Error('locked'); return move(p) })
    await s.start(['one', 'two', 'one'])
    expect(s.disk().rows).toEqual([])
    expect(s.disk().pages).toEqual({})
    expect(s.files.has(PAGE)).toBe(false)
    expect(s.files.get(TWO)).toBe('---\nStatus: Open\n---\n# Two\n\nSecond.\n')
    expect(s.bridge.moveToTrash).toHaveBeenCalledTimes(2)
  })
  it('does not change a page shared by a surviving row or a foreign mapping', async () => {
    const s = await setup()
    s.useStore.setState({ databases: { [CSV]: { ...s.doc, pages: { one: TWO, two: TWO } } } })
    await s.start()
    expect(s.bridge.writeNote).not.toHaveBeenCalled()
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
    s.useStore.setState({ databases: { [CSV]: { ...s.doc, pages: { one: 'inbox/Foreign.md' } } } })
    await s.start()
    expect(s.bridge.readNote).not.toHaveBeenCalled()
    expect(s.bridge.writeNote).not.toHaveBeenCalled()
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
  })
  it('abandons a changed mapping after the confirmation', async () => {
    const s = await setup()
    const pending = s.useStore.getState().deleteDatabaseRows(CSV, ['one'])
    s.useStore.setState({ databases: { [CSV]: { ...s.doc, pages: { one: TWO } } } })
    s.prompts.settleConfirmRequest(s.prompts.getConfirmRequest()!, true)
    await pending
    expect(s.bridge.writeNote).not.toHaveBeenCalled()
    expect(s.bridge.writeDatabaseSchema).not.toHaveBeenCalled()
  })
  it('abandons a vault switch during confirmation', async () => {
    const s = await setup()
    const pending = s.useStore.getState().deleteDatabaseRows(CSV, ['one'])
    s.useStore.setState({ vault: { root: '/other', name: 'Other' } })
    s.prompts.settleConfirmRequest(s.prompts.getConfirmRequest()!, true)
    await pending
    expect(s.bridge.readNote).not.toHaveBeenCalled()
    expect(s.bridge.writeDatabaseSchema).not.toHaveBeenCalled()
  })
  it('waits for the entire page batch before a vault-switch save finishes', async () => {
    const s = await setup(), gate = deferred(), move = s.bridge.moveToTrash.getMockImplementation()!
    s.bridge.moveToTrash.mockImplementation(async p => { await gate.promise; return move(p) })
    const pending = s.start(['one', 'two'])
    await vi.waitFor(() => expect(s.bridge.moveToTrash).toHaveBeenCalled())
    let flushed = false
    const flush = s.useStore.getState().flushDirtyNotes().then(() => { flushed = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(flushed).toBe(false)
    gate.resolve(); await pending; await flush
    expect(s.files.has(TWO)).toBe(false)
    expect(flushed).toBe(true)
  })
  it('does not replace the first row confirmation when deletion is dispatched twice', async () => {
    const s = await setup()
    const first = s.useStore.getState().deleteDatabaseRows(CSV, ['one'])
    const request = s.prompts.getConfirmRequest()!
    await s.useStore.getState().deleteDatabaseRows(CSV, ['two'])
    expect(s.prompts.getConfirmRequest()).toBe(request)
    s.prompts.settleConfirmRequest(request, false)
    await first
    expect(s.disk().rows.map(row => row.id)).toEqual(['two'])
  })
  it('does not trash a page when its selected row disappears during confirmation', async () => {
    const s = await setup()
    const pending = s.useStore.getState().deleteDatabaseRows(CSV, ['one'])
    s.useStore.setState({ databases: { [CSV]: { ...s.doc, rows: s.doc.rows.filter(row => row.id !== 'one') } } })
    s.prompts.settleConfirmRequest(s.prompts.getConfirmRequest()!, true)
    await pending
    expect(s.bridge.writeNote).not.toHaveBeenCalled()
    expect(s.bridge.writeDatabaseSchema).not.toHaveBeenCalled()
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
  })
  it('freezes remapped Trash database edits until an Empty Trash failure releases them', async () => {
    const s = await setup(), gate = deferred(), csv = 'Bin/Projects.base/data.csv'
    const emptyTrash = vi.fn(async () => { await gate.promise; throw new Error('denied') })
    Object.assign(s.bridge, { emptyTrash })
    s.useStore.setState({ databases: { [csv]: { ...s.doc, path: csv } },
      vaultSettings: { ...s.useStore.getState().vaultSettings, systemFolderPaths: { trash: 'Bin' } } })
    const pending = s.useStore.getState().emptyTrash()
    const failed = expect(pending).rejects.toThrow('denied')
    await vi.waitFor(() => expect(emptyTrash).toHaveBeenCalled())
    const original = s.useStore.getState().databases[csv]
    s.useStore.getState().updateDatabaseRows(csv, { ...original, rows: [] })
    s.useStore.getState().updateDatabaseSchema(csv, { ...original, pages: {} })
    expect(s.useStore.getState().databases[csv]).toBe(original)
    gate.resolve(); await failed
    s.useStore.getState().updateDatabaseRows(csv, { ...original, rows: [] })
    expect(s.useStore.getState().databases[csv].rows).toEqual([])
    await s.useStore.getState().flushDirtyNotes()
  })

})
