import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from './vault-layout'

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

function queryTokens(query: string): string[] {
  return normalize(query)
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter(Boolean)
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

function wikilinkMatch(context: CompletionContext): {
  from: number
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

  return { from: line.from + openIndex + 2, query: inside }
}

export function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const match = wikilinkMatch(context)
  if (!match) return null

  const state = useStore.getState()
  const activePath = state.activeNote?.path ?? null
  const notes = state.notes.filter(
    (note) => note.folder !== 'trash' && note.path !== activePath
  )
  const ranked = notes
    .filter((note) => matchesNote(note, match.query))
    .map((note) => ({
      note,
      score: scoreNote(note, match.query, activePath)
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.note.title.localeCompare(b.note.title)
    })
    .slice(0, 24)

  const options: Completion[] = ranked.map(({ note }) => {
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
    } as Completion & {
      _kind: 'wikilink'
      _target: string
      _subtitle: string
    }
  })

  return {
    from: match.from,
    options,
    filter: false
  }
}
