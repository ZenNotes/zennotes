// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { selectAll } from '@codemirror/commands'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readNoteCover } from '@shared/note-cover'
import { coverFoldExtension, coverFoldLineRanges, coverFoldText } from './cm-cover-fold'
import { mathBlockArrowKeymap } from './cm-math-nav'
import { noteCoverExtension, pinnedNoteCoverExtension } from './cm-note-cover'
import { sourceRevealExtension } from './cm-source-reveal'
import { registerDisplayLineMotion } from './cm-vim-display-line'

registerDisplayLineMotion()

const UNSPLASH =
  'https://images.unsplash.com/photo-1501785888041-af3ef285b470?ixid=M3w2NjQ3NzZ8MHwxfHNlYXJjaHwxfHxtb3VudGFpbnN8ZW58MHx8fHwxNzYxNjc0NDAwfDA&w=2400&q=80&auto=format'

// 1-based lines: 1 `---`, 2 banner, 3 banner_credit, 4 banner_credit_url, 5 `---`, 6 `# Lake`, 7 ``, 8 body.
const ONLY_COVER = `---\nbanner: "${UNSPLASH}"\nbanner_credit: Kalen Emsley\nbanner_credit_url: "https://unsplash.com/@kalenemsley"\n---\n# Lake\n\nStill water.`

// 1-based lines: 1 `---`, 2 tags, 3 due, 4 banner, 5 banner_credit, 6 banner_credit_url, 7 `---`, 8 body.
const MIXED = `---\ntags: [travel]\ndue: 2026-11-02\nbanner: "${UNSPLASH}"\nbanner_credit: Kalen Emsley\nbanner_credit_url: "https://unsplash.com/@kalenemsley"\n---\nPacking list.`

// 1-based lines: 1 `---`, 2 banner, 3 banner_credit, 4 tags, 5 banner_y, 6 `---`, 7 body.
const SPLIT = `---\nbanner: "${UNSPLASH}"\nbanner_credit: Kalen Emsley\ntags: [travel]\nbanner_y: 0.35\n---\nBody.`

const views: EditorView[] = []

function mount(
  doc: string,
  {
    anchor = doc.length,
    cover = noteCoverExtension(() => {}),
    extra = [] as Extension[]
  }: { anchor?: number; cover?: Extension; extra?: Extension[] } = {}
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), cover, coverFoldExtension, ...extra]
    })
  })
  forceParsing(view, doc.length, 5000)
  views.push(view)
  return view
}

const lineAt = (view: EditorView, n: number): number => view.state.doc.line(n).from
const headLine = (view: EditorView): number => view.state.doc.lineAt(view.state.selection.main.head).number
const summary = (view: EditorView): string | null =>
  view.contentDOM.querySelector('[data-frontmatter-cover]')?.textContent ?? null
const shownText = (view: EditorView): string => view.contentDOM.textContent ?? ''

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  while (views.length) views.pop()!.destroy()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('what the folded line says', () => {
  const text = (frontmatter: string): string => coverFoldText(readNoteCover(`---\n${frontmatter}\n---\n`)!)

  it('names the photographer of an Unsplash photo', () => {
    expect(text(`banner: "${UNSPLASH}"\nbanner_credit: Kalen Emsley`)).toBe('cover · Unsplash photo by Kalen Emsley')
    expect(text(`banner: "${UNSPLASH}"`)).toBe('cover · Unsplash photo')
  })

  it('names a vault image by its file name', () => {
    expect(text('banner: "![[assets/lisbon.jpg]]"')).toBe('cover · lisbon.jpg')
    expect(text('banner: "![](pics/my%20trip.png)"')).toBe('cover · my trip.png')
  })

  it('names a gradient or a gallery photo by its title', () => {
    expect(text('banner: "![[assets/cover-gradient-dusk.svg]]"')).toBe('cover · Dusk')
    expect(text('banner: "![[attachements/cover-great-wave.webp]]"')).toBe('cover · The Great Wave')
  })

  it('names the host of any other web image', () => {
    expect(text('banner: "https://example.com/photos/a.jpg?w=1200"')).toBe('cover · image from example.com')
  })

  it('says just cover when there is nothing more to say', () => {
    expect(text('banner: "![[assets/]]"')).toBe('cover')
  })
})

describe('folding a cover’s frontmatter', () => {
  it('folds a cover-only frontmatter into one line in the card', () => {
    const view = mount(ONLY_COVER)
    expect(coverFoldLineRanges(view.state)).toEqual([{ fromLine: 2, toLine: 4 }])
    expect(summary(view)).toBe('cover · Unsplash photo by Kalen Emsley')
    // The card's two fence rows and the one folded line.
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')].slice(0, 3)
    expect(lines.map((line) => line.textContent)).toEqual(['---', 'cover · Unsplash photo by Kalen Emsley', '---'])
    expect(shownText(view)).not.toContain('images.unsplash.com')
    expect(shownText(view)).not.toContain('banner_credit')
  })

  it('keeps the other properties of a mixed note visible', () => {
    const view = mount(MIXED)
    expect(coverFoldLineRanges(view.state)).toEqual([{ fromLine: 4, toLine: 6 }])
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')].slice(0, 5).map((line) => line.textContent)
    expect(lines).toEqual(['---', 'tags: [travel]', 'due: 2026-11-02', 'cover · Unsplash photo by Kalen Emsley', '---'])
  })

  it('folds every cover line into the first, and a later one takes no row', () => {
    const view = mount(SPLIT)
    expect(coverFoldLineRanges(view.state)).toEqual([
      { fromLine: 2, toLine: 3 },
      { fromLine: 5, toLine: 5 }
    ])
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')].slice(0, 4).map((line) => line.textContent)
    expect(lines).toEqual(['---', 'cover · Unsplash photo by Kalen Emsley', 'tags: [travel]', '---'])
  })

  it('changes nothing in the document', () => {
    const view = mount(MIXED)
    expect(view.state.doc.toString()).toBe(MIXED)
    selectAll(view)
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(MIXED)
  })

  it('leaves the raw lines in an editor without it (source mode)', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: ONLY_COVER,
        extensions: [markdown({ base: markdownLanguage }), noteCoverExtension(() => {})]
      })
    })
    views.push(view)
    expect(summary(view)).toBeNull()
    expect(shownText(view)).toContain('banner_credit: Kalen Emsley')
  })

  it('folds only where the pane draws the cover', () => {
    expect(summary(mount(ONLY_COVER, { cover: pinnedNoteCoverExtension }))).toBe('cover · Unsplash photo by Kalen Emsley')
    // Covers hidden in Settings: the raw lines are the only place it shows.
    const hidden = mount(ONLY_COVER, { cover: [] })
    expect(summary(hidden)).toBeNull()
    expect(coverFoldLineRanges(hidden.state)).toEqual([])
    expect(shownText(hidden)).toContain('banner_credit: Kalen Emsley')
  })

  it('folds a cover written by an edit, and opens when the cover goes', () => {
    const view = mount('---\ntags: [a]\n---\nBody.')
    expect(summary(view)).toBeNull()
    view.dispatch({ changes: { from: lineAt(view, 3), insert: 'banner: "![[assets/lisbon.jpg]]"\n' } })
    expect(summary(view)).toBe('cover · lisbon.jpg')
    view.dispatch({ changes: { from: lineAt(view, 3), to: lineAt(view, 4) } })
    expect(summary(view)).toBeNull()
  })

  it('folds once the closing fence is typed further down', () => {
    const view = mount('---\nbanner: "![[assets/lisbon.jpg]]"\n\nBody.')
    expect(summary(view)).toBeNull()
    view.dispatch({ changes: { from: lineAt(view, 3), insert: '---' } })
    expect(summary(view)).toBe('cover · lisbon.jpg')
  })
})

describe('opening the folded lines', () => {
  it('opens all of them while the selection touches one, and folds again when it leaves', () => {
    const view = mount(SPLIT)
    view.dispatch({ selection: { anchor: lineAt(view, 5) + 3 } })
    expect(summary(view)).toBeNull()
    expect(coverFoldLineRanges(view.state)).toEqual([])
    expect(shownText(view)).toContain('banner_credit: Kalen Emsley')
    expect(shownText(view)).toContain('banner_y: 0.35')

    view.dispatch({ selection: { anchor: lineAt(view, 4) } }) // tags, between the cover lines
    expect(summary(view)).toBe('cover · Unsplash photo by Kalen Emsley')

    view.dispatch({ selection: EditorSelection.range(lineAt(view, 1), lineAt(view, 2)) }) // a range ending on one
    expect(summary(view)).toBeNull()
  })

  it('stays folded while a note is read, and opens once the editor is being edited', () => {
    const view = mount(ONLY_COVER, { anchor: 6, extra: [sourceRevealExtension] })
    expect(headLine(view)).toBe(2)
    expect(summary(view)).toBe('cover · Unsplash photo by Kalen Emsley')
    view.focus()
    return Promise.resolve().then(() => {
      expect(summary(view)).toBeNull()
    })
  })

  it('a click on the folded line opens it with the caret on the first cover line', () => {
    const view = mount(MIXED, { anchor: MIXED.length })
    const line = view.contentDOM.querySelector('[data-frontmatter-cover]')!
    line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(view.state.selection.main.head).toBe(lineAt(view, 4))
    expect(summary(view)).toBeNull()
  })
})

describe('stepping into the folded lines from the keyboard', () => {
  beforeEach(() => {
    // jsdom has no text layout: every pixel motion here falls back to a
    // logical step and says so once, and the measure that reading the
    // caret's place runs as the fold opens logs Vim's block cursor failing
    // to measure itself.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const press = (view: EditorView, key: string): void => {
    Vim.handleKey(getCM(view)!, key, 'user')
  }
  const arrow = (view: EditorView, key: 'ArrowDown' | 'ArrowUp'): void => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  it('vim j and k step into the fold one line at a time and through the opened lines', () => {
    const view = mount(MIXED, { anchor: 0, extra: [vim()] })
    view.focus()
    const visited: number[] = []
    for (let i = 0; i < 7; i++) {
      press(view, 'j')
      visited.push(headLine(view))
    }
    expect(visited).toEqual([2, 3, 4, 5, 6, 7, 8])
    for (let i = 0; i < 7; i++) {
      press(view, 'k')
      visited.push(headLine(view))
    }
    expect(visited.slice(7)).toEqual([7, 6, 5, 4, 3, 2, 1])
  })

  it('vim k from under the card lands on the last cover line and opens the fold', () => {
    const view = mount(MIXED, { anchor: EditorState.create({ doc: MIXED }).doc.line(7).from, extra: [vim()] })
    view.focus()
    expect(summary(view)).not.toBeNull()
    press(view, 'k')
    expect(headLine(view)).toBe(6)
    expect(summary(view)).toBeNull()
  })

  it('vim j and k reach a cover line folded further down', () => {
    const view = mount(SPLIT, { anchor: 0, extra: [vim()] })
    view.focus()
    view.dispatch({ selection: { anchor: lineAt(view, 4) } }) // tags
    press(view, 'j')
    expect(headLine(view)).toBe(5)
    expect(summary(view)).toBeNull()
    press(view, 'j')
    expect(headLine(view)).toBe(6)
    press(view, 'k')
    expect(headLine(view)).toBe(5)
  })

  it('the arrow keys do the same with Vim off', () => {
    const view = mount(MIXED, { anchor: 0, extra: [keymap.of([...mathBlockArrowKeymap])] })
    view.focus()
    view.dispatch({ selection: { anchor: lineAt(view, 3) } }) // due
    arrow(view, 'ArrowDown')
    expect(headLine(view)).toBe(4)
    expect(summary(view)).toBeNull()

    view.dispatch({ selection: { anchor: lineAt(view, 7) } }) // closing fence
    expect(summary(view)).not.toBeNull()
    arrow(view, 'ArrowUp')
    expect(headLine(view)).toBe(6)
    expect(summary(view)).toBeNull()
  })
})

describe('keeping the caret in place as the fold opens and closes', () => {
  // jsdom has no layout: give the head's line a height on screen that
  // depends on whether the lines are folded, the way the card grows above it.
  function layout(view: EditorView, { folded, open }: { folded: number; open: number }): { scrolled: () => number } {
    let scrollTop = 0
    Object.defineProperty(view, 'documentTop', { configurable: true, get: () => 50 - scrollTop })
    Object.defineProperty(view.scrollDOM, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    })
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 400))
    vi.spyOn(view, 'lineBlockAtHeight').mockImplementation(() => view.lineBlockAt(0))
    vi.spyOn(view, 'lineBlockAt').mockImplementation(() => {
      const top = coverFoldLineRanges(view.state).length ? folded : open
      return { from: 0, to: 0, top, bottom: top + 20, height: 20 } as ReturnType<EditorView['lineBlockAt']>
    })
    return { scrolled: () => scrollTop }
  }

  const scrollFor = (view: EditorView, head: number): boolean =>
    view.state.facet(EditorView.scrollHandler).some((handler) =>
      handler(view, EditorSelection.cursor(head), { x: 'nearest', y: 'nearest', xMargin: 5, yMargin: 5 })
    )

  it('scrolls the line the caret opens onto back to where the folded line was drawn', () => {
    const view = mount(MIXED, { anchor: EditorState.create({ doc: MIXED }).doc.line(7).from })
    const { scrolled } = layout(view, { folded: 100, open: 160 })
    const head = lineAt(view, 6)
    view.dispatch({ selection: { anchor: head } }) // k from the fence onto the last cover line
    expect(summary(view)).toBeNull()
    // Answered once, for the scroll codemirror-vim asks for after the motion.
    expect(scrollFor(view, head)).toBe(true)
    expect(scrolled()).toBe(60)
    expect(scrollFor(view, head)).toBe(false)
  })

  it('does the same as the lines fold again under the caret', () => {
    const view = mount(MIXED, { anchor: 0 })
    view.dispatch({ selection: { anchor: lineAt(view, 6) } })
    const { scrolled } = layout(view, { folded: 100, open: 160 })
    const head = lineAt(view, 7)
    view.dispatch({ selection: { anchor: head } }) // j onto the closing fence
    expect(summary(view)).not.toBeNull()
    expect(scrollFor(view, head)).toBe(true)
    expect(scrolled()).toBe(-60)
  })

  it('leaves scrolling alone for a move that keeps the fold as it was', () => {
    const view = mount(MIXED, { anchor: 0 })
    layout(view, { folded: 100, open: 160 })
    const head = lineAt(view, 8)
    view.dispatch({ selection: { anchor: head } })
    expect(scrollFor(view, head)).toBe(false)
  })

  it('leaves scrolling alone when the line was not on screen', () => {
    const view = mount(MIXED, { anchor: 0 })
    layout(view, { folded: 900, open: 960 })
    const head = lineAt(view, 6)
    view.dispatch({ selection: { anchor: head } })
    expect(summary(view)).toBeNull()
    expect(scrollFor(view, head)).toBe(false)
  })
})
