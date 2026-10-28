// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsplashKeyStatus, UnsplashSearchResult } from '@zennotes/bridge-contract/unsplash'
import { useStore } from '../store'
import { consumeSettingsTarget } from '../lib/settings-navigation'
import { setUnsplashKeyStatus } from '../lib/unsplash-key'
import { NoteCoverPicker, unsplashMessage } from './NoteCoverPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOTE = 'inbox/Trip.md'
const RAW = 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?ixid=abc'

describe('the cover picker’s Unsplash tab and the access key', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let search: ReturnType<typeof vi.fn<(query: string, page: number) => Promise<UnsplashSearchResult>>>

  const stubZen = (status: UnsplashKeyStatus): void => {
    ;(window as unknown as { zen: unknown }).zen = {
      searchUnsplash: search,
      getUnsplashKeyStatus: vi.fn(async () => status),
      resolveVaultAssetUrl: () => ''
    }
  }

  const open = async (): Promise<HTMLInputElement> => {
    useStore.setState({ noteCoverPickerPath: NOTE, noteCoverPickerStart: { tab: 'unsplash', query: 'fog' } })
    await act(async () => root.render(createElement(NoteCoverPicker, { notePath: NOTE })))
    // Past the search's 400 ms pause, so a search would have gone out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    return document.querySelector<HTMLInputElement>('[data-note-cover-picker] input')!
  }

  const press = async (input: HTMLInputElement, key: string): Promise<void> => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    search = vi.fn(async () => ({ ok: false, reason: 'no-key', retryAt: null, limit: null }) as UnsplashSearchResult)
    setUnsplashKeyStatus(null)
    consumeSettingsTarget()
    useStore.setState({ assetFiles: [], noteContents: {}, settingsOpen: false })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    delete (window as unknown as { zen?: unknown }).zen
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  it('without a key, says what the key is for and how to get one, and sends no search', async () => {
    stubZen({ set: false, store: 'system', canStore: true })
    await open()
    const panel = document.querySelector('[data-cover-picker-setup]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('your searches go from this computer straight to Unsplash')
    expect(panel!.textContent).toContain('create a New Application')
    expect(panel!.textContent).toContain('Copy its Access Key')
    expect(panel!.textContent).toContain('Paste it into Settings')
    expect([...document.querySelectorAll('[data-cover-picker-action]')].map((b) => b.textContent)).toEqual([
      'Open Settings',
      'unsplash.com/developers'
    ])
    expect(document.querySelectorAll('[data-cover-choice-idx]')).toHaveLength(0)
    expect(search).not.toHaveBeenCalled()
  })

  it('Enter opens Settings on the key field and closes the picker', async () => {
    stubZen({ set: false, store: 'system', canStore: true })
    const input = await open()
    await press(input, 'Enter')
    expect(useStore.getState().settingsOpen).toBe(true)
    expect(useStore.getState().noteCoverPickerPath).toBeNull()
    expect(consumeSettingsTarget()).toBe('unsplash')
  })

  it('↓ then Enter opens unsplash.com/developers, from the keyboard alone', async () => {
    stubZen({ set: false, store: 'browser', canStore: true })
    const openPage = vi.spyOn(window, 'open').mockReturnValue(null)
    const input = await open()
    expect(document.querySelector('[data-cover-picker-setup]')!.textContent).toContain('from this browser')
    await press(input, 'ArrowDown')
    expect(document.querySelector('[data-cover-picker-action="developers"]')!.getAttribute('aria-current')).toBe('true')
    expect(document.body.textContent).toContain('open unsplash.com')
    await press(input, 'Enter')
    expect(openPage).toHaveBeenCalledWith('https://unsplash.com/developers', '_blank', 'noopener,noreferrer')
    expect(useStore.getState().settingsOpen).toBe(false)
  })

  it('a refused key says so and offers Change key', async () => {
    stubZen({ set: true, store: 'system', canStore: true })
    search.mockResolvedValue({ ok: false, reason: 'invalid-key', retryAt: null, limit: null })
    const input = await open()
    expect(search).toHaveBeenCalledWith('fog', 1)
    expect(document.querySelector('[data-cover-picker-message]')!.textContent).toContain(
      'Unsplash did not accept your access key'
    )
    expect([...document.querySelectorAll('[data-cover-picker-action]')].map((b) => b.textContent)).toEqual(['Change key'])
    await press(input, 'Enter')
    expect(consumeSettingsTarget()).toBe('unsplash')
  })

  it('with a key, searches and shows the photos as before', async () => {
    stubZen({ set: true, store: 'system', canStore: true })
    search.mockResolvedValue({
      ok: true,
      page: {
        query: 'fog',
        page: 1,
        totalPages: 1,
        photos: [
          {
            id: 'a1',
            width: 6000,
            height: 4000,
            color: null,
            alt: null,
            rawUrl: RAW,
            thumbUrl: `${RAW}&w=400`,
            photographer: { name: 'Jane Doe', profileUrl: 'https://unsplash.com/@janedoe' },
            downloadLocation: 'https://api.unsplash.com/photos/a1/download'
          }
        ]
      }
    })
    await open()
    expect(document.querySelector('[data-cover-picker-setup]')).toBeNull()
    expect(document.querySelectorAll('[data-cover-choice-idx]')).toHaveLength(1)
    expect(document.querySelector('[data-cover-picker-credit]')!.textContent).toBe('Photo by Jane Doe on Unsplash')
  })
})

describe('unsplashMessage', () => {
  const failedWith = (reason: 'rate-limited' | 'offline', limit: number | null = null, retryAt: number | null = null) =>
    unsplashMessage({ status: 'failed', query: 'fog', reason, retryAt, limit }, 0)

  it('explains a spent hour with the new-app allowance, or the allowance Unsplash reported', () => {
    expect(failedWith('rate-limited')).toBe(
      'Your Unsplash app has used this hour’s requests: a new Unsplash app allows 50 an hour until Unsplash approves it for production. The Covers tab still works.'
    )
    expect(failedWith('rate-limited', 50)).toContain('a new Unsplash app allows 50 an hour')
    expect(failedWith('rate-limited', 5000)).toBe('Your Unsplash app has used its 5,000 requests for this hour. The Covers tab still works.')
  })

  it('names the network plainly', () => {
    expect(failedWith('offline')).toBe('Unsplash could not be reached. Check your connection; the Covers tab works offline.')
  })
})
