import { describe, expect, it } from 'vitest'
import type { KeymapId, KeymapOverrides } from './keymaps'
import {
  chordHeldByApp,
  keymapBindingTakenBy,
  listViewBindingMatches,
  listViewKey,
  listViewSequencesLive,
  listViewYieldsKey
} from './list-view-keys'

interface FakeEventInit {
  key: string
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

function fakeEvent(init: FakeEventInit): KeyboardEvent {
  return {
    key: init.key,
    code: init.code,
    ctrlKey: !!init.ctrlKey,
    metaKey: !!init.metaKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey
  } as KeyboardEvent
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const host = globalThis as typeof globalThis & {
    window?: { zen?: { platformSync?: () => NodeJS.Platform } }
  }
  const previous = host.window
  Object.defineProperty(host, 'window', {
    value: { ...(previous ?? {}), zen: { platformSync: () => platform } },
    configurable: true
  })
  try {
    return run()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(host, 'window')
    else Object.defineProperty(host, 'window', { value: previous, configurable: true })
  }
}

// The Archive view's actions, as ArchiveView lists them.
const ARCHIVE: readonly KeymapId[] = [
  'nav.filter',
  'nav.contextMenu',
  'nav.moveDown',
  'nav.moveUp',
  'nav.jumpBottom',
  'nav.jumpTop',
  'nav.openResult',
  'nav.unarchive',
  'nav.delete'
]

const x = (): KeyboardEvent => fakeEvent({ key: 'x', code: 'KeyX' })
const d = (): KeyboardEvent => fakeEvent({ key: 'd', code: 'KeyD' })
const j = (): KeyboardEvent => fakeEvent({ key: 'j', code: 'KeyJ' })
const cmdBackspace = (): KeyboardEvent =>
  fakeEvent({ key: 'Backspace', code: 'Backspace', metaKey: true })
const ctrlBackspace = (): KeyboardEvent =>
  fakeEvent({ key: 'Backspace', code: 'Backspace', ctrlKey: true })

describe('listViewYieldsKey (#972)', () => {
  it('never steps over a typed key, so bare x, d and j reach the view as before', () => {
    withPlatform('darwin', () => {
      for (const event of [x(), d(), j(), fakeEvent({ key: 'Escape', code: 'Escape' })]) {
        expect(listViewYieldsKey(event, {}, ARCHIVE, true)).toBe(false)
        expect(listViewYieldsKey(event, {}, ARCHIVE, false)).toBe(false)
      }
    })
  })

  it('steps over a chord no action of the view has, as the old modifier bail did', () => {
    withPlatform('darwin', () => {
      expect(listViewYieldsKey(cmdBackspace(), {}, ARCHIVE, true)).toBe(true)
      expect(listViewYieldsKey(fakeEvent({ key: 'c', code: 'KeyC', metaKey: true }), {}, ARCHIVE, true)).toBe(true)
    })
  })

  it("lets through a chord the user gave one of the view's actions, Vim on or off", () => {
    const overrides: KeymapOverrides = { 'nav.delete': 'Mod+Backspace' }
    withPlatform('darwin', () => {
      expect(listViewYieldsKey(cmdBackspace(), overrides, ARCHIVE, true)).toBe(false)
      expect(listViewYieldsKey(cmdBackspace(), overrides, ARCHIVE, false)).toBe(false)
      expect(listViewYieldsKey(ctrlBackspace(), overrides, ARCHIVE, true)).toBe(true)
    })
    withPlatform('linux', () => {
      expect(listViewYieldsKey(ctrlBackspace(), overrides, ARCHIVE, true)).toBe(false)
    })
    withPlatform('darwin', () => {
      const ctrl = { 'nav.delete': 'Ctrl+Backspace' }
      expect(listViewYieldsKey(ctrlBackspace(), ctrl, ARCHIVE, false)).toBe(false)
    })
  })

  it('lets through the first key of a sequence that starts on a chord', () => {
    withPlatform('linux', () => {
      const overrides = { 'nav.jumpTop': 'Ctrl+G g' }
      const ctrlG = fakeEvent({ key: 'g', code: 'KeyG', ctrlKey: true })
      expect(listViewYieldsKey(ctrlG, overrides, ARCHIVE, true)).toBe(false)
    })
  })

  it("still steps aside for a global shortcut on the same chord", () => {
    withPlatform('darwin', () => {
      const overrides = { 'nav.delete': 'Mod+P' }
      const cmdP = fakeEvent({ key: 'p', code: 'KeyP', metaKey: true })
      expect(listViewYieldsKey(cmdP, overrides, ARCHIVE, true)).toBe(true)
      // Move Search notes off it and the view gets the key.
      const moved = { ...overrides, 'global.searchNotes': 'Alt+Mod+P' }
      expect(listViewYieldsKey(cmdP, moved, ARCHIVE, true)).toBe(false)
    })
  })

  it("steps aside for Vim's pane prefix while Vim is on", () => {
    withPlatform('darwin', () => {
      const overrides = { 'nav.delete': 'Ctrl+W' }
      const ctrlW = fakeEvent({ key: 'w', code: 'KeyW', ctrlKey: true })
      expect(listViewYieldsKey(ctrlW, overrides, ARCHIVE, true)).toBe(true)
      expect(listViewYieldsKey(ctrlW, overrides, ARCHIVE, false)).toBe(false)
      expect(chordHeldByApp(ctrlW, overrides, true)?.id).toBe('vim.panePrefix')
    })
  })
})

describe('listViewKey and listViewBindingMatches', () => {
  it('hides a chord from the hard-coded keys', () => {
    expect(listViewKey(fakeEvent({ key: 'ArrowDown', code: 'ArrowDown' }))).toBe('ArrowDown')
    expect(listViewKey(fakeEvent({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }))).toBe('')
    expect(listViewKey(fakeEvent({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBe('')
    // Shift alone still types.
    expect(listViewKey(fakeEvent({ key: 'G', code: 'KeyG', shiftKey: true }))).toBe('G')
  })

  it('keeps typed keys Vim-only and lets chords work in either mode', () => {
    withPlatform('darwin', () => {
      expect(listViewBindingMatches(x(), {}, 'nav.delete', true)).toBe(true)
      expect(listViewBindingMatches(x(), {}, 'nav.delete', false)).toBe(false)
      const overrides = { 'nav.delete': 'Mod+Backspace' }
      expect(listViewBindingMatches(cmdBackspace(), overrides, 'nav.delete', false)).toBe(true)
      expect(listViewBindingMatches(cmdBackspace(), overrides, 'nav.delete', true)).toBe(true)
      expect(listViewBindingMatches(x(), overrides, 'nav.delete', true)).toBe(false)
    })
  })

  it('runs multi-key sequences with Vim on, or from a chord', () => {
    expect(listViewSequencesLive(fakeEvent({ key: 'g', code: 'KeyG' }), true)).toBe(true)
    expect(listViewSequencesLive(fakeEvent({ key: 'g', code: 'KeyG' }), false)).toBe(false)
    expect(listViewSequencesLive(fakeEvent({ key: 'g', code: 'KeyG', ctrlKey: true }), false)).toBe(true)
  })
})

describe('keymapBindingTakenBy, the Settings warning (#972)', () => {
  it('names the global shortcut a list action loses its chord to', () => {
    withPlatform('darwin', () => {
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Mod+P', true)?.id).toBe('global.searchNotes')
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Meta+P', false)?.id).toBe('global.searchNotes')
      expect(keymapBindingTakenBy({}, 'nav.moveDown', 'Alt+J', true)?.id).toBe('global.focusPaneDown')
    })
    withPlatform('linux', () => {
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Ctrl+P', true)?.id).toBe('global.searchNotes')
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Mod+P', true)?.id).toBe('global.searchNotes')
    })
  })

  it("says nothing when the global shortcut has moved off the key", () => {
    withPlatform('darwin', () => {
      const overrides = { 'global.searchNotes': 'Alt+Mod+P' }
      expect(keymapBindingTakenBy(overrides, 'nav.delete', 'Mod+P', true)).toBeNull()
    })
  })

  it('warns about the pane prefix only while Vim is on', () => {
    withPlatform('darwin', () => {
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Ctrl+W', true)?.id).toBe('vim.panePrefix')
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Ctrl+W', false)).toBeNull()
    })
  })

  it('covers the sidebar chord too, which is a shortcut-format binding', () => {
    withPlatform('darwin', () => {
      expect(keymapBindingTakenBy({}, 'nav.sidebarTrash', 'Mod+Backspace', true)).toBeNull()
      expect(keymapBindingTakenBy({}, 'nav.sidebarTrash', 'Mod+W', true)?.id).toBe('global.closeActiveTab')
    })
  })

  it('leaves free chords, typed keys, unbound actions and other scopes alone', () => {
    withPlatform('darwin', () => {
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Mod+Backspace', true)).toBeNull()
      expect(keymapBindingTakenBy({}, 'nav.delete', 'Ctrl+Backspace', true)).toBeNull()
      expect(keymapBindingTakenBy({}, 'nav.delete', 'x', true)).toBeNull()
      expect(keymapBindingTakenBy({}, 'nav.delete', '', true)).toBeNull()
      // A global shortcut's own conflicts are findKeymapConflict's to report.
      expect(keymapBindingTakenBy({}, 'global.commandPalette', 'Mod+P', true)).toBeNull()
    })
  })
})
