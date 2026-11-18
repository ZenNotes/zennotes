import { create } from 'zustand'
import { useStore } from '../store'
import { assetTabPath } from './asset-tabs'
import { classifyLocalAssetHref } from './local-assets'
import { allLeaves } from './pane-layout'

/**
 * Where a PDF asset tab should open: the `#page=3&zoom=150` a link carried.
 *
 * The tab's identity (`zen://asset/<path>`) is the bare file, so one PDF keeps
 * one tab whichever page a link names; the location rides beside it here.
 * Before #1085 a mouse-opened link dropped the fragment on the way to the tab
 * and the PDF opened at page 1, while Vim `gd` (which pins the reference pane)
 * kept it. `nonce` changes on every open, so following the same link again
 * after scrolling away jumps back to the spot instead of leaving the frame
 * where it is.
 */
export interface AssetTabLocation {
  fragment: string
  nonce: number
}

interface AssetTabLocationState {
  byTab: Record<string, AssetTabLocation>
}

export const useAssetTabLocations = create<AssetTabLocationState>(() => ({ byTab: {} }))

let nextNonce = 1
let pruning = false

// A location belongs to an open tab. Once the tab closes, opening the PDF again
// from the sidebar starts at the top, as it always did.
function pruneClosedTabs(): void {
  const { byTab } = useAssetTabLocations.getState()
  const tabs = Object.keys(byTab)
  if (tabs.length === 0) return
  const open = new Set(allLeaves(useStore.getState().paneLayout).flatMap((leaf) => leaf.tabs))
  if (tabs.every((tab) => open.has(tab))) return
  const next: Record<string, AssetTabLocation> = {}
  for (const tab of tabs) if (open.has(tab)) next[tab] = byTab[tab]
  useAssetTabLocations.setState({ byTab: next })
}

function ensurePruning(): void {
  if (pruning) return
  pruning = true
  useStore.subscribe((state, prev) => {
    if (state.paneLayout !== prev.paneLayout) pruneClosedTabs()
  })
}

/**
 * Open a vault file in its asset tab. A PDF opened with a `#…` fragment lands
 * at that location; any other file, or a PDF without one, opens as before.
 */
export function openAssetInTab(assetPath: string, fragment?: string | null): Promise<void> {
  const tabPath = assetTabPath(assetPath)
  if (fragment && fragment.length > 1 && classifyLocalAssetHref(assetPath) === 'pdf') {
    ensurePruning()
    const location: AssetTabLocation = {
      fragment: fragment.startsWith('#') ? fragment : `#${fragment}`,
      nonce: nextNonce++
    }
    useAssetTabLocations.setState((s) => ({ byTab: { ...s.byTab, [tabPath]: location } }))
  }
  return useStore.getState().openNoteInTab(tabPath)
}

export function assetTabLocation(tabPath: string): AssetTabLocation | null {
  return useAssetTabLocations.getState().byTab[tabPath] ?? null
}
