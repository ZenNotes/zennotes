// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frontmatterTags } from '@shared/frontmatter'
import { frontmatterTagExtension } from './cm-frontmatter'

const openTagView = vi.fn()

vi.mock('../store', () => {
  const useStore = Object.assign(() => null, {
    getState: () => ({ openTagView })
  })
  return { useStore }
})

const views: EditorView[] = []
function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [frontmatterTagExtension] })
  })
  views.push(view)
  return view
}

afterEach(() => {
  openTagView.mockClear()
  while (views.length) views.pop()!.destroy()
})

function tagsIn(view: EditorView): string[] {
  return Array.from(view.dom.querySelectorAll('.cm-frontmatter-tag')).map(
    (el) => (el as HTMLElement).dataset.tag ?? ''
  )
}

describe('frontmatterTagExtension', () => {
  it('marks inline list tags and strips quotes', () => {
    const view = mount(['---', 'tags: [idea, "work/deep", \'project\']', '---', ''].join('\n'))
    expect(tagsIn(view)).toEqual(['idea', 'work/deep', 'project'])
  })

  it('marks scalar tags split by comma or whitespace', () => {
    const view = mount(['---', 'tags: daily, work', '---', ''].join('\n'))
    expect(tagsIn(view)).toEqual(['daily', 'work'])
  })

  it('marks block list tags under a bare tags key', () => {
    const view = mount(['---', 'tags:', '  - idea', '  - "project"', '---', ''].join('\n'))
    expect(tagsIn(view)).toEqual(['idea', 'project'])
  })

  it('strips a stray leading # from frontmatter tags', () => {
    const view = mount(['---', 'tags: [#idea]', '---', ''].join('\n'))
    expect(tagsIn(view)).toEqual(['idea'])
  })

  it('does not mark tags on other frontmatter keys', () => {
    const view = mount(['---', 'title: idea', '---', ''].join('\n'))
    expect(tagsIn(view)).toEqual([])
  })

  it('does not mark tags outside frontmatter', () => {
    const view = mount(['---', 'title: x', '---', '', 'tags: idea'].join('\n'))
    expect(tagsIn(view)).toEqual([])
  })

  it('opens the tag view when a frontmatter tag is clicked', () => {
    const view = mount(['---', 'tags: [idea]', '---', ''].join('\n'))
    const el = view.dom.querySelector('.cm-frontmatter-tag') as HTMLElement | null
    expect(el).not.toBeNull()
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(openTagView).toHaveBeenCalledWith('idea')
  })
})

// Review follow-up to #595. Two places now decide what a frontmatter tag is:
// `frontmatterTags` in shared-domain, which is what the vault indexes and what
// the Tags view lists, and the editor's own scan, which needs positions the
// shared parser does not return. They must not drift: a chip the index has
// never heard of goes nowhere, and a tag with no chip looks broken next to its
// neighbours.
describe('chips agree with the tags the vault indexes', () => {
  const cases = [
    '---\ntags: [draft, research]\n---\n',
    '---\ntags: draft research\n---\n',
    '---\ntags: draft, research\n---\n',
    '---\ntags:\n  - draft\n  - research\n---\n',
    '---\ntags: "#draft"\n---\n',
    // parseFrontmatterFields lowercases keys, so a capital T is still the
    // tags field: the index counts it and the editor has to as well.
    '---\nTags: draft\n---\n',
    '---\nTAGS:\n  - draft\n---\n',
    // Fields that merely look adjacent must stay plain text.
    '---\nkeywords: draft\n---\n',
    '---\ntitle: tags: not a list\n---\n'
  ]

  for (const doc of cases) {
    it(`matches frontmatterTags for ${JSON.stringify(doc.split('\n')[1])}`, () => {
      const view = mount(doc)
      const chips = Array.from(view.dom.querySelectorAll('.cm-frontmatter-tag')).map(
        (el) => el.textContent
      )
      expect(chips).toEqual(frontmatterTags(doc))
    })
  }
})
