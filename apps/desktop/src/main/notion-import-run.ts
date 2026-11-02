/**
 * One Notion import, from reading the workspace to the finished folder in the
 * vault. Everything is built in a staging folder outside the vault and moved in
 * as one step, so the vault never holds half an import, a sync never uploads
 * one, and undoing an import means deleting one folder.
 *
 * No electron in here: the run takes its fetch and its folders as arguments,
 * so a test can drive all of it against a stand-in for Notion.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { assembleNotionImport, type NotionFileTimes } from '@shared/notion-import/assemble'
import { NotionAbortError, type NotionClient } from '@shared/notion-import/client'
import {
  collectNotionWorkspace,
  type NotionImportStore,
  type NotionStoredFile
} from '@shared/notion-import/collect'
import { NOTION_REPORT_NAME } from '@shared/notion-import/plan-paths'
import type {
  NotionImportProgress,
  NotionImportResult
} from '@zennotes/bridge-contract/notion-import'
import { writeNoteCreatedAt } from './note-creation-metadata'

export const NOTION_IMPORT_FOLDER = 'Notion Import'

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
}

/** A page can point at any URL, and this fetch runs on the person's machine,
 *  inside their network. Nothing on it gets fetched because a note said so. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

/** Names the type where the URL gave no extension: an outside image is often
 *  `/photo-123?w=800`, and with no extension it wouldn't embed. */
function nameWithExtension(name: string, contentType: string | null): string {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name
  const ext = contentType ? EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] : undefined
  return ext ? `${name}${ext}` : name
}

export type FileFetch = (url: string, init: { signal?: AbortSignal }) => Promise<Response>

/** Reads and writes in staging. Records and files are named by a hash of their
 *  key: keys hold ids and property names, which aren't filename material. */
export function createStagingStore(
  dir: string,
  fetchFile: FileFetch,
  options: { signal?: AbortSignal; allowInsecureFiles?: boolean } = {}
): NotionImportStore {
  const recordPath = (key: string): string => path.join(dir, 'records', `${hashKey(key)}.json`)
  const filePath = (key: string): string => path.join(dir, 'files', hashKey(key))
  const fileIndexPath = (key: string): string => path.join(dir, 'files', `${hashKey(key)}.json`)

  const writeAtomic = async (target: string, content: string): Promise<void> => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, target)
  }

  return {
    readRecord: async <T,>(key: string): Promise<T | null> => {
      try {
        return JSON.parse(await fs.readFile(recordPath(key), 'utf8')) as T
      } catch {
        return null
      }
    },
    writeRecord: (key, value) => writeAtomic(recordPath(key), JSON.stringify(value)),
    hasFile: async (key) => {
      try {
        await fs.access(fileIndexPath(key))
        return true
      } catch {
        return false
      }
    },
    downloadFile: async (key, url, suggestedName) => {
      const { protocol, hostname } = new URL(url)
      if (protocol !== 'https:' && !(options.allowInsecureFiles && protocol === 'http:')) {
        throw new Error(`Refused a file link over ${protocol}`)
      }
      if (!options.allowInsecureFiles && isPrivateHost(hostname)) {
        throw new Error('Refused a file link to a private address')
      }
      const response = await fetchFile(url, { signal: options.signal })
      if (!response.ok || !response.body) throw new Error(`The file link answered ${response.status}`)
      const contentType = response.headers.get('content-type')
      // A link that answers with a web page isn't the file it named.
      if (/^text\/html/i.test(contentType ?? '') && !/\.html?$/i.test(suggestedName)) {
        await response.body.cancel().catch(() => undefined)
        throw new Error('The file link answered with a web page')
      }
      const target = filePath(key)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.tmp`
      // Streamed: an attachment can be far bigger than this process wants to hold.
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        createWriteStream(temporary)
      )
      await fs.rename(temporary, target)
      await writeAtomic(
        fileIndexPath(key),
        JSON.stringify({ key, name: nameWithExtension(suggestedName, contentType) })
      )
    },
    listFiles: async () => {
      const filesDir = path.join(dir, 'files')
      const names = await fs.readdir(filesDir).catch(() => [] as string[])
      const out: NotionStoredFile[] = []
      for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        try {
          out.push(JSON.parse(await fs.readFile(path.join(filesDir, name), 'utf8')) as NotionStoredFile)
        } catch {
          // A torn index means the file never finished: it was never placed.
        }
      }
      return out.sort((a, b) => a.key.localeCompare(b.key))
    }
  }
}

function insideOut(outDir: string, relative: string): string {
  const target = path.resolve(outDir, relative)
  if (!target.startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error(`Import path escapes its folder: ${relative}`)
  }
  return target
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export async function unusedFolderName(parent: string, base: string): Promise<string> {
  let name = base
  let n = 1
  while (await pathExists(path.join(parent, name))) {
    n += 1
    name = `${base} ${n}`
  }
  return name
}

export async function moveIntoVault(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  // The vault is on another volume. The copy lands under a dot name, which no
  // walker descends into, and appears whole with the final rename.
  const partial = path.join(path.dirname(to), `.${path.basename(to)}.partial`)
  await fs.rm(partial, { recursive: true, force: true })
  await fs.cp(from, partial, { recursive: true, preserveTimestamps: true })
  await fs.rename(partial, to)
}

export interface NotionRunOptions {
  client: NotionClient
  store: NotionImportStore
  stagingDir: string
  /** The vault. */
  root: string
  /** Where the vault keeps its notes, with system-folder remaps applied. */
  notesRoot: string
  includeTasks: boolean
  excluded?: string[]
  onProgress: (progress: NotionImportProgress) => void
  signal?: AbortSignal
  today?: string
}

export async function runNotionImport(options: NotionRunOptions): Promise<NotionImportResult> {
  const { client, store, stagingDir, root, notesRoot, onProgress } = options

  // The client only stops at its next request, and neither writing nor the
  // move makes one: a Stop pressed after the last page must still hold.
  const stopIfAsked = (): void => {
    if (options.signal?.aborted) throw new NotionAbortError()
  }

  const collected = await collectNotionWorkspace({ client, store, excluded: options.excluded, onProgress })
  stopIfAsked()

  await fs.mkdir(notesRoot, { recursive: true })
  const folderName = await unusedFolderName(notesRoot, NOTION_IMPORT_FOLDER)
  const finalDir = path.join(notesRoot, folderName)
  const vaultFolder = path.relative(root, finalDir).split(path.sep).join('/')
  const outDir = path.join(stagingDir, 'out')
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const createdDates = new Map<string, number>()
  const summary = await assembleNotionImport({
    collected,
    store,
    sink: {
      writeText: async (relative: string, content: string, times?: NotionFileTimes) => {
        const target = insideOut(outDir, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf8')
        if (times?.updatedMs) {
          const when = new Date(times.updatedMs)
          await fs.utimes(target, when, when)
        }
        if (times?.createdMs) createdDates.set(relative, times.createdMs)
      },
      placeFile: async (key: string, relative: string) => {
        const target = insideOut(outDir, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(path.join(stagingDir, 'files', hashKey(key)), target, fs.constants.COPYFILE_FICLONE)
      }
    },
    import: { vaultFolder, includeTasks: options.includeTasks, today: options.today },
    onProgress: (done, total) => {
      stopIfAsked()
      onProgress({ phase: 'writing', done, total })
    }
  })

  stopIfAsked()
  await moveIntoVault(outDir, finalDir)
  // The move kept modified times. Created dates live beside the notes, the
  // same place a rename keeps them.
  for (const [relative, createdAt] of createdDates) {
    await writeNoteCreatedAt(root, `${vaultFolder}/${relative}`, createdAt).catch(() => undefined)
  }
  await fs.rm(stagingDir, { recursive: true, force: true })

  return {
    folder: vaultFolder,
    reportPath: `${vaultFolder}/${NOTION_REPORT_NAME}.md`,
    pages: summary.pages,
    databases: summary.databases,
    rows: summary.rows,
    files: summary.files,
    issues: summary.issues.length
  }
}
