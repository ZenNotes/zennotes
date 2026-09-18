// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLeaf } from './lib/pane-layout'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
async function setup() {
  const path = 'inbox/Note.md'
  let disk = '![image](attachements/old.png)'
  const meta = { path, title: 'Note', folder: 'inbox' as const, siblingOrder: 0,
    createdAt: 0, updatedAt: 1, size: disk.length, tags: [], wikilinks: [],
    assetEmbeds: [], hasAttachments: true, excerpt: '' }
  const asset = { path: 'attachements/new.png', name: 'new.png', size: 1, updatedAt: 2 }
  const bridge = {
    getCapabilities: () => ({}), getAppInfo: () => ({ runtime: 'web' }),
    listNotes: async () => [meta], listFolders: async () => [],
    listAssets: async () => [], hasAssetsDir: async () => true,
    scanTasks: async () => [], scanTasksForPath: async () => [],
    getRemoteWorkspaceInfo: async () => null,
    readNote: async () => ({ ...meta, body: disk }),
    writeNote: vi.fn(async (_path: string, body: string) => { disk = body; return meta }),
    renameAsset: vi.fn(async () => { disk = disk.replace('old.png', 'new.png'); return asset }),
    moveAsset: vi.fn(async () => { disk = disk.replace('old.png', 'new.png'); return asset }),
    openLocalVault: vi.fn().mockResolvedValue(null)
  }
  Object.defineProperty(window, 'zen', { configurable: true, value: bridge })
  const { useStore } = await import('./store')
  const leaf = makeLeaf([path], path)
  useStore.setState({ vault: { root: '/test', name: 'Test' }, notes: [meta],
    paneLayout: leaf, activePaneId: leaf.id, selectedPath: path,
    noteContents: { [path]: { ...meta, body: disk + '\nUnsaved edit' } },
    noteDirty: { [path]: true }, activeNote: { ...meta, body: disk + '\nUnsaved edit' }, activeDirty: true })
  return { useStore, bridge, path, asset, disk: () => disk }
}

describe('asset link rewrites across workspace boundaries', () => {
  it.each(['renameAsset', 'moveAsset'] as const)('%s drains edits, reserves the vault and refreshes open bodies', async action => {
    const s = await setup(), saving = deferred(), moving = deferred()
    const write = s.bridge.writeNote.getMockImplementation()!
    s.bridge.writeNote.mockImplementation(async (...args) => { await saving.promise; return write(...args) })
    const rewrite = s.bridge[action].getMockImplementation()!
    s.bridge[action].mockImplementation(async () => { await moving.promise; return rewrite() })
    const pending = s.useStore.getState()[action]('attachements/old.png', 'new.png')
    expect(s.useStore.getState().workspaceTransitioning).toBe(true)
    await s.useStore.getState().openLocalVault('/other')
    expect(s.bridge.openLocalVault).not.toHaveBeenCalled()
    expect(s.bridge[action]).not.toHaveBeenCalled()
    saving.resolve()
    await vi.waitFor(() => expect(s.bridge[action]).toHaveBeenCalledOnce())
    s.useStore.getState().updateNoteBody(s.path, 'Typing during rewrite')
    expect(s.useStore.getState().noteContents[s.path].body).toContain('Unsaved edit')
    await expect(s.useStore.getState()[action]('attachements/old.png', 'other.png')).rejects.toThrow('Wait')
    moving.resolve()
    expect(await pending).toEqual(s.asset)
    expect(s.disk()).toBe('![image](attachements/new.png)\nUnsaved edit')
    expect(s.useStore.getState().activeNote?.body).toBe(s.disk())
    expect(s.useStore.getState().workspaceTransitioning).toBe(false)
    s.useStore.getState().updateNoteBody(s.path, s.disk() + '\nAfter rewrite')
    await s.useStore.getState().persistNote(s.path)
    expect(s.disk()).toBe('![image](attachements/new.png)\nUnsaved edit\nAfter rewrite')
  })
  it('does not rewrite links when the save drain fails', async () => {
    const s = await setup()
    s.bridge.writeNote.mockRejectedValue(new Error('disk full'))
    await expect(s.useStore.getState().renameAsset('old.png', 'new.png')).rejects.toThrow('unsaved')
    expect(s.bridge.renameAsset).not.toHaveBeenCalled()
    expect(s.useStore.getState().noteDirty[s.path]).toBe(true)
    expect(s.useStore.getState().workspaceTransitioning).toBe(false)
  })
  it('releases editing and the workspace reservation after a host failure', async () => {
    const s = await setup()
    s.bridge.moveAsset.mockRejectedValue(new Error('permission denied'))
    await expect(s.useStore.getState().moveAsset('old.png', 'folder')).rejects.toThrow('permission denied')
    expect(s.useStore.getState().workspaceTransitioning).toBe(false)
    s.useStore.getState().updateNoteBody(s.path, 'Recovered edit')
    expect(s.useStore.getState().noteContents[s.path].body).toBe('Recovered edit')
  })
})
