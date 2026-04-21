/**
 * Deterministic fuzzy ranker for palette-style inputs.
 *
 * Scoring tiers (higher beats lower):
 *   1000   exact case-insensitive match
 *   900    prefix match
 *   700    word-boundary match inside a longer string
 *   500    any-position substring match
 *   200-   subsequence match with gap/length penalty
 *     0    no match (filtered out)
 *
 * Anything that isn't at least a subsequence of the target is rejected —
 * so typing "the" stops matching "Save Note" (no 'h') the way a loose
 * Bitap search does.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scoreMatch(query: string, text: string): number {
  if (!query) return 1
  if (!text) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - t.length * 0.5
  // "the" → "Note Themes" via word-start on "Themes"
  const wordBoundary = new RegExp(`(?:^|[\\s·:_\\-/])${escapeRegex(q)}`)
  if (wordBoundary.test(t)) return 700 - t.length * 0.5
  if (t.includes(q)) return 500 - t.length * 0.5

  // Subsequence with locality penalty:
  //  - prefix gap (distance from start to first char) is penalized
  //  - gaps between consecutive matches are penalized
  //  - longer targets are slightly penalized so tight matches win ties
  let i = 0
  let gaps = 0
  let prev = -1
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (prev === -1) {
        gaps += j
      } else {
        gaps += j - prev - 1
      }
      prev = j
      i++
    }
  }
  if (i === q.length) return Math.max(1, 200 - gaps * 3 - t.length * 0.2)
  return 0
}

export interface RankField<T> {
  get: (item: T) => string | undefined
  weight?: number
}

/**
 * Rank `items` against `query` across the provided fields. An item's
 * final score is `max(field_i_score * field_i_weight)`. Non-matching
 * items are filtered out entirely.
 */
export function rankItems<T>(items: T[], query: string, fields: RankField<T>[]): T[] {
  const trimmed = query.trim()
  if (!trimmed) return items
  type Scored = { item: T; score: number }
  const scored: Scored[] = []
  for (const item of items) {
    let best = 0
    for (const f of fields) {
      const txt = f.get(item)
      if (!txt) continue
      const s = scoreMatch(trimmed, txt) * (f.weight ?? 1)
      if (s > best) best = s
    }
    if (best > 0) scored.push({ item, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
