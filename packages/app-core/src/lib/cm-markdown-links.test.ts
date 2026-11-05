// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  defaultHighlightStyle,
  forceParsing,
  syntaxHighlighting,
  syntaxTreeAvailable
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { markdownLinkExtension } from './cm-markdown-links'

function create(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        markdownLinkExtension,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true })
      ]
    })
  })
}

/** A state gets 20 ms of parsing and a slow runner can spend them before the
 *  definition at the end of a note, so a test finishes the parse before it reads
 *  a decoration. In the app the idle worker does this moments later. */
function finishParse(view: EditorView): void {
  forceParsing(view, view.state.doc.length, 5000)
}

function mount(doc: string): EditorView {
  const view = create(doc)
  finishParse(view)
  return view
}

/** Every read of the clock jumps past the budget: one parser step per slice. */
function withStalledClock<T>(work: () => T): T {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 25))
  try {
    return work()
  } finally {
    clock.mockRestore()
  }
}

describe('Markdown link highlighting', () => {
  it('keeps wikilink labels highlighted in source mode', () => {
    const view = mount('See [[My Note|label]] and [EE].')
    try {
      expect(view.dom.querySelector('.tok-link')?.textContent).toBe('[My Note|label]')
      expect(view.dom.querySelectorAll('.tok-link')).toHaveLength(1)
    } finally {
      view.destroy()
    }
  })
  it.each([
    '[EE]',
    '[EE][]',
    '[text][EE]',
    '![EE]',
    '[**EE**]',
    '[EE]\n\n```md\n[EE]: /note.md\n```'
  ])('keeps undefined references plain in source editors: %s', (doc) => {
    const view = mount(doc)
    try {
      expect(view.dom.querySelector('.tok-link')).toBeNull()
      expect(view.dom.textContent).toContain(doc.split('\n')[0])
    } finally {
      view.destroy()
    }
  })

  it.each(['[EE]', '[EE][]', '[text][EE]', '![EE]', '[text][eE]'])(
    'highlights defined references: %s',
    (link) => {
      const view = mount(`${link}\n\n[EE]: https://example.com`)
      try {
        expect(view.dom.querySelector('.tok-link')?.textContent).toBe(link)
      } finally {
        view.destroy()
      }
    }
  )

  it.each([
    '[link](https://example.com)',
    '[link](My Note.md)',
    '[empty]()',
    '![image](asset.png)'
  ])('preserves inline links: %s', (link) => {
    const view = mount(link)
    try {
      expect(view.dom.querySelector('.tok-link')?.textContent).toContain(
        link.slice(0, link.indexOf(']') + 1)
      )
    } finally {
      view.destroy()
    }
  })

  it('updates existing bracket text when a matching definition is added and removed', () => {
    const view = mount('[Some Label]\n\nEnd.')
    try {
      expect(view.dom.querySelector('.tok-link')).toBeNull()
      const at = view.state.doc.length
      view.dispatch({
        changes: { from: at, insert: '\n\n[some   label]: https://example.com' }
      })
      finishParse(view)
      expect(view.dom.querySelector('.tok-link')?.textContent).toBe('[Some Label]')
      view.dispatch({ changes: { from: at, to: view.state.doc.length } })
      finishParse(view)
      expect(view.dom.querySelector('.tok-link')).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('highlights a defined reference once a parse cut before its definition finishes', () => {
    const view = withStalledClock(() => create('[EE]\n\nEnd.\n\n[EE]: https://example.com'))
    try {
      expect(syntaxTreeAvailable(view.state)).toBe(false)
      expect(view.dom.querySelector('.tok-link')).toBeNull()
      finishParse(view)
      expect(view.dom.querySelector('.tok-link')?.textContent).toBe('[EE]')
    } finally {
      view.destroy()
    }
  })
})
