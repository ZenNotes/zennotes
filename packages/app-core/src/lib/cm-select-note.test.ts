// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { selectNoteText } from './cm-select-note'
import { vimAwareDefaultKeymap } from './cm-vim-default-keymap'

// #1006: a new note is `# <title>` and a rename keeps that heading in step with
// the file name, so select all from the note's text leaves it out. jsdom's
// navigator is not a Mac, so Mod is Ctrl here, as on Linux and Windows.
const NOTE = '# Shopping list\n\nBuy 3 apples and 2 pears.\nMilk and bread.\n'
const TEXT_FROM = NOTE.indexOf('Buy')
const MILK = NOTE.indexOf('Milk')

describe('select all leaves the note title out (#1006)', () => {
  const views: EditorView[] = []
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy())
  })

  // Keymap first, Vim second: the order the editors run them in (#993).
  const mount = (doc: string, { vimMode = false, at = doc.length } = {}): EditorView => {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: at },
        extensions: [keymap.of([...vimAwareDefaultKeymap(vimMode, false)]), vimMode ? vim() : []]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  const press = (view: EditorView, key: string, keyCode: number, ctrlKey = false): boolean => {
    const event = new KeyboardEvent('keydown', { key, keyCode, ctrlKey, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(event)
    return event.defaultPrevented
  }
  const ctrlA = (view: EditorView): boolean => press(view, 'a', 65, true)
  const selected = (view: EditorView): [number, number] => [
    view.state.selection.main.from,
    view.state.selection.main.to
  ]

  it('selects the text under the title, and the whole note on a second press', () => {
    const view = mount(NOTE, { at: MILK })
    expect(ctrlA(view)).toBe(true)
    expect(selected(view)).toEqual([TEXT_FROM, NOTE.length])
    expect(view.state.sliceDoc(...selected(view))).toBe('Buy 3 apples and 2 pears.\nMilk and bread.\n')
    expect(ctrlA(view)).toBe(true)
    expect(selected(view)).toEqual([0, NOTE.length])
  })

  it('counts the blank line under the title as the text, and skips frontmatter above it', () => {
    const fm = '---\ntags: [food]\n---\n'
    const view = mount(fm + NOTE, { at: fm.length + NOTE.indexOf('\n\n') + 1 })
    ctrlA(view)
    expect(selected(view)).toEqual([fm.length + TEXT_FROM, fm.length + NOTE.length])
  })

  it('selects the whole note from the title line or the frontmatter', () => {
    const onTitle = mount(NOTE, { at: 4 })
    ctrlA(onTitle)
    expect(selected(onTitle)).toEqual([0, NOTE.length])

    const fm = '---\ntags: [food]\n---\n'
    const inFrontmatter = mount(fm + NOTE, { at: 6 })
    ctrlA(inFrontmatter)
    expect(selected(inFrontmatter)).toEqual([0, fm.length + NOTE.length])
  })

  it('selects the whole note when there is no title to leave out', () => {
    for (const doc of ['Buy 3 apples.\nMilk.\n', '## Section\n\nBuy 3 apples.\n', 'Intro\n# Later heading\n\ntext\n', '# Just a title\n\n']) {
      const view = mount(doc)
      ctrlA(view)
      expect(selected(view), JSON.stringify(doc)).toEqual([0, doc.length])
    }
  })

  it('selects the text from Vim insert mode, where Ctrl+A is select all', () => {
    const view = mount(NOTE, { vimMode: true, at: MILK })
    press(view, 'i', 73)
    expect(ctrlA(view)).toBe(true)
    expect(selected(view)).toEqual([TEXT_FROM, NOTE.length])
  })

  // #993 stays: in normal mode off macOS Ctrl+A is Vim's increment. With no
  // number on the rest of the line it does nothing, as in Vim, and still
  // consumes the key, so the browser's own select all (which would take the
  // whole window while the content is not editable) never runs.
  it('leaves Ctrl+A to Vim in normal mode: increment, or nothing without a number', () => {
    const number = mount(NOTE, { vimMode: true, at: TEXT_FROM })
    expect(ctrlA(number)).toBe(true)
    expect(number.state.doc.toString()).toBe(NOTE.replace('Buy 3', 'Buy 4'))
    expect(number.state.selection.main.empty).toBe(true)

    const plain = mount(NOTE, { vimMode: true, at: MILK })
    expect(ctrlA(plain)).toBe(true)
    expect(plain.state.doc.toString()).toBe(NOTE)
    expect(selected(plain)).toEqual([MILK, MILK])
  })

  it('is the command behind Mod-a in every keymap, Vim on or off, macOS or not', () => {
    for (const vimMode of [false, true]) {
      for (const mac of [false, true]) {
        const binding = vimAwareDefaultKeymap(vimMode, mac).find((b) => b.key === 'Mod-a')
        const view = mount(NOTE, { at: MILK })
        expect(binding?.run?.(view), `vim ${vimMode} mac ${mac}`).toBe(true)
        expect(selected(view), `vim ${vimMode} mac ${mac}`).toEqual([TEXT_FROM, NOTE.length])
      }
    }
  })

  it('runs as a plain command too (the editor menu’s Select All)', () => {
    const view = mount(NOTE, { at: MILK })
    expect(selectNoteText(view)).toBe(true)
    expect(selected(view)).toEqual([TEXT_FROM, NOTE.length])
    expect(selectNoteText(view)).toBe(true)
    expect(selected(view)).toEqual([0, NOTE.length])
  })
})
