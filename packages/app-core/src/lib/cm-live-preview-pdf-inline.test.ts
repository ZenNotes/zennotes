// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { markdownLinkExtension } from './cm-markdown-links'

// Android's WebView has no PDF viewer: an iframe pointed at a PDF stays
// `about:blank`. Dave (Discord, 2026-10-27) tapped "Open as reference" and
// "Preview" on his phone and got an empty sheet both times. There the editor's
// PDF card opens the file in another app instead.

const store = vi.hoisted(() => ({
  state: {
    activeNote: null as { path: string } | null,
    assetFiles: [] as Array<{ path: string }>,
    assetFilesListed: true,
    excalidrawPreviewVersion: 0,
    noteRefs: {} as Record<string, { path: string; kind: 'note' | 'asset' }>,
    notes: [],
    pdfEmbedInEditMode: 'compact' as 'compact' | 'full',
    pinnedRefKind: 'note',
    pinnedRefPath: null as string | null,
    pinnedRefVisible: true,
    vault: null as { root: string } | null,
    editorViewRef: null as EditorView | null,
    pinAssetReferenceForNote: vi.fn(),
    togglePinnedRefVisible: vi.fn()
  }
}))

vi.mock('../store', () => ({
  useStore: Object.assign(() => null, {
    getState: () => store.state,
    subscribe: () => () => {}
  })
}))

const openElsewhere = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./external-file-link', () => ({ openVaultAssetExternally: openElsewhere }))

const NOTE = 'inbox/The trip.md'
// The embed exactly as Dave wrote it on his Linux desktop, where the vault
// lives at /home/dave/pCloudrive/zennotes.
const DESKTOP_ABSOLUTE = '![[/home/dave/pCloudrive/zennotes/assets/Tourtickets.pdf]]'
const VAULT_RELATIVE = '![[assets/Tourtickets.pdf]]'

const views: EditorView[] = []

function mountEditor(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), markdownLinkExtension, livePreviewPlugin]
    })
  })
  views.push(view)
  store.state.editorViewRef = view
  return view
}

function setPdfViewer(enabled: boolean | undefined): void {
  Object.defineProperty(window.navigator, 'pdfViewerEnabled', {
    configurable: true,
    get: () => enabled
  })
}

beforeEach(() => {
  ;(window as unknown as { zen: unknown }).zen = {
    resolveVaultAssetUrl: (_root: string, rel: string) => `zen-asset://vault/${rel}`,
    resolveLocalAssetUrl: (_root: string, _note: string, href: string) => `zen-asset://note/${href}`
  }
  store.state.vault = { root: '/vault' }
  store.state.activeNote = { path: NOTE }
  store.state.assetFiles = [{ path: 'assets/Tourtickets.pdf' }]
  store.state.pdfEmbedInEditMode = 'compact'
  store.state.noteRefs = {}
  store.state.pinnedRefPath = null
  openElsewhere.mockClear()
  store.state.pinAssetReferenceForNote.mockClear()
})

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove()
    view.destroy()
  }
  delete (window as unknown as { zen?: unknown }).zen
  delete (window.navigator as unknown as { pdfViewerEnabled?: boolean }).pdfViewerEnabled
})

describe('live preview: a PDF where the engine cannot draw one', () => {
  it.each([
    ['the desktop absolute path', DESKTOP_ABSOLUTE],
    ['the vault-relative path', VAULT_RELATIVE]
  ])('draws a card that opens %s in another app, without a frame or Preview', (_label, line) => {
    setPdfViewer(false)
    const view = mountEditor(`Mammoth Cave tickets:\n${line}\n\nNov 4`)

    const card = view.dom.querySelector<HTMLElement>('figure.cm-local-pdf-embed')!
    expect(card.classList.contains('local-asset-pinned-ref')).toBe(true)
    expect(card.querySelector('.local-asset-pinned-ref-text')?.textContent).toBe('Tourtickets.pdf')
    expect(card.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open')
    expect(card.querySelector('.local-asset-pinned-ref-preview')).toBeNull()
    expect(card.querySelector('.local-asset-pinned-ref-edit')).not.toBeNull()
    expect(view.dom.querySelector('iframe')).toBeNull()

    card.querySelector<HTMLButtonElement>('.local-asset-pinned-ref-button')!.click()
    expect(openElsewhere).toHaveBeenCalledWith('assets/Tourtickets.pdf', { confirm: false })
    expect(store.state.pinAssetReferenceForNote).not.toHaveBeenCalled()
  })

  it('keeps the card even when PDFs are set to show in full, since the frame would be empty', () => {
    setPdfViewer(false)
    store.state.pdfEmbedInEditMode = 'full'
    const view = mountEditor(`Above\n${VAULT_RELATIVE}`)

    expect(view.dom.querySelector('iframe')).toBeNull()
    expect(view.dom.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open')
  })

  it('opens a PDF pinned on an older build in another app too, not in the empty pane', () => {
    setPdfViewer(false)
    store.state.noteRefs = { [NOTE]: { path: 'assets/Tourtickets.pdf', kind: 'asset' } }
    const view = mountEditor(`Above\n${DESKTOP_ABSOLUTE}`)

    const card = view.dom.querySelector<HTMLElement>('figure.cm-local-pdf-embed')!
    expect(card.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open')
    card.querySelector<HTMLButtonElement>('.local-asset-pinned-ref-button')!.click()
    expect(openElsewhere).toHaveBeenCalledWith('assets/Tourtickets.pdf', { confirm: false })
    expect(store.state.togglePinnedRefVisible).not.toHaveBeenCalled()
  })
})

describe('live preview: a PDF where the engine draws it (desktop, iPhone)', () => {
  it.each([true, undefined])('keeps Open as reference and Preview (pdfViewerEnabled %s)', (enabled) => {
    setPdfViewer(enabled)
    const view = mountEditor(`Above\n${DESKTOP_ABSOLUTE}`)

    const card = view.dom.querySelector<HTMLElement>('figure.cm-local-pdf-embed')!
    expect(card.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open as reference')
    expect(card.querySelector('.local-asset-pinned-ref-preview')).not.toBeNull()

    card.querySelector<HTMLButtonElement>('.local-asset-pinned-ref-button')!.click()
    expect(store.state.pinAssetReferenceForNote).toHaveBeenCalledWith(NOTE, 'assets/Tourtickets.pdf', null)
    expect(openElsewhere).not.toHaveBeenCalled()
  })

  it('still draws the frame when PDFs are set to show in full', () => {
    setPdfViewer(true)
    store.state.pdfEmbedInEditMode = 'full'
    const view = mountEditor(`Above\n${VAULT_RELATIVE}`)

    expect(view.dom.querySelector('iframe.local-pdf-embed-frame')?.getAttribute('src')).toBe(
      'zen-asset://vault/assets/Tourtickets.pdf'
    )
  })
})
