/**
 * Split mode keeps the editor and the reading view on the same content. Every
 * top-level block of the rendered note carries the source line it starts on
 * (`data-source-line`), which gives one pair of scroll positions per block:
 * where that content begins in the editor and where it begins in the preview.
 * Between two such anchors a scroll position maps by the fraction of the way
 * it is from one to the next, so a formula or callout that renders ten times
 * taller than its source stretches its own stretch of the other pane instead
 * of shifting everything after it. The document's start and both panes' ends
 * are anchors too: the top of one pane is the top of the other, and the end is
 * the end.
 *
 * Both directions walk the same anchors, so preview-to-editor is the exact
 * inverse of editor-to-preview. The preview used to follow the editor by line
 * while the editor followed the preview by raw scroll ratio; with KaTeX and
 * callouts the two disagreed by whole sections, and every round trip dragged
 * the reader somewhere else. (#859)
 */
export type SplitScrollPane = 'editor' | 'preview'

export interface SplitScrollAnchor {
  editor: number
  preview: number
}

/**
 * The anchors both directions share: the document start, then each block
 * that begins further down in BOTH panes than the last one kept (blocks the
 * editor folds into one widget, or that render with no height, share a
 * position; the first of them stands for all), then the two panes' ends.
 * A block at either scroll limit belongs to the paired end anchor; keeping
 * it would leave the other pane short of its end. Blocks beyond a limit
 * are unreachable as scroll positions and end the list there too.
 */
export function splitScrollAnchors(
  blocks: Iterable<SplitScrollAnchor>,
  editorMax: number,
  previewMax: number
): SplitScrollAnchor[] {
  const anchors: SplitScrollAnchor[] = [{ editor: 0, preview: 0 }]
  for (const block of blocks) {
    if (block.editor >= editorMax || block.preview >= previewMax) break
    const last = anchors[anchors.length - 1]
    if (block.editor > last.editor && block.preview > last.preview) anchors.push(block)
  }
  const last = anchors[anchors.length - 1]
  if (editorMax > last.editor && previewMax > last.preview) {
    anchors.push({ editor: editorMax, preview: previewMax })
  }
  return anchors
}

/** The scroll position in the other pane that shows what `top` shows in `from`. */
export function mapSplitScrollTop(
  anchors: readonly SplitScrollAnchor[],
  from: SplitScrollPane,
  top: number
): number {
  const to: SplitScrollPane = from === 'editor' ? 'preview' : 'editor'
  const last = anchors.length - 1
  if (last < 1) return 0
  if (top <= anchors[0][from]) return anchors[0][to]
  if (top >= anchors[last][from]) return anchors[last][to]
  // The segment holding `top`: its start is the last anchor at or above it.
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (anchors[mid][from] <= top) lo = mid
    else hi = mid
  }
  const start = anchors[lo]
  const end = anchors[hi]
  const fraction = (top - start[from]) / (end[from] - start[from])
  return start[to] + fraction * (end[to] - start[to])
}

/** How long the pane the user drives keeps the lead after its last scroll. */
export const SPLIT_SCROLL_LEAD_MS = 250

export interface SplitScrollLead {
  pane: SplitScrollPane
  until: number
}

/**
 * True while the other pane leads: a scroll here is then the echo of our own
 * sync (or the editor re-measuring the region the sync revealed), never input
 * to send back. A one-shot "ignore the next event" flag missed the second echo
 * CodeMirror fires while it measures live-preview widgets, and that echo
 * snapped the preview back to where the editor had lagged. (#859)
 */
export function splitScrollEchoes(
  lead: SplitScrollLead | null,
  pane: SplitScrollPane,
  now: number
): boolean {
  return lead != null && lead.pane !== pane && now < lead.until
}
