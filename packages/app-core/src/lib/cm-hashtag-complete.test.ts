// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { hashtagSource } from './cm-hashtag-complete'

const meta = (path: string, folder: 'inbox' | 'trash', tags: string[]) => ({
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  folder,
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 0,
  tags,
  wikilinks: [],
  hasAttachments: false,
  excerpt: ''
})

const storeState = vi.hoisted(() => ({
  // Active note kept out of `notes` with an empty body so counts come purely
  // from the seeded notes below.
  activeNote: {
    path: 'inbox/Active.md',
    title: 'Active',
    folder: 'inbox' as const,
    body: ''
  }
})) as {
  activeNote: { path: string; title: string; folder: 'inbox'; body: string }
  notes: ReturnType<typeof meta>[]
}
storeState.notes = [
  meta('inbox/A.md', 'inbox', ['project', 'idea', 'work/deep']),
  meta('inbox/B.md', 'inbox', ['project', 'projectplan', 'todo']),
  meta('trash/Old.md', 'trash', ['project', 'projecttrash'])
]

vi.mock('../store', () => {
  const useStore = Object.assign(() => null, { getState: () => storeState })
  return { useStore }
})

function result(doc: string) {
  const state = EditorState.create({ doc })
  return hashtagSource(new CompletionContext(state, doc.length, true))
}

describe('hashtagSource (#410 — hashtag autocomplete)', () => {
  it('suggests previously used tags when typing #<query>', () => {
    const r = result('#pro')
    // project (count 2) ranks above projectplan (count 1); trash is excluded.
    expect(r?.options.map((o) => o.label)).toEqual(['project', 'projectplan'])
  })

  it('anchors completion just after the # and inserts #tag', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: 'see #pro' }) })
    const r = hashtagSource(new CompletionContext(view.state, view.state.doc.length, true))
    expect(r?.from).toBe('see #'.length)
    const option = r?.options.find((o) => o.label === 'project')
    const apply = option?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, option!, r!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('see #project')
    view.destroy()
    parent.remove()
  })

  it('matches nested tags by substring', () => {
    expect(result('#deep')?.options.map((o) => o.label)).toEqual(['work/deep'])
  })

  it('returns null for a bare # so headings do not flash the menu', () => {
    expect(result('#')).toBeNull()
  })

  it('does not trigger mid-word (# not after whitespace/start)', () => {
    expect(result('foo#pro')).toBeNull()
  })

  it('returns null when nothing matches the query', () => {
    expect(result('#zzz')).toBeNull()
  })

  it('excludes the exact tag already typed (no self-suggestion)', () => {
    // `idea` exists once; typing it fully should not offer `idea` back.
    expect(result('#idea')).toBeNull()
    // A prefix that still has a longer match keeps that one.
    expect(result('#project')?.options.map((o) => o.label)).toEqual(['projectplan'])
  })

  it('does not suggest inside frontmatter', () => {
    const doc = '---\ntags: #pro\n---\n'
    expect(result(doc)).toBeNull()
  })

  it('does not suggest inside a fenced code block', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    // Closed fence; caret mid-line after `#pro` so it resolves inside the block.
    const doc = '```\n#pro more\n```'
    const pos = '```\n#pro'.length
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [markdown()] })
    })
    forceParsing(view, view.state.doc.length)
    const r = hashtagSource(new CompletionContext(view.state, pos, true))
    expect(r).toBeNull()
    view.destroy()
    parent.remove()
  })
})
