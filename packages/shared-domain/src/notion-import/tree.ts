import type { NotionClient } from './client'
import type { McpNotionClient } from './mcp-source'
import {
  compactNotionId,
  notionPageTitle,
  plainText,
  type NotionBlock,
  type NotionDataSource,
  type NotionPage
} from './types'

/** What the picker shows: pages and databases, a level at a time. Rows aren't
 *  listed: a database comes over whole or not at all. */
export interface NotionTreeItem {
  id: string
  title: string
  kind: 'page' | 'database'
}

function hasRoots(client: NotionClient): client is McpNotionClient {
  return typeof (client as McpNotionClient).roots === 'function'
}

export async function notionTreeRoots(client: NotionClient): Promise<NotionTreeItem[]> {
  if (hasRoots(client)) return client.roots()

  const { results } = await client.search()
  const live = results.filter((item) => item.in_trash !== true && item.archived !== true)
  const known = new Set(live.map((item) => compactNotionId(item.id)))
  const items: NotionTreeItem[] = []
  for (const item of live) {
    if (item.object === 'data_source') {
      const source = item as NotionDataSource
      const parent = source.database_parent
      const parentId =
        parent?.type === 'page_id' ? compactNotionId((parent as { page_id: string }).page_id) : null
      if (parentId && known.has(parentId)) continue
      const databaseId =
        source.parent?.type === 'database_id'
          ? (source.parent as { database_id: string }).database_id
          : source.id
      items.push({
        id: compactNotionId(databaseId),
        title: plainText(source.title).trim() || 'Untitled database',
        kind: 'database'
      })
      continue
    }
    const page = item as NotionPage
    const parent = page.parent
    // Rows belong to their database, and a page in a column or a toggle
    // belongs to the page around it.
    if (parent?.type === 'data_source_id' || parent?.type === 'database_id' || parent?.type === 'block_id') continue
    if (parent?.type === 'page_id' && known.has(compactNotionId((parent as { page_id: string }).page_id))) continue
    items.push({
      id: compactNotionId(page.id),
      title: notionPageTitle(page) || 'Untitled',
      kind: 'page'
    })
  }
  return items
}

/** The pages and databases directly under a page, wherever they sit in it:
 *  a subpage can be inside a column or a toggle. */
export async function notionTreeChildren(client: NotionClient, pageId: string): Promise<NotionTreeItem[]> {
  const items: NotionTreeItem[] = []
  const walk = async (blocks: NotionBlock[]): Promise<void> => {
    for (const block of blocks) {
      if (block.type === 'child_page') {
        const title = (block.child_page as { title?: string } | undefined)?.title?.trim()
        items.push({ id: compactNotionId(block.id), title: title || 'Untitled', kind: 'page' })
      } else if (block.type === 'child_database') {
        let title = (block.child_database as { title?: string } | undefined)?.title?.trim()
        if (!title) {
          // An inline database is often listed with no name on its block.
          title = await client
            .database(block.id)
            .then((database) => plainText(database.title).trim())
            .catch(() => '')
          if (title === 'New database') title = ''
        }
        items.push({ id: compactNotionId(block.id), title: title || 'Database', kind: 'database' })
      } else if (block.has_children) {
        await walk(await client.blockChildren(block.id))
      }
    }
  }
  await walk(await client.blockChildren(pageId))
  return items
}
