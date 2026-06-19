// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { frontmatterStyle } from './cm-frontmatter'

const views: EditorView[] = []
function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [frontmatterStyle] })
  })
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
})

describe('frontmatterStyle', () => {
  it('builds line + key decorations for a record-page frontmatter without throwing', () => {
    // The mixed line + mark decorations must be added in sorted order, or the
    // RangeSetBuilder throws and breaks the editor for every note with
    // frontmatter. Constructing the view exercises that.
    const view = mount(['---', 'New field: test', 'New field 2:', '---', '', '# test'].join('\n'))

    // Property lines render as the metadata card body; the fences become caps.
    expect(view.dom.querySelector('.cm-frontmatter-top')).not.toBeNull()
    expect(view.dom.querySelector('.cm-frontmatter-bottom')).not.toBeNull()
    // The key (before the `:`) is marked as a label.
    const key = view.dom.querySelector('.cm-frontmatter-key')
    expect(key?.textContent).toBe('New field')
  })

  it('no-ops a note without leading frontmatter', () => {
    const view = mount('# Just a note\n\nbody')
    expect(view.dom.querySelector('.cm-frontmatter-line')).toBeNull()
  })

  it('handles a value that itself contains a colon', () => {
    const view = mount(['---', 'time: 12:30', '---', '', 'body'].join('\n'))
    // The key stops at the FIRST colon.
    expect(view.dom.querySelector('.cm-frontmatter-key')?.textContent).toBe('time')
  })
})
