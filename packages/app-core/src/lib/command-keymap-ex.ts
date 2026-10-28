/**
 * `:bind` and `:unbind` on the ex line (#971), apart from the editor so they
 * can be tested without one.
 *
 *   :bind <keys> <command.id>        give a command a key
 *   :unbind <action.id>              take a built-in action's key away
 *   :unbind command <command.id>     take a command's key away
 *
 * Keys are written as Settings and config.toml write them (`Mod+Backspace`,
 * `Space x t`) or in Vim's notation (`<C-BS>`, `<D-BS>`, `<leader>xt`,
 * `<Space>xt`). The command id is always the last word.
 */
import { useStore } from '../store'
import { useToastStore } from './toast'
import { requestSettingsTarget } from './settings-navigation'
import { getKeymapDefinition, getKeymapDisplay, UNBOUND_BINDING } from './keymaps'
import { COMMAND_CATALOG } from '@shared/commands-catalog'
import {
  commandBindingKind,
  findCommandBindingConflicts,
  formatCommandBinding,
  parseBindExArgs,
  parseUnbindExArgs
} from './command-keymaps'

function openKeymapSettings(): void {
  requestSettingsTarget('keymaps')
  useStore.getState().setSettingsOpen(true)
}

function toast(message: string, type: 'success' | 'info' = 'info'): void {
  useToastStore.getState().addToast(message, type)
}

function commandTitle(id: string): string {
  return COMMAND_CATALOG.find((entry) => entry.id === id)?.title ?? id
}

/** `:bind <keys> <command.id>`. Bare, or with an id and no keys, it opens
 *  Settings → Keymap, where the Commands group lists every id. */
export function runBindEx(argString: string): void {
  const state = useStore.getState()
  const parsed = parseBindExArgs(argString, state.keymapOverrides)
  if (parsed.kind === 'open') {
    openKeymapSettings()
    return
  }
  if (parsed.kind === 'unknown') {
    toast(`No command is called "${parsed.id}"`)
    openKeymapSettings()
    return
  }
  if (parsed.kind === 'invalid') {
    toast(`Can't bind ${commandTitle(parsed.id)}: ${parsed.error}`)
    return
  }
  const { id, binding } = parsed
  const display = formatCommandBinding(binding, state.keymapOverrides)
  const { blocking, shadows } = findCommandBindingConflicts(id, binding, {
    overrides: state.keymapOverrides,
    commandKeymaps: state.commandKeymaps
  })
  const sequence = commandBindingKind(binding) === 'sequence'
  if (blocking.length > 0) {
    const [first] = blocking
    toast(
      sequence && first.kind === 'action'
        ? `${display} is refused: the key after the leader belongs to the built-in "${first.title}", and built-in leader keys always win`
        : `${display} already belongs to ${first.kind === 'command' ? `the command ${first.title}` : first.title}: change that one first`
    )
    return
  }
  state.setCommandKeymapBinding(id, binding)
  const notes: string[] = []
  if (shadows.length > 0) {
    notes.push(`it wins over the default of ${shadows.map((s) => s.title).join(', ')}`)
  }
  if (sequence && !state.vimMode) notes.push('it works once Vim mode is on')
  toast(
    `${commandTitle(id)} is on ${display}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`,
    'success'
  )
}

/** `:unbind <action.id>` and `:unbind command <command.id>`. Bare, or with an
 *  id nothing knows, it opens Settings → Keymap instead of guessing. */
export function runUnbindEx(argString: string): void {
  const state = useStore.getState()
  const parsed = parseUnbindExArgs(argString)
  if (parsed.kind === 'open') {
    openKeymapSettings()
    return
  }
  if (parsed.kind === 'unknown') {
    toast(
      parsed.command
        ? `No command is called "${parsed.id}"`
        : `No keymap action is called "${parsed.id}"`
    )
    openKeymapSettings()
    return
  }
  if (parsed.kind === 'action') {
    const definition = getKeymapDefinition(parsed.id)
    const before = getKeymapDisplay(state.keymapOverrides, definition.id)
    state.setKeymapBinding(definition.id, UNBOUND_BINDING)
    toast(
      before
        ? `Unbound ${definition.title} (was ${before})`
        : `${definition.title} is already unbound`,
      'success'
    )
    return
  }
  const title = commandTitle(parsed.id)
  const before = formatCommandBinding(state.commandKeymaps[parsed.id], state.keymapOverrides)
  if (!before) {
    toast(`${title} already has no key`, 'success')
    return
  }
  state.setCommandKeymapBinding(parsed.id, UNBOUND_BINDING)
  toast(`Unbound ${title} (was ${before})`, 'success')
}
