// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  editorLandingTopMargin,
  findOutlineHeadingIndex,
  findRenderedHeadingForOutlineLine,
  nextOutlinePreviewSyncLockUntil,
  outlineHeadingTextOffset,
  planPreviewJump,
  previewEditRequestForTarget,
  previewScrollTopForHeading,
  previewShowsNote,
  previewShowsSourceLine,
  previewVisibleSourceLines,
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

// A reading view whose scroller spans `viewportTop..viewportBottom` on screen,
// with stamped blocks laid out at the given client rects.
function renderedPreview(
  blocks: Array<{ line: number | string | null; top: number; bottom: number }>,
  viewportTop: number,
  viewportBottom: number
): HTMLDivElement {
  const scroller = document.createElement('div')
  scroller.getBoundingClientRect = () =>
    ({ top: viewportTop, bottom: viewportBottom, height: viewportBottom - viewportTop } as DOMRect)
  for (const block of blocks) {
    const el = document.createElement('p')
    if (block.line != null) el.setAttribute('data-source-line', String(block.line))
    el.getBoundingClientRect = () =>
      ({ top: block.top, bottom: block.bottom, height: block.bottom - block.top } as DOMRect)
    scroller.appendChild(el)
  }
  return scroller
}

describe('previewVisibleSourceLines (what the reader has on screen, #822)', () => {
  const layout = [
    { line: 1, top: 0, bottom: 100 },
    { line: 5, top: 100, bottom: 300 },
    { line: 12, top: 300, bottom: 500 },
    { line: 20, top: 500, bottom: 700 },
    { line: 30, top: 700, bottom: 900 }
  ]

  it('starts at the block still partly in view and ends at the first block below the fold', () => {
    // Line 5 is only visible in its lower half; line 20 pokes in from below.
    // Both count as on screen; line 30 starts past the bottom edge.
    expect(previewVisibleSourceLines(renderedPreview(layout, 250, 650))).toEqual({ top: 5, end: 30 })
  })

  it('reports an open end when the view reaches the end of the note', () => {
    expect(previewVisibleSourceLines(renderedPreview(layout, 250, 1000))).toEqual({ top: 5, end: null })
  })

  it('does not count a block whose bottom edge merely touches the top of the view', () => {
    const touching = [
      { line: 1, top: 0, bottom: 251 },
      { line: 5, top: 251, bottom: 600 }
    ]
    expect(previewVisibleSourceLines(renderedPreview(touching, 250, 650))).toEqual({ top: 5, end: null })
  })

  it('skips unstamped and malformed blocks and reports nothing for an empty render', () => {
    const mixed = [
      { line: null, top: 0, bottom: 400 },
      { line: 'nope', top: 0, bottom: 400 },
      { line: 8, top: 100, bottom: 400 }
    ]
    expect(previewVisibleSourceLines(renderedPreview(mixed, 0, 500))).toEqual({ top: 8, end: null })
    expect(previewVisibleSourceLines(renderedPreview([], 0, 500))).toBeNull()
    expect(previewVisibleSourceLines(null)).toBeNull()
  })

  it('treats the line range as half open', () => {
    const visible = { top: 5, end: 30 }
    expect(previewShowsSourceLine(visible, 5)).toBe(true)
    expect(previewShowsSourceLine(visible, 4)).toBe(false)
    expect(previewShowsSourceLine(visible, 29)).toBe(true)
    expect(previewShowsSourceLine(visible, 30)).toBe(false)
    expect(previewShowsSourceLine({ top: 5, end: null }, 999)).toBe(true)
    expect(previewShowsSourceLine(null, 5)).toBe(false)
  })
})

describe('previewEditRequestForTarget (double-click in the reading view, #822)', () => {
  function article(): HTMLElement {
    const root = document.createElement('article')
    root.innerHTML = [
      '<p data-source-line="7"><strong>bold</strong> text</p>',
      '<p data-source-line="9"><a href="#x">link</a></p>',
      '<figure data-local-asset-kind="image" data-source-line="11"><img alt=""></figure>',
      '<div class="note-embed"><p data-source-line="3">embedded</p></div>',
      '<pre><code data-source-line="15">code</code></pre>',
      '<div data-zen-diagram-kind="mermaid" data-source-line="20"><div class="zen-diagram-surface"><svg></svg></div></div>',
      '<h2 data-source-line="30"><button>fold</button>Heading</h2>',
      '<p data-source-line="nope">bad stamp</p>',
      '<p data-source-line="0">zero</p>'
    ].join('')
    return root
  }

  it('resolves inline content to its top-level block and reports where the block is', () => {
    const root = article()
    const paragraph = root.querySelector<HTMLElement>('[data-source-line="7"]')!
    paragraph.getBoundingClientRect = () => ({ top: 321 } as DOMRect)

    expect(previewEditRequestForTarget(root.querySelector('strong'))).toEqual({
      sourceLine: 7,
      blockClientTop: 321
    })
    expect(previewEditRequestForTarget(root.querySelector('code'))?.sourceLine).toBe(15)
    expect(previewEditRequestForTarget(root.querySelector('h2'))?.sourceLine).toBe(30)
  })

  it('leaves links, controls, embeds, diagrams and transcluded notes alone', () => {
    const root = article()
    expect(previewEditRequestForTarget(root.querySelector('a'))).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('img'))).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('.note-embed p'))).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('svg'))).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('h2 button'))).toBeNull()
  })

  it('ignores clicks off any stamped block and stamps it cannot read', () => {
    const root = article()
    expect(previewEditRequestForTarget(root)).toBeNull()
    expect(previewEditRequestForTarget(null)).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('[data-source-line="nope"]'))).toBeNull()
    expect(previewEditRequestForTarget(root.querySelector('[data-source-line="0"]'))).toBeNull()
  })
})

describe('editorLandingTopMargin', () => {
  it('keeps the line at the height its block had on screen', () => {
    expect(editorLandingTopMargin(420, 100, 800, 24)).toBe(320)
    expect(editorLandingTopMargin(350.4, 100, 800, 24)).toBe(250)
  })

  it('clamps so the line neither hugs the top nor drops off the bottom', () => {
    expect(editorLandingTopMargin(90, 100, 800, 24)).toBe(24)
    expect(editorLandingTopMargin(880, 100, 800, 24)).toBe(752)
    // A viewport too short for the clamp still gets the minimum margin.
    expect(editorLandingTopMargin(30, 0, 40, 24)).toBe(24)
  })

  it('falls back to the outline-jump margin when the block position is unknown', () => {
    expect(editorLandingTopMargin(null, 100, 800, 24)).toBe(24)
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
