import { isWorkspaceTransitionPending } from './lib/workspace-transition'
import { buildCommands } from './lib/commands'
import { useStore } from './store'

export interface AppCommand {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly keywords?: string
  readonly shortcut?: string
  readonly available: boolean
}
/** Descriptions are snapshots. Invocation always rechecks the current command. */
export function getAppCommands(): readonly AppCommand[] {
  return Object.freeze(buildCommands({ includeUnavailable: true }).map(command => Object.freeze({
    id: command.id, title: command.title, category: command.category,
    keywords: command.keywords, shortcut: command.shortcut,
    available: !command.when || command.when()
  })))
}
export async function runAppCommand(id: string): Promise<boolean> {
  if (isWorkspaceTransitionPending()) return false
  const command = buildCommands({ includeUnavailable: true }).find(command => command.id === id)
  if (!command || (command.when && !command.when())) return false
  await command.run()
  return true
}
export function showCommandPalette(): void { useStore.getState().setCommandPaletteOpen(true) }
export function showSearch(): void { useStore.getState().setSearchOpen(true) }
export function showTemplates(): void { useStore.getState().setTemplatePaletteOpen(true) }
export function showOutline(): void {
  if (useStore.getState().activeNote) useStore.getState().setOutlinePaletteOpen(true)
}
