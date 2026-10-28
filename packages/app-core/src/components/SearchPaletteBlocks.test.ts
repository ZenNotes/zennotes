// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { SearchPalette } from './SearchPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confirmApp = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../lib/confirm-requests', () => ({ confirmApp }))
const focusEditorNormalMode = vi.hoisted(() => vi.fn())
const focusEditorAfterPick = vi.hoisted(() => vi.fn())
const focusEditorAfterSearchClose = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({
  focusEditorNormalMode,
  focusEditorAfterPick,
  focusEditorAfterSearchClose
}))

function note(title: string, tags: string[], updatedAt: number): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt,
    size: 10,
    tags,
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

const BODIES: Record<string, string> = {
  'inbox/Ideas.md': [
    '# Ideas',
    '',
    '- Recipe gallery #idea',
    '- Plugin store #idea',
    '- Dark mode #idea',
    '- Groceries'
  ].join('\n'),
  'inbox/Project.md': '---\ntags: [idea]\n---\nOnly frontmatter.'
}

// #837: with a #tag in the query, each note lists its tagged blocks.
describe('SearchPalette: tagged blocks under a #tag query', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let moveToTrash: ReturnType<typeof vi.fn>
  let openNoteAtOffset: ReturnType<typeof vi.fn>
  let openTagViewFor: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    focusEditorNormalMode.mockClear()
    focusEditorAfterPick.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    moveToTrash = vi.fn()
    openNoteAtOffset = vi.fn(async () => {})
    openTagViewFor = vi.fn(async () => {})
    ;(window as unknown as { zen: unknown }).zen = {
      moveToTrash,
      readNote: vi.fn(async (path: string) => ({ path, body: BODIES[path] ?? '' }))
    }
    useStore.setState({
      notes: [note('Ideas', ['idea'], 2), note('Project', ['idea'], 1), note('Other', [], 0)],
      selectedPath: null,
      activeNote: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      searchTaggedBlocks: true,
      openNoteAtOffset,
      openTagViewFor
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    delete (window as unknown as { zen?: unknown }).zen
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const input = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const type = (text: string): void => {
    act(() => {
      setValue.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  /** Rows as text: a note's title, an indented block's line, or "+N more". */
  const rows = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-search-idx]')].map((row) => {
      if (row.dataset.searchBlock) return `  ${row.dataset.searchBlock}`
      if (row.dataset.searchMore) return `  ${row.textContent?.replace('open in Tags', '').trim()}`
      if (row.dataset.searchCreate !== undefined) return 'create'
      return row.querySelector('span')?.textContent?.trim() ?? ''
    })
  /** Wait for the tagged blocks' reads to land (they are notified on a timer). */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })
  }

  it('lists two blocks under a note, then a row for the rest; a frontmatter-only note is plain', async () => {
    act(() => root.render(createElement(SearchPalette)))
    type('#idea')
    await settle()
    expect(rows()).toEqual([
      'Ideas',
      '  inbox/Ideas.md:3',
      '  inbox/Ideas.md:4',
      '  +1 more tagged block',
      'Project'
    ])
  })

  it('opens a block at its line, highlighted, and closes the palette', async () => {
    act(() => root.render(createElement(SearchPalette)))
    type('#idea')
    await settle()
    await key('ArrowDown')
    await key('Enter')
    await settle()
    expect(useStore.getState().searchOpen).toBe(false)
    expect(openNoteAtOffset).toHaveBeenCalledWith(
      'inbox/Ideas.md',
      BODIES['inbox/Ideas.md']!.indexOf('Recipe gallery'),
      { scrollMode: 'center', highlightLine: true }
    )
    // A block is a pick like a note: read on a phone, edited on desktop.
    expect(focusEditorAfterPick).toHaveBeenCalledTimes(1)
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })

  it('opens the Tags view on the query tags from the "+N more" row', async () => {
    act(() => root.render(createElement(SearchPalette)))
    type('#idea')
    await settle()
    for (let i = 0; i < 3; i++) await key('j', { ctrlKey: true })
    await key('Enter')
    expect(openTagViewFor).toHaveBeenCalledWith(['idea'], '')
  })

  it('leaves Ctrl+D inert on a block row', async () => {
    act(() => root.render(createElement(SearchPalette)))
    type('#idea')
    await settle()
    await key('ArrowDown')
    await key('d', { ctrlKey: true })
    expect(confirmApp).not.toHaveBeenCalled()
    expect(moveToTrash).not.toHaveBeenCalled()
  })

  it('narrows the blocks to the free text and marks the match', async () => {
    act(() => root.render(createElement(SearchPalette)))
    type('#idea plugin')
    await settle()
    expect(rows().filter((r) => r.startsWith('  '))).toEqual(['  inbox/Ideas.md:4'])
    expect(document.querySelector('[data-block-match]')?.textContent).toBe('Plugin')
  })

  it('lists plain note rows when the setting is off', async () => {
    useStore.setState({ searchTaggedBlocks: false })
    act(() => root.render(createElement(SearchPalette)))
    type('#idea')
    await settle()
    expect(rows()).toEqual(['Ideas', 'Project'])
  })
})
