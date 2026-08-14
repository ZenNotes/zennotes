// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { frontmatterTagSource } from './cm-frontmatter-tag-complete'

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
  activeNote: { path: 'inbox/Active.md', title: 'Active', folder: 'inbox' as const, body: '' }
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

function result(doc: string, pos: number) {
  const state = EditorState.create({ doc })
  return frontmatterTagSource(new CompletionContext(state, pos, true))
}

describe('frontmatterTagSource', () => {
  it('suggests tags inside an inline list', () => {
    const doc = '---\ntags: [pro\n---\n'
    const pos = doc.indexOf('\n---\n') // end of the tags line, before the closing fence
    const r = result(doc, pos)
    expect(r?.options.map((o) => o.label)).toEqual(['project', 'projectplan'])
  })

  it('suggests tags inside a scalar value', () => {
    const doc = '---\ntags: pro\n---\n'
    const pos = doc.indexOf('\n---\n')
    const r = result(doc, pos)
    expect(r?.options.map((o) => o.label)).toEqual(['project', 'projectplan'])
  })

  it('suggests tags inside a block list under a bare tags key', () => {
    const doc = '---\ntags:\n  - pro\n---\n'
    const pos = doc.indexOf('\n---\n')
    const r = result(doc, pos)
    expect(r?.options.map((o) => o.label)).toEqual(['project', 'projectplan'])
  })

  it('does not suggest outside frontmatter', () => {
    expect(result('tags: pro', 'tags: pro'.length)).toBeNull()
    expect(result('---\nbody\n---\ntags: pro', '---\nbody\n---\ntags: pro'.length)).toBeNull()
  })

  it('does not suggest on other frontmatter keys', () => {
    expect(result('---\ntitle: pro\n---\n', '---\ntitle: pro'.length)).toBeNull()
  })

  it('does not suggest before the list marker', () => {
    const doc = '---\ntags:\n  - \n---\n'
    const pos = '---\ntags:\n  - '.length
    expect(result(doc, pos)).toBeNull()
  })

  it('does not suggest while the cursor is still in the key', () => {
    const doc = '---\ntags: pro\n---\n'
    const pos = '---\ntags'.length
    expect(result(doc, pos)).toBeNull()
  })

  it('inserts the tag without a leading hash', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const doc = '---\ntags: [pro]\n---\n'
    const view = new EditorView({ parent, state: EditorState.create({ doc }) })
    const pos = doc.indexOf(']')
    const r = frontmatterTagSource(new CompletionContext(view.state, pos, true))
    const option = r?.options.find((o) => o.label === 'project')
    if (typeof option?.apply !== 'function') throw new Error('expected apply function')
    option.apply(view, option, r!.from, pos)
    expect(view.state.doc.toString()).toBe('---\ntags: [project]\n---\n')
    view.destroy()
    parent.remove()
  })

  it('keeps surrounding quotes intact', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const doc = '---\ntags: ["pro"]\n---\n'
    const view = new EditorView({ parent, state: EditorState.create({ doc }) })
    const pos = doc.indexOf('"]')
    const r = frontmatterTagSource(new CompletionContext(view.state, pos, true))
    const option = r?.options.find((o) => o.label === 'project')
    if (typeof option?.apply !== 'function') throw new Error('expected apply function')
    option.apply(view, option, r!.from, pos)
    expect(view.state.doc.toString()).toBe('---\ntags: ["project"]\n---\n')
    view.destroy()
    parent.remove()
  })

  it('consumes a stray leading # when completing', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const doc = '---\ntags: [#pro]\n---\n'
    const view = new EditorView({ parent, state: EditorState.create({ doc }) })
    const pos = doc.indexOf(']')
    const r = frontmatterTagSource(new CompletionContext(view.state, pos, true))
    const option = r?.options.find((o) => o.label === 'project')
    if (typeof option?.apply !== 'function') throw new Error('expected apply function')
    option.apply(view, option, r!.from, pos)
    expect(view.state.doc.toString()).toBe('---\ntags: [project]\n---\n')
    view.destroy()
    parent.remove()
  })
})
