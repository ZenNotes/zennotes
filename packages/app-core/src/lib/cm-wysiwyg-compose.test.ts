// @vitest-environment jsdom

// Integration check: the WYSIWYG plugins (ported from PR #185) are loaded
// together by `wysiwygExtensions()` in EditorPane. Each has its own unit
// test; this verifies they COMPOSE on one document without conflicting
// (e.g. overlapping decorations) and that every block renders at once.

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

import { livePreviewPlugin } from './cm-live-preview'
import { codeBlockFlairPlugin } from './cm-code-block-flair'
import { tablePlugin } from './cm-table'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { hashtagExtension } from './cm-hashtags'
import { wikilinkRenderExtension } from './cm-wikilink-render'

vi.mock('../store', () => {
  const state = {
    activeNote: null,
    assetFiles: [],
    notes: [],
    noteRefs: {},
    pdfEmbedInEditMode: 'compact',
    pinnedRefKind: 'note',
    pinnedRefPath: null,
    vault: null
  }
  const useStore = Object.assign(() => null, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useStore }
})

const RICH_DOC = [
  '# Title',
  '',
  'Body with **bold**, ~~struck~~, a #tag and a [[WikiLink]].',
  '',
  '> a blockquote line',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '---',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```js',
  'const x = 1',
  '```',
  ''
].join('\n')

describe('wysiwyg plugin composition', () => {
  it('renders every block construct together without conflicting', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        // Cursor on the title line so every block below is inactive (rendered).
        doc: RICH_DOC,
        selection: { anchor: 0 },
        extensions: [
          markdown({ base: markdownLanguage }),
          livePreviewPlugin,
          codeBlockFlairPlugin,
          tablePlugin,
          wysiwygBlocksPlugin,
          hashtagExtension,
          wikilinkRenderExtension
        ]
      })
    })
    // Force a full parse + a no-op edit so every viewport-driven plugin emits.
    forceParsing(view, RICH_DOC.length, 5000)
    view.dispatch({ changes: { from: RICH_DOC.length, insert: ' ' } })
    view.dispatch({ changes: { from: RICH_DOC.length, to: RICH_DOC.length + 1 } })

    expect(view.dom.querySelectorAll('.cm-table-widget').length).toBeGreaterThanOrEqual(1)
    expect(view.dom.querySelectorAll('.cm-wq-hr').length).toBeGreaterThanOrEqual(1)
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBeGreaterThanOrEqual(2)
    expect(view.dom.querySelectorAll('.cm-wq-quote').length).toBeGreaterThanOrEqual(1)
    expect(view.dom.querySelectorAll('.cm-hashtag').length).toBeGreaterThanOrEqual(1)
    expect(view.dom.querySelectorAll('.cm-wikilink').length).toBeGreaterThanOrEqual(1)
    expect(view.dom.querySelectorAll('.cm-code-flair').length).toBeGreaterThanOrEqual(1)

    view.destroy()
  })
})
