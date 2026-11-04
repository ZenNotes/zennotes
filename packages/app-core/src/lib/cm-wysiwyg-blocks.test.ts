// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'

const DOC = `# Title

- first
- second

> a quote line

---

End.`

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    // Caret at the very end, away from the list / quote / hr.
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), wysiwygBlocksPlugin]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  // Each change reparses under a time budget, which a slow runner can cut;
  // finish it so the assertions read the decorations of the whole tree.
  forceParsing(view, doc.length, 5000)
  return view
}

describe('wysiwygBlocksPlugin', () => {
  it('puts the bar after the bullet for a quote inside a list item, as Preview does', () => {
    const view = mount('- >TEST\n\nlast line')
    const line = view.dom.querySelector('.cm-wq-quote-in-list') as HTMLElement
    expect(line).toBeTruthy()
    expect(line.style.getPropertyValue('--z-quote-column')).toBe('2ch')
    expect(view.dom.querySelector('.cm-wq-quote')).toBeNull()
    view.destroy()
  })

  it('keeps the bar on the edge for a list inside a quote', () => {
    const view = mount('> - item\n\nlast line')
    expect(view.dom.querySelector('.cm-wq-quote')).toBeTruthy()
    expect(view.dom.querySelector('.cm-wq-quote-in-list')).toBeNull()
    view.destroy()
  })

  it('renders bullets, an hr, and a blockquote bar without throwing', () => {
    const view = mount(DOC)
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBe(2)
    expect(view.dom.querySelector('.cm-wq-hr')).toBeTruthy()
    expect(view.dom.querySelector('.cm-wq-quote')).toBeTruthy()
    view.destroy()
  })

  it('hides the ``` fences when the cursor is outside the code block', () => {
    const view = mount('before\n\n```js\nconst x = 1\n```\n\nafter')
    expect(view.dom.textContent).not.toContain('```js')
    expect(view.dom.textContent).not.toMatch(/```\s*$/)
    expect(view.dom.textContent).toContain('const x = 1')
    view.destroy()
  })

  it('hides a code block\'s closing fence inside a callout too', () => {
    const view = mount('# T\n\n> [!warning] Log\n> ```\n> fetch: done\n> ```\n\nEnd.')
    expect(view.dom.textContent).toContain('fetch: done')
    expect(view.dom.textContent).not.toContain('```')
    view.destroy()
  })

  it('redraws when only the syntax tree changes, as when a cut parse finishes', () => {
    // Swapping the language in changes the tree and nothing else: no edit, no
    // selection, no viewport. A parse that finishes after its time budget ran
    // out reaches the plugin the same way.
    const language = new Compartment()
    const doc = '# T\n\n> [!warning] Log\n> ```\n> fetch: done\n> ```\n\nEnd.'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [language.of([]), wysiwygBlocksPlugin]
      })
    })
    expect(view.dom.querySelector('.cm-callout')).toBeNull()
    view.dispatch({ effects: language.reconfigure(markdown({ base: markdownLanguage })) })
    forceParsing(view, doc.length, 5000)
    expect(view.dom.querySelector('.cm-callout-warning')).toBeTruthy()
    expect(view.dom.textContent).not.toContain('```')
    view.destroy()
  })

  it('reveals the raw list marker on the active line', () => {
    const view = mount(DOC)
    const firstItem = DOC.indexOf('- first')
    view.dispatch({ selection: { anchor: firstItem + 3 } })
    // The active list line shows its `-`; only the second item stays a bullet.
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBe(1)
    view.destroy()
  })

  it('renders a callout as a colored card with its custom title', () => {
    const view = mount('# T\n\n> [!warning] Heads up\n> body line\n\nEnd.')
    expect(view.dom.querySelectorAll('.cm-callout').length).toBeGreaterThanOrEqual(2)
    expect(view.dom.querySelector('.cm-callout-warning')).toBeTruthy()
    expect(view.dom.querySelector('.cm-callout-head')).toBeTruthy()
    expect(view.dom.querySelector('.cm-callout-foot')).toBeTruthy()
    // The `[!warning]` token is hidden; the custom title stays.
    expect(view.dom.textContent).not.toContain('[!warning]')
    expect(view.dom.textContent).toContain('Heads up')
    view.destroy()
  })

  it('shows the type name as the title when a callout has no custom title', () => {
    const view = mount('# T\n\n> [!note]\n> body\n\nEnd.')
    expect(view.dom.querySelector('.cm-callout-title')?.textContent).toBe('Note')
    expect(view.dom.textContent).not.toContain('[!note]')
    view.destroy()
  })

  it('hides the marker on task-list items (only the plain item gets a bullet)', () => {
    // `- [ ]` / `- [x]` are task items — their `-` is hidden (the checkbox from
    // the live-preview plugin stands in), matching Obsidian. Only the plain
    // `- item` becomes a bullet.
    const view = mount('# T\n\n- [ ] open\n- [x] done\n- plain item\n\nEnd.')
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBe(1)
    // The task markers' dashes are hidden (no "- [" left in the rendered text).
    expect(view.dom.textContent).not.toContain('- [')
    view.destroy()
  })
})
