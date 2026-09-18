// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { markdownLinkExtension } from './cm-markdown-links'

function mount(doc: string): EditorView {
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
      expect(view.dom.querySelector('.tok-link')?.textContent).toBe('[Some Label]')
      view.dispatch({ changes: { from: at, to: view.state.doc.length } })
      expect(view.dom.querySelector('.tok-link')).toBeNull()
    } finally {
      view.destroy()
    }
  })
})
