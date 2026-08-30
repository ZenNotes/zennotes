// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { hopMarkerBackward, hopMarkerForward, markerHopTarget } from './cm-marker-hop'

/** `**This|**` → column of the `|`, and the text without it. */
function parse(marked: string): { text: string; col: number } {
  const col = marked.indexOf('|')
  return { text: marked.replace('|', ''), col }
}

/** Apply one hop to a `|`-marked line and render the result the same way. */
function hop(marked: string, dir: 1 | -1): string {
  const { text, col } = parse(marked)
  const target = markerHopTarget(text, col, dir)
  if (target == null) return marked
  return `${text.slice(0, target)}|${text.slice(target)}`
}

describe('markerHopTarget — the four moves from #490', () => {
  it('steps out past the closing markers', () => {
    expect(hop('**This|**', 1)).toBe('**This**|')
  })

  it('steps out before the opening markers', () => {
    expect(hop('**That|**', -1)).toBe('|**That**')
  })

  it('steps into the formatted region, then out the far side', () => {
    const inside = hop('|**This**', 1)
    expect(inside).toBe('**|This**')
    expect(hop(inside, 1)).toBe('**This**|')
  })

  it('steps back into the region, then out before it', () => {
    const inside = hop('**This**|', -1)
    expect(inside).toBe('**This|**')
    expect(hop(inside, -1)).toBe('|**This**')
  })
})

describe('markerHopTarget — runs and neighbours', () => {
  it('crosses a whole run of identical markers at once', () => {
    expect(hop('|~~gone~~', 1)).toBe('~~|gone~~')
    expect(hop('==high|==', 1)).toBe('==high==|')
    expect(hop('`code|`', 1)).toBe('`code`|')
    expect(hop('$x|$', 1)).toBe('$x$|')
  })

  it('treats different characters as separate runs, so a link steps in three', () => {
    // `](` is two runs: the cursor gets to stand between the text and the URL.
    const a = hop('[text|](url)', 1)
    expect(a).toBe('[text]|(url)')
    const b = hop(a, 1)
    expect(b).toBe('[text](|url)')
    expect(hop(b, 1)).toBe('[text](url)|')
  })

  it('walks a bold-italic nest one pair at a time', () => {
    // `***` is a single run of `*`, so it is crossed in one hop, not three.
    expect(hop('***both|***', 1)).toBe('***both***|')
  })

  it('does nothing when the line holds no marker in that direction', () => {
    expect(markerHopTarget('plain prose here', 6, 1)).toBeNull()
    expect(markerHopTarget('plain prose here', 6, -1)).toBeNull()
    expect(markerHopTarget('**bold**', 8, 1)).toBeNull()
    expect(markerHopTarget('**bold**', 0, -1)).toBeNull()
  })

  it('leaves snake_case words alone', () => {
    expect(markerHopTarget('some_variable_name', 5, 1)).toBeNull()
  })
})

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function mount(doc: string, anchor: number): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor } }) })
  views.push(view)
  return view
}

describe('hopMarker commands', () => {
  it('moves the cursor and reports handled', () => {
    const view = mount('**bold**', 6) // **bold|**
    expect(hopMarkerForward(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(8)
    expect(hopMarkerBackward(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(6)
  })

  it('reports unhandled — leaving the key to whatever else wants it', () => {
    const view = mount('plain line', 4)
    expect(hopMarkerForward(view)).toBe(false)
    expect(hopMarkerBackward(view)).toBe(false)
    expect(view.state.selection.main.head).toBe(4)
  })

  it('scans only the cursor\'s own line', () => {
    const view = mount('first line\n**bold** second', 5)
    expect(hopMarkerForward(view)).toBe(false)
    expect(view.state.selection.main.head).toBe(5)
  })

  it('collapses a selection onto the hop target', () => {
    const view = mount('**bold**', 2)
    view.dispatch({ selection: { anchor: 2, head: 6 } })
    expect(hopMarkerForward(view)).toBe(true)
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(8)
  })
})

describe('auto-paired quotes (#685)', () => {
  const quoted = (marked: string, dir: 1 | -1): string => {
    const { text, col } = parse(marked)
    const target = markerHopTarget(text, col, dir, { quotes: true })
    if (target == null) return marked
    return `${text.slice(0, target)}|${text.slice(target)}`
  }

  it('steps out past a closing double or single quote', () => {
    expect(quoted('"This|"', 1)).toBe('"This"|')
    expect(quoted("'This|'", 1)).toBe("'This'|")
  })

  it('steps back in, then out before the opening quote', () => {
    expect(quoted('"This"|', -1)).toBe('"This|"')
    expect(quoted('"This|"', -1)).toBe('|"This"')
  })

  it('never stops at an apostrophe inside a word', () => {
    expect(quoted("'don|'t'", 1)).toBe("'don't'|")
    expect(quoted("we're |done", -1)).toBe("we're |done")
    expect(quoted("it's| fine", 1)).toBe("it's| fine")
  })

  it('still crosses the formatting markers around a quote', () => {
    expect(quoted('**"quoted"|**', 1)).toBe('**"quoted"**|')
    expect(quoted('**|"quoted"**', 1)).toBe('**"|quoted"**')
  })

  it('leaves quotes alone when they are not markers (the default)', () => {
    expect(hop('"This|"', 1)).toBe('"This|"')
    expect(hop("'This|'", 1)).toBe("'This|'")
  })

  it('the commands ask the editor per cursor whether quotes count', () => {
    const view = mount('"This"', 5) // "This|"
    expect(hopMarkerForward(view)).toBe(false)
    expect(hopMarkerForward(view, { quotesAreMarkers: () => true })).toBe(true)
    expect(view.state.selection.main.head).toBe(6)
    expect(hopMarkerBackward(view, { quotesAreMarkers: () => true })).toBe(true)
    expect(view.state.selection.main.head).toBe(5)
  })
})
