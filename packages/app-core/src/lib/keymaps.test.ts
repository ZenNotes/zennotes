import { describe, expect, it, vi } from 'vitest'
import {
  advanceSequence,
  appShortcutForEvent,
  eventMatchesUserOverride,
  findKeymapConflict,
  getDefaultKeymapBinding,
  getKeymapBinding,
  getKeymapDefinition,
  getKeymapDefinitions,
  getKeymapDisplay,
  getSequenceTokens,
  isKeymapUnbound,
  keymapAvailableOnHost,
  labelWithShortcut,
  matchesSequenceToken,
  matchesShortcut,
  matchesShortcutBinding,
  normalizeKeymapBinding,
  normalizeKeymapOverrides,
  normalizeSequenceToken,
  normalizeShortcutBinding,
  resolveSequenceToken,
  shortcutBindingFromEvent,
  sequenceTokenFromEvent
} from './keymaps'
import { toVimSequence } from './vim-key-sequence'

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
  const previousWindow = host.window
  Object.defineProperty(host, 'window', {
    value: {
      ...(previousWindow ?? {}),
      zen: { ...(previousWindow?.zen ?? {}), platformSync: () => platform }
    },
    configurable: true
  })

  try {
    return run()
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(host, 'window')
    } else {
      Object.defineProperty(host, 'window', {
        value: previousWindow,
        configurable: true
      })
    }
  }
}

describe('shortcutBindingFromEvent', () => {
  it('uses the typed character on Colemak (Cmd+P fires on the key that types p)', () => {
    // On Colemak the 'p' character lives at the QWERTY-R position.
    const event = fakeEvent({ key: 'p', code: 'KeyR', metaKey: true })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Mod+P')
    })
  })

  it('preserves Hyper+J on QWERTY when event.key is the Alt-mangled glyph', () => {
    // ⌃⌥⇧⌘+J on US QWERTY produces 'Ô' in event.key.
    const event = fakeEvent({
      key: 'Ô',
      code: 'KeyJ',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true
    })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Ctrl+Alt+Shift+Mod+J')
    })
  })

  it('falls back to event.code for Alt+digit when event.key is non-ASCII', () => {
    // Alt+1 on US Mac produces '¡' (codepoint 0xA1, outside ASCII).
    const event = fakeEvent({ key: '¡', code: 'Digit1', altKey: true, metaKey: true })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Alt+Mod+1')
    })
  })

  it('records plain Cmd+1 as Mod+1', () => {
    const event = fakeEvent({ key: '1', code: 'Digit1', metaKey: true })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Mod+1')
    })
  })

  it('records Shift+digit as the typed symbol (Shift+Mod+!)', () => {
    const event = fakeEvent({ key: '!', code: 'Digit1', shiftKey: true, metaKey: true })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Shift+Mod+!')
    })
  })

  it('handles named keys via the event.key fallback path', () => {
    const event = fakeEvent({ key: 'Escape', code: 'Escape' })
    expect(shortcutBindingFromEvent(event)).toBe('Escape')
  })

  it('returns null for modifier-only events', () => {
    const event = fakeEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    expect(shortcutBindingFromEvent(event)).toBeNull()
  })

  it('records Shift+Cmd+= as Shift+Mod+= (event.key="+" must not collide with the binding separator)', () => {
    // Shift+= on QWERTY types '+'; emitting the literal '+' would
    // produce "Mod+Shift++" which the parser strips back to "Shift",
    // dropping the key. The fast path must skip '+' so we fall back
    // to event.code='Equal' -> '='.
    const event = fakeEvent({ key: '+', code: 'Equal', shiftKey: true, metaKey: true })
    withPlatform('darwin', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Shift+Mod+=')
    })
  })

  it('never resolves Alt+numpad digits on Windows (Alt-code character entry)', () => {
    // Hold Alt, type 0233 on the numpad: an input method, not a shortcut.
    // With Alt+1..9 shipped as tab defaults (#497) each digit would
    // otherwise switch tabs mid-entry.
    const event = fakeEvent({ key: '2', code: 'Numpad2', altKey: true })
    withPlatform('win32', () => {
      expect(shortcutBindingFromEvent(event)).toBeNull()
    })
    withPlatform('linux', () => {
      expect(shortcutBindingFromEvent(event)).toBe('Alt+2')
    })
  })
})

describe('matchesShortcutBinding (digit-row layouts, #497)', () => {
  it('matches Alt+1 on AZERTY where the digit row types punctuation', () => {
    // French AZERTY: unshifted Digit1 types '&', so the typed-character
    // binding is "Alt+&" and the stored default "Alt+1" needs the physical
    // digit-row fallback to fire.
    const event = fakeEvent({ key: '&', code: 'Digit1', altKey: true })
    withPlatform('win32', () => {
      expect(matchesShortcutBinding(event, 'Alt+1')).toBe(true)
    })
  })

  it('still matches a binding recorded from the typed character first', () => {
    const event = fakeEvent({ key: '&', code: 'Digit1', altKey: true })
    withPlatform('win32', () => {
      expect(matchesShortcutBinding(event, 'Alt+&')).toBe(true)
    })
  })

  it('keeps the numpad out of the digit-row fallback', () => {
    const event = fakeEvent({ key: '2', code: 'Numpad2', altKey: true })
    withPlatform('win32', () => {
      expect(matchesShortcutBinding(event, 'Alt+2')).toBe(false)
    })
  })
})

describe('eventMatchesUserOverride (#497, rebinds outrank new defaults)', () => {
  it('flags an event landing on a combination the user rebound elsewhere', () => {
    const event = fakeEvent({ key: '3', code: 'Digit3', altKey: true })
    withPlatform('win32', () => {
      expect(
        eventMatchesUserOverride(event, { 'global.zoomIn': 'Alt+3' }, 'tabs.select3')
      ).toBe(true)
    })
  })

  it('ignores the excluded id and unrelated overrides', () => {
    const event = fakeEvent({ key: '3', code: 'Digit3', altKey: true })
    withPlatform('win32', () => {
      expect(
        eventMatchesUserOverride(event, { 'tabs.select3': 'Alt+3' }, 'tabs.select3')
      ).toBe(false)
      expect(
        eventMatchesUserOverride(event, { 'global.zoomIn': 'Alt+4' }, 'tabs.select3')
      ).toBe(false)
    })
  })
})

describe('sequenceTokenFromEvent', () => {
  it('records the typed character for unmodified letters on Colemak', () => {
    // Colemak user pressing the key that types 'j' (QWERTY-N position).
    const event = fakeEvent({ key: 'j', code: 'KeyN' })
    expect(sequenceTokenFromEvent(event)).toBe('j')
  })

  it('preserves Shift+letter case', () => {
    const event = fakeEvent({ key: 'G', code: 'KeyG', shiftKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('G')
  })

  it('falls back to event.code when event.key is mangled by Alt', () => {
    const event = fakeEvent({ key: 'ˆ', code: 'KeyI', altKey: true, ctrlKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('Ctrl+Alt+I')
  })

  it('handles dead-key composition by falling back to event.code', () => {
    const event = fakeEvent({ key: 'Dead', code: 'KeyE' })
    expect(sequenceTokenFromEvent(event)).toBe('e')
  })

  it('records Shift+= as a sequence token of "=" (event.key="+" falls back to code)', () => {
    const event = fakeEvent({ key: '+', code: 'Equal', shiftKey: true })
    expect(sequenceTokenFromEvent(event)).toBe('=')
  })

  it('records bracket keys for Vim buffer sequences', () => {
    expect(sequenceTokenFromEvent(fakeEvent({ key: '[', code: 'BracketLeft' }))).toBe('[')
    expect(sequenceTokenFromEvent(fakeEvent({ key: ']', code: 'BracketRight' }))).toBe(']')
  })
})

describe('next / previous tab (#973)', () => {
  it('default to Ctrl+PageDown / Ctrl+PageUp, and Cmd+Option+arrows on the Mac', () => {
    withPlatform('darwin', () => {
      expect(getDefaultKeymapBinding('tabs.next')).toBe('Alt+Mod+ArrowRight')
      expect(getDefaultKeymapBinding('tabs.previous')).toBe('Alt+Mod+ArrowLeft')
    })
    for (const platform of ['linux', 'win32'] as const) {
      withPlatform(platform, () => {
        expect(getDefaultKeymapBinding('tabs.next')).toBe('Mod+PageDown')
        expect(getDefaultKeymapBinding('tabs.previous')).toBe('Mod+PageUp')
      })
    }
  })

  it('fire on those chords and leave plain paging and word motions alone', () => {
    withPlatform('linux', () => {
      const ctrl = (key: string): KeyboardEvent => fakeEvent({ key, code: key, ctrlKey: true })
      expect(matchesShortcut(ctrl('PageDown'), {}, 'tabs.next')).toBe(true)
      expect(matchesShortcut(ctrl('PageUp'), {}, 'tabs.previous')).toBe(true)
      expect(matchesShortcut(fakeEvent({ key: 'PageDown', code: 'PageDown' }), {}, 'tabs.next')).toBe(false)
    })
    withPlatform('darwin', () => {
      const cmdOption = (key: string): KeyboardEvent =>
        fakeEvent({ key, code: key, metaKey: true, altKey: true })
      expect(matchesShortcut(cmdOption('ArrowRight'), {}, 'tabs.next')).toBe(true)
      expect(matchesShortcut(cmdOption('ArrowLeft'), {}, 'tabs.previous')).toBe(true)
      // Cmd+Right is end of line and Option+Right a word: neither is a tab step.
      const cmdRight = fakeEvent({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true })
      const optionRight = fakeEvent({ key: 'ArrowRight', code: 'ArrowRight', altKey: true })
      expect(matchesShortcut(cmdRight, {}, 'tabs.next')).toBe(false)
      expect(matchesShortcut(optionRight, {}, 'tabs.next')).toBe(false)
    })
  })

  it('clash with no other default, and leave Ctrl+Tab to Switch to previous note', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      withPlatform(platform, () => {
        for (const id of ['tabs.next', 'tabs.previous'] as const) {
          expect(findKeymapConflict({}, id, getDefaultKeymapBinding(id))).toBeNull()
        }
        const ctrlTab = fakeEvent({ key: 'Tab', code: 'Tab', ctrlKey: true })
        expect(matchesShortcut(ctrlTab, {}, 'global.toggleRecentNote')).toBe(true)
        expect(matchesShortcut(ctrlTab, {}, 'tabs.next')).toBe(false)
      })
    }
  })
})

describe('template shortcuts (#847)', () => {
  it('bind New note from template to ⌘⌥T on the Mac and leave Linux and Windows unbound', () => {
    withPlatform('darwin', () => {
      expect(getDefaultKeymapBinding('global.newNoteFromTemplate')).toBe('Alt+Mod+T')
      expect(getDefaultKeymapBinding('global.insertTemplate')).toBe('')
    })
    for (const platform of ['linux', 'win32'] as const) {
      withPlatform(platform, () => {
        expect(getDefaultKeymapBinding('global.newNoteFromTemplate')).toBe('')
        expect(getDefaultKeymapBinding('global.insertTemplate')).toBe('')
      })
    }
  })

  it('fire on the chord a Mac actually sends, and never while unbound', () => {
    withPlatform('darwin', () => {
      // Option turns T into †; the binding still has to match the physical key.
      const cmdOptionT = fakeEvent({ key: '†', code: 'KeyT', metaKey: true, altKey: true })
      expect(matchesShortcut(cmdOptionT, {}, 'global.newNoteFromTemplate')).toBe(true)
      expect(matchesShortcut(cmdOptionT, {}, 'global.insertTemplate')).toBe(false)
    })
    withPlatform('linux', () => {
      const ctrlAltT = fakeEvent({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true })
      expect(matchesShortcut(ctrlAltT, {}, 'global.newNoteFromTemplate')).toBe(false)
      const bound = { 'global.newNoteFromTemplate': 'Alt+Mod+T' }
      expect(matchesShortcut(ctrlAltT, bound, 'global.newNoteFromTemplate')).toBe(true)
    })
  })

  it('have no key to show while unbound, and never clash with each other', () => {
    withPlatform('linux', () => {
      expect(getKeymapDisplay({}, 'global.insertTemplate')).toBe('')
      expect(findKeymapConflict({}, 'global.newNoteFromTemplate', '')).toBeNull()
      expect(findKeymapConflict({}, 'global.insertTemplate', 'Alt+Mod+Y')).toBeNull()
    })
    withPlatform('darwin', () => {
      expect(findKeymapConflict({}, 'global.insertTemplate', 'Alt+Mod+T')?.id).toBe(
        'global.newNoteFromTemplate'
      )
    })
  })
})

describe('leader keymap definitions', () => {
  it('keeps the recent-note toggle portable with a literal Ctrl+Tab Mac default', () => {
    withPlatform('darwin', () => {
      expect(getDefaultKeymapBinding('global.toggleRecentNote')).toBe('Ctrl+Tab')
    })
    withPlatform('linux', () => {
      expect(getDefaultKeymapBinding('global.toggleRecentNote')).toBe('Mod+Tab')
    })
    withPlatform('win32', () => {
      expect(getDefaultKeymapBinding('global.toggleRecentNote')).toBe('Mod+Tab')
    })
  })

  it('keeps every shortcut default in the portable Mod spelling', () => {
    // The shortcut normalizer canonicalizes the platform-primary modifier to
    // Mod (Ctrl on Windows/Linux, Meta on the Mac), so a default written as
    // "Ctrl+..." reads back differently on Linux CI than on the Mac this
    // suite usually runs on, and the shared-domain catalog can only mirror
    // one of the two spellings. Every shortcut default must round-trip
    // unchanged on every platform.
    for (const def of getKeymapDefinitions()) {
      if (def.kind !== 'shortcut') continue
      // An action that ships unbound (the template shortcuts off the Mac,
      // #847) has no spelling to round-trip.
      if (def.defaultBinding === '') continue
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const roundTripped = withPlatform(platform, () =>
          normalizeShortcutBinding(def.defaultBinding)
        )
        expect(roundTripped, `${def.id} default is not portable on ${platform}`).toBe(
          def.defaultBinding
        )
      }
    }
  })

  it('includes switch vault in leader bindings', () => {
    expect(getKeymapDefinition('vim.leaderSwitchVault')).toMatchObject({
      title: 'Leader: switch vault',
      defaultBinding: 'v'
    })
  })

  it('binds hint mode to leader h so bare f stays a Vim motion (#107)', () => {
    expect(getKeymapDefinition('vim.hintMode')).toMatchObject({
      scope: 'leader',
      title: 'Leader: hint mode',
      defaultBinding: 'h'
    })
  })

  it('keeps search notes on leader f', () => {
    expect(getKeymapDefinition('vim.leaderSearchNotes')).toMatchObject({
      title: 'Leader: search notes',
      defaultBinding: 'f'
    })
  })

  it('nests vault text search under the leader s search group (s then t)', () => {
    expect(getKeymapDefinition('vim.leaderSearchGroup')).toMatchObject({
      scope: 'leader',
      defaultBinding: 's'
    })
    expect(getKeymapDefinition('vim.leaderSearchVaultText')).toMatchObject({
      defaultBinding: 't'
    })
  })
})

describe('buffer keymap definitions', () => {
  it('defaults Vim buffer navigation to [b and ]b', () => {
    expect(getKeymapDefinition('vim.bufferPrevious')).toMatchObject({
      title: 'Previous buffer',
      defaultBinding: '[ b'
    })
    expect(getKeymapDefinition('vim.bufferNext')).toMatchObject({
      title: 'Next buffer',
      defaultBinding: '] b'
    })
  })

  it('defaults Vim tab navigation to gt and gT', () => {
    expect(getKeymapDefinition('vim.tabNext')).toMatchObject({
      title: 'Next tab',
      defaultBinding: 'g t'
    })
    expect(getKeymapDefinition('vim.tabPrevious')).toMatchObject({
      title: 'Previous tab',
      defaultBinding: 'g T'
    })
  })
})

describe('findKeymapConflict (#298 — global shortcut conflicts)', () => {
  it('returns null when a global shortcut binding is unique', () => {
    expect(findKeymapConflict({}, 'global.commandPalette', 'Mod+Shift+K')).toBeNull()
  })

  it('detects a binding already owned by another global shortcut', () => {
    // Mod+P is global.searchNotes by default; assigning it to the palette clashes.
    expect(findKeymapConflict({}, 'global.commandPalette', 'Mod+P')?.id).toBe(
      'global.searchNotes'
    )
  })

  it('honors overrides on the other side of the conflict', () => {
    // Move searchNotes off Mod+P and it is free for the palette again.
    const overrides = { 'global.searchNotes': 'Mod+Alt+P' }
    expect(findKeymapConflict(overrides, 'global.commandPalette', 'Mod+P')).toBeNull()
  })

  it('detects conflicts created by an override', () => {
    const overrides = { 'global.toggleSidebar': 'Mod+2' }
    // Mod+2 is global.toggleConnections by default.
    expect(findKeymapConflict(overrides, 'global.toggleSidebar', 'Mod+2')?.id).toBe(
      'global.toggleConnections'
    )
  })

  it('never flags an action against itself', () => {
    const own = getDefaultKeymapBinding('global.searchNotes')
    expect(findKeymapConflict({}, 'global.searchNotes', own)).toBeNull()
  })

  it('does not flag sequence groups that reuse keys by design', () => {
    // nav.moveRight and nav.openSideItem both default to "l" (lists scope),
    // disambiguated at runtime — not a conflict.
    expect(findKeymapConflict({}, 'nav.openSideItem', 'l')).toBeNull()
    expect(findKeymapConflict({}, 'nav.moveRight', 'l')).toBeNull()
    // Even a genuine cross-action duplicate in a sequence group is allowed.
    expect(findKeymapConflict({}, 'nav.delete', 'x')).toBeNull()
  })
})

// An action with a `defaultBindingMac` has two defaults, and "is this an
// override?" has to be asked against the one for THIS platform. Comparing
// against the cross-platform default silently dropped a deliberate macOS
// rebind on the next prefs load, and stored the Mac default as an override
// everywhere else.
describe('normalizeKeymapOverrides', () => {
  const macDefault = 'Ctrl+.' // editor.hopMarkerForward on macOS
  const otherDefault = 'Alt+]' // …and everywhere else

  it('keeps a macOS rebind back to the cross-platform default', () => {
    withPlatform('darwin', () => {
      expect(getDefaultKeymapBinding('editor.hopMarkerForward')).toBe(macDefault)
      expect(normalizeKeymapOverrides({ 'editor.hopMarkerForward': otherDefault })).toEqual({
        'editor.hopMarkerForward': otherDefault
      })
    })
  })

  it('drops a macOS binding that just restates the macOS default', () => {
    withPlatform('darwin', () => {
      expect(normalizeKeymapOverrides({ 'editor.hopMarkerForward': macDefault })).toEqual({})
    })
  })

  it('mirrors both rules off macOS', () => {
    withPlatform('win32', () => {
      expect(normalizeKeymapOverrides({ 'editor.hopMarkerForward': otherDefault })).toEqual({})
      // Kept as an override, normalized the way Windows/Linux spell Ctrl.
      expect(normalizeKeymapOverrides({ 'editor.hopMarkerForward': macDefault })).toEqual({
        'editor.hopMarkerForward': 'Mod+.'
      })
    })
  })
})

describe('unbound keymaps (an override of "")', () => {
  it('keeps an empty or blank override as an unbind instead of dropping it', () => {
    expect(normalizeKeymapOverrides({ 'global.zoomIn': '' })).toEqual({ 'global.zoomIn': '' })
    expect(normalizeKeymapOverrides({ 'global.zoomIn': '   ' })).toEqual({ 'global.zoomIn': '' })
    expect(normalizeKeymapOverrides({ 'vim.leaderPrefix': '' })).toEqual({
      'vim.leaderPrefix': ''
    })
  })

  it('resolves an unbound action to no binding, not to its default', () => {
    const overrides = { 'global.zoomIn': '' }
    expect(getKeymapBinding(overrides, 'global.zoomIn')).toBe('')
    expect(isKeymapUnbound(overrides, 'global.zoomIn')).toBe(true)
    expect(isKeymapUnbound(overrides, 'global.zoomOut')).toBe(false)
    expect(getKeymapBinding(overrides, 'global.zoomOut')).toBe(
      getDefaultKeymapBinding('global.zoomOut')
    )
    expect(getSequenceTokens({ 'vim.leaderPrefix': '' }, 'vim.leaderPrefix')).toEqual([])
    expect(getKeymapDisplay(overrides, 'global.zoomIn')).toBe('')
  })

  it('never matches a key event against an unbound shortcut or sequence', () => {
    withPlatform('darwin', () => {
      const overrides = { 'global.zoomIn': '', 'nav.moveDown': '' }
      const zoomIn = fakeEvent({ key: '=', code: 'Equal', metaKey: true })
      expect(matchesShortcut(zoomIn, {}, 'global.zoomIn')).toBe(true)
      expect(matchesShortcut(zoomIn, overrides, 'global.zoomIn')).toBe(false)
      const j = fakeEvent({ key: 'j', code: 'KeyJ' })
      expect(matchesSequenceToken(j, {}, 'nav.moveDown')).toBe(true)
      expect(matchesSequenceToken(j, overrides, 'nav.moveDown')).toBe(false)
      // A keydown with no key at all must not "match" the empty binding either.
      expect(matchesShortcutBinding(fakeEvent({ key: '', code: '' }), '')).toBe(false)
    })
  })

  it('does not advance a sequence for an unbound binding', () => {
    const pending = { current: 0 }
    const timer: { current?: ReturnType<typeof setTimeout> } = {}
    let matched = 0
    const consumed = advanceSequence(
      fakeEvent({ key: 'g', code: 'KeyG' }),
      '',
      pending,
      timer,
      () => {
        matched += 1
      },
      () => {}
    )
    expect(consumed).toBe(false)
    expect(matched).toBe(0)
    expect(pending.current).toBe(0)
  })

  it('takes an unbound action out of global-shortcut conflict checks both ways', () => {
    expect(findKeymapConflict({ 'global.zoomIn': '' }, 'global.zoomIn', '')).toBeNull()
    // Zoom out may take the key that zoom in used to hold.
    expect(findKeymapConflict({ 'global.zoomIn': '' }, 'global.zoomOut', 'Mod+=')).toBeNull()
    expect(findKeymapConflict({}, 'global.zoomOut', 'Mod+=')?.id).toBe('global.zoomIn')
    withPlatform('darwin', () => {
      const zoomIn = fakeEvent({ key: '=', code: 'Equal', metaKey: true })
      expect(eventMatchesUserOverride(zoomIn, { 'global.zoomIn': '' }, 'global.zoomOut')).toBe(
        false
      )
    })
  })

  it('labels a tooltip with the key only while there is one', () => {
    expect(labelWithShortcut('Go back', '⌃O')).toBe('Go back (⌃O)')
    expect(labelWithShortcut('Go back', '')).toBe('Go back')
  })
})

describe('keymapAvailableOnHost', () => {
  const ids = getKeymapDefinitions().map((definition) => definition.id)
  const review = ids.filter((id) => /^(editor|vim)\.review/.test(id))
  const harper = ids.filter((id) => id.startsWith('vim.harper'))

  it('leaves out the review and Harper keys where those features are missing', () => {
    expect(review).toHaveLength(8)
    expect(harper.length).toBeGreaterThan(0)
    for (const id of [...review, ...harper]) expect(keymapAvailableOnHost(id, {})).toBe(false)
  })

  it('keeps each one on a host that has its feature', () => {
    for (const id of review) expect(keymapAvailableOnHost(id, { supportsAgentEditReview: true })).toBe(true)
    for (const id of harper) expect(keymapAvailableOnHost(id, { supportsHarper: true })).toBe(true)
    expect(keymapAvailableOnHost(review[0], { supportsHarper: true })).toBe(false)
  })

  it('keeps every other key everywhere', () => {
    const rest = ids.filter((id) => !review.includes(id) && !harper.includes(id))
    expect(rest.length).toBeGreaterThan(50)
    for (const id of rest) expect(keymapAvailableOnHost(id, {})).toBe(true)
  })
})

describe('Timeline panel keymaps (#1007)', () => {
  it('binds Mod+7 and leader n, like the other right-hand panels', () => {
    expect(getKeymapDefinition('global.toggleTimelinePanel')).toMatchObject({
      kind: 'shortcut',
      scope: 'app',
      group: 'global',
      title: 'Toggle timeline panel',
      defaultBinding: 'Mod+7'
    })
    expect(getKeymapDefinition('vim.leaderTimeline')).toMatchObject({
      kind: 'sequence',
      scope: 'leader',
      group: 'vim',
      title: 'Leader: toggle timeline',
      defaultBinding: 'n',
      vimOnly: true
    })
  })

  it('takes a key no other global shortcut or leader action holds', () => {
    expect(findKeymapConflict({}, 'global.toggleTimelinePanel', 'Mod+7')).toBeNull()
    // No leader binding at any depth uses n, so nothing else answers it.
    const leaderKeys = getKeymapDefinitions()
      .filter((def) => def.scope === 'leader' && def.id !== 'vim.leaderTimeline')
      .map((def) => def.defaultBinding)
    expect(leaderKeys).not.toContain('n')
  })

  it('fires on Cmd+7 on the Mac and Ctrl+7 elsewhere, and not on the tab digits', () => {
    withPlatform('darwin', () => {
      const cmd7 = fakeEvent({ key: '7', code: 'Digit7', metaKey: true })
      expect(matchesShortcut(cmd7, {}, 'global.toggleTimelinePanel')).toBe(true)
      expect(matchesShortcut(cmd7, {}, 'tabs.select7')).toBe(false)
      const ctrl7 = fakeEvent({ key: '7', code: 'Digit7', ctrlKey: true })
      expect(matchesShortcut(ctrl7, {}, 'global.toggleTimelinePanel')).toBe(false)
    })
    withPlatform('linux', () => {
      const ctrl7 = fakeEvent({ key: '7', code: 'Digit7', ctrlKey: true })
      expect(matchesShortcut(ctrl7, {}, 'global.toggleTimelinePanel')).toBe(true)
      const alt7 = fakeEvent({ key: '7', code: 'Digit7', altKey: true })
      expect(matchesShortcut(alt7, {}, 'global.toggleTimelinePanel')).toBe(false)
    })
  })

  it('can be rebound or unbound like its neighbours', () => {
    withPlatform('darwin', () => {
      const unbound = { 'global.toggleTimelinePanel': '', 'vim.leaderTimeline': '' }
      expect(normalizeKeymapOverrides(unbound)).toEqual(unbound)
      expect(getKeymapDisplay(unbound, 'global.toggleTimelinePanel')).toBe('')
      const cmd7 = fakeEvent({ key: '7', code: 'Digit7', metaKey: true })
      expect(matchesShortcut(cmd7, unbound, 'global.toggleTimelinePanel')).toBe(false)
      const n = fakeEvent({ key: 'n', code: 'KeyN' })
      expect(matchesSequenceToken(n, {}, 'vim.leaderTimeline')).toBe(true)
      expect(matchesSequenceToken(n, unbound, 'vim.leaderTimeline')).toBe(false)
      const rebound = { 'vim.leaderTimeline': 'T' }
      const shiftT = fakeEvent({ key: 'T', code: 'KeyT', shiftKey: true })
      expect(matchesSequenceToken(shiftT, rebound, 'vim.leaderTimeline')).toBe(true)
    })
  })
})

describe('Mod in sequence bindings (#972)', () => {
  const cmdBackspace = (): KeyboardEvent =>
    fakeEvent({ key: 'Backspace', code: 'Backspace', metaKey: true })
  const ctrlBackspace = (): KeyboardEvent =>
    fakeEvent({ key: 'Backspace', code: 'Backspace', ctrlKey: true })

  it('keeps Mod in the stored token instead of dropping it to a bare key', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      withPlatform(platform, () => {
        expect(normalizeSequenceToken('Mod+Backspace')).toBe('Mod+Backspace')
        expect(normalizeKeymapBinding('nav.delete', 'Mod+Backspace')).toBe('Mod+Backspace')
        // A letter under Mod is canonical uppercase, like under Ctrl.
        expect(normalizeSequenceToken('Mod+d')).toBe('Mod+D')
        expect(normalizeSequenceToken('Shift+Mod+Backspace')).toBe('Shift+Mod+Backspace')
      })
    }
  })

  it('leaves tokens without Mod exactly as before', () => {
    expect(normalizeSequenceToken('x')).toBe('x')
    expect(normalizeSequenceToken('G')).toBe('G')
    expect(normalizeSequenceToken('Ctrl+w')).toBe('Ctrl+W')
    expect(normalizeSequenceToken('Cmd+Backspace')).toBe('Meta+Backspace')
    expect(normalizeSequenceToken('Backspace')).toBe('Backspace')
  })

  it('resolves Mod to Cmd on macOS and Ctrl elsewhere when matching', () => {
    expect(resolveSequenceToken('Mod+Backspace', true)).toBe('Meta+Backspace')
    expect(resolveSequenceToken('Mod+Backspace', false)).toBe('Ctrl+Backspace')
    expect(resolveSequenceToken('Shift+Mod+K', true)).toBe('Shift+Meta+K')
    expect(resolveSequenceToken('Alt+Mod+K', false)).toBe('Ctrl+Alt+K')
    expect(resolveSequenceToken('Ctrl+Mod+K', false)).toBe('Ctrl+K')
    expect(resolveSequenceToken('x', true)).toBe('x')
    expect(resolveSequenceToken('Ctrl+W', true)).toBe('Ctrl+W')
  })

  it('matches Cmd+Backspace on macOS and Ctrl+Backspace on Linux and Windows', () => {
    const overrides = normalizeKeymapOverrides({ 'nav.delete': 'Mod+Backspace' })
    expect(overrides).toEqual({ 'nav.delete': 'Mod+Backspace' })
    withPlatform('darwin', () => {
      expect(getSequenceTokens(overrides, 'nav.delete')).toEqual(['Meta+Backspace'])
      expect(matchesSequenceToken(cmdBackspace(), overrides, 'nav.delete')).toBe(true)
      expect(matchesSequenceToken(ctrlBackspace(), overrides, 'nav.delete')).toBe(false)
      // A plain Backspace is no longer the key.
      const plain = fakeEvent({ key: 'Backspace', code: 'Backspace' })
      expect(matchesSequenceToken(plain, overrides, 'nav.delete')).toBe(false)
    })
    for (const platform of ['linux', 'win32'] as const) {
      withPlatform(platform, () => {
        expect(getSequenceTokens(overrides, 'nav.delete')).toEqual(['Ctrl+Backspace'])
        expect(matchesSequenceToken(ctrlBackspace(), overrides, 'nav.delete')).toBe(true)
        expect(matchesSequenceToken(cmdBackspace(), overrides, 'nav.delete')).toBe(false)
      })
    }
  })

  it('keeps an entry already saved as the bare key bare, and explicit Ctrl/Cmd spellings as written', () => {
    withPlatform('darwin', () => {
      const bare = normalizeKeymapOverrides({ 'nav.delete': 'Backspace' })
      expect(bare).toEqual({ 'nav.delete': 'Backspace' })
      const plain = fakeEvent({ key: 'Backspace', code: 'Backspace' })
      expect(matchesSequenceToken(plain, bare, 'nav.delete')).toBe(true)
      expect(matchesSequenceToken(cmdBackspace(), bare, 'nav.delete')).toBe(false)
      const ctrl = normalizeKeymapOverrides({ 'nav.delete': 'Ctrl+Backspace' })
      expect(matchesSequenceToken(ctrlBackspace(), ctrl, 'nav.delete')).toBe(true)
      const cmd = normalizeKeymapOverrides({ 'nav.delete': 'Cmd+Backspace' })
      expect(cmd).toEqual({ 'nav.delete': 'Meta+Backspace' })
      expect(matchesSequenceToken(cmdBackspace(), cmd, 'nav.delete')).toBe(true)
    })
  })

  it('event tokens never spell Mod, on either platform', () => {
    withPlatform('darwin', () => {
      expect(sequenceTokenFromEvent(cmdBackspace())).toBe('Meta+Backspace')
      expect(sequenceTokenFromEvent(ctrlBackspace())).toBe('Ctrl+Backspace')
    })
    withPlatform('linux', () => {
      expect(sequenceTokenFromEvent(ctrlBackspace())).toBe('Ctrl+Backspace')
    })
  })

  it('walks a sequence whose first key carries Mod', () => {
    withPlatform('linux', () => {
      const pending = { current: 0 }
      const timer: { current?: ReturnType<typeof setTimeout> } = {}
      const onMatch = vi.fn()
      const first = fakeEvent({ key: 'g', code: 'KeyG', ctrlKey: true })
      const second = fakeEvent({ key: 'g', code: 'KeyG' })
      expect(advanceSequence(first, 'Mod+G g', pending, timer, onMatch, () => {})).toBe(true)
      expect(advanceSequence(second, 'Mod+G g', pending, timer, onMatch, () => {})).toBe(true)
      expect(onMatch).toHaveBeenCalledTimes(1)
    })
  })

  it('names the global shortcut that has a chord', () => {
    withPlatform('darwin', () => {
      const cmdP = fakeEvent({ key: 'p', code: 'KeyP', metaKey: true })
      expect(appShortcutForEvent(cmdP, {})?.id).toBe('global.searchNotes')
      expect(appShortcutForEvent(cmdBackspace(), {})).toBeNull()
      // Moved off its key, Search notes no longer has it.
      expect(appShortcutForEvent(cmdP, { 'global.searchNotes': '' })).toBeNull()
    })
  })

  it('hands Vim Cmd on macOS and Ctrl elsewhere for a Mod token', () => {
    withPlatform('darwin', () => expect(toVimSequence('Mod+D')).toBe('<D-d>'))
    withPlatform('linux', () => expect(toVimSequence('Mod+D')).toBe('<C-d>'))
    withPlatform('linux', () => expect(toVimSequence('Ctrl+Mod+D')).toBe('<C-d>'))
  })
})

describe('Move sidebar note to Trash (#972)', () => {
  it('is a Mod+Backspace chord in either mode, rebindable and unbindable', () => {
    const definition = getKeymapDefinition('nav.sidebarTrash')
    expect(definition).toMatchObject({ kind: 'shortcut', defaultBinding: 'Mod+Backspace' })
    expect(definition.vimOnly).toBeUndefined()
    withPlatform('darwin', () => {
      const cmd = fakeEvent({ key: 'Backspace', code: 'Backspace', metaKey: true })
      expect(matchesShortcut(cmd, {}, 'nav.sidebarTrash')).toBe(true)
      expect(matchesShortcut(cmd, { 'nav.sidebarTrash': '' }, 'nav.sidebarTrash')).toBe(false)
      const del = fakeEvent({ key: 'Delete', code: 'Delete' })
      expect(matchesShortcut(del, { 'nav.sidebarTrash': 'Delete' }, 'nav.sidebarTrash')).toBe(true)
    })
    withPlatform('linux', () => {
      const ctrl = fakeEvent({ key: 'Backspace', code: 'Backspace', ctrlKey: true })
      expect(matchesShortcut(ctrl, {}, 'nav.sidebarTrash')).toBe(true)
    })
  })
})
