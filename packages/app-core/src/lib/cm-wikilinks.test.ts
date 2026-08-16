// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  wikilinkSource,
  wikilinkHeadingSource,
  wikilinkBlockSource,
  atNoteSource
} from './cm-wikilinks'

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
    body: '# Home\n\n## Tasks\n\n- Daily standup ^standup\n'
  },
  noteContents: {
    'inbox/Zen Garden.md': {
      body: '# Intro\n\n## Setup\n\n- Install the thing ^install\n\n## Usage Notes\n\n- Run it ^run-it\n\nbody\n'
    }
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

function blockResult(doc: string) {
  const state = EditorState.create({ doc })
  return wikilinkBlockSource(new CompletionContext(state, doc.length, true))
}

describe('wikilinkBlockSource (#601 — block id autocomplete)', () => {
  it('suggests the target note block ids after ^', async () => {
    const result = await blockResult('[[Zen Garden^')
    expect(result?.options.map((o) => o.label)).toEqual(['install', 'run-it'])
  })

  it('shows the block text so ids can be told apart', async () => {
    const result = await blockResult('[[Zen Garden^')
    expect(result?.options.map((o) => o.detail)).toEqual([
      '- Install the thing',
      '- Run it'
    ])
  })

  it('anchors the completion just after the ^ so the id lands inside the link', async () => {
    expect((await blockResult('[[Zen Garden^ru'))?.from).toBe('[[Zen Garden^'.length)
  })

  it('inserts the chosen id and closes the link', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '[[Zen Garden^ru' }) })
    const result = await wikilinkBlockSource(
      new CompletionContext(view.state, view.state.doc.length, true)
    )
    const option = result?.options.find((o) => o.label === 'run-it')
    const apply = option?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, option!, result!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('[[Zen Garden^run-it]]')
    view.destroy()
    parent.remove()
  })

  it('falls back to the current note for [[^', async () => {
    expect((await blockResult('[[^'))?.options.map((o) => o.label)).toEqual(['standup'])
  })

  it('returns null without a ^, and yields to the heading source when # comes first', async () => {
    expect(await blockResult('[[Zen Garden')).toBeNull()
    expect(await blockResult('[[Zen Garden#Setup^')).toBeNull()
  })
})

function atResult(doc: string) {
  const state = EditorState.create({ doc })
  return atNoteSource(new CompletionContext(state, doc.length, true))
}

describe('atNoteSource (#332 — @ note linking)', () => {
  it('suggests notes when typing @<query>', () => {
    const result = atResult('@Zen')
    expect(result?.options.map((o) => o.label)).toEqual(expect.arrayContaining(['Zen Garden']))
  })

  it('replaces the whole @query with a [[wikilink]]', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: '@Zen' }) })
    const result = atNoteSource(new CompletionContext(view.state, view.state.doc.length, true))
    const option = result?.options.find((o) => o.label === 'Zen Garden')
    const apply = option?.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply handler')
    apply(view, option!, result!.from, view.state.doc.length)
    expect(view.state.doc.toString()).toBe('[[Zen Garden]]')
    view.destroy()
    parent.remove()
  })

  it('returns null for a bare @ so the date shortcuts lead', () => {
    expect(atResult('@')).toBeNull()
  })

  it('does not trigger mid-word (e.g. inside an email)', () => {
    expect(atResult('foo@Zen')).toBeNull()
  })
})
