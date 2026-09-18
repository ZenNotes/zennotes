// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveTemplateTokenExtension } from './cm-live-template-tokens'

const savedAt = new Date(2026, 7, 25, 14, 7).getTime()

const storeState = vi.hoisted(() => ({
  activeNote: { path: 'inbox/Evergreen.md', updatedAt: 0 } as { path: string; updatedAt: number } | null,
  notes: [{ path: 'inbox/Evergreen.md', updatedAt: 0 }] as Array<{ path: string; updatedAt: number }>
}))
const listeners = vi.hoisted(() => new Set<(state: unknown, prev: unknown) => void>())

vi.mock('../store', () => {
  const useStore = Object.assign(() => null, {
    getState: () => storeState,
    subscribe: (fn: (state: unknown, prev: unknown) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  })
  return { useStore }
})

function mount(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), liveTemplateTokenExtension]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  storeState.notes = [{ path: 'inbox/Evergreen.md', updatedAt: 0 }]
  storeState.activeNote = { path: 'inbox/Evergreen.md', updatedAt: 0 }
})

describe('liveTemplateTokenExtension (#784)', () => {
  it('renders the token as the note\'s last-saved date when the caret is elsewhere', () => {
    storeState.notes = [{ path: 'inbox/Evergreen.md', updatedAt: savedAt }]
    const doc = 'Updated: {{modified_date}} ({{modified_time}})'
    const view = mount(doc, 0)
    views.push(view)
    const tokens = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-live-token'))
    expect(tokens.map((el) => el.textContent)).toEqual(['2026-08-25', '14:07'])
    expect(view.dom.textContent).not.toContain('{{modified_date}}')
  })

  it('reveals the raw token under the caret and inside code', () => {
    storeState.notes = [{ path: 'inbox/Evergreen.md', updatedAt: savedAt }]
    const doc = 'Updated: {{modified_date}} and `{{modified_date}}`'
    const view = mount(doc, doc.indexOf('modified'))
    views.push(view)
    expect(view.dom.querySelector('.cm-live-token')).toBeNull()
    expect(view.dom.textContent).toContain('{{modified_date}}')
  })

  it('shows nothing special until the note has a modification time, then refreshes on save', () => {
    const doc = 'Updated: {{modified_date}}'
    const view = mount(doc, 0)
    views.push(view)
    expect(view.dom.querySelector('.cm-live-token')).toBeNull()

    const prev = { ...storeState }
    storeState.notes = [{ path: 'inbox/Evergreen.md', updatedAt: savedAt }]
    for (const fn of listeners) fn(storeState, prev)
    expect(view.dom.querySelector('.cm-live-token')?.textContent).toBe('2026-08-25')
  })
})
