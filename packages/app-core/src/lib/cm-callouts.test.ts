// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { calloutTypeSource } from './cm-callouts'
import { CALLOUT_TYPES, calloutGroupFor } from './callout-types'

function complete(doc: string) {
  const state = EditorState.create({ doc })
  return calloutTypeSource(new CompletionContext(state, doc.length, true))
}

function labels(doc: string): string[] {
  return (complete(doc)?.options ?? []).map((o) => o.displayLabel ?? o.label)
}

/** Apply the option whose display label matches, return the resulting doc. */
function apply(doc: string, label: string): string {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({ parent, state: EditorState.create({ doc }) })
  const result = calloutTypeSource(new CompletionContext(view.state, doc.length, true))
  const option = result?.options.find((o) => (o.displayLabel ?? o.label) === label)
  const fn = option?.apply
  if (typeof fn !== 'function') throw new Error(`no apply handler for ${label}`)
  fn(view, option!, result!.from, view.state.doc.length)
  const out = view.state.doc.toString()
  view.destroy()
  parent.remove()
  return out
}

describe('calloutTypeSource', () => {
  it('offers the callout types after `> [!`', () => {
    expect(labels('> [!')).toEqual(
      expect.arrayContaining(['Note', 'Info', 'Abstract', 'Tip', 'Warning', 'Danger', 'Quote'])
    )
  })

  it('leads with Note and preserves the curated order via descending boost', () => {
    const options = complete('> [!')?.options ?? []
    expect(options[0]?.displayLabel).toBe('Note')
    const boosts = options.map((o) => o.boost ?? 0)
    // Strictly descending — CodeMirror keeps our order instead of alphabetizing.
    expect(boosts).toEqual([...boosts].sort((a, b) => b - a))
    expect(new Set(boosts).size).toBe(boosts.length)
  })

  it('triggers with no space after the marker (`>[!`)', () => {
    expect(complete('>[!')).not.toBeNull()
  })

  it('triggers on an indented / nested quote line', () => {
    expect(complete('  > [!')).not.toBeNull()
  })

  it('does not trigger without the blockquote marker', () => {
    expect(complete('[!')).toBeNull()
    expect(complete('hello [!')).toBeNull()
  })

  it('does not trigger once the type is closed', () => {
    expect(complete('> [!note]')).toBeNull()
  })

  it('does not trigger on a plain blockquote', () => {
    expect(complete('> just a quote')).toBeNull()
  })

  it('surfaces a type by its alias (warn → Warning)', () => {
    const result = complete('> [!warn')
    // Filtering is left to CodeMirror, but the alias must be foldable into the
    // Warning option's match label.
    const warning = result?.options.find((o) => o.displayLabel === 'Warning')
    expect(warning?.label).toContain('warn')
  })

  it('inserts the type and closes the bracket on apply', () => {
    expect(apply('> [!', 'Warning')).toBe('> [!warning] ')
  })

  it('completes a partially-typed type', () => {
    expect(apply('> [!wa', 'Warning')).toBe('> [!warning] ')
  })

  it('lands the caret after the inserted `] `', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '> [!' }) })
    const result = calloutTypeSource(new CompletionContext(view.state, 4, true))
    const tip = result?.options.find((o) => o.displayLabel === 'Tip')
    ;(tip!.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
      view,
      tip,
      result!.from,
      view.state.doc.length
    )
    expect(view.state.selection.main.head).toBe('> [!tip] '.length)
    view.destroy()
    parent.remove()
  })
})

describe('calloutGroupFor', () => {
  it('maps canonical types and aliases to their color group', () => {
    expect(calloutGroupFor('note')).toBe('note')
    expect(calloutGroupFor('tldr')).toBe('note')
    expect(calloutGroupFor('hint')).toBe('tip')
    expect(calloutGroupFor('warn')).toBe('warning')
    expect(calloutGroupFor('error')).toBe('danger')
    expect(calloutGroupFor('example')).toBe('question')
    expect(calloutGroupFor('cite')).toBe('quote')
  })

  it('is case-insensitive', () => {
    expect(calloutGroupFor('WARNING')).toBe('warning')
  })

  it('falls back to note for unknown types', () => {
    expect(calloutGroupFor('nonsense')).toBe('note')
  })

  it('has a unique canonical keyword per entry', () => {
    const types = CALLOUT_TYPES.map((c) => c.type)
    expect(new Set(types).size).toBe(types.length)
  })
})
