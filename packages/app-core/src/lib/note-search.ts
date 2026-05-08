import type { NoteMeta } from '@shared/ipc'

export interface NoteSearchEntry {
  note: NoteMeta
  title: string
  titleLower: string
  path: string
  pathLower: string
  excerpt: string
  excerptLower: string
  tags: string
  tagsLower: string[]
}

export interface ParsedNoteSearchQuery {
  freeText: string
  tagTokens: string[]
}

export type NoteSearchDefaultOrder = 'current' | 'quick-first-recent'

const LONG_QUERY_EXACT_FIRST_CHARS = 16

export function buildNoteSearchIndex(notes: NoteMeta[]): NoteSearchEntry[] {
  return notes.map((note) => {
    const tagsLower = note.tags.map((tag) => tag.toLowerCase())
    return {
      note,
      title: note.title,
      titleLower: note.title.toLowerCase(),
      path: note.path,
      pathLower: note.path.toLowerCase(),
      excerpt: note.excerpt,
      excerptLower: note.excerpt.toLowerCase(),
      tags: tagsLower.join(' '),
      tagsLower
    }
  })
}

export function parseNoteSearchQuery(query: string): ParsedNoteSearchQuery {
  const tags: string[] = []
  const text: string[] = []
  for (const token of query.split(/\s+/)) {
    if (!token) continue
    if (token.startsWith('#') && token.length > 1) tags.push(token.slice(1).toLowerCase())
    else text.push(token)
  }
  return { freeText: text.join(' ').trim(), tagTokens: tags }
}

function matchesTags(entry: NoteSearchEntry, tagTokens: string[]): boolean {
  if (tagTokens.length === 0) return true
  return tagTokens.every((tag) => entry.tagsLower.includes(tag))
}

function defaultSort(
  entries: NoteSearchEntry[],
  order: NoteSearchDefaultOrder
): NoteSearchEntry[] {
  if (order === 'current') return entries
  return [...entries].sort((a, b) => {
    if (a.note.folder === 'quick' && b.note.folder !== 'quick') return -1
    if (b.note.folder === 'quick' && a.note.folder !== 'quick') return 1
    return b.note.updatedAt - a.note.updatedAt
  })
}

function isSearchWordBoundary(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '·' ||
    char === ':' ||
    char === '_' ||
    char === '-' ||
    char === '/'
  )
}

function scoreExactPreparedMatch(query: string, text: string): number {
  if (!query) return 1
  if (!text) return 0
  if (text === query) return 1000
  if (text.startsWith(query)) return 900 - text.length * 0.5
  // "the" -> "Note Themes" via word-start on "Themes".
  let index = text.indexOf(query)
  if (index === -1) return 0
  while (index !== -1) {
    if (index === 0 || isSearchWordBoundary(text[index - 1])) {
      return 700 - text.length * 0.5
    }
    index = text.indexOf(query, index + 1)
  }
  return 500 - text.length * 0.5
}

function scorePreparedMatch(query: string, text: string, allowFuzzy = true): number {
  const exactScore = scoreExactPreparedMatch(query, text)
  if (exactScore > 0 || !allowFuzzy || query.length > text.length) return exactScore

  let i = 0
  let gaps = 0
  let prev = -1
  for (let j = 0; j < text.length && i < query.length; j += 1) {
    if (text[j] === query[i]) {
      gaps += prev === -1 ? j : j - prev - 1
      prev = j
      i += 1
    }
  }
  if (i === query.length) return Math.max(1, 200 - gaps * 3 - text.length * 0.2)
  return 0
}

function scoreNote(entry: NoteSearchEntry, query: string, allowFuzzy = true): number {
  return Math.max(
    scorePreparedMatch(query, entry.titleLower, allowFuzzy) * 0.7,
    scorePreparedMatch(query, entry.pathLower, allowFuzzy) * 0.25,
    scorePreparedMatch(query, entry.excerptLower, allowFuzzy) * 0.2,
    scorePreparedMatch(query, entry.tags, allowFuzzy) * 0.1
  )
}

function insertTopMatch<T extends { score: number }>(
  matches: T[],
  next: T,
  limit: number
): void {
  if (matches.length < limit) {
    matches.push(next)
    return
  }

  let lowestIndex = 0
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index].score < matches[lowestIndex].score) lowestIndex = index
  }
  if (next.score > matches[lowestIndex].score) matches[lowestIndex] = next
}

export function searchNoteIndex(
  entries: NoteSearchEntry[],
  query: string,
  options: {
    limit: number
    defaultOrder?: NoteSearchDefaultOrder
  }
): NoteMeta[] {
  const { freeText, tagTokens } = parseNoteSearchQuery(query)
  const limit = Math.max(0, options.limit)
  if (limit === 0) return []

  if (!freeText) {
    const live = entries.filter(
      (entry) => entry.note.folder !== 'trash' && matchesTags(entry, tagTokens)
    )
    return defaultSort(live, options.defaultOrder ?? 'current')
      .slice(0, limit)
      .map((entry) => entry.note)
  }

  const preparedQuery = freeText.toLowerCase()
  const matches: Array<{ entry: NoteSearchEntry; score: number }> = []
  if (preparedQuery.length >= LONG_QUERY_EXACT_FIRST_CHARS) {
    for (const entry of entries) {
      if (entry.note.folder === 'trash' || !matchesTags(entry, tagTokens)) continue
      const score = scoreNote(entry, preparedQuery, false)
      if (score <= 0) continue
      insertTopMatch(matches, { entry, score }, limit)
    }

    if (matches.length > 0) {
      return matches
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          return b.entry.note.updatedAt - a.entry.note.updatedAt
        })
        .map((match) => match.entry.note)
    }
  }

  for (const entry of entries) {
    if (entry.note.folder === 'trash' || !matchesTags(entry, tagTokens)) continue
    const score = scoreNote(entry, preparedQuery)
    if (score <= 0) continue
    insertTopMatch(matches, { entry, score }, limit)
  }

  return matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.entry.note.updatedAt - a.entry.note.updatedAt
    })
    .map((match) => match.entry.note)
}
