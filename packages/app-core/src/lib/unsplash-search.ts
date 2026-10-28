/**
 * The cover picker's Unsplash tab: search as you type, gentle on the hourly
 * allowance of the person's own Unsplash key (50 requests for a new app).
 * A query waits for a pause in typing and needs two characters; an answer
 * that arrives after a newer query is dropped; the last answers are kept for
 * the session, so switching tabs or reopening the picker asks nothing again.
 *
 * The host does the sending (`window.zen.searchUnsplash`); a host without it
 * (the phone shells, until they add it) gets no Unsplash tab at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UnsplashPhoto,
  UnsplashSearchFailure,
  UnsplashSearchPage,
  UnsplashSearchResult
} from '@zennotes/bridge-contract/unsplash'
import { UNSPLASH_MIN_QUERY_LENGTH, normalizeUnsplashQuery } from '@shared/unsplash'

export const UNSPLASH_DEBOUNCE_MS = 400
const CACHE_LIMIT = 20

export type UnsplashSearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | {
      status: 'ready'
      query: string
      photos: UnsplashPhoto[]
      page: number
      totalPages: number
      loadingMore: boolean
    }
  | {
      status: 'failed'
      query: string
      reason: UnsplashSearchFailure
      retryAt: number | null
      /** The key's hourly allowance, when Unsplash said. */
      limit: number | null
    }

export type UnsplashSearchFn = (query: string, page: number) => Promise<UnsplashSearchResult>

export function unsplashSearchAvailable(): boolean {
  return typeof window.zen?.searchUnsplash === 'function'
}

/** Answers by `query\npage`, oldest first, shared by every picker this
 *  session opens. Only successes are kept: a failure is worth asking again. */
export class UnsplashAnswerCache {
  private readonly pages = new Map<string, UnsplashSearchPage>()
  constructor(private readonly limit = CACHE_LIMIT) {}

  private key(query: string, page: number): string {
    return `${query.toLowerCase()}\n${page}`
  }

  get(query: string, page: number): UnsplashSearchPage | undefined {
    const key = this.key(query, page)
    const hit = this.pages.get(key)
    if (hit) {
      this.pages.delete(key)
      this.pages.set(key, hit)
    }
    return hit
  }

  set(page: UnsplashSearchPage): void {
    const key = this.key(page.query, page.page)
    this.pages.delete(key)
    this.pages.set(key, page)
    while (this.pages.size > this.limit) this.pages.delete(this.pages.keys().next().value as string)
  }
}

const sessionCache = new UnsplashAnswerCache()

export interface UnsplashSearchController {
  setQuery(query: string): void
  loadMore(): void
  dispose(): void
}

/**
 * The search itself, without React: `onChange` hears every state. Kept apart
 * from the hook so the timing (debounce, stale answers, paging) is testable
 * with fake timers.
 */
export function createUnsplashSearch(deps: {
  search: UnsplashSearchFn
  onChange: (state: UnsplashSearchState) => void
  cache?: UnsplashAnswerCache
  debounceMs?: number
}): UnsplashSearchController {
  const cache = deps.cache ?? sessionCache
  const debounceMs = deps.debounceMs ?? UNSPLASH_DEBOUNCE_MS
  let state: UnsplashSearchState = { status: 'idle' }
  let current = ''
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const emit = (next: UnsplashSearchState): void => {
    state = next
    if (!disposed) deps.onChange(next)
  }

  const ask = async (query: string, page: number): Promise<UnsplashSearchResult> => {
    const hit = cache.get(query, page)
    if (hit) return { ok: true, page: hit }
    let result: UnsplashSearchResult
    try {
      result = await deps.search(query, page)
    } catch {
      result = { ok: false, reason: 'unavailable', retryAt: null, limit: null }
    }
    if (result.ok) cache.set(result.page)
    return result
  }

  const run = async (query: string, mine: number): Promise<void> => {
    const result = await ask(query, 1)
    if (mine !== generation || disposed) return
    if (!result.ok) {
      emit({ status: 'failed', query, reason: result.reason, retryAt: result.retryAt, limit: result.limit })
      return
    }
    emit({
      status: 'ready',
      query,
      photos: result.page.photos,
      page: 1,
      totalPages: result.page.totalPages,
      loadingMore: false
    })
  }

  return {
    setQuery(raw) {
      const query = normalizeUnsplashQuery(raw)
      // The same text again keeps what is showing, unless it failed: then
      // coming back to the tab is the way to ask again.
      if (query === current && state.status !== 'idle' && state.status !== 'failed') return
      current = query
      generation++
      if (timer) clearTimeout(timer)
      timer = null
      if (query.length < UNSPLASH_MIN_QUERY_LENGTH) {
        emit({ status: 'idle' })
        return
      }
      const mine = generation
      const hit = cache.get(query, 1)
      if (hit) {
        emit({ status: 'ready', query, photos: hit.photos, page: 1, totalPages: hit.totalPages, loadingMore: false })
        return
      }
      emit({ status: 'loading', query })
      timer = setTimeout(() => {
        timer = null
        void run(query, mine)
      }, debounceMs)
    },
    loadMore() {
      const s = state
      if (s.status !== 'ready' || s.loadingMore || s.page >= s.totalPages) return
      const mine = generation
      emit({ ...s, loadingMore: true })
      void ask(s.query, s.page + 1).then((result) => {
        if (mine !== generation || disposed || state.status !== 'ready') return
        const now = state
        if (!result.ok) {
          // Keep what is on screen; the next move to the last row asks again.
          emit({ ...now, loadingMore: false })
          return
        }
        const seen = new Set(now.photos.map((p) => p.id))
        emit({
          ...now,
          photos: [...now.photos, ...result.page.photos.filter((p) => !seen.has(p.id))],
          page: s.page + 1,
          totalPages: result.page.totalPages || now.totalPages,
          loadingMore: false
        })
      })
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }
}

/** The Unsplash tab's search: idle until `enabled` (the tab is showing). */
export function useUnsplashSearch(
  query: string,
  enabled: boolean
): { state: UnsplashSearchState; loadMore: () => void } {
  const [state, setState] = useState<UnsplashSearchState>({ status: 'idle' })
  const controller = useRef<UnsplashSearchController | null>(null)

  useEffect(() => {
    const search = window.zen?.searchUnsplash
    if (!search) return
    const c = createUnsplashSearch({ search: (q, page) => search(q, page), onChange: setState })
    controller.current = c
    return () => {
      c.dispose()
      controller.current = null
    }
  }, [])

  useEffect(() => {
    if (enabled) controller.current?.setQuery(query)
  }, [enabled, query])

  const loadMore = useCallback(() => controller.current?.loadMore(), [])
  return { state, loadMore }
}
