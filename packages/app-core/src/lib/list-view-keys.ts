/**
 * How the list views (Archive, Trash, Quick Notes, Tags, Tasks, Unresolved
 * links, the Gallery, Workflows, the Timeline) read a key against their own
 * actions' bindings.
 *
 * Each of them used to open with `if (e.metaKey || e.ctrlKey || e.altKey)
 * return`, so the app's chords went past them untouched. That also threw
 * away every chord a user bound to one of the view's actions: with
 * `"nav.delete" = "Ctrl+Backspace"` in config.toml the Archive view never
 * saw the key, and nothing said so (#972). The rule now:
 *
 * - A typed key (no Ctrl, Alt or Cmd) reaches the view exactly as before.
 * - A chord reaches the view only when it is the key of one of the view's
 *   own actions, and never when an app-wide shortcut (the global and tab
 *   shortcuts) or, with Vim on, the pane prefix holds it: those keep their
 *   key everywhere. Settings → Keymap marks a binding that loses this way.
 * - A chord never answers a view's hard-coded keys (arrows, Enter, Escape,
 *   Vim's `d`): `listViewKey` hands the view an empty key for it, so a
 *   binding on Alt+ArrowDown runs its action instead of moving the cursor.
 * - With Vim off the typed keys stay off (only arrows, Enter and Escape are
 *   universal), but a chord bound to an action works in either mode.
 */
import {
  appShortcutForEvent,
  getKeymapDefinition,
  getSequenceTokens,
  isChordEvent,
  isMacPlatform,
  isUnboundBinding,
  matchesSequenceToken,
  normalizeShortcutBinding,
  resolveSequenceToken,
  sequenceTokenFromEvent,
  type KeymapDefinition,
  type KeymapId,
  type KeymapOverrides
} from './keymaps'

/** True when the event starts this action's binding: the whole binding for a
 *  one-key action, its first key for a sequence. */
function eventStartsBinding(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId
): boolean {
  const first = getSequenceTokens(overrides, id)[0]
  if (!first) return false
  return sequenceTokenFromEvent(event) === first
}

/**
 * The app-wide key a chord belongs to before any view or panel sees it: an
 * `app`-scope shortcut (the global and tab shortcuts), or with Vim on the
 * pane prefix. Null for a typed key or a chord nothing app-wide holds.
 */
export function chordHeldByApp(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  vimMode: boolean
): KeymapDefinition | null {
  if (!isChordEvent(event)) return null
  const app = appShortcutForEvent(event, overrides)
  if (app) return app
  if (vimMode && matchesSequenceToken(event, overrides, 'vim.panePrefix')) {
    return getKeymapDefinition('vim.panePrefix')
  }
  return null
}

/**
 * Whether a list view must leave this keydown alone. Replaces the views'
 * blanket modifier bail: typed keys are never stepped over here, a chord is
 * stepped over unless it is the key of one of `actions` and nothing app-wide
 * holds it.
 */
export function listViewYieldsKey(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  actions: readonly KeymapId[],
  vimMode: boolean
): boolean {
  if (!isChordEvent(event)) return false
  if (!actions.some((id) => eventStartsBinding(event, overrides, id))) return true
  return chordHeldByApp(event, overrides, vimMode) !== null
}

/** The key a view's hard-coded checks see: the event's own key for a typed
 *  key, nothing for a chord. */
export function listViewKey(event: KeyboardEvent): string {
  return isChordEvent(event) ? '' : event.key
}

/**
 * Whether the event is this view action's key. A typed key counts only with
 * Vim on; a chord counts in either mode (Ctrl, Alt and Cmd are not the
 * single-key shortcuts Vim off turns off).
 */
export function listViewBindingMatches(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
  vimMode: boolean
): boolean {
  if (!vimMode && !isChordEvent(event)) return false
  return matchesSequenceToken(event, overrides, id)
}

/** Vim mode or a chord: when a view's multi-key sequences (`g g`) may run. */
export function listViewSequencesLive(event: KeyboardEvent, vimMode: boolean): boolean {
  return vimMode || isChordEvent(event)
}

/** A key's modifiers and key as a keydown would carry them, for comparing a
 *  stored token with the app's shortcuts without a real event. */
function eventForToken(token: string, mac: boolean): KeyboardEvent | null {
  const resolved = resolveSequenceToken(token, mac)
  const parts = resolved.split('+')
  const base = parts.pop()
  if (!base) return null
  let key = base
  if (base === 'Esc') key = 'Escape'
  else if (base === 'Space') key = ' '
  else if (/^[A-Z]$/.test(base)) key = base.toLowerCase()
  const code = /^[A-Za-z]$/.test(base)
    ? `Key${base.toUpperCase()}`
    : /^\d$/.test(base)
      ? `Digit${base}`
      : base
  return {
    key,
    code,
    ctrlKey: parts.includes('Ctrl'),
    metaKey: parts.includes('Meta'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'),
    repeat: false
  } as KeyboardEvent
}

const LIST_SCOPES = new Set(['lists', 'views'])

/**
 * What takes this action's key before the action can see it, or null when
 * nothing does. Settings → Keymap shows it on the row (and the recorder
 * before saving) instead of storing a binding that never fires.
 *
 * Only chords on list and view actions can lose this way: the list views
 * step aside for an app-wide shortcut on the same chord, and for the pane
 * prefix with Vim on (see listViewYieldsKey).
 */
export function keymapBindingTakenBy(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
  binding: string,
  vimMode: boolean,
  mac: boolean = isMacPlatform()
): KeymapDefinition | null {
  const definition = getKeymapDefinition(id)
  if (!LIST_SCOPES.has(definition.scope)) return null
  if (isUnboundBinding(binding)) return null
  const first =
    definition.kind === 'shortcut' ? normalizeShortcutBinding(binding) : binding.split(/\s+/)[0]
  if (!first) return null
  const event = eventForToken(
    definition.kind === 'shortcut' ? shortcutAsToken(first, mac) : first,
    mac
  )
  if (!event) return null
  return chordHeldByApp(event, { ...(overrides ?? {}), [id]: binding }, vimMode)
}

/** A shortcut-format binding (`Shift+Mod+P`) spelled as a sequence token, so
 *  one reader serves both kinds. */
function shortcutAsToken(binding: string, mac: boolean): string {
  const parts = binding.split('+')
  const base = parts.pop() ?? ''
  const mods = parts.map((part) => (part === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : part))
  return [...mods, base].join('+')
}
