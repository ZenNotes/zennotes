/**
 * Extract `#tags` from a markdown body. Mirrors the extraction the
 * main process runs in `vault.ts` so the sidebar can update tag
 * counts *live* as the user types, instead of waiting for the save +
 * chokidar round-trip.
 *
 * Rules:
 *  - The hash must be preceded by start-of-line or whitespace (so
 *    `me#tag` and `url.com/#x` don't match).
 *  - The first tag character must be a letter, the rest can be
 *    letters, digits, `_`, `-`, or `/`.
 *  - Fenced code blocks and inline code spans are stripped first.
 *  - Heading markers (`#`, `##`, …) are not a hashtag because the
 *    character after the hash is a space, not a letter.
 */
export function extractTags(body: string): string[] {
  const stripped = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const regex = /(?:^|\s)#([a-zA-Z][\w\-/]*)/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = regex.exec(stripped)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}
