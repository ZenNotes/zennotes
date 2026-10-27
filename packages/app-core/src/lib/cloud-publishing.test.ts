import { describe, expect, it, vi } from 'vitest'
import type { CloudServiceAccount } from '@zennotes/bridge-contract/cloud-sync'
import {
  collectCloudPublishAssets,
  publishCloudNote,
  type CloudPublishingBridge
} from './cloud-publishing'
import { useStore } from '../store'

const serviceAccount = (publishActive = true): CloudServiceAccount => ({
  user: { name: 'Ada', email: 'ada@example.com' },
  device: {
    id: 'device-1',
    name: 'Ada’s Mac',
    platform: 'desktop',
    app_version: '2.26.0'
  },
  features: {
    sync: { active: true, limits: null },
    backup: { active: true, limits: null },
    publish: { active: publishActive, limits: null }
  }
})

function setup(published = false, publishActive = true) {
  const createPublishedNote = vi.fn(async () => ({
    id: 42,
    slug: 'launch',
    url: 'https://zennotes.org/s/launch'
  }))
  const updateCloudPublishedNote = vi.fn(async () => ({
    id: 42,
    slug: 'launch',
    url: 'https://zennotes.org/s/launch'
  }))
  const bridge: CloudPublishingBridge = {
    getCloudServiceAccount: vi.fn(async () => serviceAccount(publishActive)),
    listCloudPublishedNotes: vi.fn(async () => published
      ? [{
          id: 42,
          slug: 'launch',
          url: 'https://zennotes.org/s/launch',
          title: 'Launch',
          note_path: 'Notes/Launch.md',
          created_at: '2026-08-10T12:00:00.000Z',
          updated_at: '2026-08-10T12:00:00.000Z'
        }]
      : []),
    publishCloudNote: createPublishedNote,
    updateCloudPublishedNote
  }

  return { bridge, createPublishedNote, updateCloudPublishedNote }
}

const note = {
  path: 'Notes/Launch.md',
  title: 'Launch',
  body: '# Launch',
  assetEmbeds: []
}

describe('cloud publishing', () => {
  it('exposes a discovered public copy without claiming the uncertain request committed', async () => {
    const { bridge, createPublishedNote } = setup()
    vi.mocked(bridge.listCloudPublishedNotes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 42, slug: 'launch', url: 'https://zennotes.org/s/launch',
        title: 'Launch', note_path: note.path, created_at: null, updated_at: null
      }])
    createPublishedNote.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
    await expect(publishCloudNote(note, bridge)).rejects.toMatchObject({
      name: 'CloudPublishUnconfirmedError', publicNote: { id: 42 }
    })
    expect(createPublishedNote).toHaveBeenCalledOnce()
  })

  it('does not mistake an existing public copy for a successful update after a timeout', async () => {
    const { bridge, updateCloudPublishedNote } = setup(true)
    updateCloudPublishedNote.mockRejectedValueOnce(new Error('TimeoutError: The operation was aborted due to timeout.'))
    await expect(publishCloudNote(note, bridge)).rejects.toThrow('Check the public note')
    expect(updateCloudPublishedNote).toHaveBeenCalledOnce()
  })

  it('explains an uncertain create without blindly submitting it again', async () => {
    const { bridge, createPublishedNote } = setup()
    createPublishedNote.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(publishCloudNote(note, bridge)).rejects.toThrow('could not be confirmed')
    expect(createPublishedNote).toHaveBeenCalledOnce()
  })

  it('publishes a note for the first time', async () => {
    const { bridge, createPublishedNote } = setup()

    await expect(publishCloudNote(note, bridge)).resolves.toMatchObject({ updated: false })
    expect(createPublishedNote).toHaveBeenCalledWith({
      note_path: note.path,
      title: note.title,
      markdown: note.body
    })
  })

  it('updates the existing public note without changing its link', async () => {
    const { bridge, updateCloudPublishedNote } = setup(true)

    await expect(publishCloudNote(note, bridge)).resolves.toMatchObject({
      updated: true,
      url: 'https://zennotes.org/s/launch'
    })
    expect(updateCloudPublishedNote).toHaveBeenCalledWith(42, {
      note_path: note.path,
      title: note.title,
      markdown: note.body
    })
  })

  it('rejects attachments when their bytes were not prepared', async () => {
    const { bridge, createPublishedNote } = setup()

    await expect(publishCloudNote({ ...note, assetEmbeds: ['photo.png'] }, bridge))
      .rejects.toThrow('attachment')
    expect(createPublishedNote).not.toHaveBeenCalled()
  })

  it('hands supported local attachments to the platform by vault path, without reading them', async () => {
    const { bridge, createPublishedNote } = setup()
    const withPhoto = { ...note, body: '![Photo](photo.png)', assetEmbeds: ['photo.png'] }
    useStore.setState({
      assetFiles: [{ path: 'Notes/photo.png', name: 'photo.png' } as never]
    })

    const assets = collectCloudPublishAssets(withPhoto, '/vault')
    await publishCloudNote(withPhoto, bridge, assets)

    expect(createPublishedNote).toHaveBeenCalledWith(expect.objectContaining({
      assets: [{ ref: 'photo.png', name: 'photo.png', mime: 'image/png', path: 'Notes/photo.png' }]
    }))
  })

  it('publishes a note with a built-in gradient cover, leaving the SVG for the viewer to redraw', async () => {
    const { bridge, createPublishedNote } = setup()
    const covered = {
      ...note,
      body: '---\nbanner: "![[assets/cover-gradient-dusk.svg]]"\n---\n![Photo](photo.png)',
      assetEmbeds: ['assets/cover-gradient-dusk.svg', 'photo.png']
    }
    useStore.setState({
      assetFiles: [
        { path: 'assets/cover-gradient-dusk.svg', name: 'cover-gradient-dusk.svg' },
        { path: 'Notes/photo.png', name: 'photo.png' }
      ] as never
    })

    const assets = collectCloudPublishAssets(covered, '/vault')
    expect(assets.map((asset) => asset.ref)).toEqual(['photo.png'])
    await publishCloudNote(covered, bridge, assets)
    expect(createPublishedNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: covered.body }))
  })

  it('still refuses an SVG of the author’s own, which the service does not accept', () => {
    useStore.setState({ assetFiles: [{ path: 'Notes/diagram.svg', name: 'diagram.svg' }] as never })
    expect(() => collectCloudPublishAssets({ ...note, assetEmbeds: ['diagram.svg'] }, '/vault')).toThrow(
      'not a supported image'
    )
  })

  it('allows 50 attachments and says how many fit beyond that', () => {
    const refs = (count: number) => Array.from({ length: count }, (_, index) => `photo-${index}.png`)
    useStore.setState({
      assetFiles: refs(51).map((ref) => ({ path: `Notes/${ref}`, name: ref }) as never)
    })

    expect(collectCloudPublishAssets({ ...note, assetEmbeds: refs(50) }, '/vault')).toHaveLength(50)
    expect(() => collectCloudPublishAssets({ ...note, assetEmbeds: refs(51) }, '/vault')).toThrow(
      'This note has 51 attached files, but a published note can have at most 50. Remove some attachments and publish again.'
    )
  })

  it('requires an active publishing entitlement', async () => {
    const { bridge, createPublishedNote } = setup(false, false)

    await expect(publishCloudNote(note, bridge)).rejects.toThrow('plan')
    expect(createPublishedNote).not.toHaveBeenCalled()
  })

  it('publishes appearance without changing the existing content flow', async () => {
    const { bridge, updateCloudPublishedNote } = setup(true)
    const appearance = { theme: 'rose-pine-moon', logo: null }

    await publishCloudNote(note, bridge, [], appearance)

    expect(updateCloudPublishedNote).toHaveBeenCalledWith(42, {
      note_path: note.path,
      title: note.title,
      markdown: note.body,
      appearance
    })
  })
})
