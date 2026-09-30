// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetMeta, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { AssetsView } from './AssetsView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string, assetEmbeds: string[]): NoteMeta {
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
    assetEmbeds,
    excerpt: ''
  }
}

function asset(name: string): AssetMeta {
  return { path: `assets/${name}`, name, kind: 'image', siblingOrder: 0, size: 1, updatedAt: 0 }
}

describe('AssetsView: a note opened through the asset it uses takes the keyboard (#863)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let openNoteInTab: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    focusEditorNormalMode.mockClear()
    openNoteInTab = vi.fn(async () => {})
    useStore.setState({
      vault: { ...(originalState.vault ?? {}), root: '/vault', name: 'Vault' } as NonNullable<typeof originalState.vault>,
      assetFiles: [asset('solo.png'), asset('shared.png')],
      notes: [note('Alpha', ['solo.png', 'shared.png']), note('Beta', ['shared.png'])],
      openNoteInTab
    })
    act(() => root.render(createElement(AssetsView)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(originalState, true)
  })

  const usedButton = (assetPath: string): HTMLButtonElement => {
    const row = host.querySelector(`[title="${assetPath}"]`)
    const button = row && [...row.querySelectorAll('button')].find((b) => !b.disabled)
    expect(button).toBeTruthy()
    return button as HTMLButtonElement
  }

  it('from the Used count, when one note uses the asset', async () => {
    await act(async () => usedButton('assets/solo.png').click())
    expect(openNoteInTab).toHaveBeenCalledWith('inbox/Alpha.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('from the menu of notes, when several use it', async () => {
    await act(async () => usedButton('assets/shared.png').click())
    const item = [...document.querySelectorAll<HTMLElement>('[data-ctx-menu] button, [data-ctx-menu] [role="menuitem"]')].find(
      (el) => el.textContent?.includes('Beta')
    )
    expect(item).toBeTruthy()
    await act(async () => item!.click())
    expect(openNoteInTab).toHaveBeenCalledWith('inbox/Beta.md')
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('but opening the asset itself leaves the keyboard alone', async () => {
    const row = host.querySelector<HTMLElement>('[title="assets/solo.png"]')
    await act(async () => row!.click())
    expect(openNoteInTab).toHaveBeenCalledWith(expect.stringContaining('solo.png'))
    expect(focusEditorNormalMode).not.toHaveBeenCalled()
  })
})
