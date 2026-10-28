import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commandBindingHint,
  commandIdForChordEvent,
  commandLeaderHints,
  commandRecorderStep,
  findActionCommandConflicts,
  findCommandBindingConflicts,
  findLeaderCollision,
  formatCommandBinding,
  normalizeCommandKeymaps,
  parseBindExArgs,
  parseCommandBinding,
  parseUnbindExArgs,
  parseVimKeyNotation,
  stepCommandLeader
} from './command-keymaps'
import { sequenceTokenFromEvent, shortcutBindingFromEvent } from './keymaps'

// Every binding below is read on one platform at a time: `Mod` means Cmd on a
// Mac and Ctrl elsewhere, and the canonical forms differ accordingly.
type Host = typeof globalThis & { window?: { zen?: { platformSync?: () => NodeJS.Platform } } }
let previousWindow: Host['window']

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(globalThis, 'window', {
    value: { zen: { platformSync: () => platform } },
    configurable: true
  })
}

beforeEach(() => {
  previousWindow = (globalThis as Host).window
  setPlatform('darwin')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
  vi.restoreAllMocks()
})

function key(init: {
  key: string
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
}): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...init
  } as KeyboardEvent
}

const recorderContext = {
  leaderToken: 'Space',
  shortcutFromEvent: shortcutBindingFromEvent,
  tokenFromEvent: sequenceTokenFromEvent
}

describe('parseCommandBinding', () => {
  it('reads a chord in the keymap table format and canonicalizes it', () => {
    expect(parseCommandBinding('Mod+Backspace', {})).toEqual({ ok: true, binding: 'Mod+Backspace' })
    expect(parseCommandBinding('Cmd+Backspace', {})).toEqual({ ok: true, binding: 'Mod+Backspace' })
    expect(parseCommandBinding('cmd+shift+k', {})).toEqual({ ok: true, binding: 'Shift+Mod+K' })
    expect(parseCommandBinding('F5', {})).toEqual({ ok: true, binding: 'F5' })
  })

  it('refuses a chord that would type text', () => {
    expect(parseCommandBinding('x', {}).ok).toBe(false)
    expect(parseCommandBinding('Shift+X', {}).ok).toBe(false)
    expect(parseCommandBinding('Backspace', {}).ok).toBe(false)
  })

  it('reads a leader sequence however it is spelled, and keeps the leader symbolic', () => {
    expect(parseCommandBinding('Leader x t', {})).toEqual({ ok: true, binding: 'Leader x t' })
    expect(parseCommandBinding('<leader> x t', {})).toEqual({ ok: true, binding: 'Leader x t' })
    // Space is the leader by default, so spelling it out means the leader.
    expect(parseCommandBinding('Space x t', {})).toEqual({ ok: true, binding: 'Leader x t' })
    // With the leader moved to `,`, Space no longer starts a sequence.
    expect(parseCommandBinding('Space x t', { 'vim.leaderPrefix': ',' }).ok).toBe(false)
    expect(parseCommandBinding(', x t', { 'vim.leaderPrefix': ',' })).toEqual({
      ok: true,
      binding: 'Leader x t'
    })
  })

  it('refuses sequences it cannot press', () => {
    expect(parseCommandBinding('Leader', {}).ok).toBe(false)
    expect(parseCommandBinding('Leader a b c d', {}).ok).toBe(false)
    expect(parseCommandBinding('Leader xt', {}).ok).toBe(false)
    expect(parseCommandBinding('Leader Ctrl+X', {}).ok).toBe(false)
    expect(parseCommandBinding('g g', {}).ok).toBe(false)
  })

  it('reads "" as a deliberate unbind', () => {
    expect(parseCommandBinding('', {})).toEqual({ ok: true, binding: '' })
  })
})

describe('normalizeCommandKeymaps', () => {
  it('keeps bindable ids, drops unknown ones and broken bindings, keeps ""', () => {
    expect(
      normalizeCommandKeymaps({
        'note.trash': 'Cmd+Backspace',
        'note.archive': 'Leader x a',
        'note.restore': '',
        'not.a.command': 'Mod+K',
        'workflow.run.reading-log': 'Mod+J',
        'note.favorite': 'q',
        'note.unarchive': 42
      })
    ).toEqual({ 'note.archive': 'Leader x a', 'note.trash': 'Mod+Backspace', 'note.restore': '' })
  })

  it('reads nav.back as the Go Back command: the command map is its own namespace', () => {
    expect(normalizeCommandKeymaps({ 'nav.back': 'Alt+Mod+B' })).toEqual({ 'nav.back': 'Alt+Mod+B' })
  })

  it('refuses a sequence that starts on a built-in leader key', () => {
    // `Space t` is the template picker, so `Space t x` could never be reached.
    expect(normalizeCommandKeymaps({ 'note.trash': 'Leader t x' })).toEqual({})
    // A built-in group counts too: `Space l` is the note actions.
    expect(normalizeCommandKeymaps({ 'note.trash': 'Leader l x' })).toEqual({})
    // Once the user moves the template picker, `t` is free.
    expect(
      normalizeCommandKeymaps({ 'note.trash': 'Leader t x' }, { 'vim.leaderTemplatePicker': 'T' })
    ).toEqual({ 'note.trash': 'Leader t x' })
  })

  it('writes entries in palette order, whatever order they came in', () => {
    const out = normalizeCommandKeymaps({ 'note.trash': 'F6', 'note.new.quick': 'F5' })
    expect(Object.keys(out)).toEqual(['note.new.quick', 'note.trash'])
  })

  it('returns nothing for anything that is not a map', () => {
    expect(normalizeCommandKeymaps(null)).toEqual({})
    expect(normalizeCommandKeymaps('Mod+K')).toEqual({})
    expect(normalizeCommandKeymaps(['Mod+K'])).toEqual({})
  })
})

describe('conflicts between commands and actions', () => {
  it('lets a command take a built-in default, and says whose', () => {
    // Mod+L is Toggle checkbox's default: allowed, a shadow, not a block.
    const { blocking, shadows } = findCommandBindingConflicts('note.trash', 'Mod+L', {
      overrides: {},
      commandKeymaps: {}
    })
    expect(blocking).toEqual([])
    expect(shadows.map((s) => s.id)).toEqual(['editor.toggleCheckbox'])
  })

  it('refuses a key an action override already holds', () => {
    const { blocking } = findCommandBindingConflicts('note.trash', 'Alt+Mod+Y', {
      overrides: { 'global.zoomIn': 'Alt+Mod+Y' },
      commandKeymaps: {}
    })
    expect(blocking).toEqual([
      { kind: 'action', id: 'global.zoomIn', title: 'Zoom in', user: true }
    ])
  })

  it('refuses a key another command holds, both ways', () => {
    const commandKeymaps = { 'note.archive': 'Mod+Backspace' }
    const fromTrash = findCommandBindingConflicts('note.trash', 'Mod+Backspace', {
      overrides: {},
      commandKeymaps
    })
    expect(fromTrash.blocking.map((b) => b.id)).toEqual(['note.archive'])
    const fromArchive = findCommandBindingConflicts('note.archive', 'Mod+Backspace', {
      overrides: {},
      commandKeymaps: { 'note.trash': 'Mod+Backspace' }
    })
    expect(fromArchive.blocking.map((b) => b.id)).toEqual(['note.trash'])
    // Its own key is not a conflict with itself.
    expect(
      findCommandBindingConflicts('note.archive', 'Mod+Backspace', { overrides: {}, commandKeymaps })
        .blocking
    ).toEqual([])
  })

  it("catches Vim's reserved chords by what is pressed, not how it is spelled", () => {
    setPlatform('linux')
    // On Linux Mod+W is Ctrl+W: both Close active tab and Vim's pane prefix.
    const { shadows } = findCommandBindingConflicts('note.trash', 'Mod+W', {
      overrides: {},
      commandKeymaps: {}
    })
    expect(shadows.map((s) => s.id).sort()).toEqual(['global.closeActiveTab', 'vim.panePrefix'])
  })

  it('refuses a sequence that overlaps another command sequence or a leader key', () => {
    const ctx = { overrides: {}, commandKeymaps: { 'note.trash': 'Leader x t' } }
    expect(findCommandBindingConflicts('note.archive', 'Leader x', ctx).blocking.map((b) => b.id)).toEqual([
      'note.trash'
    ])
    expect(
      findCommandBindingConflicts('note.archive', 'Leader x t a', ctx).blocking.map((b) => b.id)
    ).toEqual(['note.trash'])
    expect(findCommandBindingConflicts('note.archive', 'Leader x a', ctx).blocking).toEqual([])
    const leader = findCommandBindingConflicts('note.archive', 'Leader t a', ctx).blocking
    expect(leader.map((b) => b.id)).toEqual(['vim.leaderTemplatePicker'])
    expect(findLeaderCollision('Leader t a', {})?.id).toBe('vim.leaderTemplatePicker')
  })

  it('finds the same clash from the action side', () => {
    const commandKeymaps = { 'note.trash': 'Alt+Mod+Y', 'note.archive': 'Leader x a' }
    expect(
      findActionCommandConflicts('global.zoomIn', 'Alt+Mod+Y', { overrides: {}, commandKeymaps }).map(
        (c) => c.id
      )
    ).toEqual(['note.trash'])
    // Moving a built-in leader key onto `x` takes the archive sequence's start.
    expect(
      findActionCommandConflicts('vim.leaderDailyNote', 'x', { overrides: {}, commandKeymaps }).map(
        (c) => c.id
      )
    ).toEqual(['note.archive'])
    expect(
      findActionCommandConflicts('global.zoomIn', '', { overrides: {}, commandKeymaps })
    ).toEqual([])
  })
})

describe('matching keys', () => {
  it('finds the command on a chord, first in palette order', () => {
    const event = key({ key: 'Backspace', code: 'Backspace', metaKey: true })
    expect(commandIdForChordEvent(event, { 'note.trash': 'Mod+Backspace' })).toBe('note.trash')
    expect(
      commandIdForChordEvent(event, { 'note.trash': 'Mod+Backspace', 'note.new.quick': 'Mod+Backspace' })
    ).toBe('note.new.quick')
    expect(commandIdForChordEvent(key({ key: 'x', code: 'KeyX' }), { 'note.trash': 'Mod+Backspace' })).toBe(
      null
    )
    expect(commandIdForChordEvent(event, { 'note.trash': '' })).toBe(null)
    // A sequence is never a chord.
    expect(commandIdForChordEvent(event, { 'note.trash': 'Leader x t' })).toBe(null)
  })

  it('walks a leader sequence one key at a time', () => {
    const keymaps = { 'note.trash': 'Leader x t', 'note.archive': 'Leader x a', 'note.favorite': 'Leader z' }
    expect(stepCommandLeader(keymaps, [], 'x')).toEqual({ kind: 'more', prefix: ['x'] })
    expect(stepCommandLeader(keymaps, ['x'], 't')).toEqual({ kind: 'run', id: 'note.trash' })
    expect(stepCommandLeader(keymaps, ['x'], 'a')).toEqual({ kind: 'run', id: 'note.archive' })
    expect(stepCommandLeader(keymaps, [], 'z')).toEqual({ kind: 'run', id: 'note.favorite' })
    expect(stepCommandLeader(keymaps, ['x'], 'q')).toBe(null)
    expect(stepCommandLeader(keymaps, [], 'q')).toBe(null)
  })

  it('names the next keys for the which-key hints', () => {
    const keymaps = { 'note.trash': 'Leader x t', 'note.archive': 'Leader x a', 'note.favorite': 'Leader z' }
    expect(commandLeaderHints(keymaps, []).map((h) => [h.key, h.label])).toEqual([
      ['z', 'Toggle Note Favorite'],
      ['x', '2 commands']
    ])
    expect(commandLeaderHints(keymaps, ['x']).map((h) => [h.key, h.label])).toEqual([
      ['a', 'Move Note to Archive'],
      ['t', 'Move Note to Trash']
    ])
  })
})

describe('display', () => {
  it('formats chords and sequences, the leader as the user has it', () => {
    expect(formatCommandBinding('Mod+Backspace', {})).toBe('⌘Backspace')
    expect(formatCommandBinding('Leader x t', {})).toBe('Space x t')
    expect(formatCommandBinding('Leader x t', { 'vim.leaderPrefix': ',' })).toBe(', x t')
    expect(formatCommandBinding('', {})).toBe('')
  })

  it('hides a sequence where it names a Vim key nobody can press', () => {
    expect(commandBindingHint('Leader x t', { overrides: {}, vimMode: true })).toBe('Space x t')
    expect(commandBindingHint('Leader x t', { overrides: {}, vimMode: false })).toBe('')
    expect(commandBindingHint('Mod+Backspace', { overrides: {}, vimMode: false })).toBe('⌘Backspace')
  })
})

describe('the command recorder', () => {
  it('records a chord, saves on Enter and cancels on Escape', () => {
    expect(
      commandRecorderStep('', key({ key: 'Backspace', code: 'Backspace', metaKey: true }), recorderContext)
    ).toEqual({ type: 'set', binding: 'Mod+Backspace' })
    expect(commandRecorderStep('Mod+Backspace', key({ key: 'Enter', code: 'Enter' }), recorderContext)).toEqual({
      type: 'save'
    })
    expect(commandRecorderStep('Mod+Backspace', key({ key: 'Escape', code: 'Escape' }), recorderContext)).toEqual({
      type: 'cancel'
    })
    expect(
      commandRecorderStep('Mod+Backspace', key({ key: 'Backspace', code: 'Backspace' }), recorderContext)
    ).toEqual({ type: 'set', binding: '' })
  })

  it('starts a sequence on the leader and takes back one key at a time', () => {
    const space = key({ key: ' ', code: 'Space' })
    expect(commandRecorderStep('', space, recorderContext)).toEqual({ type: 'set', binding: 'Leader' })
    expect(commandRecorderStep('Leader', key({ key: 'x', code: 'KeyX' }), recorderContext)).toEqual({
      type: 'set',
      binding: 'Leader x'
    })
    expect(
      commandRecorderStep('Leader x', key({ key: 'T', code: 'KeyT', shiftKey: true }), recorderContext)
    ).toEqual({ type: 'set', binding: 'Leader x T' })
    expect(commandRecorderStep('Leader x T', key({ key: 'Backspace', code: 'Backspace' }), recorderContext)).toEqual({
      type: 'set',
      binding: 'Leader x'
    })
    expect(
      commandRecorderStep('Leader a b c', key({ key: 'd', code: 'KeyD' }), recorderContext).type
    ).toBe('ignore')
  })

  it('turns away a bare letter with a hint, and lets modifiers and Tab through', () => {
    const letter = commandRecorderStep('', key({ key: 'x', code: 'KeyX' }), recorderContext)
    expect(letter.type).toBe('ignore')
    expect(letter.type === 'ignore' && letter.hint).toBeTruthy()
    expect(commandRecorderStep('', key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), recorderContext)).toEqual({
      type: 'ignore'
    })
    expect(commandRecorderStep('', key({ key: 'Tab', code: 'Tab' }), recorderContext)).toEqual({ type: 'ignore' })
  })
})

describe(':bind and :unbind', () => {
  it("reads Vim's key notation", () => {
    expect(parseVimKeyNotation('<C-BS>')).toEqual(['Ctrl+Backspace'])
    expect(parseVimKeyNotation('<D-BS>')).toEqual(['Meta+Backspace'])
    expect(parseVimKeyNotation('<M-x>')).toEqual(['Alt+x'])
    expect(parseVimKeyNotation('<Space>xt')).toEqual(['Space', 'x', 't'])
    expect(parseVimKeyNotation('<leader>xt')).toEqual(['Leader', 'x', 't'])
    expect(parseVimKeyNotation('<F5>')).toEqual(['F5'])
    expect(parseVimKeyNotation('<C-->')).toEqual(['Ctrl+-'])
    expect(parseVimKeyNotation('<Q-x>')).toBe(null)
    expect(parseVimKeyNotation('<C-x')).toBe(null)
  })

  it('binds a chord or a sequence, the command id last', () => {
    expect(parseBindExArgs('<D-BS> note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Mod+Backspace'
    })
    expect(parseBindExArgs('<C-BS> note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Ctrl+Backspace'
    })
    expect(parseBindExArgs('<Space>xt note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Leader x t'
    })
    expect(parseBindExArgs('<leader>xa note.archive', {})).toEqual({
      kind: 'bind',
      id: 'note.archive',
      binding: 'Leader x a'
    })
    expect(parseBindExArgs('Mod+Backspace note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Mod+Backspace'
    })
    expect(parseBindExArgs('Space x t note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Leader x t'
    })
  })

  it('reads <C-…> as Ctrl, which is Mod off the Mac', () => {
    setPlatform('linux')
    expect(parseBindExArgs('<C-BS> note.trash', {})).toEqual({
      kind: 'bind',
      id: 'note.trash',
      binding: 'Mod+Backspace'
    })
  })

  it('opens Settings when there is nothing to bind, and names what it cannot read', () => {
    expect(parseBindExArgs('', {})).toEqual({ kind: 'open' })
    expect(parseBindExArgs('note.trash', {})).toEqual({ kind: 'open' })
    expect(parseBindExArgs('<C-x> no.such.command', {})).toEqual({ kind: 'unknown', id: 'no.such.command' })
    expect(parseBindExArgs('x note.trash', {}).kind).toBe('invalid')
    expect(parseBindExArgs('<Q-x> note.trash', {}).kind).toBe('invalid')
  })

  it('keeps :unbind <action.id> and adds :unbind command <command.id>', () => {
    expect(parseUnbindExArgs('global.zoomIn')).toEqual({ kind: 'action', id: 'global.zoomIn' })
    expect(parseUnbindExArgs('command note.trash')).toEqual({ kind: 'command', id: 'note.trash' })
    // A bare command id that is no action's id: the command.
    expect(parseUnbindExArgs('note.trash')).toEqual({ kind: 'command', id: 'note.trash' })
    expect(parseUnbindExArgs('')).toEqual({ kind: 'open' })
    expect(parseUnbindExArgs('command')).toEqual({ kind: 'open' })
    expect(parseUnbindExArgs('nope')).toEqual({ kind: 'unknown', id: 'nope', command: false })
    expect(parseUnbindExArgs('command nope')).toEqual({ kind: 'unknown', id: 'nope', command: true })
  })

  it('is not ambiguous for nav.back, the id that is both', () => {
    expect(parseUnbindExArgs('nav.back')).toEqual({ kind: 'action', id: 'nav.back' })
    expect(parseUnbindExArgs('command nav.back')).toEqual({ kind: 'command', id: 'nav.back' })
  })
})
