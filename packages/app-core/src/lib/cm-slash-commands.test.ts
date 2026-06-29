// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

// The "Page" command reaches into the store on apply; nothing else does, and the
// tests below never apply Page, so a bare stub keeps the module store-free.
vi.mock('../store', () => ({ useStore: { getState: () => ({}) } }))

import { slashCommandSource, templateSlashCommandSource } from './cm-slash-commands'

type Source = typeof templateSlashCommandSource

function complete(doc: string, source: Source = templateSlashCommandSource) {
  const state = EditorState.create({ doc })
  return source(new CompletionContext(state, doc.length, true))
}

function labels(doc: string, source: Source = templateSlashCommandSource): string[] {
  return (complete(doc, source)?.options ?? []).map((o) => o.displayLabel ?? o.label)
}

describe('slash command sources', () => {
  it('offers the full block menu for a slash at line start', () => {
    expect(labels('/')).toEqual(
      expect.arrayContaining([
        'Heading 1',
        'Task',
        'Bulleted list',
        'Numbered list',
        'Quote',
        'Code block',
        'Table',
        'Math block',
        'Callout',
        'Link',
        'Image'
      ])
    )
  })

  it('templateSlashCommandSource (Quick Capture) excludes the store-only "Page"', () => {
    expect(labels('/')).not.toContain('Page')
  })

  it('slashCommandSource (main editor) includes "Page"', () => {
    expect(labels('/', slashCommandSource)).toContain('Page')
  })

  it('does not trigger mid-word', () => {
    expect(complete('foo/bar')).toBeNull()
  })

  it('triggers after whitespace', () => {
    expect(complete('hello /')).not.toBeNull()
  })

  it('inserts the Task block on apply, replacing the slash', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '/' }) })
    const result = templateSlashCommandSource(new CompletionContext(view.state, 1, true))
    const task = result?.options.find((o) => (o.displayLabel ?? o.label) === 'Task')
    const apply = task?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, task!, result!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('- [ ] ')
    view.destroy()
    parent.remove()
  })
})
