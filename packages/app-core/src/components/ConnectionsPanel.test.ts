// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { ConnectionsPanel } from './ConnectionsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))
const promptApp = vi.hoisted(() => vi.fn())
vi.mock('../lib/prompt-requests', () => ({ promptApp }))

function meta(title: string): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

const bodies: Record<string, string> = {
  'inbox/Alpha.md': '# Alpha\n\nSee [[Beta]], and [[Gamma]] which does not exist yet.\n',
  'inbox/Beta.md': '# Beta\n\nBack to [[Alpha]].\n'
}

describe('ConnectionsPanel: following a connection hands the keyboard to the editor (#863)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let selectNote: ReturnType<typeof vi.fn>
  let createAndOpen: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    focusEditorNormalMode.mockClear()
    promptApp.mockReset()
    selectNote = vi.fn(async () => {})
    createAndOpen = vi.fn(async () => {})
    ;(window as unknown as { zen: unknown }).zen = {
      readNote: vi.fn(async (path: string) => ({
        ...meta(path.replace(/^inbox\/|\.md$/g, '')),
        body: bodies[path] ?? ''
      }))
    }
    useStore.setState({ notes: [meta('Alpha'), meta('Beta')], assetFiles: [], selectNote, createAndOpen })
    const note: NoteContent = { ...meta('Alpha'), body: bodies['inbox/Alpha.md'] }
    await act(async () => root.render(createElement(ConnectionsPanel, { note })))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const rowsFor = (path: string): HTMLButtonElement[] => [
    ...host.querySelectorAll<HTMLButtonElement>(`[data-connections-type="note"][data-connections-path="${path}"]`)
  ]

  it('from a link out of the note', async () => {
    await act(async () => rowsFor('inbox/Beta.md')[0]!.click())
    expect(selectNote).toHaveBeenCalledWith('inbox/Beta.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('from a backlink', async () => {
    // Beta shows twice: linked from Alpha, and linking back to it.
    const rows = rowsFor('inbox/Beta.md')
    expect(rows).toHaveLength(2)
    await act(async () => rows[1]!.click())
    expect(selectNote).toHaveBeenCalledWith('inbox/Beta.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('only once the note has opened', async () => {
    let opened: () => void = () => {}
    selectNote.mockImplementation(() => new Promise<void>((resolve) => (opened = resolve)))
    await act(async () => rowsFor('inbox/Beta.md')[0]!.click())
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
    await act(async () => opened())
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('after creating the note a missing link names', async () => {
    promptApp.mockResolvedValue('inbox/Gamma.md')
    const missing = host.querySelector<HTMLButtonElement>('[data-connections-type="missing"]')
    expect(missing).not.toBeNull()
    await act(async () => missing!.click())
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Gamma' })
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })
})
