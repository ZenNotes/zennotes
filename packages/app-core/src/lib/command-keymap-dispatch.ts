/**
 * Running a command from the key the user gave it (#971).
 *
 * Precedence: a command's key is a binding the user chose, and an explicit
 * binding wins over every default. So the chord listener goes on `window`, in
 * the capture phase, before any component registers there (App installs it
 * at import time, right after the ignored-keys guard): it sees the key before
 * VimNav, before App's own shortcut handlers, and before CodeMirror. A
 * command on Mod+Backspace trashes the note even from the editor, where
 * Mod+Backspace would otherwise delete to the line start; a command on a
 * built-in default such as Mod+L takes that key from Toggle checkbox until
 * one of them moves. Settings refuses a key another of the user's own
 * bindings holds; a config.toml that holds one anyway lets the command win,
 * the first in palette order when two commands share a chord.
 *
 * Leader sequences are the exception: they run through VimNav's leader
 * machinery, after every built-in leader key, because built-in leader keys
 * always win.
 */
import { buildCommands, type Command } from './commands'
import { commandIdForChordEvent, type CommandKeymaps } from './command-keymaps'
import { isOverlayOrDialogOpen } from './overlay-open'
import { isWorkspaceTransitionPending } from './workspace-transition'
import { useToastStore } from './toast'

/** The store fields the dispatcher reads. */
export interface CommandKeymapDispatchState {
  commandKeymaps: CommandKeymaps
  whatsNewOpen: boolean
  settingsOpen: boolean
  searchOpen: boolean
  vaultTextSearchOpen: boolean
  commandPaletteOpen: boolean
  bufferPaletteOpen: boolean
  templatePaletteOpen: boolean
  embedDrawingPaletteOpen: boolean
  outlinePaletteOpen: boolean
}

/**
 * True while something else owns the keyboard: What's New, Settings (and
 * with it every keymap recorder), a palette, a dialog, a menu, an open
 * completion list, or hint mode. The same bail-outs the app's own shortcuts
 * honor. The key then does what it would have done without the binding.
 */
export function commandKeymapsStandDown(state: CommandKeymapDispatchState): boolean {
  if (
    state.whatsNewOpen ||
    state.settingsOpen ||
    state.searchOpen ||
    state.vaultTextSearchOpen ||
    state.commandPaletteOpen ||
    state.bufferPaletteOpen ||
    state.templatePaletteOpen ||
    state.embedDrawingPaletteOpen ||
    state.outlinePaletteOpen
  ) {
    return true
  }
  if (isOverlayOrDialogOpen()) return true
  if (typeof document === 'undefined') return false
  return !!(
    document.querySelector('.cm-tooltip-autocomplete') ||
    document.querySelector('[data-vim-hint-overlay]')
  )
}

/** The words a bound key shows when its command cannot run where it is. */
export function unavailableMessage(command: Pick<Command, 'title' | 'unavailableReason'>): string {
  return command.unavailableReason?.() ?? `${command.title} isn't available here`
}

export type BoundCommandResult = 'ran' | 'unavailable' | 'missing' | 'busy'

/**
 * Run a command a key was bound to, rechecking its `when` now. When it says
 * no, nothing runs and a short toast says why, since the key, unlike a
 * palette row, cannot hide itself.
 */
export async function runBoundCommand(id: string): Promise<BoundCommandResult> {
  if (isWorkspaceTransitionPending()) return 'busy'
  const command = buildCommands({ includeUnavailable: true }).find((cmd) => cmd.id === id)
  if (!command) return 'missing'
  if (command.when && !command.when()) {
    useToastStore.getState().addToast(unavailableMessage(command), 'info')
    return 'unavailable'
  }
  try {
    await command.run()
  } catch (err) {
    console.error('bound command failed', id, err)
  }
  return 'ran'
}

/**
 * The capture-phase keydown handler. Returns true when the key was a
 * command's and has been consumed.
 */
export function handleCommandChordEvent(
  event: KeyboardEvent,
  getState: () => CommandKeymapDispatchState,
  run: (id: string) => unknown = runBoundCommand
): boolean {
  if (event.isComposing) return false
  const state = getState()
  const id = commandIdForChordEvent(event, state.commandKeymaps)
  if (!id) return false
  if (commandKeymapsStandDown(state)) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  // A held chord repeats; the command runs once per press, not once per
  // repeat (holding Mod+Backspace must not trash note after note).
  if (event.repeat) return true
  void run(id)
  return true
}

/**
 * Whether this renderer is the main window. The same bundle draws the quick
 * capture window, floating note windows and the external-file window, which
 * keep their own small set of keys: a command bound to Mod+Backspace must not
 * trash a note from behind a quick capture being typed.
 */
export function isMainAppWindow(search: string): boolean {
  const params = new URLSearchParams(search)
  return (
    params.get('quickCapture') !== '1' &&
    params.get('floating') !== '1' &&
    params.get('externalFile') === null &&
    params.get('exportNote') === null
  )
}

let installed: (() => void) | null = null

/**
 * Install the chord listener once on `window`, capture phase. Must run before
 * any component registers its own window listener (see the top of this
 * file), so App calls it at import time. Reads the live store on each key.
 */
export function installCommandKeymapDispatcher(
  getState: () => CommandKeymapDispatchState
): () => void {
  if (installed) return installed
  if (typeof window === 'undefined') return () => {}
  if (!isMainAppWindow(window.location.search)) return () => {}
  const listener = (event: KeyboardEvent): void => {
    handleCommandChordEvent(event, getState)
  }
  window.addEventListener('keydown', listener, true)
  installed = () => {
    window.removeEventListener('keydown', listener, true)
    installed = null
  }
  return installed
}
