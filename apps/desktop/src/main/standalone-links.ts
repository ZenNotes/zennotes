/**
 * Following a link from a note that has no vault.
 *
 * A markdown file opened from outside every known vault (Finder "Open With",
 * a double-click, `zn open <file>`) lives in a standalone window with no vault
 * behind it, and every resolver in the app is vault-bound: wikilinks look up
 * the vault's note index, relative links resolve against a vault-relative note
 * path, and both end in "open this note in the workspace". None of that has
 * anything to stand on for a loose file, so every link in that window was
 * dead (#626).
 *
 * The one thing a loose file does have is a directory. This resolves a link
 * the way the file's author meant it: a relative href from the file's own
 * directory, a `[[wikilink]]` by name within that directory's tree (a
 * generated wiki keeps its pages together), and the result is handed back
 * to the Finder opener, which already knows whether an absolute markdown path
 * belongs to a known vault or gets a standalone window of its own.
 */
import path from 'node:path'
import { promises as fsp, type Dirent } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMarkdownFilePath, MARKDOWN_FILE_EXTENSIONS } from './file-open'

export type StandaloneLink =
  | { kind: 'wikilink'; target: string }
  | { kind: 'href'; href: string }

export type StandaloneLinkTarget =
  | { kind: 'markdown'; absPath: string }
  | { kind: 'file'; absPath: string }

export interface StandaloneLinkIo {
  isFile(absPath: string): Promise<boolean>
  readdir(absPath: string): Promise<Dirent[]>
}

const defaultIo: StandaloneLinkIo = {
  async isFile(absPath) {
    try {
      return (await fsp.stat(absPath)).isFile()
    } catch {
      return false
    }
  },
  readdir: (absPath) => fsp.readdir(absPath, { withFileTypes: true })
}

/** How far below the note's directory a bare wikilink name is looked for. A
 *  generated wiki nests a few levels at most; a whole home directory is not a
 *  place to go looking for `[[notes]]`. */
export const WIKILINK_SEARCH_DEPTH = 4
/** Upper bound on directory entries visited for one lookup. */
export const WIKILINK_SEARCH_BUDGET = 5000

const SKIPPED_DIRS = new Set(['node_modules', '.git'])

/** True for a StandaloneLink shape the renderer may send; anything else is
 *  refused before it reaches the filesystem. */
export function isStandaloneLink(value: unknown): value is StandaloneLink {
  if (!value || typeof value !== 'object') return false
  const link = value as { kind?: unknown; target?: unknown; href?: unknown }
  if (link.kind === 'wikilink') return typeof link.target === 'string'
  if (link.kind === 'href') return typeof link.href === 'string'
  return false
}

/**
 * The file a link from `notePath` names, or null when it names nothing on
 * disk. Web URLs, mail links, in-page anchors and app schemes are not files
 * and resolve to null here; the renderer keeps those on their own paths.
 */
export async function resolveStandaloneLink(
  notePath: string,
  link: StandaloneLink,
  io: StandaloneLinkIo = defaultIo
): Promise<StandaloneLinkTarget | null> {
  const noteDir = path.dirname(path.resolve(notePath))
  const abs =
    link.kind === 'wikilink'
      ? await resolveWikilink(noteDir, link.target, io)
      : await resolveHref(noteDir, link.href, io)
  if (!abs) return null
  return { kind: isMarkdownFilePath(abs) ? 'markdown' : 'file', absPath: abs }
}

async function resolveHref(
  noteDir: string,
  rawHref: string,
  io: StandaloneLinkIo
): Promise<string | null> {
  const href = rawHref.trim()
  if (!href || href.startsWith('#')) return null
  let candidate: string
  if (/^file:\/\//i.test(href)) {
    try {
      candidate = fileURLToPath(href)
    } catch {
      return null
    }
  } else {
    // Any other scheme (https:, mailto:, zen-asset:, a Windows drive letter is
    // handled below) is not a path from this directory.
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) return null
    const pathOnly = href.split(/[?#]/)[0] ?? href
    let decoded = pathOnly
    try {
      decoded = decodeURIComponent(pathOnly)
    } catch {
      // A stray `%` in a hand-written link is still a path.
    }
    if (!decoded) return null
    candidate = path.isAbsolute(decoded) ? decoded : path.resolve(noteDir, decoded)
  }
  return await existingFile(candidate, io)
}

/** `candidate` when it is a file, else the markdown file it names without an
 *  extension (`[Readme](../README)` for `README.md`), else null. */
async function existingFile(candidate: string, io: StandaloneLinkIo): Promise<string | null> {
  if (await io.isFile(candidate)) return candidate
  if (path.extname(candidate)) return null
  for (const ext of MARKDOWN_FILE_EXTENSIONS) {
    if (await io.isFile(candidate + ext)) return candidate + ext
  }
  return null
}

async function resolveWikilink(
  noteDir: string,
  rawTarget: string,
  io: StandaloneLinkIo
): Promise<string | null> {
  // `[[Doc|alias]]`, `[[Doc#Heading]]` and `[[Doc^block]]` all name Doc.
  const target = rawTarget.split('|')[0].split(/[#^]/)[0].trim()
  if (!target) return null
  // A path-like target is Obsidian's "relative to this note" form.
  if (target.includes('/') || /\.(md|markdown)$/i.test(target)) {
    const found = await existingFile(path.resolve(noteDir, target), io)
    if (found) return found
    if (!/\.(md|markdown)$/i.test(target)) return null
    return null
  }
  return await findByName(noteDir, target, io)
}

/** The shallowest markdown file named `name` (case-insensitively, extension
 *  aside) under `root`, ties broken alphabetically for a stable answer. */
async function findByName(root: string, name: string, io: StandaloneLinkIo): Promise<string | null> {
  const wanted = name.toLowerCase()
  let visited = 0
  let level: string[] = [root]
  for (let depth = 0; depth <= WIKILINK_SEARCH_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    const hits: string[] = []
    for (const dir of level.sort()) {
      let entries: Dirent[]
      try {
        entries = await io.readdir(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (++visited > WIKILINK_SEARCH_BUDGET) return hits.sort()[0] ?? null
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) next.push(full)
          continue
        }
        if (!entry.isFile() || !isMarkdownFilePath(entry.name)) continue
        const stem = entry.name.slice(0, entry.name.length - path.extname(entry.name).length)
        if (stem.toLowerCase() === wanted) hits.push(full)
      }
    }
    if (hits.length > 0) return hits.sort()[0]
    level = next
  }
  return null
}
