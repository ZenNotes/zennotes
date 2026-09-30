// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { HomeView } from './HomeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string, updatedAt: number): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

describe('HomeView: opening a note hands the keyboard to the editor (#863)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let selectNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    focusEditorNormalMode.mockClear()
    selectNote = vi.fn(async () => {})
    useStore.setState({
      notes: [note('Support', 2), note('Plans', 1)],
      folders: [],
      vaultTasks: [],
      tasksLoading: true,
      refreshTasks: vi.fn(async () => {}),
      selectNote,
      vaultSettings: { ...originalState.vaultSettings, favorites: ['inbox/Plans.md'] }
    })
    act(() => root.render(createElement(HomeView, { sidebarOpen: true, onShowSidebar: () => {} })))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const click = async (selector: string): Promise<void> => {
    const row = host.querySelector<HTMLButtonElement>(selector)
    expect(row).not.toBeNull()
    await act(async () => {
      row!.click()
    })
  }

  it('from a recent note', async () => {
    await click('[data-home-section="recent"] [data-home-note-path="inbox/Support.md"]')
    expect(selectNote).toHaveBeenCalledWith('inbox/Support.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('from a favorite note', async () => {
    await click('[data-home-favorite="note"][data-home-note-path="inbox/Plans.md"]')
    expect(selectNote).toHaveBeenCalledWith('inbox/Plans.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('names a new note first: New note focuses its title field, like every other New note button', async () => {
    const createAndOpen = vi.fn(async () => {})
    act(() => useStore.setState({ createAndOpen }))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New note')
    expect(button).toBeDefined()
    await act(async () => {
      button!.click()
    })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { focusTitle: true })
  })

  it('only once the note has opened', async () => {
    let opened: () => void = () => {}
    selectNote.mockImplementation(() => new Promise<void>((resolve) => (opened = resolve)))
    await click('[data-home-section="recent"] [data-home-note-path="inbox/Support.md"]')
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
    await act(async () => opened())
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })
})
