// @vitest-environment jsdom

import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { wikilinkSource } from './cm-wikilinks'

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
    body: ''
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
  vaultSettings: {
    primaryNotesLocation: 'root' as const,
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
