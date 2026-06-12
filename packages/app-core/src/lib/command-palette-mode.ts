export type CommandPaletteMode = 'main' | 'theme' | 'vault'
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
