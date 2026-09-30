// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { ATLAS_TAB_PATH } from '@shared/atlas-view'
import { useStore } from '../store'
import { makeLeaf } from '../lib/pane-layout'
import { AtlasView } from './AtlasView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string): NoteMeta {
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

const press = (key: string, code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
}

// The map is a canvas jsdom cannot draw, so a note is picked the keyboard's
// way (a region jump focuses one, Enter opens it); the second click on a node
// goes through the same opener and is checked in the built app.
describe('AtlasView: opening a note from the map hands the keyboard to the editor (#863)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let selectNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    focusEditorNormalMode.mockClear()
    selectNote = vi.fn(async () => {})
    ;(window as unknown as { zen: unknown }).zen = { readNote: vi.fn(async () => ({ body: '' })) }
    const leaf = makeLeaf([ATLAS_TAB_PATH], ATLAS_TAB_PATH)
    useStore.setState({
      vault: { ...(originalState.vault ?? {}), root: '/vault', name: 'Vault' } as NonNullable<typeof originalState.vault>,
      notes: [note('Alpha')],
      vimMode: true,
      paneLayout: leaf,
      activePaneId: leaf.id,
      selectNote
    })
    act(() => root.render(createElement(AtlasView)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
    vi.restoreAllMocks()
  })

  it('on Enter, once the note has opened', async () => {
    let opened: () => void = () => {}
    selectNote.mockImplementation(() => new Promise<void>((resolve) => (opened = resolve)))
    await act(async () => {
      press(']', 'BracketRight')
      press('Enter', 'Enter')
    })
    expect(selectNote).toHaveBeenCalledWith('inbox/Alpha.md')
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
    await act(async () => opened())
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })
})
