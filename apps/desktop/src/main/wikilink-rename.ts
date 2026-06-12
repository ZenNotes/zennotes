/**
 * Rewriting inbound `[[wikilinks]]` when a note is renamed.
 *
 * The wikilink *resolution* here mirrors
 * `packages/app-core/src/lib/wikilinks.ts` (the renderer's source of truth):
 * a target resolves by note title (case-insensitive) unless it looks like a
 * path, in which case it resolves by explicit/suffix path match. We keep a
 * backend copy because the main process cannot import the renderer bundle.
 * The Go server carries an equivalent port in `internal/vault`.
 */

export interface RenameNoteRef {
  path: string
  title: string
  folder: string
}

const TOP_FOLDERS = ['inbox', 'quick', 'archive', 'trash']

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function stripMdExtension(value: string): string {
  return value.replace(/\.md$/i, '')
}

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase()
}

export function isPathLikeWikilinkTarget(target: string): boolean {
  const trimmed = target.trim()
  return trimmed.startsWith('/') || trimmed.includes('/') || /\.md$/i.test(trimmed)
}

function resolveExplicitPath(notes: RenameNoteRef[], target: string): RenameNoteRef | null {
  const normalized = normalizeSlashes(target.trim())
  if (!normalized) return null
  const trimmed = stripMdExtension(normalized).replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) return null

  let relPath: string | null = null
  if (normalized.startsWith('/')) {
    relPath = `inbox/${trimmed}.md`
  } else if (TOP_FOLDERS.some((folder) => trimmed.toLowerCase().startsWith(`${folder}/`))) {
    relPath = `${trimmed}.md`
  }
  if (!relPath) return null

  const needle = normalizeForCompare(relPath)
  return notes.find((note) => normalizeForCompare(note.path) === needle) ?? null
}

function resolvePathSuffix(notes: RenameNoteRef[], target: string): RenameNoteRef | null {
  const trimmed = stripMdExtension(normalizeSlashes(target.trim()))
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!trimmed) return null

  const suffix = normalizeForCompare(`/${trimmed}.md`)
  const exact = normalizeForCompare(`${trimmed}.md`)
  const matches = notes.filter((note) => {
    const path = normalizeForCompare(note.path)
    return path === exact || path.endsWith(suffix)
  })
  return matches.length === 1 ? matches[0] : null
}

export function resolveWikilinkTarget(
  notes: RenameNoteRef[],
  target: string
): RenameNoteRef | null {
  const visible = notes.filter((note) => note.folder !== 'trash')
  if (isPathLikeWikilinkTarget(target)) {
    return resolveExplicitPath(visible, target) ?? resolvePathSuffix(visible, target)
  }
  const needle = normalizeForCompare(stripMdExtension(target))
  return visible.find((note) => normalizeForCompare(note.title) === needle) ?? null
}

/** Split `[[ ... ]]` inner text into target, `#heading`/`^block` anchor, and
 *  `|alias` — the anchor/alias keep their leading delimiter so the link can be
 *  reassembled verbatim. */
function splitWikilinkContent(content: string): {
  target: string
  anchor: string
  alias: string
} {
  let rest = content
  let alias = ''
  const pipe = rest.indexOf('|')
  if (pipe >= 0) {
    alias = rest.slice(pipe)
    rest = rest.slice(0, pipe)
  }
  let anchor = ''
  const anchorIdx = rest.search(/[#^]/)
  if (anchorIdx >= 0) {
    anchor = rest.slice(anchorIdx)
    rest = rest.slice(0, anchorIdx)
  }
  return { target: rest, anchor, alias }
}

/** Replace a wikilink target's final segment (the renamed file's name) with the
 *  new title, preserving any directory prefix, leading slash, and `.md`. */
function swapBasename(target: string, newTitle: string): string {
  const slash = target.lastIndexOf('/')
  const dir = slash >= 0 ? target.slice(0, slash + 1) : ''
  const base = slash >= 0 ? target.slice(slash + 1) : target
  const md = base.match(/\.md$/i)
  return `${dir}${newTitle}${md ? md[0] : ''}`
}

// Matches a fenced code block, inline code, or a (possibly embedded) wikilink.
// Code is matched first so links inside code spans/blocks are left untouched.
const TOKEN_RE = /(```[\s\S]*?```|`[^`\n]*`)|(!?)\[\[([^\]\n]+?)\]\]/g

/**
 * Rewrite every inbound `[[target]]` / `![[target]]` in `body` whose target
 * resolves to the note at `oldPath`, pointing it at `newTitle` instead. Aliases,
 * `#heading` / `^block` anchors, and embeds are preserved; code is skipped.
 *
 * `notes` must reflect the pre-rename vault (the renamed note still under its
 * old title/path) so resolution matches what the links currently point to.
 */
export function rewriteWikilinksForRename(
  body: string,
  notes: RenameNoteRef[],
  oldPath: string,
  newTitle: string
): { body: string; changed: number } {
  let changed = 0
  const next = body.replace(TOKEN_RE, (full, code, embed, content) => {
    if (code !== undefined) return full
    const { target, anchor, alias } = splitWikilinkContent(content as string)
    if (resolveWikilinkTarget(notes, target)?.path !== oldPath) return full
    const newTarget = swapBasename(target, newTitle)
    if (newTarget === target) return full
    changed++
    return `${embed}[[${newTarget}${anchor}${alias}]]`
  })
  return { body: next, changed }
}
