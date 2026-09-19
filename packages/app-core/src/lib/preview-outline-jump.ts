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
