import { describe, expect, it } from 'vitest'
import {
  advanceSequence,
  eventMatchesUserOverride,
  findKeymapConflict,
  getDefaultKeymapBinding,
  getKeymapBinding,
  getKeymapDefinition,
  getKeymapDefinitions,
  getKeymapDisplay,
  getSequenceTokens,
  isKeymapUnbound,
  labelWithShortcut,
  matchesSequenceToken,
  matchesShortcut,
  matchesShortcutBinding,
  normalizeKeymapOverrides,
  normalizeShortcutBinding,
  shortcutBindingFromEvent,
  sequenceTokenFromEvent
} from './keymaps'

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
