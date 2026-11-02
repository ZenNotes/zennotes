/**
 * Copies an Obsidian vault into a folder of the open vault. The source is only
 * ever read. As with the Notion import, the copy is built outside the vault and
 * moved in as one step, so undoing it means deleting one folder.
 *
 * Files keep their structure and their bytes: only a note with a link that the
 * move would break is rewritten (see obsidian-import/links.ts).
 *
 * No electron in here, so a test can run it on a folder of fixtures.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { NotionAbortError } from '@shared/notion-import/client'
import { updateFrontmatterFields } from '@shared/frontmatter'
import { prepareLinkIndex, rewriteObsidianLinks } from '@shared/obsidian-import/links'
import type {
  NotionImportProgress,
  NotionImportResult,
  ObsidianImportScan,
  ObsidianTreeItem
} from '@zennotes/bridge-contract/notion-import'
import { moveIntoVault, unusedFolderName } from './notion-import-run'
import { writeNoteCreatedAt } from './note-creation-metadata'

export const OBSIDIAN_IMPORT_FOLDER = 'Obsidian Import'
const REPORT_NAME = 'Import Report.md'
const SKIPPED_DIRS = new Set(['node_modules'])

interface SourceFile {
  rel: string
  abs: string
  isNote: boolean
}

function posix(rel: string): string {
  return rel.split(path.sep).join('/')
}

/** Every file worth copying. Dot folders are Obsidian's own (`.obsidian`,
 *  `.trash`) or a sync tool's, and a symlink can point anywhere, so neither is
 *  followed. */
async function walkVault(
  root: string
): Promise<{ files: SourceFile[]; tree: ObsidianTreeItem[]; counts: Map<string, number> }> {
  const files: SourceFile[] = []
  const counts = new Map<string, number>()
  const visit = async (dir: string, rel: string): Promise<{ items: ObsidianTreeItem[]; notes: number }> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const folders: ObsidianTreeItem[] = []
    const notes: ObsidianTreeItem[] = []
    let noteCount = 0
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        const inner = await visit(abs, childRel)
        const size = counts.get(childRel) ?? 0
        noteCount += inner.notes
        counts.set(rel, (counts.get(rel) ?? 0) + size)
        folders.push({
          id: childRel,
          title: entry.name,
          kind: 'folder',
          noteCount: inner.notes,
          fileCount: size,
          children: inner.items
        })
      } else if (entry.isFile()) {
        const isNote = /\.md$/i.test(entry.name)
        files.push({ rel: childRel, abs, isNote })
        if (isNote) {
          noteCount += 1
          notes.push({ id: childRel, title: entry.name.replace(/\.md$/i, ''), kind: 'note' })
        } else {
          counts.set(rel, (counts.get(rel) ?? 0) + 1)
        }
      }
    }
    return { items: [...folders, ...notes], notes: noteCount }
  }
  const top = await visit(root, '')
  return { files, tree: top.items, counts }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function scanObsidianVault(source: string): Promise<ObsidianImportScan> {
  const { files, tree } = await walkVault(source)
  const isObsidian = await fs
    .stat(path.join(source, '.obsidian'))
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  return {
    path: source,
    name: path.basename(source),
    isObsidian,
    notes: files.filter((file) => file.isNote).length,
    files: files.filter((file) => !file.isNote).length,
    tree
  }
}

function isExcluded(rel: string, excluded: Set<string>): boolean {
  if (excluded.has(rel)) return true
  for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
    if (excluded.has(rel.slice(0, slash))) return true
  }
  return false
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export interface ObsidianRunOptions {
  source: string
  stagingDir: string
  /** The open vault. */
  root: string
  /** Where it keeps its notes, with system-folder remaps applied. */
  notesRoot: string
  /** Paths already in the open vault, relative to its root. */
  existingNotes: string[]
  existingAssets: string[]
  excluded: string[]
  includeTasks: boolean
  onProgress: (progress: NotionImportProgress) => void
  signal?: AbortSignal
  today?: string
}

export async function runObsidianImport(options: ObsidianRunOptions): Promise<NotionImportResult> {
  const { source, stagingDir, root, notesRoot, onProgress } = options
  const stopIfAsked = (): void => {
    if (options.signal?.aborted) throw new NotionAbortError()
  }

  if (isInside(source, root) || isInside(root, source)) {
    throw new Error('That folder holds this vault, or sits inside it. Choose a vault somewhere else.')
  }

  onProgress({ phase: 'finding', done: 0, total: 0 })
  const excluded = new Set(options.excluded)
  const { files } = await walkVault(source)
  await fs.mkdir(notesRoot, { recursive: true })
  const folderName = await unusedFolderName(notesRoot, OBSIDIAN_IMPORT_FOLDER)
  const finalDir = path.join(notesRoot, folderName)
  const vaultFolder = posix(path.relative(root, finalDir))

  const notes = files.filter((file) => file.isNote && !isExcluded(file.rel, excluded))
  const allAssets = files.filter((file) => !file.isNote)
  const index = prepareLinkIndex({
    notes: notes.map((note) => note.rel),
    assets: allAssets.map((asset) => asset.rel),
    existingNotes: options.existingNotes,
    existingAssets: options.existingAssets,
    vaultFolder
  })

  const outDir = path.join(stagingDir, 'out')
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const place = async (rel: string): Promise<string> => {
    const target = path.resolve(outDir, rel)
    if (!target.startsWith(path.resolve(outDir) + path.sep)) throw new Error(`Path escapes the import: ${rel}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    return target
  }
  const keepTimes = async (target: string, abs: string): Promise<void> => {
    const stat = await fs.stat(abs)
    await fs.utimes(target, stat.atime, stat.mtime)
  }

  const total = files.length + 1
  let done = 0
  const tick = (title?: string): void => {
    stopIfAsked()
    done += 1
    onProgress({ phase: 'writing', done, total, title })
  }

  let rewritten = 0
  let dataviewBlocks = 0
  const referenced = new Set<string>()
  const createdDates = new Map<string, number>()
  for (const note of notes) {
    const original = await fs.readFile(note.abs, 'utf8')
    const result = rewriteObsidianLinks(original, note.rel, index)
    rewritten += result.rewritten
    dataviewBlocks += result.dataviewBlocks
    for (const asset of result.referencedAssets) referenced.add(asset)
    const body =
      result.hasTasks && !options.includeTasks
        ? updateFrontmatterFields(result.body, { tasks: 'false' })
        : result.body
    const target = await place(note.rel)
    // A note nothing changed is copied, so it stays byte for byte what it was.
    if (body === original) await fs.copyFile(note.abs, target, fs.constants.COPYFILE_FICLONE)
    else await fs.writeFile(target, body, 'utf8')
    await keepTimes(target, note.abs)
    const stat = await fs.stat(note.abs)
    createdDates.set(note.rel, stat.birthtimeMs || stat.mtimeMs)
    tick(note.rel)
  }

  // A file comes over with its folder, or because a note that came over uses it.
  const assets = allAssets.filter((asset) => !isExcluded(asset.rel, excluded) || referenced.has(asset.rel))
  const canvases: string[] = []
  const bases: string[] = []
  for (const asset of assets) {
    const target = await place(asset.rel)
    await fs.copyFile(asset.abs, target, fs.constants.COPYFILE_FICLONE)
    await keepTimes(target, asset.abs)
    if (/\.canvas$/i.test(asset.rel)) canvases.push(asset.rel)
    if (/\.base$/i.test(asset.rel)) bases.push(asset.rel)
    tick(asset.rel)
  }

  const settings = await readJson(path.join(source, '.obsidian', 'daily-notes.json'))
  const templates = await readJson(path.join(source, '.obsidian', 'templates.json'))
  const issues = (canvases.length > 0 ? 1 : 0) + (bases.length > 0 ? 1 : 0) + (dataviewBlocks > 0 ? 1 : 0)

  const lines: string[] = [`Imported from Obsidian${options.today ? ` on ${options.today}` : ''}.`, '']
  lines.push(`- ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`)
  lines.push(`- ${assets.length} ${assets.length === 1 ? 'file' : 'files'}`)
  if (rewritten > 0) {
    lines.push(`- ${rewritten} ${rewritten === 1 ? 'link' : 'links'} pinned to their note, because the name is shared`)
  }
  lines.push('', 'The original vault was not changed.', '')
  if (canvases.length > 0) {
    lines.push('## Canvases', '', "These came over as files. ZenNotes doesn't open canvases.", '')
    for (const canvas of canvases) lines.push(`- ${canvas}`)
    lines.push('')
  }
  if (bases.length > 0) {
    lines.push('## Obsidian Bases', '', "These came over as files. ZenNotes databases are a different format, so they don't open as databases.", '')
    for (const base of bases) lines.push(`- ${base}`)
    lines.push('')
  }
  if (dataviewBlocks > 0) {
    lines.push('## Dataview', '', `${dataviewBlocks} Dataview ${dataviewBlocks === 1 ? 'query stays a code block' : 'queries stay code blocks'} and won't run.`, '')
  }
  // Obsidian names these folders whether or not they exist, and one may have
  // been left out. Only point at what actually came over.
  const cameOver = (folder: unknown): string => {
    const name = typeof folder === 'string' ? folder.trim().replace(/^\/+|\/+$/g, '') : ''
    return name && notes.some((note) => note.rel.startsWith(`${name}/`)) ? name : ''
  }
  const daily = cameOver(settings.folder)
  const template = cameOver(templates.folder)
  if (daily || template) {
    lines.push('## Settings to carry over', '', 'Obsidian kept these here. Point Settings at them to keep using them:', '')
    if (daily) lines.push(`- Daily notes: ${vaultFolder}/${daily}`)
    if (template) lines.push(`- Templates: ${vaultFolder}/${template}`)
    lines.push('')
  }
  lines.push('Plugins and their settings stay in Obsidian.', '')
  await fs.writeFile(path.join(outDir, REPORT_NAME), lines.join('\n'), 'utf8')
  tick(REPORT_NAME)

  stopIfAsked()
  await moveIntoVault(outDir, finalDir)
  for (const [rel, createdAt] of createdDates) {
    await writeNoteCreatedAt(root, `${vaultFolder}/${rel}`, createdAt).catch(() => undefined)
  }
  await fs.rm(stagingDir, { recursive: true, force: true })

  return {
    folder: vaultFolder,
    reportPath: `${vaultFolder}/${REPORT_NAME}`,
    pages: notes.length,
    databases: 0,
    rows: 0,
    files: assets.length,
    issues
  }
}
