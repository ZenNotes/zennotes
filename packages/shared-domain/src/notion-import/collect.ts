import { EMBED_VIDEO_HOST, blockFileKey } from './blocks'
import { NotionAbortError, NotionApiError, type NotionClient } from './client'
import { propertyFileKey } from './database'
import type { NotionIssue, NotionIssueKind } from './render-context'
import {
  compactNotionId,
  notionPageTitle,
  plainText,
  type NotionBlock,
  type NotionDatabase,
  type NotionDataSource,
  type NotionFile,
  type NotionPage,
  type NotionParent,
  type NotionView
} from './types'

/**
 * Reads the workspace into a store, one record a page, before anything is
 * written to the vault.
 *
 * Reading comes first because links need every page's final path, and because
 * a run can take hours at Notion's rate limit: a record that reached the store
 * is never fetched again, so a stopped run picks up where it was. Hosted files
 * are downloaded as they're met, since their URLs last an hour and a queue
 * can't promise to get back to one in time.
 */

export interface NotionStoredFile {
  key: string
  name: string
}

export interface NotionImportStore {
  readRecord<T>(key: string): Promise<T | null>
  writeRecord(key: string, value: unknown): Promise<void>
  hasFile(key: string): Promise<boolean>
  /** Download to the store. Rejects on a failed download, including an
   *  expired link, which the caller answers by asking Notion for a fresh one. */
  downloadFile(key: string, url: string, suggestedName: string): Promise<void>
  listFiles(): Promise<NotionStoredFile[]>
}

export interface NotionPageRecord {
  page: NotionPage
  blocks: NotionBlock[]
}

export interface NotionSourceRecord {
  source: NotionDataSource
  database: NotionDatabase | null
  rows: NotionPage[]
  views: NotionView[]
}

export interface NotionCollectedNode {
  id: string
  kind: 'page' | 'database'
  title: string
  parentId: string | null
  isRow: boolean
  /** The id its record is stored under. Rows and pages: the page. */
  recordKey: string
}

export interface NotionCollected {
  nodes: NotionCollectedNode[]
  /** A database id to the data sources it holds. */
  databaseSources: Map<string, string[]>
  /** What the person left out, so a link to it isn't reported as a problem. */
  excluded: Set<string>
  issues: NotionIssue[]
}

export interface NotionCollectProgress {
  phase: 'finding' | 'reading'
  done: number
  total: number
  title?: string
}

export const pageRecordKey = (id: string): string => `page-${id}`
export const sourceRecordKey = (id: string): string => `source-${id}`
export const coverFileKey = (pageId: string): string => `cover-${pageId}`

function isTrashed(item: { in_trash?: boolean; archived?: boolean }): boolean {
  return item.in_trash === true || item.archived === true
}

function nameFromUrl(url: string, fallback: string): string {
  try {
    const leaf = new URL(url).pathname.split('/').filter(Boolean).pop()
    return leaf ? decodeURIComponent(leaf) : fallback
  } catch {
    return fallback
  }
}

function expiresSoon(file: NotionFile, now: number): boolean {
  const expiry = file.file?.expiry_time ? Date.parse(file.file.expiry_time) : NaN
  return Number.isFinite(expiry) && expiry - now < 60_000
}

const HOSTED_MEDIA = new Set(['image', 'video', 'audio', 'file', 'pdf'])

export async function collectNotionWorkspace(options: {
  client: NotionClient
  store: NotionImportStore
  /** Pages and databases left out, with everything under them. */
  excluded?: Iterable<string>
  onProgress?: (progress: NotionCollectProgress) => void
  now?: () => number
}): Promise<NotionCollected> {
  const { client, store } = options
  const excluded = new Set([...(options.excluded ?? [])].map(compactNotionId))
  const now = options.now ?? Date.now
  const issues: NotionIssue[] = []
  const report = (kind: NotionIssueKind, detail: string, nodeId?: string): void => {
    issues.push({ kind, detail, nodeId })
  }

  const pages = new Map<string, NotionPage>()
  const sourceQueue = new Map<string, NotionDataSource | null>()
  const sourceDone = new Map<string, NotionSourceRecord>()
  const databaseSources = new Map<string, string[]>()
  /** A page or database found inside another page's blocks. When its own
   *  `parent` names a block rather than a page, this is the page. */
  const foundInside = new Map<string, string>()
  const pagesDone = new Set<string>()

  options.onProgress?.({ phase: 'finding', done: 0, total: 0 })
  const found = await client.search((count) =>
    options.onProgress?.({ phase: 'finding', done: count, total: count })
  )
  if (found.incomplete) {
    report(
      'search-incomplete',
      'Notion cut its list of pages short. Pages it left out were still found if another page links them as subpages.'
    )
  }
  for (const item of found.results) {
    if (isTrashed(item) || excluded.has(compactNotionId(item.id))) continue
    if (item.object === 'data_source') {
      const parent = item.parent
      const database =
        parent?.type === 'database_id' ? compactNotionId((parent as { database_id: string }).database_id) : null
      if (!database || !excluded.has(database)) sourceQueue.set(compactNotionId(item.id), item)
    } else {
      const page = item as NotionPage
      pages.set(compactNotionId(item.id), page)
      // A shared row can turn up without its database in the results.
      if (page.parent?.type === 'data_source_id') {
        const source = compactNotionId((page.parent as { data_source_id: string }).data_source_id)
        if (!sourceQueue.has(source) && !excluded.has(source)) sourceQueue.set(source, null)
      }
    }
  }

  const progress = (title?: string): void => {
    options.onProgress?.({
      phase: 'reading',
      done: pagesDone.size + sourceDone.size,
      total: pages.size + sourceDone.size + sourceQueue.size,
      title
    })
  }

  const download = async (key: string, url: string, name: string, refresh: () => Promise<string | null>): Promise<boolean> => {
    if (await store.hasFile(key)) return true
    try {
      await store.downloadFile(key, url, name)
      return true
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
    }
    // Usually an expired link. Ask for a fresh one once.
    try {
      const fresh = await refresh()
      if (fresh) {
        await store.downloadFile(key, fresh, name)
        return true
      }
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
    }
    return false
  }

  const discoverDatabase = async (databaseId: string, parentPage: string): Promise<void> => {
    const compact = compactNotionId(databaseId)
    if (excluded.has(compact)) return
    foundInside.set(compact, parentPage)
    if (databaseSources.has(compact)) return
    try {
      const database = await client.database(databaseId)
      const ids = (database.data_sources ?? []).map((source) => compactNotionId(source.id))
      databaseSources.set(compact, ids)
      for (const id of ids) {
        foundInside.set(id, parentPage)
        if (!sourceDone.has(id) && !sourceQueue.has(id)) sourceQueue.set(id, null)
      }
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
      if (error instanceof NotionApiError && error.isAuth) throw error
      // A linked database answers this way: rendering reports it where it sits.
      databaseSources.set(compact, [])
    }
  }

  const discoverPage = async (pageBlockId: string, parentPage: string): Promise<void> => {
    const childId = compactNotionId(pageBlockId)
    if (excluded.has(childId)) return
    foundInside.set(childId, parentPage)
    if (pages.has(childId)) return
    try {
      const child = await client.page(pageBlockId)
      if (!isTrashed(child)) pages.set(childId, child)
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
      if (error instanceof NotionApiError && error.isAuth) throw error
      // Shows up as an unresolved subpage in the report.
    }
  }

  const fetchTree = async (parentId: string, pageId: string): Promise<NotionBlock[]> => {
    const blocks = await client.blockChildren(parentId)
    const live: NotionBlock[] = []
    for (const block of blocks) {
      if (isTrashed(block)) continue
      live.push(block)
      if (block.type === 'child_page') {
        await discoverPage(block.id, pageId)
        continue
      }
      if (block.type === 'child_database') {
        await discoverDatabase(block.id, pageId)
        continue
      }
      if (HOSTED_MEDIA.has(block.type)) {
        const media = block[block.type] as NotionFile
        if (media?.type === 'file' && media.file?.url) {
          const url = media.file.url
          const name = media.name || nameFromUrl(url, `${block.type}`)
          await download(blockFileKey(block.id), url, name, async () => {
            const fresh = await client.block(block.id)
            return (fresh[block.type] as NotionFile | undefined)?.file?.url ?? null
          })
        } else if (media?.type === 'external' && media.external?.url) {
          // Hosted elsewhere, so it can vanish. Kept here when it can be
          // fetched; if not, the note just links to it. A YouTube or Vimeo
          // video stays an embed, since there's no file to get.
          const url = media.external.url
          if (!(block.type === 'video' && EMBED_VIDEO_HOST.test(url))) {
            await download(blockFileKey(block.id), url, media.name || nameFromUrl(url, block.type), async () => null)
          }
        }
      }
      if (block.has_children) {
        block.children = await fetchTree(block.id, pageId)
      }
      if (block.type === 'synced_block') {
        // A copy of a synced block points at its original. The docs don't say
        // a copy lists the original's children, so ask the original if not.
        const source = (block.synced_block as { synced_from?: { block_id?: string } | null })?.synced_from?.block_id
        if (source && (block.children ?? []).length === 0) {
          try {
            block.children = await fetchTree(source, pageId)
          } catch (error) {
            if (error instanceof NotionAbortError) throw error
            if (error instanceof NotionApiError && error.isAuth) throw error
            report('unresolved-link', 'A synced block whose original this token cannot read', pageId)
          }
        }
      }
    }
    return live
  }

  const saveCover = async (page: NotionPage): Promise<void> => {
    const cover = page.cover
    if (!cover) return
    const url = cover.type === 'file' ? cover.file?.url : cover.external?.url
    if (!url) return
    const ok = await download(coverFileKey(page.id), url, nameFromUrl(url, 'cover.jpg'), async () => {
      const fresh = await client.page(page.id)
      return fresh.cover?.file?.url ?? fresh.cover?.external?.url ?? null
    })
    // An outside cover that won't download stays a link in the note.
    if (!ok && cover.type === 'file') report('file-missing', 'Its cover image', compactNotionId(page.id))
  }

  const readPage = async (id: string): Promise<void> => {
    let page = pages.get(id) as NotionPage
    progress(notionPageTitle(page))
    const stored = await store.readRecord<NotionPageRecord>(pageRecordKey(id))
    if (stored) {
      // Subpages a stopped run found still have to be found by this one.
      const walk = async (blocks: NotionBlock[]): Promise<void> => {
        for (const block of blocks) {
          if (block.type === 'child_page') await discoverPage(block.id, id)
          else if (block.type === 'child_database') await discoverDatabase(block.id, id)
          else if (block.children) await walk(block.children)
        }
      }
      await walk(stored.blocks)
      pagesDone.add(id)
      return
    }
    try {
      // Search can answer with a bare id, and a cover link may have aged out
      // while this page waited its turn.
      if (!page.properties || (page.cover?.type === 'file' && expiresSoon(page.cover, now()))) {
        page = await client.page(page.id)
        pages.set(id, page)
      } else if (client.pageDetails) {
        page = { ...page, ...(await client.pageDetails(page.id)) }
        pages.set(id, page)
      }
      await saveCover(page)
      const blocks = await fetchTree(page.id, id)
      await store.writeRecord(pageRecordKey(id), { page, blocks } satisfies NotionPageRecord)
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
      if (error instanceof NotionApiError && error.isAuth) throw error
      report('page-failed', error instanceof Error ? error.message : String(error), id)
    }
    pagesDone.add(id)
  }

  const readSource = async (id: string, known: NotionDataSource | null): Promise<void> => {
    const stored = await store.readRecord<NotionSourceRecord>(sourceRecordKey(id))
    if (stored) {
      addSource(id, stored)
      return
    }
    try {
      const source = await client.dataSource(known?.id ?? id)
      progress(plainText(source.title))
      const databaseId =
        source.parent?.type === 'database_id' ? (source.parent as { database_id: string }).database_id : null
      if (databaseId && excluded.has(compactNotionId(databaseId))) return
      let database: NotionDatabase | null = null
      if (databaseId) {
        try {
          database = await client.database(databaseId)
        } catch (error) {
          if (error instanceof NotionAbortError) throw error
          if (error instanceof NotionApiError && error.isAuth) throw error
        }
      }

      const rows = (await client.queryDataSource(source.id)).filter((row) => !isTrashed(row))
      if (rows.length >= 10_000) {
        report('rows-capped', 'Notion returns at most 10,000 rows from one query', id)
      }
      if (client.rowsIncomplete?.(source.id)) {
        report('rows-capped', "Notion's limit on this plan stopped it reading every row, so some may be missing", id)
      }
      for (const row of rows) await completeRow(row, source)

      let views: NotionView[] = []
      if (databaseId) {
        try {
          views = await client.views(databaseId)
        } catch (error) {
          if (error instanceof NotionAbortError) throw error
          if (error instanceof NotionApiError && error.isAuth) throw error
          report('views-unavailable', 'Its views could not be read, so it has one table view', id)
        }
      }
      const record: NotionSourceRecord = { source, database, rows, views }
      await store.writeRecord(sourceRecordKey(id), record)
      addSource(id, record)
    } catch (error) {
      if (error instanceof NotionAbortError) throw error
      if (error instanceof NotionApiError && error.isAuth) throw error
      report('page-failed', error instanceof Error ? error.message : String(error), id)
    }
  }

  /** Fill in what a query cuts short and take a row's files while their URLs
   *  are good. */
  const completeRow = async (row: NotionPage, source: NotionDataSource): Promise<void> => {
    for (const [name, value] of Object.entries(row.properties ?? {})) {
      if (value.type === 'relation' && value.has_more) {
        const items = await client.propertyItems(row.id, value.id)
        value.relation = items.flatMap((item) => item.relation ?? [])
        value.has_more = false
      }
      if (value.type === 'people' && value.has_more) {
        const items = await client.propertyItems(row.id, value.id)
        value.people = items.flatMap((item) => item.people ?? [])
      }
      if (value.type === 'files') {
        const schemaId = source.properties?.[name]?.id ?? value.id
        for (const [index, file] of (value.files ?? []).entries()) {
          const key = propertyFileKey(row.id, schemaId, index)
          if (file.type === 'external' && file.external?.url) {
            await download(key, file.external.url, file.name || nameFromUrl(file.external.url, 'file'), async () => null)
            continue
          }
          if (file.type !== 'file' || !file.file?.url) continue
          const fileName = file.name || nameFromUrl(file.file.url, 'file')
          const ok = await download(key, file.file.url, fileName, async () => {
            const fresh = await client.page(row.id)
            return fresh.properties?.[name]?.files?.[index]?.file?.url ?? null
          })
          if (!ok) report('file-missing', `"${fileName}" in "${name}"`, compactNotionId(row.id))
        }
      }
    }
  }

  const addSource = (id: string, record: NotionSourceRecord): void => {
    sourceDone.set(id, record)
    sourceQueue.delete(id)
    const databaseId = record.database ? compactNotionId(record.database.id) : null
    if (databaseId) {
      const known = databaseSources.get(databaseId) ?? []
      if (!known.includes(id)) databaseSources.set(databaseId, [...known, id])
    }
    for (const row of record.rows) {
      pages.set(compactNotionId(row.id), row)
    }
  }

  /** Search can list a page whose ancestor was left out. */
  const underExcluded = (start: string): boolean => {
    const seen = new Set<string>()
    let id: string | undefined = start
    while (id && !seen.has(id)) {
      seen.add(id)
      if (excluded.has(id)) return true
      const found = foundInside.get(id)
      if (found) {
        id = found
        continue
      }
      const parent: NotionParent | undefined = pages.get(id)?.parent
      id =
        parent?.type === 'page_id'
          ? compactNotionId((parent as { page_id: string }).page_id)
          : parent?.type === 'data_source_id'
            ? compactNotionId((parent as { data_source_id: string }).data_source_id)
            : undefined
    }
    return false
  }

  // Sources first: their rows join the pages still to read. Reading a page can
  // find more of either, so this runs until both are empty.
  for (;;) {
    const nextSource = sourceQueue.entries().next()
    if (!nextSource.done) {
      const [id, known] = nextSource.value
      sourceQueue.delete(id)
      await readSource(id, known)
      progress()
      continue
    }
    const nextPage = [...pages.keys()].find((id) => !pagesDone.has(id))
    if (!nextPage) break
    if (underExcluded(nextPage)) {
      pagesDone.add(nextPage)
      continue
    }
    await readPage(nextPage)
  }

  const blockOwners = new Map<string, string | null>()
  const resolveBlockOwner = async (blockId: string): Promise<string | null> => {
    const start = compactNotionId(blockId)
    if (blockOwners.has(start)) return blockOwners.get(start) ?? null
    let current = blockId
    let owner: string | null = null
    for (let step = 0; step < 30; step++) {
      let block: Awaited<ReturnType<NotionClient['block']>>
      try {
        block = await client.block(current)
      } catch (error) {
        if (error instanceof NotionAbortError) throw error
        break
      }
      const parent = block.parent
      if (parent?.type === 'page_id') {
        owner = compactNotionId((parent as { page_id: string }).page_id)
        break
      }
      if (parent?.type !== 'block_id') break
      current = (parent as { block_id: string }).block_id
    }
    blockOwners.set(start, owner)
    return owner
  }

  const parentNode = async (id: string, parent: NotionParent | undefined): Promise<string | null> => {
    if (!parent) return foundInside.get(id) ?? null
    switch (parent.type) {
      case 'page_id': {
        // A page in a column can name the column as its parent page. The page
        // whose blocks it was found in is the one that exists.
        const named = compactNotionId((parent as { page_id: string }).page_id)
        return pages.has(named) ? named : (foundInside.get(id) ?? named)
      }
      case 'data_source_id':
        return compactNotionId((parent as { data_source_id: string }).data_source_id)
      case 'database_id': {
        const database = compactNotionId((parent as { database_id: string }).database_id)
        return databaseSources.get(database)?.[0] ?? null
      }
      case 'block_id':
        return foundInside.get(id) ?? (await resolveBlockOwner((parent as { block_id: string }).block_id))
      default:
        return foundInside.get(id) ?? null
    }
  }

  const nodes: NotionCollectedNode[] = []
  for (const [id, record] of sourceDone) {
    if (record.database && excluded.has(compactNotionId(record.database.id))) continue
    const sourceTitle = plainText(record.source.title).trim()
    const databaseTitle = plainText(record.database?.title).trim()
    const sourceCount = record.database?.data_sources?.length ?? 1
    let title = databaseTitle || sourceTitle
    if (sourceCount > 1 && sourceTitle && sourceTitle !== databaseTitle) {
      title = databaseTitle ? `${databaseTitle} - ${sourceTitle}` : sourceTitle
    }
    const parentId = await parentNode(id, record.database?.parent ?? record.source.database_parent)
    // "New database" is what Notion calls one nobody named, and a workspace
    // can have many. The page around it says what it's for.
    if (!title || title === 'New database') {
      const around = parentId ? pages.get(parentId) : undefined
      const aroundTitle = around ? notionPageTitle(around) : ''
      title = aroundTitle ? `${aroundTitle} database` : title || 'Untitled database'
    }
    nodes.push({
      id,
      kind: 'database',
      title,
      parentId,
      isRow: false,
      recordKey: sourceRecordKey(id)
    })
  }
  for (const [id, page] of pages) {
    if (underExcluded(id)) continue
    const parentId = await parentNode(id, page.parent)
    nodes.push({
      id,
      kind: 'page',
      title: notionPageTitle(page) || 'Untitled',
      parentId,
      // A row whose database couldn't be read is an ordinary page: nothing
      // else would write it.
      isRow: parentId !== null && sourceDone.has(parentId),
      recordKey: pageRecordKey(id)
    })
  }

  return { nodes, databaseSources, excluded, issues }
}
