import type {
  NotionBlock,
  NotionDatabase,
  NotionDataSource,
  NotionListResponse,
  NotionPage,
  NotionPropertyValue,
  NotionView
} from './types'

export const NOTION_API_BASE_URL = 'https://api.notion.com'
/** Pinned: the first version with data sources and views. Reads differ from
 *  the newer 2026-03-11 only in `archived` becoming `in_trash`, and the
 *  importer accepts both. */
export const NOTION_API_VERSION = '2025-09-03'

/** 180 requests a minute is Notion's limit on every plan below Business, and
 *  querying a data source is held to about 3 a second on all of them. */
const MIN_REQUEST_SPACING_MS = 340
const MAX_ATTEMPTS = 6
const MAX_RETRY_WAIT_MS = 60_000

export interface NotionFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type NotionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<NotionFetchResponse>

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'NotionApiError'
  }

  /** The token itself is bad: retrying or moving on to the next page won't help. */
  get isAuth(): boolean {
    return this.status === 401
  }
}

export class NotionAbortError extends Error {
  constructor() {
    super('Import stopped.')
    this.name = 'NotionAbortError'
  }
}

export interface NotionClientOptions {
  fetch: NotionFetch
  token: string
  baseUrl?: string
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  spacingMs?: number
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NotionAbortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new NotionAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface NotionClient {
  me(): Promise<{ name?: string; bot?: { workspace_name?: string | null } }>
  search(onPage?: (found: number) => void): Promise<{
    results: Array<NotionPage | NotionDataSource>
    incomplete: boolean
  }>
  blockChildren(blockId: string): Promise<NotionBlock[]>
  block(blockId: string): Promise<NotionBlock & { parent?: NotionPage['parent'] }>
  page(pageId: string): Promise<NotionPage>
  database(databaseId: string): Promise<NotionDatabase>
  dataSource(dataSourceId: string): Promise<NotionDataSource>
  queryDataSource(dataSourceId: string): Promise<NotionPage[]>
  views(databaseId: string): Promise<NotionView[]>
  propertyItems(pageId: string, propertyId: string): Promise<NotionPropertyValue[]>
  /** A row comes without its cover and dates on some connections. */
  pageDetails?(pageId: string): Promise<Partial<NotionPage>>
  /** A source's rows couldn't all be read: a plan's query quota, chiefly. */
  rowsIncomplete?(dataSourceId: string): boolean
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  const baseUrl = (options.baseUrl ?? NOTION_API_BASE_URL).replace(/\/+$/, '')
  const spacing = options.spacingMs ?? MIN_REQUEST_SPACING_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, options.signal))
  let nextSlot = 0

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw new NotionAbortError()
      const wait = nextSlot - now()
      if (wait > 0) await sleep(wait)
      nextSlot = now() + spacing

      let response: NotionFetchResponse
      try {
        response = await options.fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            'notion-version': NOTION_API_VERSION,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: options.signal
        })
      } catch (error) {
        if (options.signal?.aborted) throw new NotionAbortError()
        if (attempt >= MAX_ATTEMPTS) throw error
        await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS))
        continue
      }

      if (response.status >= 200 && response.status < 300) return (await response.json()) as T

      const retryable = response.status === 429 || response.status === 529 || response.status >= 500
      if (retryable && attempt < MAX_ATTEMPTS) {
        const header = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(header) && header > 0
          ? header * 1000
          : 1000 * 2 ** (attempt - 1)
        await sleep(Math.min(delay, MAX_RETRY_WAIT_MS))
        continue
      }

      let code = 'unknown'
      let message = `Notion answered ${response.status}.`
      try {
        const detail = (await response.json()) as { code?: string; message?: string }
        code = detail.code ?? code
        message = detail.message ?? message
      } catch {
        // The status says enough.
      }
      throw new NotionApiError(response.status, code, message)
    }
  }

  async function listAll<T>(
    first: (cursor: string | undefined) => Promise<NotionListResponse<T>>,
    onPage?: (found: number) => void
  ): Promise<{ results: T[]; incomplete: boolean }> {
    const results: T[] = []
    let cursor: string | undefined
    let incomplete = false
    do {
      const page = await first(cursor)
      results.push(...page.results)
      incomplete ||= page.request_status === 'incomplete'
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
      onPage?.(results.length)
    } while (cursor)
    return { results, incomplete }
  }

  const query = (cursor: string | undefined): string =>
    `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`

  return {
    me: () => request('GET', '/v1/users/me'),
    search: (onPage) =>
      listAll<NotionPage | NotionDataSource>(
        (cursor) =>
          request('POST', '/v1/search', {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {})
          }),
        onPage
      ),
    blockChildren: async (blockId) =>
      (
        await listAll<NotionBlock>((cursor) =>
          request('GET', `/v1/blocks/${blockId}/children?${query(cursor)}`)
        )
      ).results,
    block: (blockId) => request('GET', `/v1/blocks/${blockId}`),
    page: (pageId) => request('GET', `/v1/pages/${pageId}`),
    database: (databaseId) => request('GET', `/v1/databases/${databaseId}`),
    dataSource: (dataSourceId) => request('GET', `/v1/data_sources/${dataSourceId}`),
    queryDataSource: async (dataSourceId) =>
      (
        await listAll<NotionPage>((cursor) =>
          request('POST', `/v1/data_sources/${dataSourceId}/query`, {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {})
          })
        )
      ).results,
    views: async (databaseId) => {
      const { results } = await listAll<{ id: string }>((cursor) =>
        request('GET', `/v1/views?database_id=${databaseId}&${query(cursor)}`)
      )
      const views: NotionView[] = []
      for (const reference of results) {
        views.push(await request<NotionView>('GET', `/v1/views/${reference.id}`))
      }
      return views
    },
    propertyItems: async (pageId, propertyId) => {
      const { results } = await listAll<NotionPropertyValue>((cursor) =>
        request('GET', `/v1/pages/${pageId}/properties/${encodeURIComponent(propertyId)}?${query(cursor)}`)
      )
      return results
    }
  }
}
