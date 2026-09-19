// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  findOutlineHeadingIndex,
  findRenderedHeadingForOutlineLine,
  nextOutlinePreviewSyncLockUntil,
  outlineHeadingTextOffset,
  planPreviewJump,
  previewScrollTopForHeading,
  previewShowsNote,
  scrollTopForElementRelativeTop,
  scrollTopForScrollRatio,
  shouldSyncPreviewAfterMarkdownSettles,
  shouldSyncPreviewFromEditorViewport
} from './preview-outline-jump'
import type { OutlineItem } from './outline'

const outline: OutlineItem[] = [
  { level: 1, text: 'Intro', line: 1, from: 0 },
  { level: 2, text: 'Middle', line: 24, from: 400 },
  { level: 2, text: 'Target', line: 72, from: 1200 }
]

describe('preview outline jump helpers', () => {
  it('maps an outline line to the matching rendered heading index', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h1>Intro</h1><p>body</p><h2>Middle</h2><h2>Target</h2>'

    expect(findOutlineHeadingIndex(outline, 72)).toBe(2)
    expect(findRenderedHeadingForOutlineLine(root, outline, 72)?.textContent).toBe('Target')
    expect(findRenderedHeadingForOutlineLine(root, outline, 99)).toBeNull()
  })

  it('targets the rendered heading text instead of the markdown marker', () => {
    expect(outlineHeadingTextOffset('# Intro')).toBe(2)
    expect(outlineHeadingTextOffset('###### Deep heading')).toBe(7)
    expect(outlineHeadingTextOffset('Plain text')).toBe(0)
  })

  it('computes a bounded preview scroll top for a rendered heading', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 120, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 260 } as DOMRect)

    expect(previewScrollTopForHeading(preview, heading, 24)).toBe(336)
  })

  it('keeps a rendered element at the same viewport offset as its editor anchor', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 120, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 180 } as DOMRect)

    expect(scrollTopForElementRelativeTop(preview, heading, 72)).toBe(208)
  })

  it('clamps preview scroll targets to the available scroll range', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 650, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 260 } as DOMRect)

    expect(previewScrollTopForHeading(preview, heading, 24)).toBe(700)
  })

  it('maps continuous scroll by ratio for smooth split-pane sync', () => {
    expect(scrollTopForScrollRatio(250, 1000, 500, 2000, 1000)).toBe(500)
    expect(scrollTopForScrollRatio(1200, 1000, 500, 2000, 1000)).toBe(1000)
    expect(scrollTopForScrollRatio(250, 500, 500, 2000, 1000)).toBe(0)
    expect(scrollTopForScrollRatio(250, 1000, 500, 1000, 1000)).toBe(0)
  })

  it('extends the outline preview sync lock without shortening an active lock', () => {
    expect(nextOutlinePreviewSyncLockUntil(100, 450, 0)).toBe(550)
    expect(nextOutlinePreviewSyncLockUntil(125, 100, 550)).toBe(550)
    expect(nextOutlinePreviewSyncLockUntil(600, 100, 550)).toBe(700)
  })

  it('waits for current split preview markdown before resyncing after render', () => {
    expect(shouldSyncPreviewAfterMarkdownSettles('split', true, false)).toBe(true)
    expect(shouldSyncPreviewAfterMarkdownSettles('split', true, true)).toBe(false)
    expect(shouldSyncPreviewAfterMarkdownSettles('edit', true, false)).toBe(false)
    expect(shouldSyncPreviewAfterMarkdownSettles('split', false, false)).toBe(false)
  })

  it('allows editor-driven preview sync only when the current preview can move', () => {
    expect(shouldSyncPreviewFromEditorViewport('split', true, false, false)).toBe(true)
    expect(shouldSyncPreviewFromEditorViewport('split', true, true, false)).toBe(false)
    expect(shouldSyncPreviewFromEditorViewport('split', true, false, true)).toBe(false)
    expect(shouldSyncPreviewFromEditorViewport('preview', true, false, false)).toBe(false)
  })
})

describe('planPreviewJump (a jump landing in a pane that is reading)', () => {
  const body = '# Intro\n\nSome text.\n\n## Target\n\nMore text. ^quote\n'
  const targetHeadingFrom = body.indexOf('## Target')
  const blockFrom = body.indexOf('More text.')

  it('lands a [[Note#Heading]] jump on the heading line and stays in reading mode', () => {
    expect(
      planPreviewJump(
        { editorSelectionAnchor: targetHeadingFrom, previewScrollTop: 0, editorScrollMode: 'start' },
        body
      )
    ).toEqual({ kind: 'line', line: 5 })
  })

  it('lands a ^block jump and a search hit on the block that holds the offset', () => {
    expect(
      planPreviewJump(
        { editorSelectionAnchor: blockFrom, previewScrollTop: 0, editorScrollMode: 'start' },
        body
      )
    ).toEqual({ kind: 'line', line: 7 })
    // A search hit points into the middle of a line, not at its start.
    expect(
      planPreviewJump(
        { editorSelectionAnchor: blockFrom + 5, previewScrollTop: 0, editorScrollMode: 'center' },
        body
      )
    ).toEqual({ kind: 'line', line: 7 })
    // An offset past the end (the note shrank) clamps to the last line.
    expect(
      planPreviewJump(
        { editorSelectionAnchor: body.length + 40, previewScrollTop: 0, editorScrollMode: 'center' },
        body
      )
    ).toEqual({ kind: 'line', line: 8 })
  })

  it('puts the reading view back where it was for a Ctrl+O / Ctrl+I jump', () => {
    expect(
      planPreviewJump(
        { editorSelectionAnchor: 900, previewScrollTop: 412, editorScrollMode: 'preserve' },
        body
      )
    ).toEqual({ kind: 'restore', top: 412 })
    // A location captured before scroll modes existed carries no mode: it is
    // a history entry, so it restores instead of scrolling to a line.
    expect(
      planPreviewJump({ editorSelectionAnchor: 900, previewScrollTop: -3 }, body)
    ).toEqual({ kind: 'restore', top: 0 })
  })

  it('still hands a task jump to the editor, which owns the line highlight', () => {
    expect(
      planPreviewJump(
        {
          editorSelectionAnchor: blockFrom,
          previewScrollTop: 0,
          editorScrollMode: 'center',
          highlightLine: true
        },
        body
      )
    ).toEqual({ kind: 'edit' })
  })
})

describe('previewShowsNote', () => {
  it('is true only when the rendered article carries the note path', () => {
    const scroller = document.createElement('div')
    const article = document.createElement('article')
    article.setAttribute('data-preview-content', '')
    scroller.appendChild(article)

    expect(previewShowsNote(scroller, 'inbox/A.md')).toBe(false)
    article.dataset.notePath = 'inbox/A.md'
    expect(previewShowsNote(scroller, 'inbox/A.md')).toBe(true)
    expect(previewShowsNote(scroller, 'inbox/B.md')).toBe(false)
    expect(previewShowsNote(null, 'inbox/A.md')).toBe(false)
  })
})
