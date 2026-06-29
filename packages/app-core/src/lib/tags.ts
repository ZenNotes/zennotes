/**
 * Extract `#tags` from a markdown body. Mirrors the extraction the
 * main process runs in `vault.ts` so the sidebar can update tag
 * counts *live* as the user types, instead of waiting for the save +
 * chokidar round-trip.
 *
 * Rules:
 *  - The hash must be preceded by start-of-line or whitespace (so
 *    `me#tag` and `url.com/#x` don't match).
 *  - The first tag character must be a letter in any script (Cyrillic,
 *    CJK, … — #205), the rest can be letters, digits, `_`, `-`, or `/`.
 *  - Fenced code blocks and inline code spans are stripped first.
 *  - Heading markers (`#`, `##`, …) are not a hashtag because the
 *    character after the hash is a space, not a letter.
 */
export function extractTags(body: string): string[] {
  const stripped = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const regex = /(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = regex.exec(stripped)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Does a note's tags satisfy the Tags-view selection? `all` = the note carries
 * every selected tag (AND, the narrowing default, #221); `any` = it carries at
 * least one (OR). Case-insensitive. No selection → no match.
 */
export function matchesSelectedTags(
  noteTags: readonly string[],
  selectedTags: readonly string[],
  mode: 'all' | 'any'
): boolean {
  if (selectedTags.length === 0) return false
  const have = new Set(noteTags.map((t) => t.toLowerCase()))
  const want = selectedTags.map((t) => t.toLowerCase())
  return mode === 'any' ? want.some((t) => have.has(t)) : want.every((t) => have.has(t))
}
