// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findLeaf } from './lib/pane-layout'

const original = new Map([
  ['one.md', '# First note\n\nOriginal body.\n'],
  ['two.md', '# Second note\n\nDifferent body.\n']
])
let vault: Map<string, string>
const disposers: Array<() => void> = []

function meta(path: string, body: string) {
  return {
    path,
    title: path,
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: body.slice(0, 40)
  }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  vault = new Map(original)
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: () => ({ supportsRemoteWorkspace: false }),
      listNotes: async () => [...vault].map(([path, body]) => meta(path, body)),
      listFolders: async () => [],
      listAssets: async () => [],
      listLocalVaults: async () => [],
      hasAssetsDir: async () => false,
      getRemoteWorkspaceInfo: async () => null,
      scanTasks: async () => [],
      scanTasksForPath: async () => [],
      readNote: async (path: string) => {
        const body = vault.get(path)
        if (body === undefined) throw new Error(`Missing note: ${path}`)
        return { ...meta(path, body), body }
      },
      writeNote: async (path: string, body: string) => {
        vault.set(path, body)
        return meta(path, body)
      }
    }
  })
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

async function setup() {
  const { useStore } = await import('./store')
  const navigation = await import('./navigation')
  useStore.setState({
    notes: [...vault].map(([path, body]) => meta(path, body))
  })
  return { useStore, ...navigation }
}

describe('public shell navigation', () => {
  it('shows Home without closing tabs or modifying note bytes', async () => {
    const { useStore, openNote, goHome } = await setup()
    await openNote('one.md')
    await openNote('two.md')
    goHome()
    const state = useStore.getState()
    expect(findLeaf(state.paneLayout, state.activePaneId)).toMatchObject({
      tabs: ['one.md', 'two.md'],
      activeTab: null
    })
    expect(state.selectedPath).toBeNull()
    expect(state.activeNote).toBeNull()
    expect(vault).toEqual(original)
  })

  it('saves only the edited note when returning Home', async () => {
    const { useStore, openNote, goHome } = await setup()
    await openNote('one.md')
    useStore
      .getState()
      .updateNoteBody('one.md', '# First note\n\nEdited body.\n')
    goHome()
    await vi.waitFor(() =>
      expect(useStore.getState().noteDirty['one.md']).toBe(false)
    )
    expect(vault.get('one.md')).toBe('# First note\n\nEdited body.\n')
    expect(vault.get('two.md')).toBe(original.get('two.md'))
    expect(useStore.getState().selectedPath).toBeNull()
  })

  it('keeps Home during a rescan and still allows deliberate navigation', async () => {
    const { useStore, openNote, goHome, installHomeGuard } = await setup()
    disposers.push(installHomeGuard())
    await openNote('one.md')
    await openNote('two.md')
    goHome()
    await useStore.getState().refreshNotes()
    expect(useStore.getState().selectedPath).toBeNull()
    await openNote('two.md')
    expect(useStore.getState().selectedPath).toBe('two.md')
    expect(useStore.getState().activeNote?.body).toBe(original.get('two.md'))
  })

  it('removes the Home guard when its shell unmounts', async () => {
    const { useStore, openNote, goHome, installHomeGuard } = await setup()
    const dispose = installHomeGuard()
    disposers.push(dispose)
    await openNote('one.md')
    goHome()
    dispose()
    await useStore.getState().refreshNotes()
    expect(useStore.getState().selectedPath).toBe('one.md')
  })

  it('uses the existing note history for back and forward', async () => {
    const { useStore, openNote, goBack, goForward } = await setup()
    const { getShellSnapshot } = await import('./shell')
    expect(getShellSnapshot()).toMatchObject({
      canGoBack: false,
      canGoForward: false
    })
    await openNote('one.md')
    await openNote('two.md')
    expect(getShellSnapshot()).toMatchObject({
      canGoBack: true,
      canGoForward: false,
      selectedNote: { path: 'two.md' }
    })
    await goBack()
    expect(useStore.getState().selectedPath).toBe('one.md')
    expect(getShellSnapshot()).toMatchObject({
      canGoForward: true,
      selectedNote: { path: 'one.md' }
    })
    await goForward()
    expect(useStore.getState().selectedPath).toBe('two.md')
    expect(getShellSnapshot().canGoForward).toBe(false)
    expect(vault).toEqual(original)
  })
})

describe('navigation across workspace changes', () => {
  function gate<T>() {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
  }
  it('does not read the old relative target in a new vault after a pending save', async () => {
    const s = await setup()
    s.useStore.setState({ vault: { root: '/one', name: 'One' } })
    await s.openNote('one.md')
    const save = gate<void>()
    s.useStore.setState({ noteDirty: { 'one.md': true }, persistNote: () => save.promise })
    const read = vi.spyOn(window.zen, 'readNote')
    const pending = s.openNote('two.md')
    s.useStore.setState({ vault: { root: '/two', name: 'Two' } })
    save.resolve()
    await pending
    expect(read).not.toHaveBeenCalled()
    expect(s.useStore.getState().selectedPath).toBe('one.md')
  })
  it.each(['openNoteInPane', 'focusTabInPane'] as const)('does not install an old read through %s', async method => {
    const s = await setup(), read = gate<ReturnType<typeof meta> & { body: string }>()
    s.useStore.setState({ vault: { root: '/one', name: 'One' } })
    vi.spyOn(window.zen, 'readNote').mockReturnValue(read.promise)
    const pending = s.useStore.getState()[method](s.useStore.getState().activePaneId, 'one.md')
    s.useStore.setState({ vault: { root: '/two', name: 'Two' } })
    read.resolve({ ...meta('one.md', 'old'), body: 'old' })
    await pending
    expect(s.useStore.getState().noteContents).toEqual({})
    expect(s.useStore.getState().selectedPath).toBeNull()
  })
  it('rejects a task read that finishes after the vault changes', async () => {
    const s = await setup(), read = gate<ReturnType<typeof meta> & { body: string }>()
    const tasks = await import('./tasks')
    const task = { id: 'task', sourcePath: 'one.md', noteFolder: 'inbox', lineNumber: 0, taskIndex: 0 } as import('@bridge-contract/tasks').VaultTask
    s.useStore.setState({ vault: { root: '/one', name: 'One' }, vaultTasks: [task] })
    vi.spyOn(window.zen, 'readNote').mockReturnValue(read.promise)
    const pending = tasks.openTask('task')
    s.useStore.setState({ vault: { root: '/two', name: 'Two' } })
    read.resolve({ ...meta('one.md', '- [ ] Old task'), body: '- [ ] Old task' })
    expect(await pending).toBe(false)
    expect(s.useStore.getState().pendingJumpLocation).toBeNull()
    expect(s.useStore.getState().selectedPath).toBeNull()
  })
  it.each(['one#Heading', 'one#^block'])('rejects a stale anchored wikilink %s', async target => {
    const s = await setup(), read = gate<ReturnType<typeof meta> & { body: string }>()
    s.useStore.setState({ vault: { root: '/one', name: 'One' }, notes: [{ ...meta('one.md', ''), title: 'one' }] })
    const spy = vi.spyOn(window.zen, 'readNote').mockReturnValue(read.promise)
    const pending = s.openWikilink(target)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    s.useStore.setState({ vault: { root: '/two', name: 'Two' } })
    read.resolve({ ...meta('one.md', ''), body: '# Heading\n\nBlock ^block\n' })
    expect(await pending).toBe(false)
    expect(s.useStore.getState().selectedPath).toBeNull()
    expect(s.useStore.getState().pendingJumpLocation).toBeNull()
  })
})
