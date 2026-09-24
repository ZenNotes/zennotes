// @vitest-environment jsdom
// #827: the frontmatter is carved out of the markdown parse, so the markdown
// Enter command no longer continues a `tags:` list there. This exercises the
// real dispatch chain the editors use (note grammar + vim-aware markdown
// keymap + default keymap) and pins what Enter does on every kind of
// frontmatter line, with Vim off and in Vim normal mode.
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { noteMarkdown } from './cm-markdown-language'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

function mount(doc: string, cursor: number, vimMode = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        ...(vimMode ? [vim()] : []),
        noteMarkdown(),
        vimAwareMarkdownKeymap,
        keymap.of([...vimAwareDefaultKeymap(vimMode)])
      ]
    }),
    parent: document.body
  })
  views.push(view)
  view.focus()
  return view
}

const pressEnter = (view: EditorView): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
  )
}

const NOTE = `---
title: InfSec
tags:
  - todo
  - 
key:
  nested: v
---

- item`

// Absolute offset of the end of line `n` (1-based) in `doc`.
function lineEnd(doc: string, n: number): number {
  const lines = doc.split('\n')
  let pos = 0
  for (let i = 0; i < n; i++) pos += lines[i].length + (i < n - 1 ? 1 : 0)
  return pos
}

describe('Enter inside frontmatter (#827)', () => {
  it('continues a YAML list item with the marker at the same indentation', () => {
    const view = mount(NOTE, lineEnd(NOTE, 4)) // end of "  - todo"
    pressEnter(view)
    expect(view.state.doc.line(5).text).toBe('  - ')
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).to)
    // The next line is the original empty item, untouched.
    expect(view.state.doc.line(6).text).toBe('  - ')
  })

  it('ends the list on an empty item by clearing the marker', () => {
    const view = mount(NOTE, lineEnd(NOTE, 5)) // end of "  - "
    pressEnter(view)
    expect(view.state.doc.lines).toBe(NOTE.split('\n').length)
    expect(view.state.doc.line(5).text).toBe('')
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from)
  })

  it('copies indentation on a nested key line (default Enter through indentNodeProp)', () => {
    const view = mount(NOTE, lineEnd(NOTE, 7)) // end of "  nested: v"
    pressEnter(view)
    expect(view.state.doc.line(8).text).toBe('  ')
    expect(view.state.selection.main.head).toBe(view.state.doc.line(8).to)
  })

  it('inserts a plain newline on a top-level key line', () => {
    const view = mount(NOTE, lineEnd(NOTE, 2)) // end of "title: InfSec"
    pressEnter(view)
    expect(view.state.doc.line(3).text).toBe('')
    expect(view.state.doc.line(4).text).toBe('tags:')
  })

  it('leaves the closing fence to the default Enter', () => {
    const view = mount(NOTE, lineEnd(NOTE, 8)) // end of the closing "---"
    pressEnter(view)
    expect(view.state.doc.line(8).text).toBe('---')
    expect(view.state.doc.line(9).text).toBe('')
    // A blank line was inserted; the body starts one line later.
    expect(view.state.doc.line(11).text).toBe('- item')
  })

  it('does not treat a fence as a list item when the cursor is before the marker', () => {
    const view = mount(NOTE, lineEnd(NOTE, 4) - '- todo'.length) // before "- todo"
    pressEnter(view)
    expect(view.state.doc.line(4).text).toBe('  ')
    expect(view.state.doc.line(5).text).toBe('  - todo')
  })

  it('still lets markdown continue a list in the body', () => {
    const view = mount(NOTE, NOTE.length) // end of "- item"
    pressEnter(view)
    expect(view.state.doc.line(view.state.doc.lines).text).toBe('- ')
  })

  it('does not fire on a `- item` line when the block is not closed', () => {
    const open = '---\ntags:\n  - todo\n\nbody'
    const view = mount(open, lineEnd(open, 3)) // end of "  - todo"
    pressEnter(view)
    // Without a closing fence the whole document is markdown and `  - todo`
    // is a bullet, so the markdown command is the one continuing it here.
    expect(view.state.doc.line(4).text).toBe('  - ')
  })

  it('in Vim normal mode Enter is a motion, not an edit', () => {
    const view = mount(NOTE, lineEnd(NOTE, 4), true) // end of "  - todo"
    pressEnter(view)
    // The j^ motion itself cannot be asserted: jsdom has no layout, so Vim's
    // vertical motion cannot measure lines. What matters is that the list
    // command deferred and nothing was edited.
    expect(view.state.doc.toString()).toBe(NOTE)
  })

  it('in Vim insert mode Enter continues the list as with Vim off', () => {
    const view = mount(NOTE, lineEnd(NOTE, 4), true) // end of "  - todo"
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', keyCode: 65, bubbles: true, cancelable: true })
    ) // append after the cursor: insert mode at the end of the line
    pressEnter(view)
    expect(view.state.doc.line(5).text).toBe('  - ')
    expect(view.state.doc.line(6).text).toBe('  - ')
  })
})
