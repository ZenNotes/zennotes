// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { wikilinkSource, wikilinkHeadingSource } from './cm-wikilinks'

const storeState = vi.hoisted(() => ({
  activeNote: {
    path: 'inbox/Welcome.md',
    title: 'Welcome',
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    excerpt: '',
    body: '# Home\n\n## Tasks\n'
  },
  noteContents: {
    'inbox/Zen Garden.md': { body: '# Intro\n\n## Setup\n\n## Usage Notes\n\nbody\n' }
  },
  notes: [
    {
      path: 'inbox/Zen Garden.md',
      title: 'Zen Garden',
      folder: 'inbox' as const,
      siblingOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      size: 0,
      tags: [],
      wikilinks: [],
      hasAttachments: false,
      excerpt: ''
    }
  ],
  assetFiles: [
    {
      path: 'zennotes logo.png',
      name: 'zennotes logo.png',
      kind: 'image' as const,
      siblingOrder: 0,
      size: 100,
      updatedAt: 1
    },
    {
      path: 'media/zennotes-demo-card.svg',
      name: 'zennotes-demo-card.svg',
      kind: 'image' as const,
      siblingOrder: 1,
      size: 100,
      updatedAt: 1
    }
  ],
  folders: [
    { folder: 'inbox' as const, subpath: 'Projects.base', siblingOrder: 0 },
    { folder: 'inbox' as const, subpath: 'demo', siblingOrder: 1 }
  ],
  vaultSettings: {
    primaryNotesLocation: 'root' as const,
    dailyNotes: { enabled: false, directory: 'Daily Notes' },
    folderIcons: {}
  }
}))

vi.mock('../store', () => {
  const useStore = Object.assign(() => null, {
    getState: () => storeState
  })
  return { useStore }
})

function completionResult(doc: string) {
  const state = EditorState.create({ doc })
  return wikilinkSource(new CompletionContext(state, doc.length, true))
}

describe('wikilinkSource', () => {
  it('offers asset files as wikilink completions', () => {
    const result = completionResult('[[zen')

    expect(result?.options.map((option) => option.label)).toEqual(
      expect.arrayContaining(['Zen Garden', 'zennotes logo.png'])
    )
  })

  it('offers CSV databases as wikilink completions (#238)', () => {
    const result = completionResult('[[Proj')
    const db = result?.options.find((option) => option.label === 'Projects')
    expect(db).toBeTruthy()
    expect(db?.detail).toBe('DATABASE')
  })

  it('inserts a database link as a plain wikilink, not an embed (#238)', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '[[Proj' }) })
    const result = wikilinkSource(new CompletionContext(view.state, view.state.doc.length, true))
    const option = result?.options.find((candidate) => candidate.label === 'Projects')
    const apply = option?.apply
    if (typeof apply !== 'function') throw new Error('Expected a function completion apply handler')
    apply(view, option!, result!.from, view.state.doc.length)

    expect(view.state.doc.toString()).toBe('[[Projects]]')
    view.destroy()
    parent.remove()
  })

  it('inserts selected image assets as embeds', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: '[[zen' })
    })
    const result = wikilinkSource(new CompletionContext(view.state, view.state.doc.length, true))
    const option = result?.options.find((candidate) => candidate.label === 'zennotes logo.png')

    expect(option).toBeTruthy()
    const apply = option!.apply
    expect(typeof apply).toBe('function')
    if (typeof apply !== 'function') throw new Error('Expected a function completion apply handler')
    apply(view, option!, result!.from, view.state.doc.length)

    expect(view.state.doc.toString()).toBe('![[zennotes logo.png]]')
    view.destroy()
    parent.remove()
  })
})

function headingResult(doc: string) {
  const state = EditorState.create({ doc })
  return wikilinkHeadingSource(new CompletionContext(state, doc.length, true))
}

describe('wikilinkHeadingSource (#196 — heading autocomplete)', () => {
  it('suggests the target note headings after #', async () => {
    const result = await headingResult('[[Zen Garden#')
    expect(result?.options.map((o) => o.label)).toEqual(['Intro', 'Setup', 'Usage Notes'])
  })

  it('anchors the completion just after the # so the heading lands inside the link', async () => {
    const doc = '[[Zen Garden#Us'
    const result = await headingResult(doc)
    expect(result?.from).toBe('[[Zen Garden#'.length)
  })

  it('inserts the chosen heading and closes the link', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '[[Zen Garden#Us' }) })
    const result = await wikilinkHeadingSource(
      new CompletionContext(view.state, view.state.doc.length, true)
    )
    const option = result?.options.find((o) => o.label === 'Usage Notes')
    const apply = option?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, option!, result!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('[[Zen Garden#Usage Notes]]')
    view.destroy()
    parent.remove()
  })

  it('falls back to the current note for [[#', async () => {
    const result = await headingResult('[[#')
    expect(result?.options.map((o) => o.label)).toEqual(['Home', 'Tasks'])
  })

  it('returns null without a # (note mode owns that)', async () => {
    expect(await headingResult('[[Zen Garden')).toBeNull()
  })
})
