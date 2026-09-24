import { lineOfOffset } from '@shared/note-comments'
import type { OutlineItem } from './outline'

const RENDERED_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

/** The slice of a store `NoteJumpLocation` the reading view needs. */
export interface PreviewJumpRequest {
  editorSelectionAnchor: number
  previewScrollTop: number
  editorScrollMode?: 'preserve' | 'center' | 'start'
  highlightLine?: boolean
}

/**
 * What a pane in reading mode does with a pending jump.
 *
 * - `edit`: the jump exists for the editor. A task jump paints a highlight on
 *   the source line, which only the editor can show.
 * - `restore`: Ctrl+O / Ctrl+I. The location remembers how far the reading
 *   view was scrolled when the user left, so put it back there.
 * - `line`: a `[[Note#Heading]]`, `[[Note#^block]]` or search hit. Land the
 *   rendered block for that source line at the top, and stay in reading mode.
 */
export type PreviewJumpPlan =
  | { kind: 'edit' }
  | { kind: 'restore'; top: number }
  | { kind: 'line'; line: number }

export function planPreviewJump(jump: PreviewJumpRequest, body: string): PreviewJumpPlan {
  if (jump.highlightLine) return { kind: 'edit' }
  if ((jump.editorScrollMode ?? 'preserve') === 'preserve') {
    return { kind: 'restore', top: Math.max(0, jump.previewScrollTop) }
  }
  return { kind: 'line', line: lineOfOffset(body, jump.editorSelectionAnchor) }
}

/**
 * Whether the reading view's DOM is the render of `notePath`. The preview
 * renders asynchronously (diagrams first, then one DOM swap), so right after a
 * note opens the article still shows the previous note; scrolling against
 * those blocks would land anywhere. `Preview` stamps the path on the article
 * in the same step as the DOM swap.
 */
export function previewShowsNote(previewScrollEl: ParentNode | null, notePath: string): boolean {
  const article = previewScrollEl?.querySelector<HTMLElement>('[data-preview-content]')
  return article?.dataset.notePath === notePath
}

/**
 * The stretch of source the reading view has on screen. `top` is the stamped
 * line of the first block still (partly) in view, `end` the line of the first
 * block below the fold, or null when the view reaches the end of the note.
 */
export interface PreviewVisibleSourceLines {
  top: number
  end: number | null
}

/**
 * Read the visible source range off the rendered blocks. Null when nothing
 * stamped is on screen: an empty note, or a render of the previous note
 * (check `previewShowsNote` first).
 */
export function previewVisibleSourceLines(
  previewScrollEl: HTMLElement | null
): PreviewVisibleSourceLines | null {
  if (!previewScrollEl) return null
  const viewport = previewScrollEl.getBoundingClientRect()
  let top: number | null = null
  for (const block of previewScrollEl.querySelectorAll<HTMLElement>('[data-source-line]')) {
    const line = Number(block.dataset.sourceLine)
    if (!Number.isFinite(line)) continue
    const rect = block.getBoundingClientRect()
    if (top == null) {
      if (rect.bottom > viewport.top + 1) top = line
    } else if (rect.top >= viewport.bottom) {
      return { top, end: line }
    }
  }
  return top == null ? null : { top, end: null }
}

/**
 * Whether `line` falls inside what the reader can see. The block that starts
 * at `top` counts even when its first pixels are scrolled off, so a caret
 * left on a heading whose section is on screen is still "in view".
 */
export function previewShowsSourceLine(
  visible: PreviewVisibleSourceLines | null,
  line: number
): boolean {
  if (!visible) return false
  return line >= visible.top && (visible.end == null || line < visible.end)
}

/** A rendered block the reader pointed at, resolved to where it came from. */
export interface PreviewEditRequest {
  /** 1-based source line of the block, null when the pointer sat off any stamped block. */
  sourceLine: number | null
  /** Where the block's top edge is on screen (client coordinates), when known. */
  blockClientTop: number | null
}

// Things in the reading view that own their double-click, or whose lines are
// not this note's: links (the first click already navigated), controls, asset
// embeds (the image embed offers its own "Edit this block" button), diagrams
// (double-click resets their pan and zoom), Excalidraw frames, and transcluded
// notes (their stamps count lines of the expanded markdown, not of this file).
const PREVIEW_EDIT_INERT_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  'iframe',
  'video',
  'audio',
  'canvas',
  '[data-local-asset-kind]',
  '[data-zen-diagram-kind]',
  '[data-excalidraw-embed]',
  '.note-embed'
].join(', ')

/**
 * The block a double-click in the reading view opens for editing, or null when
 * the click landed on something that should keep its own behaviour.
 */
export function previewEditRequestForTarget(target: EventTarget | null): PreviewEditRequest | null {
  if (!(target instanceof Element)) return null
  if (target.closest(PREVIEW_EDIT_INERT_SELECTOR)) return null
  const block = target.closest<HTMLElement>('[data-source-line]')
  if (!block) return null
  const line = Number(block.dataset.sourceLine)
  if (!Number.isFinite(line) || line < 1) return null
  return { sourceLine: line, blockClientTop: block.getBoundingClientRect().top }
}

/**
 * Where the landed line should sit in the editor so it stays at the height its
 * rendered block had on screen and the eye does not have to travel. Clamped so
 * the line neither hugs the top edge nor falls off the bottom; a block whose
 * position is unknown lands at the minimum margin, like an outline jump.
 */
export function editorLandingTopMargin(
  blockClientTop: number | null,
  viewportClientTop: number,
  viewportHeight: number,
  minMargin: number
): number {
  if (blockClientTop == null) return minMargin
  const maxMargin = Math.max(minMargin, viewportHeight - 2 * minMargin)
  const offset = Math.round(blockClientTop - viewportClientTop)
  return Math.max(minMargin, Math.min(maxMargin, offset))
}

const ATX_HEADING_TEXT_OFFSET_RE = /^(#{1,6})[ \t]+/

export function outlineHeadingTextOffset(lineText: string): number {
  return lineText.match(ATX_HEADING_TEXT_OFFSET_RE)?.[0].length ?? 0
}

export function shouldSyncPreviewAfterMarkdownSettles(
  mode: string,
  hasContent: boolean,
  previewIsStale: boolean
): boolean {
  return mode === 'split' && hasContent && !previewIsStale
}

export function shouldSyncPreviewFromEditorViewport(
  mode: string,
  hasContent: boolean,
  previewIsStale: boolean,
  outlineSyncLocked: boolean
): boolean {
  return shouldSyncPreviewAfterMarkdownSettles(mode, hasContent, previewIsStale) &&
    !outlineSyncLocked
}

export function findOutlineHeadingIndex(
  items: readonly OutlineItem[],
  line: number
): number {
  return items.findIndex((item) => item.line === line)
}

export function findRenderedHeadingForOutlineLine(
  previewRoot: ParentNode,
  items: readonly OutlineItem[],
  line: number
): HTMLElement | null {
  const outlineIndex = findOutlineHeadingIndex(items, line)
  if (outlineIndex < 0) return null
  const headings = previewRoot.querySelectorAll<HTMLElement>(RENDERED_HEADING_SELECTOR)
  return headings[outlineIndex] ?? null
}

export function previewScrollTopForHeading(
  previewScrollEl: HTMLElement,
  heading: HTMLElement,
  topMargin: number
): number {
  return scrollTopForElementRelativeTop(previewScrollEl, heading, topMargin)
}

export function scrollTopForElementRelativeTop(
  scrollEl: HTMLElement,
  element: HTMLElement,
  relativeTop: number
): number {
  const containerRect = scrollEl.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const maxTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
  const nextTop = scrollEl.scrollTop + elementRect.top - containerRect.top - relativeTop
  return Math.max(0, Math.min(maxTop, nextTop))
}

export function scrollTopForScrollRatio(
  sourceScrollTop: number,
  sourceScrollHeight: number,
  sourceClientHeight: number,
  targetScrollHeight: number,
  targetClientHeight: number
): number {
  const sourceMax = sourceScrollHeight - sourceClientHeight
  const targetMax = targetScrollHeight - targetClientHeight
  if (targetMax <= 0) return 0
  if (sourceMax <= 0) return 0
  const ratio = Math.max(0, Math.min(1, sourceScrollTop / sourceMax))
  return ratio * targetMax
}

export function nextOutlinePreviewSyncLockUntil(
  nowMs: number,
  durationMs: number,
  currentUntilMs: number
): number {
  return Math.max(currentUntilMs, nowMs + durationMs)
}
