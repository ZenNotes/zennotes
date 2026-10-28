// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => 'darwin',
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
    ...(await import('./command-keymap-dispatch')),
    ...(await import('./command-keymap-ex')),
    ...(await import('./toast'))
  }
}

function chord(init: KeyboardEventInit & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

const cmdBackspace = (): KeyboardEvent =>
  chord({ key: 'Backspace', code: 'Backspace', metaKey: true })

const closedState = {
  commandKeymaps: { 'note.trash': 'Mod+Backspace' },
  whatsNewOpen: false,
  settingsOpen: false,
  searchOpen: false,
  vaultTextSearchOpen: false,
  commandPaletteOpen: false,
  bufferPaletteOpen: false,
  templatePaletteOpen: false,
  embedDrawingPaletteOpen: false,
  outlinePaletteOpen: false
}

const note = (folder: string, path: string) =>
  ({ folder, path, title: path.split('/').pop()?.replace(/\.md$/, ''), body: '' }) as never

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('a bound chord', () => {
  it('runs its command and consumes the key', async () => {
    const { handleCommandChordEvent } = await load()
    const run = vi.fn()
    const event = cmdBackspace()
    expect(handleCommandChordEvent(event, () => closedState, run)).toBe(true)
    expect(run).toHaveBeenCalledWith('note.trash')
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves every other key alone', async () => {
    const { handleCommandChordEvent } = await load()
    const run = vi.fn()
    const event = chord({ key: 'Backspace', code: 'Backspace' })
    expect(handleCommandChordEvent(event, () => closedState, run)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(
      handleCommandChordEvent(cmdBackspace(), () => ({ ...closedState, commandKeymaps: {} }), run)
    ).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once per press, not once per auto-repeat', async () => {
    const { handleCommandChordEvent } = await load()
    const run = vi.fn()
    const held = chord({ key: 'Backspace', code: 'Backspace', metaKey: true, repeat: true })
    expect(handleCommandChordEvent(held, () => closedState, run)).toBe(true)
    expect(held.defaultPrevented).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    'whatsNewOpen',
    'settingsOpen',
    'searchOpen',
    'vaultTextSearchOpen',
    'commandPaletteOpen',
    'bufferPaletteOpen',
    'templatePaletteOpen',
    'embedDrawingPaletteOpen',
    'outlinePaletteOpen'
  ] as const)('stands down while %s, and lets the key through', async (flag) => {
    const { handleCommandChordEvent } = await load()
    const run = vi.fn()
    const event = cmdBackspace()
    expect(handleCommandChordEvent(event, () => ({ ...closedState, [flag]: true }), run)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['a dialog', '<div aria-modal="true"></div>'],
    ['a context menu', '<div data-ctx-menu></div>'],
    ['a prompt', '<div data-prompt-modal></div>'],
    ['a completion list', '<div class="cm-tooltip-autocomplete"></div>'],
    ['hint mode', '<div data-vim-hint-overlay></div>']
  ])('stands down while %s is open', async (_name, html) => {
    const { handleCommandChordEvent } = await load()
    document.body.innerHTML = html
    const run = vi.fn()
    expect(handleCommandChordEvent(cmdBackspace(), () => closedState, run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('is heard before a listener registered later on window, as VimNav and the editor are', async () => {
    const { installCommandKeymapDispatcher, useStore } = await load()
    useStore.setState({ commandKeymaps: { 'note.trash': 'Mod+Backspace' } })
    const runSpy = vi.fn()
    useStore.setState({ trashActive: runSpy, activeNote: note('inbox', 'inbox/A.md') } as never)
    const uninstall = installCommandKeymapDispatcher(() => useStore.getState())
    const later = vi.fn()
    window.addEventListener('keydown', later, true)
    try {
      window.dispatchEvent(cmdBackspace())
      await Promise.resolve()
      expect(later).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(runSpy).toHaveBeenCalled())
    } finally {
      window.removeEventListener('keydown', later, true)
      uninstall()
    }
  })

  it('only listens in the main window, not quick capture or a floating note', async () => {
    const { isMainAppWindow } = await load()
    expect(isMainAppWindow('')).toBe(true)
    expect(isMainAppWindow('?quickCapture=1')).toBe(false)
    expect(isMainAppWindow('?floating=1&note=inbox%2FA.md')).toBe(false)
    expect(isMainAppWindow('?externalFile=%2Ftmp%2Fa.md')).toBe(false)
    expect(isMainAppWindow('?exportNote=inbox%2FA.md')).toBe(false)
  })
})

describe('runBoundCommand', () => {
  it('runs a command that can run here', async () => {
    const { runBoundCommand, useStore } = await load()
    const trashActive = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ activeNote: note('inbox', 'inbox/A.md'), trashActive } as never)
    expect(await runBoundCommand('note.trash')).toBe('ran')
    expect(trashActive).toHaveBeenCalled()
  })

  it("says why instead of running when the command's when() is false", async () => {
    const { runBoundCommand, useStore, useToastStore } = await load()
    const restoreActive = vi.fn()
    useStore.setState({ activeNote: note('inbox', 'inbox/A.md'), restoreActive } as never)
    expect(await runBoundCommand('note.restore')).toBe('unavailable')
    expect(restoreActive).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Restore from Trash only works on a note in the Trash'
    ])
  })

  it('names what is missing for the shared guards, and falls back to a generic line', async () => {
    const { runBoundCommand, useStore, useToastStore } = await load()
    useStore.setState({ activeNote: null, selectedPath: null, closedTabStack: [] } as never)
    await runBoundCommand('note.rename')
    await runBoundCommand('tab.reopen')
    await runBoundCommand('demo.remove')
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Rename Note… needs an open note',
      'No closed tab to reopen',
      "Remove Demo Tour Notes isn't available here"
    ])
  })

  it('opens the palette on its list for a command the palette drills into', async () => {
    const { runBoundCommand, useStore } = await load()
    expect(await runBoundCommand('ui.themes')).toBe('ran')
    expect(useStore.getState().commandPaletteOpen).toBe(true)
    expect(useStore.getState().commandPaletteInitialMode).toBe('theme')
  })

  it('does nothing for an id the palette does not have', async () => {
    const { runBoundCommand } = await load()
    expect(await runBoundCommand('no.such.command')).toBe('missing')
  })
})

describe(':bind and :unbind', () => {
  it(':bind gives a command a key in the store', async () => {
    const { runBindEx, useStore, useToastStore } = await load()
    runBindEx('<D-BS> note.trash')
    expect(useStore.getState().commandKeymaps['note.trash']).toBe('Mod+Backspace')
    runBindEx('<leader>xa note.archive')
    expect(useStore.getState().commandKeymaps['note.archive']).toBe('Leader x a')
    expect(useToastStore.getState().toasts.map((t) => t.type)).toEqual(['success', 'success'])
    // Saved with the other preferences, so it survives a restart.
    expect(JSON.parse(localStorage.getItem('zen:prefs:v2') ?? '{}').commandKeymaps).toEqual({
      'note.trash': 'Mod+Backspace',
      'note.archive': 'Leader x a'
    })
  })

  it(':bind refuses a key another binding holds, and a built-in leader key', async () => {
    const { runBindEx, useStore, useToastStore } = await load()
    useStore.setState({ commandKeymaps: { 'note.archive': 'Mod+Backspace' } })
    runBindEx('<D-BS> note.trash')
    runBindEx('<leader>tx note.trash')
    expect(useStore.getState().commandKeymaps['note.trash']).toBeUndefined()
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      '⌘Backspace already belongs to the command Move Note to Archive: change that one first',
      'Space t x is refused: the key after the leader belongs to the built-in "Leader: new from template", and built-in leader keys always win'
    ])
  })

  it(':bind says when it takes over a default', async () => {
    const { runBindEx, useStore, useToastStore } = await load()
    runBindEx('<D-l> note.trash')
    expect(useStore.getState().commandKeymaps['note.trash']).toBe('Mod+L')
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      'Move Note to Trash is on ⌘L; it wins over the default of Toggle checkbox'
    )
  })

  it(':unbind command takes the key away; :unbind nav.back is still the action', async () => {
    const { runUnbindEx, useStore } = await load()
    useStore.setState({ commandKeymaps: { 'nav.back': 'Alt+Mod+B', 'note.trash': 'Mod+Backspace' } })
    runUnbindEx('command note.trash')
    expect(useStore.getState().commandKeymaps['note.trash']).toBe('')
    runUnbindEx('nav.back')
    expect(useStore.getState().keymapOverrides['nav.back']).toBe('')
    expect(useStore.getState().commandKeymaps['nav.back']).toBe('Alt+Mod+B')
    runUnbindEx('command nav.back')
    expect(useStore.getState().commandKeymaps['nav.back']).toBe('')
  })

  it('bare :bind and :unbind open Settings on the Keymap page', async () => {
    const { runBindEx, runUnbindEx, useStore } = await load()
    const { consumeSettingsTarget } = await import('./settings-navigation')
    runBindEx('')
    expect(useStore.getState().settingsOpen).toBe(true)
    expect(consumeSettingsTarget()).toBe('keymaps')
    useStore.setState({ settingsOpen: false })
    runUnbindEx('command')
    expect(useStore.getState().settingsOpen).toBe(true)
    expect(consumeSettingsTarget()).toBe('keymaps')
  })
})
