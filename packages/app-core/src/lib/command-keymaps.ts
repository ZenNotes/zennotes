/**
 * Keys for command palette commands (#971).
 *
 * The keymap table (`keymaps.ts`) binds the app's built-in ACTIONS: a fixed
 * catalog, each with a shipped default. Commands are the palette's rows, and
 * there are more of them than actions, so they get their own namespace: a
 * map from command id to binding, stored apart from `keymapOverrides`. One
 * id lives in both worlds (`nav.back` is the `h` back-out action and the Go
 * Back command), which is exactly why the two maps never share keys.
 *
 * Every command starts unbound. A binding is one of two shapes:
 *
 * - a chord, in the keymap table's shortcut format (`Mod+Backspace`,
 *   `Shift+Mod+K`, `F5`). It needs Ctrl, Alt or Cmd, or a function key: a
 *   bare letter would eat typing.
 * - a leader sequence, `Leader x t`: the leader key, then one to three
 *   single characters. The leader stays symbolic, so the sequence follows a
 *   rebound leader. Sequences run through Vim mode's leader machinery
 *   (VimNav) and are inert with Vim mode off.
 *
 * As in the keymap table, `""` is a deliberate unbind.
 */
import { COMMAND_CATALOG, COMMAND_LEADER_TOKEN, isBindableCommandId } from '@shared/commands-catalog'
import {
  formatKeyToken,
  getKeymapBinding,
  getKeymapDefinitions,
  getKeymapDisplay,
  getSequenceTokens,
  isMacPlatform,
  isUnboundBinding,
  matchesShortcutBinding,
  normalizeSequenceToken,
  resolveSequenceToken,
  normalizeShortcutBinding,
  UNBOUND_BINDING,
  type KeymapDefinition,
  type KeymapId,
  type KeymapOverrides
} from './keymaps'

export type CommandKeymaps = Record<string, string>

export { COMMAND_LEADER_TOKEN, isBindableCommandId }

/** How many keys may follow the leader in a command's sequence. */
export const MAX_COMMAND_SEQUENCE_KEYS = 3

export type CommandBindingKind = 'shortcut' | 'sequence'

/** The kind of a stored binding, or null for an unbound one. */
export function commandBindingKind(binding: string | null | undefined): CommandBindingKind | null {
  if (typeof binding !== 'string' || isUnboundBinding(binding)) return null
  return binding.split(/\s+/)[0] === COMMAND_LEADER_TOKEN ? 'sequence' : 'shortcut'
}

/** The keys after the leader in a sequence binding, else an empty list. */
export function commandSequenceKeys(binding: string | null | undefined): string[] {
  if (commandBindingKind(binding) !== 'sequence') return []
  return (binding ?? '').split(/\s+/).filter(Boolean).slice(1)
}

/** The leader key's token under these overrides, or "" while it is unbound. */
export function leaderTokenOf(overrides: KeymapOverrides | null | undefined): string {
  return getSequenceTokens(overrides, 'vim.leaderPrefix')[0] ?? UNBOUND_BINDING
}

const CHORD_MODIFIERS = new Set(['Ctrl', 'Alt', 'Mod', 'Meta'])
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/**
 * Whether a normalized shortcut can stand as a command's chord: one with
 * Ctrl, Alt or Cmd (Shift alone types a capital), or a function key.
 */
export function isValidCommandChord(binding: string): boolean {
  const parts = binding.split('+')
  const key = parts.pop() ?? ''
  if (!key) return false
  if (FUNCTION_KEY.test(key)) return true
  return parts.some((part) => CHORD_MODIFIERS.has(part))
}

/** A key that may follow the leader: one visible character, no modifiers. */
function isSequenceKey(token: string): boolean {
  return token.length === 1 && token > ' ' && token <= '~'
}

function isLeaderWord(token: string): boolean {
  return /^(<leader>|leader)$/i.test(token)
}

export type CommandBindingParse =
  | { ok: true; binding: string }
  | { ok: false; error: string }

/**
 * Read a binding as Settings, config.toml or `:bind` writes it and return
 * its canonical form. Accepts `Mod+Backspace` and the other shortcut
 * spellings the keymap table takes, `Leader x t` (also `<leader> x t`), and
 * a sequence that spells the leader out (`Space x t` while Space is the
 * leader). The canonical form is what is stored and written to the file.
 */
export function parseCommandBinding(
  input: string,
  overrides: KeymapOverrides | null | undefined
): CommandBindingParse {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: true, binding: UNBOUND_BINDING }
  const leader = leaderTokenOf(overrides)
  const first = tokens[0]
  const startsWithLeader =
    isLeaderWord(first) ||
    (!!leader && resolveSequenceToken(normalizeSequenceToken(first) ?? '') === leader && tokens.length > 1)
  if (startsWithLeader) {
    const keys = tokens.slice(1)
    if (keys.length === 0) {
      return { ok: false, error: 'A leader sequence needs at least one key after the leader' }
    }
    if (keys.length > MAX_COMMAND_SEQUENCE_KEYS) {
      return {
        ok: false,
        error: `A leader sequence takes at most ${MAX_COMMAND_SEQUENCE_KEYS} keys after the leader`
      }
    }
    for (const key of keys) {
      if (!isSequenceKey(key)) {
        return {
          ok: false,
          error: `"${key}" can't follow the leader: use single keys such as x or T, separated by spaces`
        }
      }
    }
    return { ok: true, binding: [COMMAND_LEADER_TOKEN, ...keys].join(' ') }
  }
  if (tokens.length > 1) {
    return {
      ok: false,
      error: 'A key sequence for a command starts with the leader key, as in "Leader x t"'
    }
  }
  const chord = normalizeShortcutBinding(first)
  if (!chord) return { ok: false, error: `"${first}" is not a key ZenNotes can read` }
  if (!isValidCommandChord(chord)) {
    return {
      ok: false,
      error: `${formatKeyToken(chord)} would type text: a command's key needs Ctrl, Alt or ${isMacPlatform() ? 'Cmd' : 'Meta'}, or a function key`
    }
  }
  return { ok: true, binding: chord }
}

/* ------------------------------------------------------------------------ */
/* Built-in leader keys                                                     */
/* ------------------------------------------------------------------------ */

// The leader actions that sit one level down, after Leader l (note actions)
// or Leader s (search). Everything else in the leader scope is a key right
// after the leader, which is the level a command's sequence starts on.
const LEADER_SUBGROUP_IDS: ReadonlySet<KeymapId> = new Set<KeymapId>([
  'vim.leaderFormatNote',
  'vim.leaderCopyMarkdown',
  'vim.leaderToggleFavorite',
  'vim.leaderTableToDatabase',
  'vim.leaderNoteCover',
  'vim.leaderNoteCoverUnsplash',
  'vim.leaderCalloutType',
  'vim.leaderCodeLanguage',
  'vim.leaderSearchVaultText'
])

/** The built-in keys that follow the leader directly, under these overrides. */
export function builtinLeaderKeys(
  overrides: KeymapOverrides | null | undefined
): Array<{ key: string; definition: KeymapDefinition }> {
  const out: Array<{ key: string; definition: KeymapDefinition }> = []
  for (const definition of getKeymapDefinitions()) {
    if (definition.scope !== 'leader') continue
    if (definition.id === 'vim.leaderPrefix' || LEADER_SUBGROUP_IDS.has(definition.id)) continue
    const key = getSequenceTokens(overrides, definition.id)[0]
    if (key) out.push({ key, definition })
  }
  return out
}

/**
 * The built-in leader key a sequence would run into, or null. Built-in leader
 * keys always win, so a command sequence may not start with one: `Space t`
 * is the template picker, which makes `Space t x` unreachable and refused.
 * (A built-in group such as `Space l` counts as taken too: its keys are its
 * own.)
 */
export function findLeaderCollision(
  binding: string,
  overrides: KeymapOverrides | null | undefined
): KeymapDefinition | null {
  const keys = commandSequenceKeys(binding)
  if (keys.length === 0) return null
  return builtinLeaderKeys(overrides).find((entry) => entry.key === keys[0])?.definition ?? null
}

/* ------------------------------------------------------------------------ */
/* Normalizing a stored map                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Validate an untrusted command keymap (localStorage, config.toml). Unknown
 * ids, bindings that do not parse, and sequences that collide with a
 * built-in leader key are dropped; `""` survives as a deliberate unbind.
 * Entries come out in palette order, so the written file is stable.
 */
export function normalizeCommandKeymaps(
  input: unknown,
  overrides?: KeymapOverrides | null
): CommandKeymaps {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const raw = input as Record<string, unknown>
  const out: CommandKeymaps = {}
  for (const entry of COMMAND_CATALOG) {
    const value = raw[entry.id]
    if (typeof value !== 'string') continue
    const parsed = parseCommandBinding(value, overrides)
    if (!parsed.ok) {
      console.warn(`[keymaps.commands] ignoring "${entry.id}" = "${value}": ${parsed.error}`)
      continue
    }
    const collision = findLeaderCollision(parsed.binding, overrides)
    if (collision) {
      console.warn(
        `[keymaps.commands] ignoring "${entry.id}" = "${value}": the built-in "${collision.title}" holds that leader key`
      )
      continue
    }
    out[entry.id] = parsed.binding
  }
  return out
}

/* ------------------------------------------------------------------------ */
/* Conflicts                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * What a chord physically is on this platform: its modifier keys and its key.
 * The shortcut format writes the platform's primary modifier as `Mod`, while
 * Vim's sequence tokens write `Ctrl+W`; comparing physical chords is what
 * catches a command on Ctrl+W colliding with Vim's pane prefix on Linux.
 */
function chordSignature(binding: string, format: 'shortcut' | 'token'): string | null {
  if (!binding) return null
  const parts = binding.split('+')
  const rawKey = parts.pop()
  if (!rawKey) return null
  const mac = isMacPlatform()
  const mods = new Set<string>()
  for (const part of parts) {
    if (part === 'Mod') mods.add(mac ? 'meta' : 'ctrl')
    else if (part === 'Meta') mods.add('meta')
    else if (part === 'Ctrl') mods.add('ctrl')
    else if (part === 'Alt') mods.add('alt')
    else if (part === 'Shift') mods.add('shift')
  }
  // A sequence token without a modifier is a typed key, never a chord.
  if (format === 'token' && mods.size === 0) return null
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey
  return `${[...mods].sort().join('+')}|${key}`
}

export interface CommandKeymapConflict {
  /** A built-in action or another command. */
  kind: 'action' | 'command'
  id: string
  title: string
  /** True when the other side is a key the user set (an override or another
   *  command's binding): two of those cannot share a key. False for a
   *  built-in default, which an explicit binding wins over. */
  user: boolean
}

function catalogTitle(id: string): string {
  return COMMAND_CATALOG.find((entry) => entry.id === id)?.title ?? id
}

function actionChordSignature(
  definition: KeymapDefinition,
  overrides: KeymapOverrides | null | undefined
): string | null {
  const binding = getKeymapBinding(overrides, definition.id)
  if (isUnboundBinding(binding)) return null
  if (definition.kind === 'shortcut') return chordSignature(binding, 'shortcut')
  const tokens = binding.split(/\s+/).filter(Boolean)
  return tokens.length === 1 ? chordSignature(tokens[0], 'token') : null
}

/**
 * Everything a command binding would collide with.
 *
 * - `blocking`: another key the user set, on the same chord (an action
 *   override or another command), a sequence that is the same as, or a
 *   prefix of, another command's sequence, or a built-in leader key. Save is
 *   refused for these.
 * - `shadows`: a built-in action's DEFAULT on the same chord. Allowed: an
 *   explicit binding wins over a default, and the recorder says which
 *   default stops answering that key.
 */
export function findCommandBindingConflicts(
  commandId: string,
  binding: string,
  context: { overrides: KeymapOverrides | null | undefined; commandKeymaps: CommandKeymaps }
): { blocking: CommandKeymapConflict[]; shadows: CommandKeymapConflict[] } {
  const blocking: CommandKeymapConflict[] = []
  const shadows: CommandKeymapConflict[] = []
  const kind = commandBindingKind(binding)
  if (!kind) return { blocking, shadows }

  if (kind === 'sequence') {
    const leaderHit = findLeaderCollision(binding, context.overrides)
    if (leaderHit) {
      blocking.push({ kind: 'action', id: leaderHit.id, title: leaderHit.title, user: true })
    }
    const keys = commandSequenceKeys(binding)
    for (const [otherId, other] of Object.entries(context.commandKeymaps)) {
      if (otherId === commandId) continue
      const otherKeys = commandSequenceKeys(other)
      if (otherKeys.length === 0) continue
      const shared = Math.min(keys.length, otherKeys.length)
      if (keys.slice(0, shared).join(' ') === otherKeys.slice(0, shared).join(' ')) {
        blocking.push({ kind: 'command', id: otherId, title: catalogTitle(otherId), user: true })
      }
    }
    return { blocking, shadows }
  }

  const signature = chordSignature(binding, 'shortcut')
  if (!signature) return { blocking, shadows }
  for (const [otherId, other] of Object.entries(context.commandKeymaps)) {
    if (otherId === commandId || commandBindingKind(other) !== 'shortcut') continue
    if (chordSignature(other, 'shortcut') === signature) {
      blocking.push({ kind: 'command', id: otherId, title: catalogTitle(otherId), user: true })
    }
  }
  for (const definition of getKeymapDefinitions()) {
    if (actionChordSignature(definition, context.overrides) !== signature) continue
    const user = typeof context.overrides?.[definition.id] === 'string'
    const conflict: CommandKeymapConflict = {
      kind: 'action',
      id: definition.id,
      title: definition.title,
      user
    }
    if (user) blocking.push(conflict)
    else shadows.push(conflict)
  }
  return { blocking, shadows }
}

/**
 * The other direction: the commands whose binding a built-in action's key
 * would collide with. A chord shared with a command, or a leader key that
 * starts a command's sequence (the built-in then wins and the command can no
 * longer be reached).
 */
export function findActionCommandConflicts(
  actionId: KeymapId,
  binding: string,
  context: { overrides: KeymapOverrides | null | undefined; commandKeymaps: CommandKeymaps }
): CommandKeymapConflict[] {
  if (isUnboundBinding(binding)) return []
  const definition = getKeymapDefinitions().find((d) => d.id === actionId)
  if (!definition) return []
  const out: CommandKeymapConflict[] = []
  const nextOverrides: KeymapOverrides = { ...(context.overrides ?? {}), [actionId]: binding }
  const signature = actionChordSignature(definition, nextOverrides)
  const leaderKey =
    definition.scope === 'leader' &&
    definition.id !== 'vim.leaderPrefix' &&
    !LEADER_SUBGROUP_IDS.has(definition.id)
      ? binding.split(/\s+/)[0]
      : null
  for (const [commandId, commandBinding] of Object.entries(context.commandKeymaps)) {
    const kind = commandBindingKind(commandBinding)
    if (kind === 'shortcut' && signature && chordSignature(commandBinding, 'shortcut') === signature) {
      out.push({ kind: 'command', id: commandId, title: catalogTitle(commandId), user: true })
    } else if (kind === 'sequence' && leaderKey && commandSequenceKeys(commandBinding)[0] === leaderKey) {
      out.push({ kind: 'command', id: commandId, title: catalogTitle(commandId), user: true })
    }
  }
  return out
}

/* ------------------------------------------------------------------------ */
/* Matching keys                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The command whose chord this keydown is, or null. Checked in palette order,
 * so two commands left on one chord by a hand-edited config.toml resolve the
 * same way every time: the first one wins.
 */
export function commandIdForChordEvent(
  event: KeyboardEvent,
  commandKeymaps: CommandKeymaps
): string | null {
  // Only a modifier chord or a function key can be a command's chord; every
  // other key is typing and skips the walk.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d{1,2}$/.test(event.key)) return null
  for (const entry of COMMAND_CATALOG) {
    const binding = commandKeymaps[entry.id]
    if (commandBindingKind(binding) !== 'shortcut') continue
    if (matchesShortcutBinding(event, binding)) return entry.id
  }
  return null
}

export type CommandLeaderStep =
  | { kind: 'run'; id: string }
  | { kind: 'more'; prefix: string[] }

/**
 * One key of a command's leader sequence. `prefix` holds the keys already
 * pressed after the leader. A complete sequence runs; a key that starts a
 * longer one keeps the leader armed; anything else is not a command's.
 */
export function stepCommandLeader(
  commandKeymaps: CommandKeymaps,
  prefix: readonly string[],
  key: string
): CommandLeaderStep | null {
  const next = [...prefix, key]
  let longer = false
  for (const entry of COMMAND_CATALOG) {
    const keys = commandSequenceKeys(commandKeymaps[entry.id])
    if (keys.length < next.length) continue
    if (next.some((k, i) => keys[i] !== k)) continue
    if (keys.length === next.length) return { kind: 'run', id: entry.id }
    longer = true
  }
  return longer ? { kind: 'more', prefix: next } : null
}

/**
 * The which-key rows for command sequences after `prefix`: one per next key,
 * named for its command when only one sequence continues there.
 */
export function commandLeaderHints(
  commandKeymaps: CommandKeymaps,
  prefix: readonly string[]
): Array<{ key: string; label: string; detail: string }> {
  const byKey = new Map<string, Array<{ id: string; rest: string[] }>>()
  for (const entry of COMMAND_CATALOG) {
    const keys = commandSequenceKeys(commandKeymaps[entry.id])
    if (keys.length <= prefix.length) continue
    if (prefix.some((k, i) => keys[i] !== k)) continue
    const key = keys[prefix.length]
    const list = byKey.get(key) ?? []
    list.push({ id: entry.id, rest: keys.slice(prefix.length + 1) })
    byKey.set(key, list)
  }
  return [...byKey.entries()].map(([key, list]) => {
    if (list.length === 1) {
      const [only] = list
      return {
        key,
        label: catalogTitle(only.id),
        detail: only.rest.length > 0 ? `Then ${only.rest.join(' ')}. Command ${only.id}.` : `Command ${only.id}.`
      }
    }
    return {
      key,
      label: `${list.length} commands`,
      detail: list.map((item) => catalogTitle(item.id)).join(', ')
    }
  })
}

/* ------------------------------------------------------------------------ */
/* Display                                                                   */
/* ------------------------------------------------------------------------ */

/** A binding as the UI shows it: `⌘⌫`, `Space x t`. Empty for unbound. */
export function formatCommandBinding(
  binding: string | null | undefined,
  overrides: KeymapOverrides | null | undefined
): string {
  const kind = commandBindingKind(binding)
  if (!kind) return ''
  if (kind === 'shortcut') return formatKeyToken(binding ?? '')
  const leader = getKeymapDisplay(overrides, 'vim.leaderPrefix') || COMMAND_LEADER_TOKEN
  return [leader, ...commandSequenceKeys(binding).map((key) => formatKeyToken(key))].join(' ')
}

/**
 * What a palette row or the manual shows for a command's own key. A leader
 * sequence names a Vim key, so it shows only while Vim mode is on and the
 * leader has a key; a chord always shows.
 */
export function commandBindingHint(
  binding: string | null | undefined,
  context: { overrides: KeymapOverrides | null | undefined; vimMode: boolean }
): string {
  const kind = commandBindingKind(binding)
  if (!kind) return ''
  if (kind === 'sequence' && (!context.vimMode || !leaderTokenOf(context.overrides))) return ''
  return formatCommandBinding(binding, context.overrides)
}

/* ------------------------------------------------------------------------ */
/* The recorder                                                              */
/* ------------------------------------------------------------------------ */

export type CommandRecorderStep =
  | { type: 'save' }
  | { type: 'cancel' }
  | { type: 'set'; binding: string }
  | { type: 'ignore'; hint?: string }

/**
 * One keydown in a command's recorder. Unlike an action's recorder, which
 * takes any key, a command's binding never is a bare Enter, Escape or
 * Backspace, so those three drive it from the keyboard: Enter saves, Escape
 * cancels, Backspace clears a chord or takes back the last key of a
 * sequence. Pressing the leader first starts a sequence; anything else is a
 * chord.
 */
export function commandRecorderStep(
  current: string,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  context: {
    leaderToken: string
    shortcutFromEvent: (event: KeyboardEvent) => string | null
    tokenFromEvent: (event: KeyboardEvent) => string | null
  }
): CommandRecorderStep {
  const bare = !event.ctrlKey && !event.metaKey && !event.altKey
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return { type: 'ignore' }
  // Tab moves between the recorder's buttons, as in any dialog.
  if (bare && event.key === 'Tab') return { type: 'ignore' }
  if (bare && !event.shiftKey && event.key === 'Enter') return { type: 'save' }
  if (bare && !event.shiftKey && event.key === 'Escape') return { type: 'cancel' }
  if (bare && !event.shiftKey && (event.key === 'Backspace' || event.key === 'Delete')) {
    if (commandBindingKind(current) === 'sequence') {
      const tokens = current.split(/\s+/).filter(Boolean)
      tokens.pop()
      return { type: 'set', binding: tokens.join(' ') }
    }
    return { type: 'set', binding: UNBOUND_BINDING }
  }
  const asEvent = event as KeyboardEvent
  const sequence = current === COMMAND_LEADER_TOKEN || commandBindingKind(current) === 'sequence'
  if (sequence) {
    const token = context.tokenFromEvent(asEvent)
    if (!token || !isSequenceKey(token)) {
      return { type: 'ignore', hint: 'After the leader, press single keys such as x or T' }
    }
    const keys = current.split(/\s+/).filter(Boolean).slice(1)
    if (keys.length >= MAX_COMMAND_SEQUENCE_KEYS) {
      return { type: 'ignore', hint: `At most ${MAX_COMMAND_SEQUENCE_KEYS} keys follow the leader` }
    }
    return { type: 'set', binding: [COMMAND_LEADER_TOKEN, ...keys, token].join(' ') }
  }
  if (context.leaderToken && context.tokenFromEvent(asEvent) === context.leaderToken) {
    return { type: 'set', binding: COMMAND_LEADER_TOKEN }
  }
  const chord = context.shortcutFromEvent(asEvent)
  if (!chord) return { type: 'ignore' }
  if (!isValidCommandChord(chord)) {
    return {
      type: 'ignore',
      hint: `Hold Ctrl, Alt or ${isMacPlatform() ? 'Cmd' : 'Meta'} with the key, use a function key, or start with the leader`
    }
  }
  return { type: 'set', binding: chord }
}

/* ------------------------------------------------------------------------ */
/* The ex line: :bind and :unbind                                           */
/* ------------------------------------------------------------------------ */

const VIM_KEY_NAMES: Record<string, string> = {
  bs: 'Backspace',
  backspace: 'Backspace',
  cr: 'Enter',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  del: 'Delete',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  lt: '<',
  bar: '|',
  bslash: '\\'
}

const VIM_MODIFIERS: Record<string, string> = {
  c: 'Ctrl',
  a: 'Alt',
  m: 'Alt',
  s: 'Shift',
  d: 'Meta'
}

/**
 * Vim's key notation, as `:map` writes it, into the keymap table's tokens:
 * `<C-BS>` is Ctrl+Backspace, `<D-BS>` Cmd+Backspace (MacVim's D), `<M-x>`
 * and `<A-x>` Alt+X, `<leader>` the leader, `<Space>` Space, and characters
 * outside angle brackets are keys of their own (`<Space>xt` is Space, x, t).
 * Returns null for notation it cannot read.
 */
export function parseVimKeyNotation(input: string): string[] | null {
  const tokens: string[] = []
  let i = 0
  const text = input.trim()
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '<') {
      const close = text.indexOf('>', i + 1)
      if (close === -1) return null
      const inner = text.slice(i + 1, close)
      i = close + 1
      if (/^leader$/i.test(inner)) {
        tokens.push(COMMAND_LEADER_TOKEN)
        continue
      }
      const parts = inner.split('-')
      // `<C-->` (Ctrl and minus) splits into an empty last part.
      let key = parts.pop() ?? ''
      if (key === '' && parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop()
        key = '-'
      }
      const mods: string[] = []
      for (const part of parts) {
        const mod = VIM_MODIFIERS[part.toLowerCase()]
        if (!mod) return null
        mods.push(mod)
      }
      const named = VIM_KEY_NAMES[key.toLowerCase()]
      let base: string
      if (named) base = named
      else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) base = key.toUpperCase()
      else if (key.length === 1) base = key
      else return null
      tokens.push(mods.length > 0 ? `${mods.join('+')}+${base}` : base)
      continue
    }
    tokens.push(ch)
    i += 1
  }
  return tokens.length > 0 ? tokens : null
}

/**
 * The keys half of `:bind` into a canonical binding. Vim notation when it
 * has angle brackets, otherwise the Settings spelling (`Mod+Backspace`,
 * `Space x t`).
 */
export function parseBindKeys(
  keys: string,
  overrides: KeymapOverrides | null | undefined
): CommandBindingParse {
  if (!keys.includes('<')) return parseCommandBinding(keys, overrides)
  const tokens = parseVimKeyNotation(keys)
  if (!tokens) return { ok: false, error: `Can't read the keys "${keys}"` }
  return parseCommandBinding(tokens.join(' '), overrides)
}

export type BindExArgs =
  | { kind: 'open' }
  | { kind: 'unknown'; id: string }
  | { kind: 'invalid'; id: string; error: string }
  | { kind: 'bind'; id: string; binding: string }

/** `:bind <keys> <command.id>`: the command id is the last word. */
export function parseBindExArgs(
  argString: string,
  overrides: KeymapOverrides | null | undefined
): BindExArgs {
  const text = argString.trim()
  if (!text) return { kind: 'open' }
  const split = text.lastIndexOf(' ')
  if (split === -1) return isBindableCommandId(text) ? { kind: 'open' } : { kind: 'unknown', id: text }
  const id = text.slice(split + 1).trim()
  const keys = text.slice(0, split).trim()
  if (!isBindableCommandId(id)) return { kind: 'unknown', id }
  const parsed = parseBindKeys(keys, overrides)
  if (!parsed.ok) return { kind: 'invalid', id, error: parsed.error }
  if (!parsed.binding) return { kind: 'invalid', id, error: 'No keys given' }
  return { kind: 'bind', id, binding: parsed.binding }
}

export type UnbindExArgs =
  | { kind: 'open' }
  | { kind: 'action'; id: KeymapId }
  | { kind: 'command'; id: string }
  | { kind: 'unknown'; id: string; command: boolean }

/**
 * `:unbind <action.id>` as before, `:unbind command <command.id>` for a
 * command. A bare id that names no action but does name a command unbinds
 * the command, the same courtesy config.toml pays; an id that is both
 * (`nav.back`) is the action, and `:unbind command nav.back` the command.
 */
export function parseUnbindExArgs(argString: string): UnbindExArgs {
  const words = argString.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'open' }
  if (words[0] === 'command') {
    const id = words[1]
    if (!id) return { kind: 'open' }
    return isBindableCommandId(id) ? { kind: 'command', id } : { kind: 'unknown', id, command: true }
  }
  const id = words[0]
  const action = getKeymapDefinitions().find((definition) => definition.id === id)
  if (action) return { kind: 'action', id: action.id }
  if (isBindableCommandId(id)) return { kind: 'command', id }
  return { kind: 'unknown', id, command: false }
}
