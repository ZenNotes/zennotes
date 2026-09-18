import { useStore } from '../store'
import { resolveAssetPathAmong } from './asset-path-resolution'
import { assetTabPath } from './asset-tabs'

/**
 * Open the vault file a wikilink names (`[[assets/diagram.png]]`, a PDF, an
 * embedded image) in its own tab. Returns false when the target is not an
 * existing file, so the caller continues with its own fallbacks.
 *
 * Three surfaces follow wikilinks with their own resolution chains: the
 * cmd-click and table path (follow-link.ts), the rendered-wikilink click
 * (cm-wikilink-render.ts) and the Vim `gd` action (Editor.tsx). Each fell
 * through to the create offer for a file target and proposed a note named
 * `assets/diagram.png.md`. This is the one step they share. (#757)
 */
export function openWikilinkAttachment(target: string): boolean {
  const state = useStore.getState()
  const assetPath = resolveAssetPathAmong(state.assetFiles, state.selectedPath ?? '', target)
  if (!assetPath) return false
  void state.openNoteInTab(assetTabPath(assetPath))
  return true
}
