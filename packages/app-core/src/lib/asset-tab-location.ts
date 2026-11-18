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
  /** Reference-pane frame URL (with its fragment) -> the nonce of the last
   *  link followed to it. */
  referenceJumps: Record<string, number>
}

export const useAssetTabLocations = create<AssetTabLocationState>(() => ({
  byTab: {},
  referenceJumps: {}
}))

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

/**
 * Pin a PDF in the reference pane at the spot a followed link names.
 *
 * The pane keeps one frame per URL alive so switching between references
 * leaves each PDF where the reader left it; that is right for switching, but
 * a followed link must land on its spot. Before this, a card whose PDF was
 * already pinned only revealed the pane, so `[p. 4](paper.pdf#page=4)` showed
 * whatever page the pane was on (#1085). The pin takes the link's fragment,
 * and a fresh nonce for that frame's URL remounts it at the spot, even when
 * the same location was visited and scrolled away from before. A link with no
 * fragment pins as it always did.
 */
export function pinPdfReferenceAt(
  notePath: string,
  assetPath: string,
  fragment?: string | null
): void {
  const state = useStore.getState()
  const frag = fragment && fragment.length > 1 ? (fragment.startsWith('#') ? fragment : `#${fragment}`) : null
  state.pinAssetReferenceForNote(notePath, assetPath, frag)
  const root = state.vault?.root
  if (!frag || !root) return
  const url = window.zen.resolveVaultAssetUrl(root, assetPath) + frag
  useAssetTabLocations.setState((s) => ({
    referenceJumps: { ...s.referenceJumps, [url]: nextNonce++ }
  }))
}

export function assetTabLocation(tabPath: string): AssetTabLocation | null {
  return useAssetTabLocations.getState().byTab[tabPath] ?? null
}
