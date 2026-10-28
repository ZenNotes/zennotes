// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./note-lifecycle-actions', () => ({
  runNoteLifecycleAction: vi.fn().mockResolvedValue('completed'),
  runNoteBatchAction: vi.fn().mockResolvedValue(true),
  runEmptyTrash: vi.fn()
}))

function installZen(platform: NodeJS.Platform = 'darwin'): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => platform,
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false
      })
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  return {
    ...(await import('../store')),
    ...(await import('./sidebar-note-actions')),
    ...(await import('./note-lifecycle-actions')),
    ...(await import('./commands')),
    ...(await import('./toast'))
  }
}

const note = (folder: string, path: string) =>
  ({ folder, path, title: path.split('/').pop()?.replace(/\.md$/, ''), body: '' }) as never

const NOTES = [
  { path: 'inbox/A.md', folder: 'inbox' as const },
  { path: 'inbox/B.md', folder: 'inbox' as const },
  { path: 'inbox/C.md', folder: 'inbox' as const },
  { path: 'archive/D.md', folder: 'archive' as const },
  { path: 'trash/E.md', folder: 'trash' as const },
  { path: 'trash/F.md', folder: 'trash' as const }
]

const LABELS = { inbox: 'Inbox', quick: 'Quick Notes', archive: 'Archive', trash: 'Trash' }

const noSelection = { count: 0, notePaths: new Set<string>(), actionNotePaths: [], folderCount: 0 }

function selectionOf(paths: string[], folderCount = 0) {
  return {
    count: paths.length + folderCount,
    notePaths: new Set(paths),
    actionNotePaths: paths,
    folderCount
  }
}

function chord(init: KeyboardEventInit & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

const cmdBackspace = (init: KeyboardEventInit = {}): KeyboardEvent =>
  chord({ key: 'Backspace', code: 'Backspace', metaKey: true, ...init })
const plainX = (): KeyboardEvent => chord({ key: 'x', code: 'KeyX' })

/** Sidebar rows the way Sidebar draws them, cursor numbers included. */
function drawSidebar(): void {
  document.body.innerHTML = `
    <aside data-zen-sidebar>
      <div data-sidebar-idx="9" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath=""></div>
      <div data-sidebar-idx="10" data-sidebar-type="note" data-sidebar-path="inbox/A.md"></div>
      <div data-sidebar-idx="11" data-sidebar-type="note" data-sidebar-path="inbox/B.md"></div>
      <div data-sidebar-idx="12" data-sidebar-type="note" data-sidebar-path="inbox/C.md"></div>
      <div data-sidebar-idx="13" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath="Projects"></div>
      <div data-sidebar-idx="3" data-sidebar-type="trash"></div>
      <div data-sidebar-idx="20" data-sidebar-type="note" data-sidebar-path="trash/E.md"></div>
    </aside>`
}

const closedState = {
  whatsNewOpen: false,
  settingsOpen: false,
  searchOpen: false,
  vaultTextSearchOpen: false,
  commandPaletteOpen: false,
  bufferPaletteOpen: false,
  templatePaletteOpen: false,
  embedDrawingPaletteOpen: false,
  outlinePaletteOpen: false,
  commandKeymaps: {},
  keymapOverrides: {},
  vimMode: true,
  focusedPanel: 'sidebar' as string | null,
  sidebarOpen: true,
  sidebarCursorIndex: 10
}

beforeEach(() => {
  vi.clearAllMocks()
  installZen()
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('planSidebarNoteAction (#972)', () => {
  const plan = async (
    overrides: Partial<{
      action: 'trash' | 'archive'
      path: string
      selection: ReturnType<typeof selectionOf> | typeof noSelection
      vimMode: boolean
      permanentForTrashed: boolean
    }>
  ) => {
    const { planSidebarNoteAction } = await load()
    return planSidebarNoteAction({
      action: 'trash',
      path: 'inbox/A.md',
      notes: NOTES,
      selection: noSelection,
      labels: LABELS,
      vimMode: true,
      permanentForTrashed: true,
      ...overrides
    })
  }

  it('moves a single note row to the Trash', async () => {
    expect(await plan({})).toEqual({ kind: 'run', action: 'trash', paths: ['inbox/A.md'], batch: false })
  })

  it('takes the whole selection, with one confirm, when it includes the cursor row', async () => {
    const selection = selectionOf(['inbox/A.md', 'inbox/B.md', 'inbox/C.md'])
    expect(await plan({ path: 'inbox/B.md', selection })).toEqual({
      kind: 'run',
      action: 'trash',
      paths: ['inbox/A.md', 'inbox/B.md', 'inbox/C.md'],
      batch: true
    })
  })

  it('takes only the cursor row when the selection does not include it', async () => {
    const selection = selectionOf(['inbox/B.md', 'inbox/C.md'])
    expect(await plan({ path: 'inbox/A.md', selection })).toEqual({
      kind: 'run',
      action: 'trash',
      paths: ['inbox/A.md'],
      batch: false
    })
  })

  it('refuses a selection that includes folders, naming the menu key for the mode', async () => {
    const selection = selectionOf(['inbox/A.md', 'inbox/B.md'], 1)
    const on = await plan({ selection })
    expect(on.kind).toBe('refuse')
    expect(on.kind === 'refuse' && on.reason).toContain('(m)')
    const off = await plan({ selection, vimMode: false })
    expect(off.kind === 'refuse' && off.reason).toContain('(right-click)')
  })

  it('deletes a note in the Trash for good from the keys, and refuses it from the command', async () => {
    expect(await plan({ path: 'trash/E.md' })).toEqual({
      kind: 'run',
      action: 'delete',
      paths: ['trash/E.md'],
      batch: false
    })
    expect(await plan({ path: 'trash/E.md', permanentForTrashed: false })).toEqual({
      kind: 'refuse',
      reason: 'This note is already in the Trash'
    })
    const selection = selectionOf(['trash/E.md', 'trash/F.md'])
    expect(await plan({ path: 'trash/E.md', selection })).toEqual({
      kind: 'run',
      action: 'delete',
      paths: ['trash/E.md', 'trash/F.md'],
      batch: true
    })
  })

  it('archives a note row, or the archivable part of a selection', async () => {
    expect(await plan({ action: 'archive' })).toEqual({
      kind: 'run',
      action: 'archive',
      paths: ['inbox/A.md'],
      batch: false
    })
    expect(await plan({ action: 'archive', path: 'archive/D.md' })).toEqual({
      kind: 'refuse',
      reason: 'This note is already in the Archive'
    })
    const selection = selectionOf(['inbox/A.md', 'inbox/B.md', 'archive/D.md'])
    expect(await plan({ action: 'archive', selection })).toEqual({
      kind: 'run',
      action: 'archive',
      paths: ['inbox/A.md', 'inbox/B.md'],
      batch: true
    })
  })
})

describe('sidebarRowRefusal', () => {
  it('points a folder at its menu, in the words of the mode, and says nothing is undone there', async () => {
    const { sidebarRowRefusal } = await load()
    const folder = { type: 'folder', path: null, folder: 'inbox', subpath: 'Projects' }
    expect(sidebarRowRefusal(folder, LABELS, true)).toBe(
      "A folder can't go to the Trash. Delete it from its menu (m); that can't be undone"
    )
    expect(sidebarRowRefusal(folder, LABELS, false)).toContain('(right-click)')
    const top = { type: 'folder', path: null, folder: 'inbox', subpath: '' }
    expect(sidebarRowRefusal(top, LABELS, true)).toBe('Only a note can go to the Trash from here')
    expect(sidebarRowRefusal({ type: 'trash', path: null, folder: null, subpath: null }, LABELS, true)).toBe(
      'Only a note can go to the Trash from here'
    )
  })
})

describe('the sidebar trash chord (#972)', () => {
  it('runs on Cmd+Backspace with the sidebar focused, Vim on or off', async () => {
    const { handleSidebarTrashChord } = await load()
    for (const vimMode of [true, false]) {
      const run = vi.fn()
      const event = cmdBackspace()
      expect(handleSidebarTrashChord(event, () => ({ ...closedState, vimMode }), run)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      expect(run).toHaveBeenCalledTimes(1)
    }
  })

  it('is Ctrl+Backspace on Linux and Windows', async () => {
    installZen('linux')
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    const ctrl = chord({ key: 'Backspace', code: 'Backspace', ctrlKey: true })
    expect(handleSidebarTrashChord(ctrl, () => closedState, run)).toBe(true)
    expect(handleSidebarTrashChord(cmdBackspace(), () => closedState, run)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('leaves the typed x to VimNav, and with Vim off nothing takes it', async () => {
    const { handleSidebarTrashChord, isSidebarTrashKey } = await load()
    const run = vi.fn()
    expect(handleSidebarTrashChord(plainX(), () => closedState, run)).toBe(false)
    expect(handleSidebarTrashChord(plainX(), () => ({ ...closedState, vimMode: false }), run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    // VimNav's own check: x is a trash key with Vim on, and not with Vim off.
    expect(isSidebarTrashKey(plainX(), {}, true)).toBe(true)
    expect(isSidebarTrashKey(plainX(), {}, false)).toBe(false)
  })

  it('takes a chord the user gave nav.delete, in either mode', async () => {
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    const state = {
      ...closedState,
      vimMode: false,
      keymapOverrides: { 'nav.delete': 'Ctrl+Backspace', 'nav.sidebarTrash': '' }
    }
    const ctrl = chord({ key: 'Backspace', code: 'Backspace', ctrlKey: true })
    expect(handleSidebarTrashChord(ctrl, () => state, run)).toBe(true)
    // Unbound, the default chord is free again.
    expect(handleSidebarTrashChord(cmdBackspace(), () => state, run)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does nothing unless the sidebar holds the keyboard', async () => {
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    for (const focusedPanel of ['editor', null, 'tasks']) {
      const event = cmdBackspace()
      expect(handleSidebarTrashChord(event, () => ({ ...closedState, focusedPanel }), run)).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(handleSidebarTrashChord(cmdBackspace(), () => ({ ...closedState, sidebarOpen: false }), run)).toBe(
      false
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('stands down while a dialog, menu or palette is open, and in a text field', async () => {
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    for (const html of ['<div aria-modal="true"></div>', '<div data-ctx-menu></div>', '<div data-prompt-modal></div>']) {
      document.body.innerHTML = html
      expect(handleSidebarTrashChord(cmdBackspace(), () => closedState, run)).toBe(false)
    }
    document.body.innerHTML = ''
    expect(handleSidebarTrashChord(cmdBackspace(), () => ({ ...closedState, commandPaletteOpen: true }), run)).toBe(
      false
    )
    const input = document.createElement('input')
    document.body.appendChild(input)
    const typed = cmdBackspace()
    Object.defineProperty(typed, 'target', { value: input })
    expect(handleSidebarTrashChord(typed, () => closedState, run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves a chord a global shortcut has to that shortcut', async () => {
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    const state = { ...closedState, keymapOverrides: { 'nav.sidebarTrash': 'Mod+P' } }
    expect(handleSidebarTrashChord(chord({ key: 'p', code: 'KeyP', metaKey: true }), () => state, run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once per press, not once per auto-repeat', async () => {
    const { handleSidebarTrashChord } = await load()
    const run = vi.fn()
    const held = cmdBackspace({ repeat: true })
    expect(handleSidebarTrashChord(held, () => closedState, run)).toBe(true)
    expect(held.defaultPrevented).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('is heard before a list view that registered on the window later', async () => {
    const { installSidebarTrashKeys, useStore, runNoteLifecycleAction } = await load()
    drawSidebar()
    useStore.setState({
      notes: NOTES as never,
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 11
    } as never)
    const uninstall = installSidebarTrashKeys(() => useStore.getState())
    const archiveView = vi.fn()
    window.addEventListener('keydown', archiveView, true)
    try {
      window.dispatchEvent(cmdBackspace())
      expect(archiveView).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(runNoteLifecycleAction).toHaveBeenCalledWith('inbox/B.md', 'trash'))
    } finally {
      window.removeEventListener('keydown', archiveView, true)
      uninstall()
    }
  })
})

describe('trashSidebarCursorRow', () => {
  async function setup(cursor: number) {
    const loaded = await load()
    drawSidebar()
    loaded.useStore.setState({
      notes: NOTES as never,
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: cursor,
      vimMode: true
    } as never)
    return loaded
  }

  it('trashes the note under the cursor, holding the cursor while it runs', async () => {
    const { trashSidebarCursorRow, registerSidebarActionHost, runNoteLifecycleAction } = await setup(12)
    let holds = 0
    const unregister = registerSidebarActionHost({
      selection: () => noSelection,
      clearSelection: vi.fn(),
      holdCursor: (run) => {
        holds += 1
        return run()
      }
    })
    try {
      expect(await trashSidebarCursorRow()).toBe(true)
      expect(runNoteLifecycleAction).toHaveBeenCalledWith('inbox/C.md', 'trash')
      expect(holds).toBe(1)
    } finally {
      unregister()
    }
  })

  it('trashes the selection with one batch and clears it', async () => {
    const { trashSidebarCursorRow, registerSidebarActionHost, runNoteBatchAction, runNoteLifecycleAction } =
      await setup(11)
    const clearSelection = vi.fn()
    const unregister = registerSidebarActionHost({
      selection: () => selectionOf(['inbox/A.md', 'inbox/B.md', 'inbox/C.md']),
      clearSelection,
      holdCursor: (run) => run()
    })
    try {
      expect(await trashSidebarCursorRow()).toBe(true)
      expect(runNoteBatchAction).toHaveBeenCalledWith(['inbox/A.md', 'inbox/B.md', 'inbox/C.md'], 'trash')
      expect(runNoteLifecycleAction).not.toHaveBeenCalled()
      expect(clearSelection).toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('offers permanent delete on a note in the Trash', async () => {
    const { trashSidebarCursorRow, runNoteLifecycleAction } = await setup(20)
    await trashSidebarCursorRow()
    expect(runNoteLifecycleAction).toHaveBeenCalledWith('trash/E.md', 'delete')
  })

  it('leaves a folder alone and says where folders are deleted', async () => {
    const { trashSidebarCursorRow, runNoteLifecycleAction, runNoteBatchAction, useToastStore } = await setup(13)
    expect(await trashSidebarCursorRow()).toBe(false)
    expect(runNoteLifecycleAction).not.toHaveBeenCalled()
    expect(runNoteBatchAction).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "A folder can't go to the Trash. Delete it from its menu (m); that can't be undone"
    ])
  })

  it('a cancelled confirm leaves the selection as it was', async () => {
    const { trashSidebarCursorRow, registerSidebarActionHost, runNoteBatchAction } = await setup(11)
    vi.mocked(runNoteBatchAction).mockResolvedValueOnce(false)
    const clearSelection = vi.fn()
    const unregister = registerSidebarActionHost({
      selection: () => selectionOf(['inbox/A.md', 'inbox/B.md']),
      clearSelection,
      holdCursor: (run) => run()
    })
    try {
      expect(await trashSidebarCursorRow()).toBe(false)
      expect(clearSelection).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})

describe('Move Note to Trash follows the sidebar (#972)', () => {
  async function command(id: string) {
    const loaded = await load()
    const cmd = loaded.buildCommands({ includeUnavailable: true }).find((c) => c.id === id)
    if (!cmd) throw new Error(`no ${id}`)
    return { ...loaded, cmd }
  }

  it('acts on the sidebar row, not the open note, while the sidebar holds focus', async () => {
    drawSidebar()
    const { cmd, useStore, runNoteLifecycleAction } = await command('note.trash')
    const trashActive = vi.fn()
    useStore.setState({
      notes: NOTES as never,
      activeNote: note('inbox', 'inbox/A.md'),
      selectedPath: 'inbox/A.md',
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 12,
      trashActive
    } as never)
    expect(cmd.when?.()).toBe(true)
    await cmd.run()
    expect(runNoteLifecycleAction).toHaveBeenCalledWith('inbox/C.md', 'trash')
    expect(trashActive).not.toHaveBeenCalled()
  })

  it('works on the sidebar row with no note open in the editor', async () => {
    drawSidebar()
    const { cmd, useStore } = await command('note.trash')
    useStore.setState({
      notes: NOTES as never,
      activeNote: null,
      selectedPath: null,
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 10
    } as never)
    expect(cmd.when?.()).toBe(true)
  })

  it('keeps acting on the open note when the editor has focus or the cursor is not on a note', async () => {
    drawSidebar()
    const { cmd, useStore, runNoteLifecycleAction } = await command('note.trash')
    const trashActive = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      notes: NOTES as never,
      activeNote: note('inbox', 'inbox/A.md'),
      selectedPath: 'inbox/A.md',
      focusedPanel: 'editor',
      sidebarOpen: true,
      sidebarCursorIndex: 12,
      trashActive
    } as never)
    await cmd.run()
    expect(trashActive).toHaveBeenCalledTimes(1)
    useStore.setState({ focusedPanel: 'sidebar', sidebarCursorIndex: 13 } as never)
    await cmd.run()
    expect(trashActive).toHaveBeenCalledTimes(2)
    expect(runNoteLifecycleAction).not.toHaveBeenCalled()
    // With nothing open either, it says what is missing.
    useStore.setState({ activeNote: null, selectedPath: null } as never)
    expect(cmd.when?.()).toBe(false)
    expect(cmd.unavailableReason?.()).toBe('Move Note to Trash needs an open note')
  })

  it('says a trashed sidebar note is in the Trash already', async () => {
    drawSidebar()
    const { cmd, useStore } = await command('note.trash')
    useStore.setState({
      notes: NOTES as never,
      activeNote: note('inbox', 'inbox/A.md'),
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 20
    } as never)
    expect(cmd.when?.()).toBe(false)
    expect(cmd.unavailableReason?.()).toBe('This note is already in the Trash')
  })

  it('Move Note to Archive follows the sidebar the same way', async () => {
    drawSidebar()
    const { cmd, useStore, runNoteLifecycleAction } = await command('note.archive')
    const archiveActive = vi.fn()
    useStore.setState({
      notes: NOTES as never,
      activeNote: note('inbox', 'inbox/A.md'),
      selectedPath: 'inbox/A.md',
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: 11,
      archiveActive
    } as never)
    expect(cmd.when?.()).toBe(true)
    await cmd.run()
    expect(runNoteLifecycleAction).toHaveBeenCalledWith('inbox/B.md', 'archive')
    expect(archiveActive).not.toHaveBeenCalled()
  })
})
