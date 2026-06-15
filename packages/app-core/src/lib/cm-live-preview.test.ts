// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'

const storeState = vi.hoisted(() => ({
  activeNote: null as { path: string } | null,
  assetFiles: [] as Array<{
    id?: string
    path: string
    name: string
    kind: 'image' | 'pdf' | 'audio' | 'video' | 'file'
    sourcePath?: string
    previewPath?: string
    siblingOrder: number
    size: number
    updatedAt: number
  }>,
  editorViewRef: null as EditorView | null,
  noteRefs: {} as Record<string, { kind: string; path: string }>,
  openNoteInTab: vi.fn(),
  pdfEmbedInEditMode: 'compact',
  pinAssetReferenceForNote: vi.fn(),
  pinnedRefKind: 'note',
  pinnedRefPath: null as string | null,
  pinnedRefVisible: false,
  togglePinnedRefVisible: vi.fn(),
  vault: null as { root: string } | null
}))

vi.mock('../store', () => {
  const useStore = Object.assign(() => null, {
    getState: () => storeState,
    subscribe: () => () => {}
  })
  return { useStore }
})

function mountEditor(
  doc: string,
  anchor: number,
  options: { focus?: boolean } = {}
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), livePreviewPlugin]
    })
  })
  if (options.focus !== false) {
    view.focus()
    const nudge = anchor < doc.length ? anchor + 1 : Math.max(0, anchor - 1)
    if (nudge !== anchor) {
      view.dispatch({ selection: { anchor: nudge } })
      view.dispatch({ selection: { anchor } })
    }
  }
  return view
}

function configureVideoAsset(): void {
  storeState.vault = { root: '/vault' }
  storeState.activeNote = { path: 'quick/Note.md' }
  storeState.assetFiles = [
    {
      id: '1948417e-30d2-4175-8cd4-6cfcf4ee90fb',
      path: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset',
      name: 'Clip (480p30).mp4',
      kind: 'video',
      sourcePath: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4',
      previewPath: 'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/previews/320.png',
      siblingOrder: 0,
      size: 123,
      updatedAt: 456
    }
  ]
  ;(window as unknown as {
    zen: { resolveVaultAssetUrl: (root: string, rel: string) => string }
  }).zen = {
    resolveVaultAssetUrl: (_root, rel) => `zen-asset://local/${rel}`
  }
}

function configurePdfAsset(): void {
  storeState.vault = { root: '/vault' }
  storeState.activeNote = { path: 'quick/Note.md' }
  storeState.assetFiles = [
    {
      id: '26325d22-a8d7-49ab-8968-4df0c0f0b871',
      path: 'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset',
      name: '示例文档.pdf',
      kind: 'pdf',
      sourcePath: 'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset/source.pdf',
      previewPath: 'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset/previews/320.png',
      siblingOrder: 0,
      size: 123,
      updatedAt: 456
    }
  ]
  ;(window as unknown as {
    zen: { resolveVaultAssetUrl: (root: string, rel: string) => string }
  }).zen = {
    resolveVaultAssetUrl: (_root, rel) => `zen-asset://local/${rel}`
  }
}

describe('livePreviewPlugin', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    storeState.activeNote = null
    storeState.assetFiles = []
    storeState.editorViewRef = null
    storeState.noteRefs = {}
    storeState.openNoteInTab.mockClear()
    storeState.pdfEmbedInEditMode = 'compact'
    storeState.pinAssetReferenceForNote.mockClear()
    storeState.pinnedRefKind = 'note'
    storeState.pinnedRefPath = null
    storeState.pinnedRefVisible = false
    storeState.togglePinnedRefVisible.mockClear()
    storeState.vault = null
    ;(window as unknown as { zen?: unknown }).zen = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reveals link markdown only when the selection is inside the link', () => {
    const doc = 'Paragraph start with a [visible link](https://example.com) and trailing text.'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('visible link')
    expect(view.dom.textContent).not.toContain('https://example.com')

    view.dispatch({
      selection: { anchor: doc.indexOf('visible link') + 2 }
    })

    expect(view.dom.textContent).toContain('[visible link](https://example.com)')

    view.destroy()
  })

  it('reveals heading markers when the cursor is anywhere on the heading line', () => {
    // Obsidian-style: the active line shows its raw source, so the leading
    // `# ` reappears even when the caret is on the heading text (not the mark).
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('Code'))

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('reveals heading markers when the selection is on the marker', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('hides heading markers when the editor is not focused', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0, { focus: false })

    expect(view.dom.textContent).not.toContain('# Code blocks')
    expect(view.dom.textContent).toContain('Code blocks')

    view.destroy()
  })

  it('replaces an unchecked task marker with a checkbox widget', () => {
    const doc = '- [ ] Buy milk'
    // Cursor at end of line, off the marker.
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.checked).toBe(false)
    // The raw `[ ]` is replaced by the widget, so it's no longer in the
    // rendered text. The task body remains.
    expect(view.dom.textContent).not.toContain('[ ]')
    expect(view.dom.textContent).toContain('Buy milk')

    view.destroy()
  })

  it('replaces a checked task marker with a checked checkbox', () => {
    const doc = '- [x] Done\n- [X] Also done'
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.checked).toBe(true)
    expect(inputs[1]?.checked).toBe(true)
    expect(view.dom.textContent).not.toContain('[x]')
    expect(view.dom.textContent).not.toContain('[X]')

    view.destroy()
  })

  it('reveals the raw marker when the cursor lands inside it', () => {
    const doc = '- [ ] Edit me'
    // Position 3 sits between `[` and `]` — i.e. on the state character.
    const view = mountEditor(doc, 3)

    expect(view.dom.querySelectorAll('input.cm-task-checkbox-input')).toHaveLength(0)
    expect(view.dom.textContent).toContain('[ ]')

    view.destroy()
  })

  it('toggles the underlying marker when the checkbox is clicked', () => {
    const doc = '- [ ] Buy milk'
    const view = mountEditor(doc, doc.length)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('- [x] Buy milk')

    view.destroy()
  })

  it('toggles back to unchecked from a `[x]` marker', () => {
    const doc = '- [x] Already done'
    const view = mountEditor(doc, doc.length)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('- [ ] Already done')

    view.destroy()
  })

  it('renders checkboxes for ordered, nested, and quoted tasks', () => {
    // Task variants the TASK_LINE_RE in shared/tasklists supports.
    const doc = ['1. [ ] Ordered', '   - [x] Nested', '> - [ ] Quoted'].join('\n')
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(3)
    expect(inputs[0]?.checked).toBe(false)
    expect(inputs[1]?.checked).toBe(true)
    expect(inputs[2]?.checked).toBe(false)

    view.destroy()
  })

  it('renders an asset-id video embed as a video widget', () => {
    configureVideoAsset()
    const doc = '![[asset:1948417e-30d2-4175-8cd4-6cfcf4ee90fb|Clip (480p30).mp4]]'
    const view = mountEditor(doc, doc.length)

    const video = view.dom.querySelector<HTMLVideoElement>('video.local-video-embed-video')
    expect(video).toBeTruthy()
    expect(video?.src).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4'
    )
    expect(video?.poster).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/previews/320.png'
    )
    expect(view.dom.querySelector<HTMLElement>('[data-local-asset-kind="video"]')).toBeTruthy()
    expect(view.dom.querySelector('.local-pdf-embed-header')).toBeNull()
    expect(view.dom.querySelector('.local-video-embed-caption')?.textContent).toBe(
      'Clip (480p30).mp4'
    )
    Object.defineProperty(video, 'videoWidth', { value: 1080, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 2340, configurable: true })
    video?.dispatchEvent(new Event('loadedmetadata'))
    expect(view.dom.querySelector('.local-video-embed')?.classList.contains('is-portrait')).toBe(
      true
    )

    view.destroy()
  })

  it('renders a direct source-path video embed as the same video widget', () => {
    configureVideoAsset()
    const doc = '![[assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4]]'
    const view = mountEditor(doc, doc.length)

    const video = view.dom.querySelector<HTMLVideoElement>('video.local-video-embed-video')
    expect(video).toBeTruthy()
    expect(video?.src).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4'
    )
    expect(view.dom.querySelector<HTMLElement>('[data-local-asset-kind="video"]')).toBeTruthy()
    expect(view.dom.querySelector('.local-video-embed-caption')?.textContent).toBe(
      'Clip (480p30).mp4'
    )

    view.destroy()
  })

  it('renders a direct display-name video embed with the original name as caption', () => {
    configureVideoAsset()
    const doc = '![[Clip (480p30).mp4]]'
    const view = mountEditor(doc, doc.length)

    const video = view.dom.querySelector<HTMLVideoElement>('video.local-video-embed-video')
    expect(video).toBeTruthy()
    expect(video?.src).toContain(
      'assets/1948417e-30d2-4175-8cd4-6cfcf4ee90fb.asset/source.mp4'
    )
    expect(view.dom.querySelector('.local-video-embed-caption')?.textContent).toBe(
      'Clip (480p30).mp4'
    )

    view.destroy()
  })

  it('renders compact PDF embeds as a book-style cover with a caption', () => {
    configurePdfAsset()
    const doc = '![[asset:26325d22-a8d7-49ab-8968-4df0c0f0b871|示例文档.pdf]]\n\nTail'
    const view = mountEditor(doc, doc.length)

    const cover = view.dom.querySelector<HTMLElement>('.local-pdf-book-embed')
    const thumbnail = view.dom.querySelector<HTMLImageElement>('.local-pdf-book-thumbnail')
    expect(cover).toBeTruthy()
    expect(thumbnail?.src).toContain(
      'assets/26325d22-a8d7-49ab-8968-4df0c0f0b871.asset/previews/320.png'
    )
    expect(view.dom.querySelector('.local-asset-pinned-ref-button')).toBeNull()
    expect(cover?.classList.contains('cm-local-pdf-embed')).toBe(false)
    expect(view.dom.querySelector('.local-pdf-book-tag')?.textContent).toBe('PDF')
    expect(view.dom.querySelector('.local-pdf-book-caption')?.textContent).toBe('示例文档.pdf')

    view.destroy()
  })

  it('keeps the PDF widget visible when the PDF embed line is active', () => {
    configurePdfAsset()
    const doc = '![[asset:26325d22-a8d7-49ab-8968-4df0c0f0b871|示例文档.pdf]]'
    const view = mountEditor(doc, doc.indexOf('asset:') + 2)

    expect(view.dom.textContent).toContain('![[asset:')
    expect(view.dom.querySelector('.local-pdf-book-embed')).toBeTruthy()
    expect(view.dom.querySelector('.local-pdf-book-caption')?.textContent).toBe('示例文档.pdf')

    view.destroy()
  })
})
