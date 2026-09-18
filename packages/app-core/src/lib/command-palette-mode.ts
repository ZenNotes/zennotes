export type CommandPaletteMode = 'main' | 'theme' | 'vault' | 'workflow'
export type CommandPaletteInitialMode = 'main' | 'vault'

/**
 * Whether Escape (and the "‹ Back" affordance) should step the command
 * palette back to the command list rather than closing it.
 *
 * We only go back when the user drilled into a sub-mode *from* the command
 * list. When the palette is opened straight into a sub-mode — e.g. `<leader>v`
 * opens it directly in 'vault' mode — there is no command list behind it, so
 * Escape must close the palette instead of surfacing a command palette the
 * user never opened. (#119)
 */
export function canReturnToCommandList(
  mode: CommandPaletteMode,
  initialMode: CommandPaletteInitialMode
): boolean {
  return mode !== 'main' && initialMode === 'main'
}

/**
 * Store flags for the palettes and modals a command can open. Each claims
 * focus for its own input when it mounts.
 */
export const COMMAND_OVERLAY_FLAGS = [
  'settingsOpen',
  'searchOpen',
  'vaultTextSearchOpen',
  'bufferPaletteOpen',
  'outlinePaletteOpen',
  'templatePaletteOpen',
  'embedDrawingPaletteOpen'
] as const

export type CommandOverlayFlag = (typeof COMMAND_OVERLAY_FLAGS)[number]

/**
 * Whether the command palette should hand DOM focus to the editor once a
 * command has run.
 *
 * Only when the command landed on the editor and left nothing open on top of
 * it. `focusEditorNormalMode` focuses on the next animation frame, which is
 * after the opened palette's mount effect focused its input, so refocusing
 * behind an overlay sends the user's typing into the note instead of the
 * search field. The overlays are lazy-loaded, which hid this on the first open
 * of a session (the chunk mounted after the refocus) and broke every later
 * one. (zennotesandroid#65)
 *
 * `dialogOutsideStoreOpen` covers the dialogs a command opens WITHOUT awaiting
 * them and that are tracked outside the main store, where the flag list above
 * cannot see them: the Cloud conflict review and the Publish Note dialog. The
 * caller reports those. Prompts, confirms and date pickers need no entry: their
 * commands await the answer, so they are closed by the time this runs.
 */
export function shouldRefocusEditorAfterCommand(
  state: { focusedPanel: string | null } & Record<CommandOverlayFlag, boolean>,
  dialogOutsideStoreOpen: boolean
): boolean {
  if (state.focusedPanel !== 'editor' || dialogOutsideStoreOpen) return false
  return !COMMAND_OVERLAY_FLAGS.some((flag) => state[flag])
}
