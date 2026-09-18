// @vitest-environment jsdom

import {
  autocompletion,
  completionStatus,
  currentCompletions,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { completionKeymapExtension, completionNavKeymap } from './cm-completion-nav'
import { wikilinkDisplayTextEdit } from './cm-wikilink-tail'

/**
 * Stands in for the wikilink picker: the same option shape (`_kind`,
 * `_target`) and the same two ways of applying a pick. A link still being
 * typed gets its `]]` with the caret after it; a link that is already closed
 * (Auto-close Markdown typed the `]]`) only has its target filled in.
 */
function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]|#^]*/)
  if (!match) return null
  const apply =
    (target: string) =>
    (view: EditorView, _completion: Completion, from: number, to: number): void => {
      const closed = view.state.doc.sliceString(to, to + 2) === ']]'
      const insert = closed ? target : `${target}]]`
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
    }
  const option = (target: string): Completion =>
    ({ label: target, _kind: 'wikilink', _target: target, apply: apply(target) }) as Completion
  return { from: match.from + 2, options: [option('Kickoff notes'), option('Linux')], filter: false }
}

/** A picker whose options are not wikilinks: `|` must stay a character there. */
function otherSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/@\w*/)
  if (!match) return null
  return { from: match.from + 1, options: [{ label: 'Today' }], filter: false }
}

function mount(doc: string, caret: number): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        autocompletion({ defaultKeymap: false, override: [wikilinkSource, otherSource] }),
        completionNavKeymap,
        completionKeymapExtension
      ]
    }),
    parent: document.body
  })
}

/** True when the editor took the key, which is when the browser would not type it. */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

async function open(view: EditorView): Promise<void> {
  startCompletion(view)
  const deadline = Date.now() + 5_000
  while (currentCompletions(view.state).length === 0) {
    if (Date.now() > deadline) throw new Error('completion never opened')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

const marked = (view: EditorView): string => {
  const { from, to } = view.state.selection.main
  const text = view.state.doc.toString()
  return from === to
    ? `${text.slice(0, from)}‸${text.slice(from)}`
    : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

describe('the | key in the wikilink picker (#804)', () => {
  // The report: `[[`, pick a note, `|`. It left `[[|]]`.
  it('takes the highlighted note and starts its display text', async () => {
    const view = mount('[[]]', 2)
    await open(view)
    press(view, 'ArrowDown')
    expect(press(view, '|', { shiftKey: true })).toBe(true)
    expect(marked(view)).toBe('[[Linux|‸]]')
    expect(completionStatus(view.state)).not.toBe('active')
  })

  it('completes what was typed so far to the highlighted note, like Enter does', async () => {
    const view = mount('see [[Kick]] later', 10)
    await open(view)
    press(view, '|', { shiftKey: true })
    expect(marked(view)).toBe('see [[Kickoff notes|‸]] later')
  })

  it('closes a link that was still being typed', async () => {
    const view = mount('[[Lin', 5)
    await open(view)
    press(view, 'ArrowDown')
    press(view, '|', { shiftKey: true })
    expect(marked(view)).toBe('[[Linux|‸]]')
  })

  // Option+7 on a German Mac, AltGr+< on a German PC (Ctrl and Alt together).
  it('is the character, whatever modifiers the layout needs to type it', async () => {
    const mac = mount('[[]]', 2)
    await open(mac)
    expect(press(mac, '|', { altKey: true })).toBe(true)
    expect(marked(mac)).toBe('[[Kickoff notes|‸]]')

    const altGr = mount('[[]]', 2)
    await open(altGr)
    expect(press(altGr, '|', { ctrlKey: true, altKey: true })).toBe(true)
    expect(marked(altGr)).toBe('[[Kickoff notes|‸]]')
  })

  it('leaves | alone when no picker is open, and in pickers that are not wikilinks', async () => {
    const closed = mount('[[Linux]] and a table | cell', 22)
    expect(press(closed, '|', { shiftKey: true })).toBe(false)

    const other = mount('@', 1)
    await open(other)
    expect(press(other, '|', { shiftKey: true })).toBe(false)
    expect(other.state.doc.toString()).toBe('@')
  })

  it('does not treat Ctrl+| or Cmd+| as typing', async () => {
    const view = mount('[[]]', 2)
    await open(view)
    expect(press(view, '|', { ctrlKey: true })).toBe(false)
    expect(press(view, '|', { metaKey: true })).toBe(false)
    expect(view.state.doc.toString()).toBe('[[]]')
  })
})

describe('where the display text of a wikilink starts', () => {
  const edit = (doc: string, caret: number): string => {
    const state = EditorState.create({ doc, selection: { anchor: caret } })
    const next = state.update(wikilinkDisplayTextEdit(state, caret)).state
    const { from, to } = next.selection.main
    const text = next.doc.toString()
    return from === to
      ? `${text.slice(0, from)}‸${text.slice(from)}`
      : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
  }

  it('adds the | before the ]], whether the caret is inside or just past them', () => {
    expect(edit('[[Linux]]', 7)).toBe('[[Linux|‸]]')
    expect(edit('[[Linux]]', 9)).toBe('[[Linux|‸]]')
  })

  it('puts it after a section the link already carries', () => {
    expect(edit('[[Linux#Install]]', 7)).toBe('[[Linux#Install|‸]]')
  })

  // Repicking the note of `[[Old|alias]]` keeps the alias; a second | would break the link.
  it('selects the display text that is already there instead of adding a second |', () => {
    expect(edit('[[Linux|the penguin]]', 7)).toBe('[[Linux|«the penguin»]]')
    expect(edit('[[Linux#Install|setup]]', 7)).toBe('[[Linux#Install|«setup»]]')
  })

  it('only looks at its own link', () => {
    expect(edit('[[Linux]] and [[Other|alias]]', 9)).toBe('[[Linux|‸]] and [[Other|alias]]')
  })
})
