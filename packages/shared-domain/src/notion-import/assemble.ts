import { composePageBody } from '../database-records'
import { serializeRows } from '../database-csv'
import {
  FORM_DATA_FILE,
  FORM_SCHEMA_FILE,
  type DatabaseDoc,
  type DatabaseSidecar
} from '../databases'
import { updateFrontmatterFields, yamlValue } from '../frontmatter'
import { blocksHaveTodos, renderBlocks } from './blocks'
import {
  coverFileKey,
  pageRecordKey,
  sourceRecordKey,
  type NotionCollected,
  type NotionImportStore,
  type NotionPageRecord,
  type NotionSourceRecord
} from './collect'
import { buildNotionDatabase, type BuiltNotionDatabase } from './database'
import {
  NOTION_ASSETS_DIR,
  NOTION_REPORT_NAME,
  planNotionPaths,
  safeNotionName,
  type NotionPlannedNode
} from './plan-paths'
import type {
  NotionAsset,
  NotionIssue,
  NotionIssueKind,
  NotionLinkTarget,
  NotionRenderContext
} from './render-context'
import { wikilink } from './rich-text'
import { compactNotionId, type NotionPage } from './types'

/**
 * Turns what `collect` stored into files. Nothing here reads the network or
 * the vault: every file goes to a sink, under paths relative to the import
 * folder, so the desktop side can build the whole folder in staging and move
 * it into the vault in one step.
 */

export interface NotionOutputSink {
  writeText(path: string, content: string, times?: NotionFileTimes): Promise<void>
  /** Put a stored file at `path`. */
  placeFile(key: string, path: string): Promise<void>
}

export interface NotionFileTimes {
  createdMs?: number
  updatedMs?: number
}

export interface NotionImportOptions {
  /** The import folder's path from the vault root: what links and embeds use. */
  vaultFolder: string
  /** Let imported to-dos into the Tasks view. Off, they stay plain checklists. */
  includeTasks: boolean
  today?: string
}

export interface NotionImportSummary {
  pages: number
  databases: number
  rows: number
  files: number
  issues: NotionIssue[]
}

function times(page: NotionPage): NotionFileTimes {
  const created = page.created_time ? Date.parse(page.created_time) : NaN
  const updated = page.last_edited_time ? Date.parse(page.last_edited_time) : NaN
  return {
    ...(Number.isFinite(created) ? { createdMs: created } : {}),
    ...(Number.isFinite(updated) ? { updatedMs: updated } : {})
  }
}

function assignFileNames(
  files: Array<{ key: string; name: string }>,
  vaultFolder: string
): Map<string, NotionAsset & { relative: string }> {
  const taken = new Set<string>()
  const out = new Map<string, NotionAsset & { relative: string }>()
  for (const file of files) {
    const dot = file.name.lastIndexOf('.')
    const hasExt = dot > 0 && file.name.length - dot <= 12
    const ext = hasExt ? file.name.slice(dot).replace(/[^.\w-]/g, '') : ''
    const stem = safeNotionName(hasExt ? file.name.slice(0, dot) : file.name)
    let name = `${stem}${ext}`
    let n = 1
    while (taken.has(name.toLowerCase())) {
      n += 1
      name = `${stem} ${n}${ext}`
    }
    taken.add(name.toLowerCase())
    const relative = `${NOTION_ASSETS_DIR}/${name}`
    out.set(file.key, { path: `${vaultFolder}/${relative}`, name, relative })
  }
  return out
}

const ISSUE_HEADINGS: Record<NotionIssueKind, string> = {
  'page-failed': 'Pages that could not be read',
  'file-missing': 'Files that could not be downloaded',
  'linked-database': 'Linked databases',
  'unsupported-block': 'Blocks Notion does not return',
  'unknown-block': 'Blocks and properties this importer does not know',
  'unresolved-link': 'Links to pages not in this import',
  'view-converted': 'Views with no ZenNotes equal',
  'filter-dropped': 'View filters left out',
  'sort-dropped': 'View sorts left out',
  'computed-empty': 'Formulas and rollups with missing values',
  'option-renamed': 'Select options that changed',
  'search-incomplete': 'Coverage',
  'rows-capped': 'Coverage',
  'views-unavailable': 'Views that could not be read'
}

function reportNote(
  summary: NotionImportSummary,
  nodeLink: (id: string) => string | null,
  today: string | undefined
): string {
  const lines: string[] = []
  lines.push(`Imported from Notion${today ? ` on ${today}` : ''}.`, '')
  lines.push(`- ${summary.pages} pages`)
  lines.push(`- ${summary.databases} ${summary.databases === 1 ? 'database' : 'databases'}, with ${summary.rows} rows`)
  lines.push(`- ${summary.files} ${summary.files === 1 ? 'file' : 'files'}`, '')

  lines.push('## Changed in every import', '')
  lines.push('- Formula and rollup columns hold the values they had, and no longer calculate.')
  lines.push('- Columns are one after another, and synced blocks are separate copies.')
  lines.push('- Text color, underline, block color and page icons have no Markdown form.')
  lines.push('- Comments, page history and permissions were not imported.', '')

  const groups = new Map<string, NotionIssue[]>()
  for (const issue of summary.issues) {
    const heading = ISSUE_HEADINGS[issue.kind]
    groups.set(heading, [...(groups.get(heading) ?? []), issue])
  }
  if (groups.size === 0) {
    lines.push('Nothing else was left out.', '')
    return lines.join('\n')
  }
  for (const [heading, issues] of groups) {
    lines.push(`## ${heading}`, '')
    const seen = new Set<string>()
    for (const issue of issues) {
      const where = issue.nodeId ? nodeLink(issue.nodeId) : null
      const line = where ? `- ${where}: ${issue.detail}` : `- ${issue.detail}`
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export async function assembleNotionImport(options: {
  collected: NotionCollected
  store: NotionImportStore
  sink: NotionOutputSink
  import: NotionImportOptions
  onProgress?: (done: number, total: number) => void
}): Promise<NotionImportSummary> {
  const { collected, store, sink } = options
  const { vaultFolder, includeTasks } = options.import

  const plan = planNotionPaths(collected.nodes)
  const vaultPath = (relative: string): string => `${vaultFolder}/${relative}`
  const pageTarget = (planned: NotionPlannedNode): string =>
    vaultPath(planned.path.replace(/\.md$/i, ''))
  const titles = new Map(collected.nodes.map((node) => [node.id, node.title]))

  const files = await store.listFiles()
  const assets = assignFileNames(files, vaultFolder)
  for (const [key, asset] of assets) await sink.placeFile(key, asset.relative)

  const issues: NotionIssue[] = [...collected.issues]
  /** Rows something links to. Those get a record page even with an empty body,
   *  because a record can only be linked once it has one. */
  const referenced = new Set<string>()

  const makeContext = (nodeId: string): NotionRenderContext => ({
    resolvePage: (id) => {
      const compact = compactNotionId(id)
      const planned = plan.get(compact)
      if (!planned || planned.kind !== 'page') return null
      referenced.add(compact)
      return { target: pageTarget(planned), title: titles.get(compact) ?? planned.name }
    },
    resolveDatabase: (id) => {
      const compact = compactNotionId(id)
      const direct = plan.get(compact)
      const sources = direct ? [compact] : (collected.databaseSources.get(compact) ?? [])
      const out: NotionLinkTarget[] = []
      for (const source of sources) {
        const planned = plan.get(source)
        // A database's link resolves by title, so its name is the target.
        if (planned?.kind === 'database') out.push({ target: planned.name, title: planned.name })
      }
      return out
    },
    assetFor: (key) => assets.get(key) ?? null,
    isExcluded: (id) => {
      const compact = compactNotionId(id)
      return (
        collected.excluded.has(compact) &&
        !plan.has(compact)
      )
    },
    issue: (kind, detail) => issues.push({ kind, detail, nodeId })
  })

  const frontmatter = (page: NotionPage, hasTodos: boolean): Record<string, string> => {
    const fields: Record<string, string> = {}
    const coverAsset = assets.get(coverFileKey(page.id))
    if (coverAsset) fields.banner = `![[${coverAsset.path}]]`
    else if (page.cover?.type === 'external' && page.cover.external?.url) {
      fields.banner = page.cover.external.url
    }
    if (hasTodos && !includeTasks) fields.tasks = 'false'
    return fields
  }

  const pageNodes = collected.nodes.filter((node) => node.kind === 'page')
  const sourceNodes = collected.nodes.filter((node) => node.kind === 'database')
  const totalSteps = pageNodes.length + sourceNodes.length
  let step = 0
  const tick = (): void => options.onProgress?.(++step, totalSteps)

  // Databases first: their relation cells mark which rows need a page, and so
  // do the links in every body rendered after them.
  const built = new Map<string, { record: NotionSourceRecord; database: BuiltNotionDatabase }>()
  for (const node of sourceNodes) {
    const record = await store.readRecord<NotionSourceRecord>(sourceRecordKey(node.id))
    if (!record) continue
    const context = makeContext(node.id)
    const database = buildNotionDatabase({
      schema: record.source.properties ?? {},
      rows: record.rows,
      views: record.views,
      resolveRow: (id) => context.resolvePage(id),
      assetFor: context.assetFor,
      issue: context.issue
    })
    built.set(node.id, { record, database })
  }

  const rowBodies = new Map<string, { page: NotionPage; body: string; hasTodos: boolean }>()
  for (const node of pageNodes) {
    const planned = plan.get(node.id)
    if (!planned) continue
    const record = await store.readRecord<NotionPageRecord>(pageRecordKey(node.id))
    const context = makeContext(node.id)
    const body = record ? renderBlocks(record.blocks, context) : ''

    if (node.isRow) {
      if (record) rowBodies.set(node.id, { page: record.page, body, hasTodos: blocksHaveTodos(record.blocks) })
      continue
    }

    let content = planned.renamed ? `# ${node.title}\n\n` : ''
    content += body || (record ? '' : '> [!warning] This page could not be read from Notion.')
    if (content && !content.endsWith('\n')) content += '\n'
    if (record) {
      const fields = frontmatter(record.page, blocksHaveTodos(record.blocks))
      if (Object.keys(fields).length > 0) {
        const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`)
        content = `---\n${lines.join('\n')}\n---\n${content}`
      }
    }
    await sink.writeText(planned.path, content, record ? times(record.page) : undefined)
    tick()
  }

  const parents = new Set(collected.nodes.map((node) => node.parentId))
  let rowCount = 0
  for (const [id, { record, database }] of built) {
    const planned = plan.get(id)
    if (!planned) continue
    const pages: Record<string, string> = {}
    const rowPages = new Map(record.rows.map((row) => [row.id, row]))
    const doc = {
      path: `${planned.path}/${FORM_DATA_FILE}`,
      ...database.sidecar,
      rows: database.rows
    } as unknown as DatabaseDoc

    for (const row of database.rows) {
      rowCount += 1
      const rowId = compactNotionId(row.id)
      const rowPlan = plan.get(rowId)
      if (!rowPlan) continue
      const rendered = rowBodies.get(rowId)
      const rowFiles = database.rowFiles.get(row.id) ?? []
      const hasChildren = parents.has(rowId)
      // Most rows in a list of links have no page body. Notion gives every row
      // a page; a vault doesn't need a thousand empty notes for it.
      const needsPage =
        !!rendered?.body || rowFiles.length > 0 || hasChildren || referenced.has(rowId)
      if (!needsPage) continue

      const title = titles.get(rowId) ?? rowPlan.name
      const sections = [`# ${title}`]
      if (rendered?.body) sections.push(rendered.body)
      if (rowFiles.length > 0) sections.push(rowFiles.join('\n\n'))
      let content = composePageBody(doc, row, `${sections.join('\n\n')}\n`)
      const page = rendered?.page ?? rowPages.get(row.id)
      if (page) {
        const fields = frontmatter(page, rendered?.hasTodos ?? false)
        if (Object.keys(fields).length > 0) content = updateFrontmatterFields(content, fields)
      }
      await sink.writeText(rowPlan.path, content, page ? times(page) : undefined)
      // The sidecar keeps these relative to the database folder.
      pages[row.id] = rowPlan.path.slice(planned.path.length + 1)
    }

    const sidecar: DatabaseSidecar = {
      ...database.sidecar,
      ...(Object.keys(pages).length > 0 ? { pages } : {})
    }
    await sink.writeText(
      `${planned.path}/${FORM_DATA_FILE}`,
      serializeRows(database.rows, database.sidecar.fields)
    )
    await sink.writeText(`${planned.path}/${FORM_SCHEMA_FILE}`, `${JSON.stringify(sidecar, null, 2)}\n`)
    tick()
  }

  const summary: NotionImportSummary = {
    pages: pageNodes.filter((node) => !node.isRow).length,
    databases: built.size,
    rows: rowCount,
    files: assets.size,
    issues
  }
  const nodeLink = (id: string): string | null => {
    const planned = plan.get(id)
    if (!planned) return null
    return planned.kind === 'page'
      ? wikilink(pageTarget(planned), titles.get(id) ?? planned.name)
      : wikilink(planned.name)
  }
  await sink.writeText(
    `${NOTION_REPORT_NAME}.md`,
    reportNote(summary, nodeLink, options.import.today)
  )
  return summary
}
