// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type {
  CloudSyncConflict,
  CloudSyncRunSummary
} from '@zennotes/bridge-contract/cloud-sync'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCloudSyncStatus, useCloudSyncStatusStore } from './cloud-auto-sync'
import { livePreviewPlugin } from './cm-live-preview'
import { markdownLinkExtension } from './cm-markdown-links'
import { registerNoteEditor } from './note-editor-context'

const store = vi.hoisted(() => ({
  state: {
    activeNote: null as { path: string } | null,
    assetFiles: [] as Array<{ path: string }>,
    assetFilesListed: false,
    excalidrawPreviewVersion: 0,
    noteRefs: {},
    notes: [],
    openNoteInTab: (() => Promise.resolve()) as (path: string) => Promise<void>,
    pdfEmbedInEditMode: 'compact',
    pinnedRefKind: 'note',
    pinnedRefPath: null,
    vault: null as { root: string } | null
  }
}))

vi.mock('../store', () => ({
  useStore: Object.assign(() => null, {
    getState: () => store.state,
    subscribe: () => () => {}
  })
}))

const NOTE = 'inbox/Media Note.md'
const NOTICE = 'Not synced to Cloud: larger than the 10 MB file-size limit, so it stays on this device.'

function tooLarge(path: string, limit = 10_000_000): CloudSyncConflict {
  return {
    operation_id: `op-${path}`,
    item_id: `item-${path}`,
    code: 'FILE_SIZE_LIMIT_EXCEEDED',
    current_revision: null,
    current_path: null,
    path,
    capacity: {
      dimension: 'sync_max_file_bytes',
      used: 0,
      reserved: 0,
      limit,
      projected: limit * 2,
      can_retry_after_reduction: true
    }
  }
}

function run(...conflicts: CloudSyncConflict[]): CloudSyncRunSummary {
  return { cursor: 1, pulled: 0, pushed: 0, bootstrap_conflicts: [], local_conflicts: [], conflicts }
}

const views: EditorView[] = []

function mountEditor(doc: string, anchor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), markdownLinkExtension, livePreviewPlugin]
    })
  })
  views.push(view)
  return view
}

/** The rendered line whose text includes `text`, or the line holding `el`. */
function lineOf(el: Element): HTMLElement {
  const line = el.closest<HTMLElement>('.cm-line')
  if (!line) throw new Error('not inside a line')
  return line
}

function notices(view: EditorView): string[] {
  return [...view.dom.querySelectorAll('[data-cloud-sync-notice]')].map((el) => el.textContent ?? '')
}

/** A drawn picture. CodeMirror's own `img.cm-widgetBuffer` cursor helpers sit
 *  beside every widget and are not one. */
const PICTURE = 'img:not(.cm-widgetBuffer)'

/** Each embed drawn as "not on this device": its kind, its href, its line. */
function missing(view: EditorView): Array<[string, string, string]> {
  return [...view.dom.querySelectorAll<HTMLElement>('[data-local-asset-missing]')].map((card) => [
    card.dataset.localAssetMissing ?? '',
    card.dataset.localAssetHref ?? '',
    card.querySelector('[role="note"]')?.textContent ?? ''
  ])
}

beforeEach(() => {
  ;(window as unknown as { zen: unknown }).zen = {
    resolveVaultAssetUrl: (_root: string, rel: string) => `zen-asset://vault/${rel}`,
    resolveLocalAssetUrl: (_root: string, _note: string, href: string) => `zen-asset://note/${href}`
  }
  store.state.vault = { root: '/vault' }
  store.state.activeNote = { path: NOTE }
  store.state.assetFiles = [
    { path: 'assets/clip.mp4' },
    { path: 'assets/song.mp3' },
    { path: 'assets/pic.png' },
    { path: 'assets/doc.pdf' },
    { path: 'assets/archive.zip' }
  ]
  // The app has read the vault's files, as it has by the time a note is open.
  store.state.assetFilesListed = true
  clearCloudSyncStatus()
})

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove()
    view.destroy()
  }
  clearCloudSyncStatus()
  delete (window as unknown as { zen?: unknown }).zen
})

describe('live preview: audio and video embeds', () => {
  it('reads a standalone embed with an escaped pipe the way it reads a plain one', () => {
    const view = mountEditor('Above\n\n![[assets/clip.mp4\\|Clip]]\n\nBelow', 0)
    const figure = view.dom.querySelector<HTMLElement>('figure.cm-local-media-embed')
    expect(figure?.dataset.localAssetHref).toBe('assets/clip.mp4')
  })

  it("draws the reading view's player for a standalone ![[clip.mp4]] and hides its source off the cursor line", () => {
    const doc = 'Above\n\n![[assets/clip.mp4]]\n\nBelow'
    const view = mountEditor(doc, 0)

    const figure = view.dom.querySelector<HTMLElement>('figure.cm-local-media-embed')
    expect(figure).not.toBeNull()
    expect(figure!.classList.contains('local-asset-embed')).toBe(true)
    expect(figure!.dataset.localAssetKind).toBe('video')
    expect(figure!.dataset.localAssetHref).toBe('assets/clip.mp4')
    expect(figure!.querySelector('.local-asset-embed-title')?.textContent).toBe('clip.mp4')
    const video = figure!.querySelector('video')!
    expect(video.getAttribute('src')).toBe('zen-asset://vault/assets/clip.mp4')
    expect(video.controls).toBe(true)
    expect(video.preload).toBe('metadata')

    expect(view.dom.textContent).not.toContain('![[assets/clip.mp4]]')
    expect(lineOf(figure!).classList.contains('cm-image-embed-line')).toBe(true)
  })

  it('reveals the source on the cursor line, as images do, and keeps the same player', () => {
    const doc = 'Above\n\n![[assets/clip.mp4]]\n\nBelow'
    const view = mountEditor(doc, 0)
    const video = view.dom.querySelector('video')!

    view.dispatch({ selection: { anchor: doc.indexOf('![[') + 3 } })
    expect(view.dom.textContent).toContain('![[assets/clip.mp4]]')
    expect(view.dom.querySelector('video')).toBe(video)
    expect(lineOf(video).classList.contains('cm-image-embed-line')).toBe(false)

    view.dispatch({ selection: { anchor: doc.length } })
    expect(view.dom.textContent).not.toContain('![[assets/clip.mp4]]')
    expect(view.dom.querySelector('video')).toBe(video)
  })

  it('keeps the player through edits elsewhere in the note, so playback is not restarted', () => {
    const doc = 'Above\n\n![[assets/clip.mp4]]\n\nBelow'
    const view = mountEditor(doc, 0)
    const video = view.dom.querySelector('video')!

    view.dispatch({ changes: { from: 0, insert: 'Typed ' }, selection: { anchor: 6 } })
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } })
    view.dispatch({ changes: { from: 0, insert: 'New first line\n' } })

    expect(view.dom.querySelectorAll('video')).toHaveLength(1)
    expect(view.dom.querySelector('video')).toBe(video)
  })

  it('draws an audio player for ![[song.mp3]], and plays the Markdown spelling ![](clip.mp4) instead of chipping it', () => {
    const doc = 'Top\n\n![[assets/song.mp3]]\n\n![](assets/clip.mp4)\n\nEnd'
    const view = mountEditor(doc, 0)

    const audio = view.dom.querySelector('audio')
    expect(audio?.getAttribute('src')).toBe('zen-asset://vault/assets/song.mp3')
    expect(audio?.closest('figure')?.dataset.localAssetKind).toBe('audio')
    expect(view.dom.querySelector('video')?.getAttribute('src')).toBe('zen-asset://vault/assets/clip.mp4')
    expect(view.dom.querySelector('.local-file-attachment')).toBeNull()
  })

  it('leaves the line as source until the asset list arrives', () => {
    store.state.assetFiles = []
    store.state.assetFilesListed = false
    const doc = 'Top\n\n![[assets/clip.mp4]]\n\n![[assets/gone.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)
    expect(view.dom.querySelector('video')).toBeNull()
    expect(missing(view)).toEqual([])
    expect(view.dom.textContent).toContain('![[assets/clip.mp4]]')
    expect(view.dom.textContent).toContain('![[assets/gone.mp4]]')
  })

  it('puts the caret on the embed line from its </> action', () => {
    const doc = 'Above\n\n![[assets/clip.mp4]]\n\nBelow'
    const view = mountEditor(doc, 0)
    const edit = view.dom.querySelector<HTMLButtonElement>('.cm-local-media-embed .local-asset-embed-edit')
    expect(edit?.textContent).toBe('</>')

    edit!.click()

    expect(view.state.selection.main.head).toBe(doc.indexOf('![['))
    expect(view.dom.textContent).toContain('![[assets/clip.mp4]]')
  })
})

describe('live preview: an embed whose file is not on this device', () => {
  // A file over Cloud's per-file limit never leaves the device that has it.
  // Every other device gets the note and its embed, and no file to play.
  it('says so where the player would be, instead of drawing a player with nothing to play', () => {
    const doc = 'Top\n\n![[assets/gone.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)

    expect(view.dom.querySelector('video')).toBeNull()
    expect(missing(view)).toEqual([['video', 'assets/gone.mp4', "gone.mp4 isn't on this device."]])
    const card = view.dom.querySelector<HTMLElement>('[data-local-asset-missing]')!
    expect(card.querySelector('[role="note"]')?.classList.contains('text-warning')).toBe(true)
    // Laid out as the player was: the source hides off the cursor line.
    expect(view.dom.textContent).not.toContain('![[assets/gone.mp4]]')
    expect(lineOf(card).classList.contains('cm-image-embed-line')).toBe(true)
  })

  it('says so for audio, pictures and PDFs, in each spelling those embeds take', () => {
    const doc = [
      'Top',
      '',
      '![[assets/gone.mp3]]',
      '',
      '![](assets/gone%20clip.mp4)',
      '',
      '![[assets/gone.png]]',
      '',
      '![A chart](assets/chart.png)',
      '',
      '![[assets/gone.pdf]]',
      '',
      '[The spec](assets/spec.pdf)',
      '',
      '![](assets/scan.pdf)',
      '',
      'End'
    ].join('\n')
    const view = mountEditor(doc, 0)

    expect(view.dom.querySelector(`audio, video, ${PICTURE}, iframe, .local-file-attachment`)).toBeNull()
    expect(view.dom.querySelector('.local-asset-pinned-ref')).toBeNull()
    expect(missing(view)).toEqual([
      ['audio', 'assets/gone.mp3', "gone.mp3 isn't on this device."],
      ['video', 'assets/gone%20clip.mp4', "gone clip.mp4 isn't on this device."],
      ['image', 'assets/gone.png', "gone.png isn't on this device."],
      ['image', 'assets/chart.png', "chart.png isn't on this device."],
      ['pdf', 'assets/gone.pdf', "gone.pdf isn't on this device."],
      ['pdf', 'assets/spec.pdf', "spec.pdf isn't on this device."],
      ['pdf', 'assets/scan.pdf', "scan.pdf isn't on this device."]
    ])
  })

  it('keeps the chip of any other attachment: the vault listing leaves out files a chip can still name', () => {
    const doc = 'Top\n\n![[assets/gone.zip]]\n\nEnd'
    const view = mountEditor(doc, 0)
    expect(missing(view)).toEqual([])
    expect(view.dom.querySelector('.local-file-attachment')?.textContent).toContain('gone.zip')
  })

  it('says so in a vault whose listing holds no files at all', () => {
    store.state.assetFiles = []
    const doc = 'Top\n\n![[assets/gone.mp4]]\n\n![[assets/gone.png]]\n\nEnd'
    const view = mountEditor(doc, 0)
    expect(view.dom.querySelector(`video, ${PICTURE}`)).toBeNull()
    expect(missing(view).map(([kind, href]) => [kind, href])).toEqual([
      ['video', 'assets/gone.mp4'],
      ['image', 'assets/gone.png']
    ])
  })

  it('trusts only a listing read from the vault: a list seeded by hand keeps the player', () => {
    // The share viewer and PDF export hand the store a list of their own and
    // serve the files the list leaves out from the guessed URL.
    store.state.assetFilesListed = false
    const doc = 'Top\n\n![[assets/gone.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)
    expect(missing(view)).toEqual([])
    expect(view.dom.querySelector('video')?.getAttribute('src')).toBe('zen-asset://note/assets/gone.mp4')
  })

  it('shows the source above the notice on the cursor line, and the player once the file arrives', () => {
    const doc = 'Top\n\n![[assets/gone.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)

    view.dispatch({ selection: { anchor: doc.indexOf('![[') + 3 } })
    expect(view.dom.textContent).toContain('![[assets/gone.mp4]]')
    expect(missing(view)).toHaveLength(1)
    expect(lineOf(view.dom.querySelector('[data-local-asset-missing]')!).classList.contains('cm-image-embed-line')).toBe(false)

    store.state.assetFiles = [...store.state.assetFiles, { path: 'assets/gone.mp4' }]
    view.dispatch({ selection: { anchor: doc.length } })

    expect(missing(view)).toEqual([])
    expect(view.dom.querySelector('video')?.getAttribute('src')).toBe('zen-asset://vault/assets/gone.mp4')
  })

  it("puts the caret on the embed line from the notice's </> action", () => {
    const doc = 'Above\n\n![[assets/gone.mp4]]\n\nBelow'
    const view = mountEditor(doc, 0)
    const edit = view.dom.querySelector<HTMLButtonElement>('[data-local-asset-missing] .local-asset-embed-edit')
    expect(edit?.textContent).toBe('</>')

    edit!.click()

    expect(view.state.selection.main.head).toBe(doc.indexOf('![['))
    expect(view.dom.textContent).toContain('![[assets/gone.mp4]]')
  })
})

describe('live preview: the too-large-for-Cloud notice', () => {
  it('says so under the oversized video and under nothing else', () => {
    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('assets/clip.mp4')) })
    const doc = 'Top\n\n![[assets/clip.mp4]]\n\n![[assets/song.mp3]]\n\nEnd'
    const view = mountEditor(doc, 0)

    expect(notices(view)).toEqual([NOTICE])
    const notice = view.dom.querySelector('[data-cloud-sync-notice]')!
    expect(notice.closest('figure')?.dataset.localAssetHref).toBe('assets/clip.mp4')
    expect(notice.previousElementSibling?.tagName).toBe('VIDEO')
    expect(notice.classList.contains('text-warning')).toBe(true)
  })

  it('is on image, PDF and attachment-chip embeds too', () => {
    useCloudSyncStatusStore.setState({
      lastSummary: run(
        tooLarge('assets/pic.png'),
        tooLarge('assets/doc.pdf'),
        tooLarge('assets/archive.zip'),
        tooLarge('assets/song.mp3')
      )
    })
    const doc = [
      'Top',
      '',
      '![[assets/pic.png]]',
      '',
      '![[assets/doc.pdf]]',
      '',
      '![](assets/archive.zip)',
      '',
      '![[assets/song.mp3]]',
      '',
      'End'
    ].join('\n')
    const view = mountEditor(doc, 0)

    const hosts = [...view.dom.querySelectorAll('[data-cloud-sync-notice]')].map(
      (el) => (el.parentElement as HTMLElement).dataset.localAssetKind ?? el.parentElement?.className
    )
    expect(hosts).toEqual([
      expect.stringContaining('local-image-embed'),
      'pdf',
      'file',
      'audio'
    ])
    expect(new Set(notices(view))).toEqual(new Set([NOTICE]))
  })

  it("matches the way sync compares paths, against the pane's own note", () => {
    // Two files share a name; only the one beside the pane's note is too large.
    store.state.assetFiles = [{ path: 'projects/media/clip.mp4' }, { path: 'inbox/media/clip.mp4' }]
    store.state.activeNote = { path: 'inbox/Other.md' }
    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('Projects/Media/CLIP.mp4')) })
    const doc = 'Top\n\n![[media/clip.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)
    registerNoteEditor(view, () => 'projects/Clip Note.md', 'pane-a')
    view.dispatch({ selection: { anchor: doc.length } })

    expect(view.dom.querySelector('video')?.getAttribute('src')).toBe(
      'zen-asset://vault/projects/media/clip.mp4'
    )
    expect(notices(view)).toEqual([NOTICE])
  })

  it('follows each run in place: it goes when the summary clears and names a new limit, and the player stays', () => {
    const doc = 'Top\n\n![[assets/clip.mp4]]\n\nEnd'
    const view = mountEditor(doc, 0)
    const video = view.dom.querySelector('video')!
    expect(notices(view)).toEqual([])

    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('assets/clip.mp4')) })
    expect(notices(view)).toEqual([NOTICE])
    expect(view.dom.querySelector('video')).toBe(video)

    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('assets/clip.mp4', 50_000_000)) })
    expect(notices(view)).toEqual([
      'Not synced to Cloud: larger than the 50 MB file-size limit, so it stays on this device.'
    ])
    expect(view.dom.querySelector('video')).toBe(video)

    useCloudSyncStatusStore.setState({ lastSummary: null })
    expect(notices(view)).toEqual([])
    expect(view.dom.querySelector('video')).toBe(video)
  })

  it('costs nothing while no file is over the limit', () => {
    const doc = 'Top\n\n![[assets/clip.mp4]]\n\n![[assets/pic.png]]\n\nEnd'
    const view = mountEditor(doc, 0)
    const dispatch = vi.spyOn(view, 'dispatch')

    useCloudSyncStatusStore.setState({ lastSummary: run() })
    useCloudSyncStatusStore.setState({
      lastSummary: run({
        operation_id: 'op-rev',
        item_id: 'rev',
        code: 'REVISION_CONFLICT',
        current_revision: 2,
        current_path: null,
        path: 'assets/clip.mp4'
      })
    })
    useCloudSyncStatusStore.setState({ phase: 'syncing' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(notices(view)).toEqual([])

    // A later run that leaves the same file at the same limit redraws nothing either.
    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('assets/clip.mp4')) })
    expect(dispatch).toHaveBeenCalledTimes(1)
    useCloudSyncStatusStore.setState({ lastSummary: run(tooLarge('assets/clip.mp4')) })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
