import { describe, expect, it } from 'vitest'
import { useStore } from '../store'
import {
  COMMAND_OVERLAY_FLAGS,
  canReturnToCommandList,
  shouldRefocusEditorAfterCommand
} from './command-palette-mode'

describe('canReturnToCommandList', () => {
  it('steps back when a sub-mode was entered from the command list', () => {
    expect(canReturnToCommandList('vault', 'main')).toBe(true)
    expect(canReturnToCommandList('theme', 'main')).toBe(true)
  })

  it('closes when the palette was opened straight into a sub-mode (#119)', () => {
    // `<leader>v` opens vault mode directly — Esc must close it, not reveal
    // the command list the user never opened.
    expect(canReturnToCommandList('vault', 'vault')).toBe(false)
  })

  it('closes from the main command list', () => {
    expect(canReturnToCommandList('main', 'main')).toBe(false)
  })
})

describe('shouldRefocusEditorAfterCommand', () => {
  const onEditor = {
    focusedPanel: 'editor',
    settingsOpen: false,
    searchOpen: false,
    vaultTextSearchOpen: false,
    bufferPaletteOpen: false,
    outlinePaletteOpen: false,
    templatePaletteOpen: false,
    embedDrawingPaletteOpen: false
  }

  it('hands focus to the editor when a command lands on it', () => {
    expect(shouldRefocusEditorAfterCommand(onEditor, false)).toBe(true)
  })

  it('leaves focus alone when the command landed elsewhere', () => {
    expect(shouldRefocusEditorAfterCommand({ ...onEditor, focusedPanel: 'sidebar' }, false)).toBe(
      false
    )
    expect(shouldRefocusEditorAfterCommand({ ...onEditor, focusedPanel: null }, false)).toBe(false)
  })

  // "Search Text in Vault…", "Search Notes…" and "Open Note Outline…" run from
  // the editor used to open with the caret still in the note.
  // (zennotesandroid#65)
  it.each(COMMAND_OVERLAY_FLAGS)('does not pull focus behind an open %s', (flag) => {
    expect(shouldRefocusEditorAfterCommand({ ...onEditor, [flag]: true }, false)).toBe(false)
  })

  // The Cloud conflict review and the Publish Note dialog are opened without
  // being awaited and live outside the store, so the caller reports them.
  it('does not pull focus behind a dialog tracked outside the store', () => {
    expect(shouldRefocusEditorAfterCommand(onEditor, true)).toBe(false)
  })

  // A new `…Open` overlay has to be classified here, or a command that opens
  // it silently regresses to typing into the note behind it.
  it('covers every overlay flag in the store', () => {
    const notCommandOverlays = ['sidebarOpen', 'noteListOpen', 'commandPaletteOpen']
    const openFlags = Object.entries(useStore.getState())
      .filter(([key, value]) => key.endsWith('Open') && typeof value === 'boolean')
      .map(([key]) => key)
    expect(openFlags.sort()).toEqual([...COMMAND_OVERLAY_FLAGS, ...notCommandOverlays].sort())
  })
})
