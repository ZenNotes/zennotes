/**
 * Copies a Logseq graph into the open vault. The graph is only ever read.
 *
 * Like the Notion and Obsidian imports, the import folder is built outside the
 * vault and moved in as one step, so undoing it means deleting one folder. The
 * one thing that lands elsewhere is a journal that becomes a daily note: those
 * go in one at a time after the move, each only if nothing is at its path yet,
 * and the report names every one. The conversion itself is the pure
 * `@shared/logseq-import/convert`; this file only reads and writes.
 *
 * No electron in here, so a test can run it on a folder of fixtures.
 */
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { NotionAbortError } from '@shared/notion-import/client'
import { parseLogseqConfig } from '@shared/logseq-import/config'
import {
  LOGSEQ_JOURNALS_DIR,
  LOGSEQ_REPORT_NAME,
  logseqJournalDate,
  planLogseqImport,
  safeNoteName,
  type LogseqSourceFile
} from '@shared/logseq-import/convert'
import type {
  LogseqDailyNotePlace,
  LogseqImportScan,
  NotionImportProgress,
  NotionImportResult
} from '@zennotes/bridge-contract/notion-import'
import { moveIntoVault, unusedFolderName } from './notion-import-run'
import { writeNoteCreatedAt } from './note-creation-metadata'
import { isInside } from './obsidian-import-run'

export const LOGSEQ_IMPORT_FOLDER = 'Logseq'

/** The graph folders that hold what a person wrote. `logseq/` is the app's own
 *  (settings, backups, version files) and stays behind. */
const NOTE_DIRS = ['pages', 'journals']
const FILE_DIRS = ['assets', 'draws', 'whiteboards']

interface GraphFile {
  rel: string
  abs: string
}

function posix(rel: string): string {
  return rel.split(path.sep).join('/')
}

/** Every file under `dir`, skipping dot entries (a sync tool's, or Logseq's
 *  `.recycle`) and symlinks, which can point anywhere. */
async function walk(root: string, dir: string): Promise<GraphFile[]> {
  const out: GraphFile[] = []
  const visit = async (abs: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = path.join(abs, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) out.push({ rel: posix(path.relative(root, child)), abs: child })
    }
  }
  await visit(path.join(root, dir))
  return out
}

interface GraphListing {
  markdown: GraphFile[]
  org: GraphFile[]
  files: GraphFile[]
  config: string | null
}

async function listGraph(source: string): Promise<GraphListing> {
  const markdown: GraphFile[] = []
  const org: GraphFile[] = []
  const files: GraphFile[] = []
  for (const dir of NOTE_DIRS) {
    for (const file of await walk(source, dir)) {
      if (/\.(md|markdown)$/i.test(file.rel)) markdown.push(file)
      else if (/\.org$/i.test(file.rel)) org.push(file)
      else files.push(file)
    }
  }
  for (const dir of FILE_DIRS) files.push(...(await walk(source, dir)))
  const config = await fs.readFile(path.join(source, 'logseq', 'config.edn'), 'utf8').catch(() => null)
  return { markdown, org, files, config }
}

export async function scanLogseqGraph(source: string): Promise<LogseqImportScan> {
  const listing = await listGraph(source)
  const config = parseLogseqConfig(listing.config)
  const journalDates: string[] = []
  let pages = 0
  for (const file of listing.markdown) {
    const date = file.rel.startsWith('journals/') ? logseqJournalDate(file.rel, config) : null
    if (date) journalDates.push(date)
    else pages += 1
  }
  if (listing.config === null && listing.markdown.length === 0 && listing.org.length === 0) {
    throw new Error("That folder isn't a Logseq graph. Choose the folder that holds pages and journals.")
  }
  return {
    path: source,
    name: path.basename(source),
    isLogseq: listing.config !== null,
    pages,
    journals: journalDates.length,
    files: listing.files.length,
    orgPages: listing.org.length,
    journalDates
  }
}

const SEGMENT_BAD = /[\\:*?"<>|#^[\]]/

/** A vault-relative folder path the renderer named, or null if it names anything
 *  but plain folders below where it starts. */
function cleanSubpath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  const parts = trimmed.split('/')
  if (parts.some((part) => !part.trim() || part === '.' || part === '..' || part.startsWith('.') || SEGMENT_BAD.test(part))) {
    return null
  }
  return parts.join('/')
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.startsWith('.') || SEGMENT_BAD.test(trimmed)) return null
  return trimmed
}

export interface LogseqRunOptions {
  source: string
  stagingDir: string
  /** The open vault. */
  root: string
  /** Where it keeps its notes, with system-folder remaps applied. */
  notesRoot: string
  /** Paths already in the open vault, relative to its root. */
  existingNotes: string[]
  /** The folder to make in the notes area; a taken name gets a number. */
  folder: string
  /** Where each date's daily note goes, from the app's settings. Left out,
   *  journals stay in the import folder. */
  dailyNotes?: Record<string, LogseqDailyNotePlace>
  bullets: boolean
  includeTasks: boolean
  onProgress: (progress: NotionImportProgress) => void
  signal?: AbortSignal
  today?: string
}

export async function runLogseqImport(options: LogseqRunOptions): Promise<NotionImportResult> {
  const { source, stagingDir, root, notesRoot, onProgress } = options
  const stopIfAsked = (): void => {
    if (options.signal?.aborted) throw new NotionAbortError()
  }
  if (isInside(source, root) || isInside(root, source)) {
    throw new Error('That folder holds this vault, or sits inside it. Choose a graph somewhere else.')
  }

  onProgress({ phase: 'finding', done: 0, total: 0 })
  const listing = await listGraph(source)
  const config = parseLogseqConfig(listing.config)

  const wanted = cleanSubpath(options.folder)
  if (wanted === null || wanted === '') throw new Error('Choose a folder name without / \\ : * ? " < > | # ^ [ ]')
  const parentRel = path.dirname(wanted) === '.' ? '' : path.dirname(wanted)
  const parentAbs = path.join(notesRoot, parentRel)
  await fs.mkdir(parentAbs, { recursive: true })
  const folderName = await unusedFolderName(parentAbs, safeNoteName(path.basename(wanted)))
  const finalDir = path.join(parentAbs, folderName)
  const vaultFolder = posix(path.relative(root, finalDir))
  const notesFolder = posix(path.relative(root, notesRoot))

  // Daily notes: only a date with a clean place, and nothing there yet.
  const taken: string[] = []
  const dailyPaths = new Map<string, string>()
  for (const [date, place] of Object.entries(options.dailyNotes ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const subpath = cleanSubpath(place?.subpath)
    const title = cleanTitle(place?.title)
    if (subpath === null || title === null) continue
    const rel = [notesFolder, subpath, `${title}.md`].filter(Boolean).join('/')
    const abs = path.resolve(root, rel)
    if (!isInside(notesRoot, abs) || isInside(finalDir, abs)) continue
    const exists = place.exists || (await fs.stat(abs).then(() => true, () => false))
    if (exists) taken.push(date)
    else dailyPaths.set(date, rel)
  }

  const read = async (file: GraphFile): Promise<LogseqSourceFile> => ({
    rel: file.rel,
    text: await fs.readFile(file.abs, 'utf8')
  })
  const pages: LogseqSourceFile[] = []
  const journals: LogseqSourceFile[] = []
  for (const file of listing.markdown) {
    stopIfAsked()
    ;(file.rel.startsWith('journals/') ? journals : pages).push(await read(file))
  }
  const orgFiles = await Promise.all(listing.org.map(read))

  const plan = planLogseqImport(
    {
      config,
      pages,
      journals,
      orgFiles,
      assets: listing.files.map((file) => file.rel)
    },
    {
      folder: vaultFolder,
      journalPath: options.dailyNotes ? (date) => dailyPaths.get(date) ?? null : undefined,
      takenJournalDates: options.dailyNotes ? taken : [],
      existingNotes: options.existingNotes,
      bullets: options.bullets,
      includeTasks: options.includeTasks,
      today: options.today
    }
  )

  const outDir = path.join(stagingDir, 'out')
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  const inFolder = (vaultRel: string): string => {
    const rel = vaultRel.slice(vaultFolder.length + 1)
    const target = path.resolve(outDir, rel)
    if (!target.startsWith(path.resolve(outDir) + path.sep)) throw new Error(`Path escapes the import: ${vaultRel}`)
    return target
  }

  const total = plan.notes.length + plan.assets.length + 1
  let done = 0
  const tick = (title?: string): void => {
    stopIfAsked()
    done += 1
    onProgress({ phase: 'writing', done, total, title })
  }

  const sources = new Map(listing.markdown.concat(listing.org, listing.files).map((file) => [file.rel, file.abs]))
  const created = new Map<string, number>()
  const createdFor = async (rel: string, date?: string): Promise<number | null> => {
    if (date) {
      const [y, m, d] = date.split('-').map(Number)
      return new Date(y, m - 1, d, 9).getTime()
    }
    const abs = sources.get(rel)
    if (!abs) return null
    const stat = await fs.stat(abs)
    return stat.birthtimeMs || stat.mtimeMs
  }

  const outside = plan.notes.filter((note) => note.outside)
  for (const note of plan.notes) {
    if (note.outside) continue
    const target = inFolder(note.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, note.body, 'utf8')
    const at = await createdFor(note.source, note.date)
    if (at) created.set(note.path, at)
    tick(note.title)
  }
  for (const asset of plan.assets) {
    const from = sources.get(asset.source)
    if (!from) continue
    const target = inFolder(asset.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(from, target, fsConstants.COPYFILE_FICLONE)
    const stat = await fs.stat(from)
    await fs.utimes(target, stat.atime, stat.mtime)
    tick(asset.source)
  }
  const reportFile = inFolder(plan.report.path)
  await fs.writeFile(reportFile, plan.report.body, 'utf8')
  tick(LOGSEQ_REPORT_NAME)

  stopIfAsked()
  await moveIntoVault(outDir, finalDir)

  // After the move: each daily note only where nothing is yet. One that loses
  // a race with a note written meanwhile joins the others in the folder.
  const moved: string[] = []
  for (const note of outside) {
    const abs = path.resolve(root, note.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    let placed = note.path
    try {
      await fs.writeFile(abs, note.body, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const dir = path.join(finalDir, LOGSEQ_JOURNALS_DIR)
      await fs.mkdir(dir, { recursive: true })
      const base = path.basename(note.path, '.md')
      let name = base
      for (let n = 2; await fs.stat(path.join(dir, `${name}.md`)).then(() => true, () => false); n++) {
        name = `${base} ${n}`
      }
      await fs.writeFile(path.join(dir, `${name}.md`), note.body, { encoding: 'utf8', flag: 'wx' })
      placed = `${vaultFolder}/${LOGSEQ_JOURNALS_DIR}/${name}.md`
      moved.push(placed)
    }
    const at = await createdFor(note.source, note.date)
    if (at) created.set(placed, at)
  }
  if (moved.length > 0) {
    const extra = [
      '## Journals written while importing',
      '',
      'A daily note appeared for these days while the import ran, so their journal is here instead:',
      '',
      ...moved.map((rel) => `- ${rel}`),
      ''
    ].join('\n')
    await fs.appendFile(path.join(finalDir, LOGSEQ_REPORT_NAME), `\n${extra}`, 'utf8')
  }
  for (const [rel, at] of created) await writeNoteCreatedAt(root, rel, at).catch(() => undefined)
  await fs.rm(stagingDir, { recursive: true, force: true })

  const { stats } = plan
  const kept = Object.values(stats.verbatim).reduce((sum, entry) => sum + entry.count, 0)
  const issues =
    Object.values(stats.verbatim).filter((entry) => entry.count > 0).length +
    (taken.length > 0 ? 1 : 0) +
    (stats.missingBlockRefs > 0 ? 1 : 0) +
    (moved.length > 0 ? 1 : 0)
  return {
    folder: vaultFolder,
    reportPath: plan.report.path,
    pages: stats.pages + stats.orgPages,
    databases: 0,
    rows: 0,
    files: stats.assets,
    issues,
    journals: stats.journals,
    kept
  }
}
