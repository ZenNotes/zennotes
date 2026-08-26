// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'
import { notifyPublishedNoteChanged } from '../lib/published-note-events'
import { dismissPublishNoteRequest, getPublishNoteRequest } from '../lib/publish-note-requests'
import { clearCloudSyncStatus, useCloudSyncStatusStore } from '../lib/cloud-auto-sync'
import { PublishedNoteButton } from './PublishedNoteButton'

const note = {
  path: 'Notes/Launch.md',
  title: 'Launch',
  body: '# Launch',
  assetEmbeds: []
}

describe('PublishedNoteButton', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    // The button only exists while a Cloud account is signed in.
    useCloudSyncStatusStore.setState({ phase: 'ready' })
  })

  afterEach(() => {
    const request = getPublishNoteRequest()
    if (request) dismissPublishNoteRequest(request)
    act(() => root.unmount())
    host.remove()
    clearCloudSyncStatus()
  })

  it('stays out of the header without a signed-in Cloud account, and never asks for the list', async () => {
    const bridge = {
      listCloudPublishedNotes: vi.fn(async () => [])
    } as Pick<ZenBridge, 'listCloudPublishedNotes'>

    for (const phase of ['hidden', 'disconnected', 'connecting'] as const) {
      act(() => useCloudSyncStatusStore.setState({ phase }))
      await act(async () => {
        root.render(createElement(PublishedNoteButton, { note, bridge }))
      })
      expect(host.querySelector('button')).toBeNull()
    }
    expect(bridge.listCloudPublishedNotes).not.toHaveBeenCalled()

    // A signed-in account with no linked vault can still publish.
    act(() => useCloudSyncStatusStore.setState({ phase: 'unlinked' }))
    await act(async () => {
      root.render(createElement(PublishedNoteButton, { note, bridge }))
    })
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Publish note')
    expect(bridge.listCloudPublishedNotes).toHaveBeenCalledTimes(1)

    // Signing out takes it away again.
    act(() => useCloudSyncStatusStore.setState({ phase: 'disconnected' }))
    expect(host.querySelector('button')).toBeNull()
  })

  it('shows a minimal published icon and opens the manage dialog', async () => {
    const bridge = {
      listCloudPublishedNotes: vi.fn(async () => [{
        id: 42,
        slug: 'launch',
        url: 'https://zennotes.org/s/launch',
        title: 'Launch',
        note_path: note.path,
        created_at: '2026-08-10T12:00:00.000Z',
        updated_at: '2026-08-10T12:00:00.000Z'
      }])
    } as Pick<ZenBridge, 'listCloudPublishedNotes'>

    await act(async () => {
      root.render(createElement(PublishedNoteButton, { note, bridge }))
    })

    const button = host.querySelector('button')!
    expect(button.dataset.published).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Published · Manage public note')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe('Published · Manage public note')

    act(() => button.click())
    expect(getPublishNoteRequest()?.note).toEqual(note)
  })

  it('updates immediately when publishing state changes', async () => {
    const bridge = {
      listCloudPublishedNotes: vi.fn(async () => [])
    } as Pick<ZenBridge, 'listCloudPublishedNotes'>

    await act(async () => {
      root.render(createElement(PublishedNoteButton, { note, bridge }))
    })

    expect(host.querySelector('button')?.dataset.published).toBe('false')
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Publish note')

    act(() => notifyPublishedNoteChanged({
      notePath: note.path,
      url: 'https://zennotes.org/s/launch'
    }))

    expect(host.querySelector('button')?.dataset.published).toBe('true')
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Published · Manage public note'
    )

    act(() => notifyPublishedNoteChanged({ notePath: note.path, url: null }))
    expect(host.querySelector('button')?.dataset.published).toBe('false')
  })
})
