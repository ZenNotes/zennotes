import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsplashPhoto, UnsplashSearchResult } from '@zennotes/bridge-contract/unsplash'
import {
  UnsplashAnswerCache,
  createUnsplashSearch,
  type UnsplashSearchFn,
  type UnsplashSearchState
} from './unsplash-search'

function photo(id: string): UnsplashPhoto {
  return {
    id,
    width: 6000,
    height: 4000,
    color: '#336699',
    alt: null,
    rawUrl: `https://images.unsplash.com/photo-${id}?ixid=x`,
    thumbUrl: `https://images.unsplash.com/photo-${id}?ixid=x&w=400`,
    photographer: { name: `Photographer ${id}`, profileUrl: `https://unsplash.com/@p${id}` },
    downloadLocation: `https://api.unsplash.com/photos/${id}/download?ixid=x`
  }
}

function answer(query: string, page: number, ids: string[], totalPages = 3): UnsplashSearchResult {
  return { ok: true, page: { query, page, totalPages, photos: ids.map(photo) } }
}

function setup(search: UnsplashSearchFn) {
  const states: UnsplashSearchState[] = []
  const controller = createUnsplashSearch({
    search,
    onChange: (s) => states.push(s),
    cache: new UnsplashAnswerCache()
  })
  return { controller, states, last: () => states[states.length - 1] }
}

describe('createUnsplashSearch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for a pause in typing and asks once, for the last text', async () => {
    const search = vi.fn<UnsplashSearchFn>(async (q, page) => answer(q, page, ['a', 'b']))
    const { controller, last } = setup(search)
    controller.setQuery('f')
    expect(last()).toEqual({ status: 'idle' })
    controller.setQuery('fo')
    controller.setQuery('fog')
    expect(last()).toEqual({ status: 'loading', query: 'fog' })
    await vi.advanceTimersByTimeAsync(399)
    expect(search).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('fog', 1)
    expect(last()).toMatchObject({ status: 'ready', query: 'fog', page: 1, totalPages: 3 })
  })

  it('drops an answer that arrives after a newer search', async () => {
    let release: (r: UnsplashSearchResult) => void = () => {}
    const search = vi.fn<UnsplashSearchFn>((q, page) =>
      q === 'fog' ? new Promise((resolve) => (release = resolve)) : Promise.resolve(answer(q, page, ['m']))
    )
    const { controller, last } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    controller.setQuery('mountain')
    await vi.advanceTimersByTimeAsync(400)
    expect(last()).toMatchObject({ status: 'ready', query: 'mountain' })
    release(answer('fog', 1, ['f']))
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ status: 'ready', query: 'mountain' })
  })

  it('answers a repeated search from the cache without asking', async () => {
    const search = vi.fn<UnsplashSearchFn>(async (q, page) => answer(q, page, ['a']))
    const { controller, last } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    controller.setQuery('forest')
    await vi.advanceTimersByTimeAsync(400)
    controller.setQuery('FOG')
    expect(last()).toMatchObject({ status: 'ready', query: 'FOG' })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('appends the next page once, without repeats', async () => {
    const search = vi.fn<UnsplashSearchFn>(async (q, page) =>
      page === 1 ? answer(q, 1, ['a', 'b']) : answer(q, 2, ['b', 'c'])
    )
    const { controller, last } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    controller.loadMore()
    controller.loadMore()
    expect(last()).toMatchObject({ loadingMore: true })
    await vi.advanceTimersByTimeAsync(0)
    const state = last()
    expect(state.status === 'ready' && state.photos.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(state).toMatchObject({ page: 2, loadingMore: false })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('stops at the last page', async () => {
    const search = vi.fn<UnsplashSearchFn>(async (q, page) => answer(q, page, ['a'], 1))
    const { controller } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    controller.loadMore()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('reports a failure, and asks again when the same search comes back', async () => {
    const search = vi
      .fn<UnsplashSearchFn>()
      .mockResolvedValueOnce({ ok: false, reason: 'rate-limited', retryAt: null, limit: 50 })
      .mockImplementation(async (q, page) => answer(q, page, ['a']))
    const { controller, last } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    expect(last()).toEqual({ status: 'failed', query: 'fog', reason: 'rate-limited', retryAt: null, limit: 50 })
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    expect(last()).toMatchObject({ status: 'ready', query: 'fog' })
  })

  it('treats a host that throws as unavailable, and goes quiet once disposed', async () => {
    const search = vi.fn<UnsplashSearchFn>(async () => {
      throw new Error('bridge gone')
    })
    const { controller, last, states } = setup(search)
    controller.setQuery('fog')
    await vi.advanceTimersByTimeAsync(400)
    expect(last()).toMatchObject({ status: 'failed', reason: 'unavailable' })
    controller.setQuery('forest')
    controller.dispose()
    const seen = states.length
    await vi.advanceTimersByTimeAsync(400)
    expect(states.length).toBe(seen)
  })
})

describe('UnsplashAnswerCache', () => {
  it('keeps the most recent answers', () => {
    const cache = new UnsplashAnswerCache(2)
    for (const q of ['a1', 'b1', 'c1']) {
      const r = answer(q, 1, [])
      if (r.ok) cache.set(r.page)
    }
    expect(cache.get('a1', 1)).toBeUndefined()
    expect(cache.get('c1', 1)?.query).toBe('c1')
  })
})
