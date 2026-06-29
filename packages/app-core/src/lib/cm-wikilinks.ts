import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { AssetMeta, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from './vault-layout'
import { resolveWikilinkTarget } from './wikilinks'
import { parseOutline } from './outline'
import { listDatabaseLinkTargets, type DatabaseLinkTarget } from './database-links'

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function compact(value: string): string {
  return normalize(value).replace(/[^a-z0-9/]+/g, '')
}

function initials(value: string): string {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
}

function stripMdExtension(value: string): string {
  return value.replace(/\.md$/i, '')
}

function folderLabelFor(note: NoteMeta): string {
  const vaultSettings = useStore.getState().vaultSettings
  const subpath = noteFolderSubpath(note, vaultSettings)
  if (note.folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings)) {
    return subpath ? `${subpath}/` : ''
  }
  return subpath ? `${subpath}/` : `${note.folder}/`
}

function folderLabelForAsset(asset: AssetMeta): string {
  const parent = asset.path.split('/').slice(0, -1).join('/')
  const kind = asset.kind.toUpperCase()
  return parent ? `${kind} ${parent}/` : kind
}

function queryTokens(query: string): string[] {
  return normalize(query)
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function matchesAsset(asset: AssetMeta, query: string): boolean {
  const q = normalize(query)
  if (!q) return true

  const name = normalize(asset.name)
  const path = normalize(asset.path)
  const compactName = compact(asset.name)
  const compactPath = compact(asset.path)
  const compactQuery = compact(query)

  if (name.includes(q) || path.includes(q)) return true

  if (compactQuery && (compactName.includes(compactQuery) || compactPath.includes(compactQuery))) {
    return true
  }

  const tokens = queryTokens(query)
  if (tokens.length > 1) {
    const nameWords = name.split(/[\s._-]+/).filter(Boolean)
    const pathParts = path.split('/').flatMap((part) => part.split(/[\s._-]+/)).filter(Boolean)
    return tokens.every(
      (token) =>
        nameWords.some((word) => word.startsWith(token)) ||
        pathParts.some((part) => part.startsWith(token))
    )
  }

  return compactQuery.length >= 2 && (
    initials(asset.name).startsWith(compactQuery) ||
    initials(asset.path).startsWith(compactQuery)
  )
}

function matchesNote(note: NoteMeta, query: string): boolean {
  const q = normalize(query)
  if (!q) return true

  const title = normalize(note.title)
  const path = normalize(stripMdExtension(note.path))
  const compactTitle = compact(note.title)
  const compactPath = compact(stripMdExtension(note.path))
  const compactQuery = compact(query)

  if (title.includes(q) || path.includes(q)) return true

  if (compactQuery && (compactTitle.includes(compactQuery) || compactPath.includes(compactQuery))) {
    return true
  }

  const tokens = queryTokens(query)
  if (tokens.length > 1) {
    const titleWords = title.split(/[\s/_-]+/).filter(Boolean)
    const pathParts = path.split('/').flatMap((part) => part.split(/[\s._-]+/)).filter(Boolean)
    return tokens.every(
      (token) =>
        titleWords.some((word) => word.startsWith(token)) ||
        pathParts.some((part) => part.startsWith(token))
    )
  }

  return compactQuery.length >= 2 && (
    initials(note.title).startsWith(compactQuery) ||
    initials(stripMdExtension(note.path)).startsWith(compactQuery)
  )
}

function noteTargetFor(note: NoteMeta, notes: NoteMeta[]): string {
  const titleNeedle = normalize(note.title)
  const titleMatches = notes.filter(
    (candidate) =>
      candidate.folder !== 'trash' && normalize(candidate.title) === titleNeedle
  )
  if (titleMatches.length === 1) return note.title

  const rel = stripMdExtension(note.path)
  if (note.folder === 'inbox' && isPrimaryNotesAtRoot(useStore.getState().vaultSettings)) {
    return `/${rel}`
  }
  if (rel.startsWith('inbox/')) return `/${rel.slice('inbox/'.length)}`
  return rel
}

function scoreAsset(asset: AssetMeta, query: string, activePath: string | null): number {
  const name = normalize(asset.name)
  const path = normalize(asset.path)
  const q = normalize(query)
  let score = 4

  if (q) {
    if (name === q) score -= 112
    else if (name.startsWith(q)) score -= 84
    else if (name.split(/[\s._-]+/).some((word) => word.startsWith(q))) score -= 72
    else if (name.includes(q)) score -= 56
    else if (path.endsWith(`/${q}`) || path === q) score -= 42
    else if (path.split('/').some((part) => part.startsWith(q))) score -= 34
    else if (path.includes(q)) score -= 18
    else {
      const compactQuery = compact(query)
      const compactName = compact(asset.name)
      const compactPath = compact(asset.path)
      if (compactQuery && compactName.includes(compactQuery)) score -= 38
      else if (compactQuery && compactPath.includes(compactQuery)) score -= 22
      else if (compactQuery.length >= 2 && initials(asset.name).startsWith(compactQuery)) score -= 14
      else if (compactQuery.length >= 2 && initials(asset.path).startsWith(compactQuery)) score -= 7
      else score += 200
    }
  }

  if (activePath) {
    const activeParent = activePath.split('/').slice(0, -1).join('/')
    const assetParent = asset.path.split('/').slice(0, -1).join('/')
    if (assetParent === activeParent) score -= 12
  }

  return score
}

function scoreNote(note: NoteMeta, query: string, activePath: string | null): number {
  const title = normalize(note.title)
  const path = normalize(stripMdExtension(note.path))
  const q = normalize(query)
  let score = 0

  if (q) {
    if (title === q) score -= 120
    else if (title.startsWith(q)) score -= 90
    else if (title.split(/[\s/_-]+/).some((word) => word.startsWith(q))) score -= 78
    else if (title.includes(q)) score -= 60
    else if (path.endsWith(`/${q}`) || path === q) score -= 45
    else if (path.split('/').some((part) => part.startsWith(q))) score -= 36
    else if (path.includes(q)) score -= 20
    else {
      const compactQuery = compact(query)
      const compactTitle = compact(note.title)
      const compactPath = compact(stripMdExtension(note.path))
      if (compactQuery && compactTitle.includes(compactQuery)) score -= 42
      else if (compactQuery && compactPath.includes(compactQuery)) score -= 24
      else if (compactQuery.length >= 2 && initials(note.title).startsWith(compactQuery)) score -= 16
      else if (compactQuery.length >= 2 && initials(stripMdExtension(note.path)).startsWith(compactQuery)) score -= 8
      else score += 200
    }
  }

  if (activePath) {
    const activeParent = activePath.split('/').slice(0, -1).join('/')
    const noteParent = note.path.split('/').slice(0, -1).join('/')
    if (noteParent === activeParent) score -= 18
    else if (note.folder === activePath.split('/')[0]) score -= 6
  }

  return score
}

function matchesDatabase(db: DatabaseLinkTarget, query: string): boolean {
  const q = normalize(query)
  if (!q) return true

  const title = normalize(db.title)
  const compactTitle = compact(db.title)
  const compactQuery = compact(query)

  if (title.includes(q)) return true
  if (compactQuery && compactTitle.includes(compactQuery)) return true

  const tokens = queryTokens(query)
  if (tokens.length > 1) {
    const titleWords = title.split(/[\s/_-]+/).filter(Boolean)
    return tokens.every((token) => titleWords.some((word) => word.startsWith(token)))
  }

  return compactQuery.length >= 2 && initials(db.title).startsWith(compactQuery)
}

function scoreDatabase(db: DatabaseLinkTarget, query: string): number {
  const title = normalize(db.title)
  const q = normalize(query)
  // Base 2: tie-break just after same-strength notes, ahead of generic assets.
  let score = 2

  if (q) {
    if (title === q) score -= 116
    else if (title.startsWith(q)) score -= 86
    else if (title.split(/[\s/_-]+/).some((word) => word.startsWith(q))) score -= 74
    else if (title.includes(q)) score -= 58
    else {
      const compactQuery = compact(query)
      const compactTitle = compact(db.title)
      if (compactQuery && compactTitle.includes(compactQuery)) score -= 40
      else if (compactQuery.length >= 2 && initials(db.title).startsWith(compactQuery)) score -= 15
      else score += 200
    }
  }

  return score
}

/** `DATABASE` plus the parent folder, e.g. `DATABASE work/` (strips `/<Name>.base/data.csv`). */
function databaseSubtitle(db: DatabaseLinkTarget): string {
  const parent = db.csvPath.split('/').slice(0, -2).join('/')
  return parent ? `DATABASE ${parent}/` : 'DATABASE'
}

function wikilinkMatch(context: CompletionContext): {
  openFrom: number
  from: number
  hasBangPrefix: boolean
  query: string
} | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const openIndex = before.lastIndexOf('[[')
  if (openIndex < 0) return null

  const inside = before.slice(openIndex + 2)
  if (inside.includes(']]')) return null
  if (inside.includes('|')) return null
  if (inside.includes('#') || inside.includes('^')) return null

  return {
    openFrom: line.from + openIndex,
    from: line.from + openIndex + 2,
    hasBangPrefix: openIndex > 0 && before[openIndex - 1] === '!',
    query: inside
  }
}

type WikilinkCompletion = Completion & {
  _kind: 'wikilink'
  _target: string
  _subtitle: string
}

export function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const match = wikilinkMatch(context)
  if (!match) return null

  const state = useStore.getState()
  const activePath = state.activeNote?.path ?? null
  const notes = state.notes.filter(
    (note) => note.folder !== 'trash' && note.path !== activePath
  )
  const rankedNotes = notes
    .filter((note) => matchesNote(note, match.query))
    .map((note) => ({
      kind: 'note' as const,
      note,
      score: scoreNote(note, match.query, activePath)
    }))

  const rankedAssets = state.assetFiles
    .filter((asset) => matchesAsset(asset, match.query))
    .map((asset) => ({
      kind: 'asset' as const,
      asset,
      score: scoreAsset(asset, match.query, activePath)
    }))

  // CSV "databases" (`.base` folders) are linkable too — they live in the
  // folder list, not `notes`/`assetFiles`, so they need their own pass. (#238)
  const rankedDatabases = listDatabaseLinkTargets(state.folders, state.vaultSettings)
    .filter((db) => matchesDatabase(db, match.query))
    .map((db) => ({
      kind: 'database' as const,
      db,
      score: scoreDatabase(db, match.query)
    }))

  type RankedCandidate =
    | { kind: 'note'; note: NoteMeta; score: number }
    | { kind: 'asset'; asset: AssetMeta; score: number }
    | { kind: 'database'; db: DatabaseLinkTarget; score: number }
  const labelOf = (c: RankedCandidate): string =>
    c.kind === 'note' ? c.note.title : c.kind === 'asset' ? c.asset.name : c.db.title

  const ranked: RankedCandidate[] = [...rankedNotes, ...rankedAssets, ...rankedDatabases]
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return labelOf(a).localeCompare(labelOf(b))
    })
    .slice(0, 24)

  const options: Completion[] = ranked.map((candidate) => {
    if (candidate.kind === 'asset') {
      const target = candidate.asset.path
      const subtitle = folderLabelForAsset(candidate.asset)
      return {
        label: candidate.asset.name,
        detail: subtitle,
        type: candidate.asset.kind === 'image' ? 'image' : 'file',
        _kind: 'wikilink',
        _target: target,
        _subtitle: subtitle,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const existingClose = view.state.doc.sliceString(to, to + 2) === ']]'
          const insert = `${target}${existingClose ? '' : ']]'}`
          const addBangPrefix = !match.hasBangPrefix
          view.dispatch({
            changes: addBangPrefix
              ? [
                  { from: match.openFrom, to: match.openFrom, insert: '!' },
                  { from, to, insert }
                ]
              : { from, to, insert },
            selection: {
              anchor: from + target.length + (existingClose ? 0 : 2) + (addBangPrefix ? 1 : 0)
            }
          })
        }
      } as WikilinkCompletion
    }

    if (candidate.kind === 'database') {
      const target = candidate.db.title
      const subtitle = databaseSubtitle(candidate.db)
      return {
        label: candidate.db.title,
        detail: subtitle,
        type: 'class',
        _kind: 'wikilink',
        _target: target,
        _subtitle: subtitle,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const existingClose = view.state.doc.sliceString(to, to + 2) === ']]'
          const insert = `${target}${existingClose ? '' : ']]'}`
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + target.length + (existingClose ? 0 : 2) }
          })
        }
      } as WikilinkCompletion
    }

    const note = candidate.note
    const target = noteTargetFor(note, notes)
    return {
      label: note.title,
      detail: folderLabelFor(note),
      type: 'text',
      _kind: 'wikilink',
      _target: target,
      _subtitle: folderLabelFor(note),
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const existingClose = view.state.doc.sliceString(to, to + 2) === ']]'
        const insert = `${target}${existingClose ? '' : ']]'}`
        const anchor = from + target.length + (existingClose ? 0 : 2)
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor }
        })
      }
    } as WikilinkCompletion
  })

  return {
    from: match.from,
    options,
    filter: false
  }
}

/**
 * Match `[[Note#<headingQuery>` so we can suggest the target note's headings.
 * The note is everything before the first `#`; the heading query is whatever
 * follows the last `#` (so nested `#a#b` still completes the deepest part).
 */
function wikilinkHeadingMatch(context: CompletionContext): {
  from: number
  notePart: string
  query: string
} | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const openIndex = before.lastIndexOf('[[')
  if (openIndex < 0) return null

  const inside = before.slice(openIndex + 2)
  if (inside.includes(']]') || inside.includes('|')) return null
  const firstHash = inside.indexOf('#')
  if (firstHash < 0) return null // no heading anchor — `wikilinkSource` owns this
  const lastHash = inside.lastIndexOf('#')

  return {
    from: line.from + openIndex + 2 + lastHash + 1,
    notePart: inside.slice(0, firstHash).trim(),
    query: inside.slice(lastHash + 1)
  }
}

// Bodies fetched for heading completion are cached so typing the heading query
// doesn't re-read the file on every keystroke (`validFor` keeps the option list
// while the query stays anchor-shaped, so this mostly matters across notes).
const headingBodyCache = new Map<string, string>()

/**
 * Autocomplete headings inside a wikilink: typing `[[Note#` (or `[[#` for the
 * current note) suggests that note's headings. (#196)
 */
export async function wikilinkHeadingSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  const match = wikilinkHeadingMatch(context)
  if (!match) return null

  const state = useStore.getState()
  const note = match.notePart
    ? resolveWikilinkTarget(state.notes, match.notePart)
    : state.activeNote
  if (!note) return null

  let body =
    state.noteContents[note.path]?.body ??
    (note as { body?: string }).body ?? // activeNote ([[#…]]) already carries its body
    headingBodyCache.get(note.path)
  if (body == null) {
    try {
      body = (await window.zen.readNote(note.path)).body
      headingBodyCache.set(note.path, body)
    } catch {
      return null
    }
  }

  const seen = new Set<string>()
  const options: Completion[] = []
  for (const heading of parseOutline(body)) {
    const text = heading.text.trim()
    const key = normalize(text)
    if (!text || seen.has(key)) continue
    seen.add(key)
    options.push({
      label: text,
      detail: `H${heading.level}`,
      type: 'text',
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const existingClose = view.state.doc.sliceString(to, to + 2) === ']]'
        const insert = `${text}${existingClose ? '' : ']]'}`
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + text.length + (existingClose ? 0 : 2) }
        })
      }
    })
    if (options.length >= 100) break
  }
  if (options.length === 0) return null

  // Default filter (fuzzy) on the heading query; validFor lets CodeMirror keep
  // and filter the list client-side while the query stays anchor-shaped.
  return { from: match.from, options, validFor: /^[^\]|]*$/ }
}
