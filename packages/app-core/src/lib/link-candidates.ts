/**
 * Pure link-candidate discovery and ranking — the engine behind every `[[`
 * surface. Extracted from cm-wikilinks (which keeps only the CodeMirror
 * adapters) so non-editor surfaces — the database cell pickers of #500 — rank
 * notes, assets, and databases identically to the editor's completion.
 * Everything here is store-free: callers pass the state slices they hold.
 */
import type { AssetMeta, NoteMeta, VaultSettings } from '@shared/ipc'
import type { FolderEntry } from '@shared/ipc'
import type { SelectOptionsSource } from '@shared/databases'
import { isPathInTemplateFolder, outsideTemplateFolder } from '@shared/template-folder'
import { isPrimaryNotesAtRoot, noteFolderLabel } from './vault-layout'
import { listDatabaseLinkTargets, type DatabaseLinkTarget } from './database-links'

/**
 * Scope the note pool by a select field's options source (#500): every note,
 * a folder subtree (vault-relative path prefix), or a #tag (case-insensitive).
 * A tag never offers a note in the template folder (#1024): its tags are the
 * note a template will make. A folder source naming that folder still does.
 */
export function notesMatchingSource(
  notes: NoteMeta[],
  source: SelectOptionsSource | null | undefined,
  templateFolder: string | null = null
): NoteMeta[] {
  if (!source || source.kind === 'notes') return notes
  if (source.kind === 'folder') {
    const prefix = source.path.replace(/\/+$/, '') + '/'
    return notes.filter((n) => n.path.startsWith(prefix))
  }
  const tag = source.tag.toLowerCase()
  return notes.filter(
    (n) =>
      !isPathInTemplateFolder(n.path, templateFolder) &&
      n.tags.some((t) => t.toLowerCase() === tag)
  )
}

/** The tags Options from tag suggests, lowercased and sorted: every note's,
 *  except the template folder's (#1024). */
export function tagSourceSuggestions(
  notes: readonly NoteMeta[],
  templateFolder: string | null
): string[] {
  const tags = new Set(
    outsideTemplateFolder(notes, templateFolder).flatMap((n) => n.tags.map((t) => t.toLowerCase()))
  )
  return [...tags].sort()
}

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

/** `folder/` prefix shown beside a note suggestion, the folder note search and
 *  the buffer switcher show (`noteFolderLabel`); a note at the top of the
 *  inbox shows `inbox/`, and nothing at a root-mode vault's root. */
export function noteSubtitle(
  note: NoteMeta,
  vaultSettings: VaultSettings | null | undefined
): string {
  const folder = noteFolderLabel(note, vaultSettings)
  if (folder) return `${folder}/`
  return note.folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings) ? '' : `${note.folder}/`
}

export function assetSubtitle(asset: AssetMeta): string {
  const parent = asset.path.split('/').slice(0, -1).join('/')
  const kind = asset.kind.toUpperCase()
  return parent ? `${kind} ${parent}/` : kind
}

/** `DATABASE` plus the parent folder, e.g. `DATABASE work/` (strips `/<Name>.base/data.csv`). */
export function databaseSubtitle(db: DatabaseLinkTarget): string {
  const parent = db.csvPath.split('/').slice(0, -2).join('/')
  return parent ? `DATABASE ${parent}/` : 'DATABASE'
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

/**
 * The string a wikilink should store to reach `note` unambiguously: the bare
 * title when it is unique (nicest to read), otherwise the vault path with the
 * layout-aware prefix rules the resolver expects.
 */
export function noteLinkTarget(
  note: NoteMeta,
  notes: NoteMeta[],
  vaultSettings: VaultSettings | null | undefined
): string {
  const titleNeedle = normalize(note.title)
  const titleMatches = notes.filter(
    (candidate) =>
      candidate.folder !== 'trash' && normalize(candidate.title) === titleNeedle
  )
  if (titleMatches.length === 1) return note.title

  const rel = stripMdExtension(note.path)
  if (note.folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings)) {
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

export type LinkCandidate =
  | { kind: 'note'; label: string; subtitle: string; target: string; score: number; note: NoteMeta }
  | { kind: 'asset'; label: string; subtitle: string; target: string; score: number; asset: AssetMeta }
  | { kind: 'database'; label: string; subtitle: string; target: string; score: number; db: DatabaseLinkTarget }

export interface LinkCandidateContext {
  notes: NoteMeta[]
  /** Omit (or pass []) to exclude assets from the results. */
  assetFiles?: AssetMeta[]
  /** Omit (or pass []) to exclude `.base` databases from the results. */
  folders?: FolderEntry[]
  vaultSettings: VaultSettings | null | undefined
  /** The note the query is typed in: excluded from results, boosts neighbors. */
  activePath?: string | null
  /** Result cap after ranking; the editor completion uses the default 24. */
  limit?: number
}

/**
 * Ranked link candidates for `query`, merged across notes, assets, and
 * databases exactly the way the editor's `[[` completion ranks them: lower
 * score first, ties broken by label. Trash and the active note never appear.
 */
export function linkCandidates(query: string, ctx: LinkCandidateContext): LinkCandidate[] {
  const activePath = ctx.activePath ?? null
  const limit = ctx.limit ?? 24
  const notes = ctx.notes.filter(
    (note) => note.folder !== 'trash' && note.path !== activePath
  )

  const ranked: LinkCandidate[] = notes
    .filter((note) => matchesNote(note, query))
    .map((note) => ({
      kind: 'note' as const,
      label: note.title,
      subtitle: noteSubtitle(note, ctx.vaultSettings),
      target: noteLinkTarget(note, notes, ctx.vaultSettings),
      score: scoreNote(note, query, activePath),
      note
    }))

  for (const asset of ctx.assetFiles ?? []) {
    if (!matchesAsset(asset, query)) continue
    ranked.push({
      kind: 'asset',
      label: asset.name,
      subtitle: assetSubtitle(asset),
      target: asset.path,
      score: scoreAsset(asset, query, activePath),
      asset
    })
  }

  const folders = ctx.folders ?? []
  if (folders.length > 0 && ctx.vaultSettings) {
    for (const db of listDatabaseLinkTargets(folders, ctx.vaultSettings)) {
      if (!matchesDatabase(db, query)) continue
      ranked.push({
        kind: 'database',
        label: db.title,
        subtitle: databaseSubtitle(db),
        target: db.title,
        score: scoreDatabase(db, query),
        db
      })
    }
  }

  return ranked
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.label.localeCompare(b.label)
    })
    .slice(0, limit)
}
