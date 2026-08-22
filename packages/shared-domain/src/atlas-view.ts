// The pseudo-path that opens the Atlas map as a tab, matching the convention
// used by Tasks, Tags, Workflows, Archive, Trash and Help. Lives in
// shared-domain so the renderer, the command palette and the pane router all
// agree on one string.
export const ATLAS_TAB_PATH = 'zen://atlas'

export function isAtlasTabPath(path: string | null | undefined): boolean {
  return path === ATLAS_TAB_PATH
}
