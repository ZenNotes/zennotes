/**
 * Extract a note's tags from a markdown body: its frontmatter `tags` field
 * plus every inline `#tag`. Mirrors the extraction the main process runs in
 * `vault.ts` so the sidebar can update tag counts *live* as the user types,
 * instead of waiting for the save + chokidar round-trip.
 *
 * Rules:
 *  - The hash must be preceded by start-of-line or whitespace (so
 *    `me#tag` and `url.com/#x` don't match).
 *  - The first tag character must be a letter in any script (Cyrillic,
 *    CJK, and so on: #205), the rest can be letters, digits, `_`, `-`, or `/`.
 *  - Fenced code blocks and inline code spans are stripped first.
 *  - Heading markers (`#`, `##`, …) are not a hashtag because the
 *    character after the hash is a space, not a letter.
 *  - The frontmatter block is read for `tags` and then excluded from the
 *    inline scan, so a `#` in some other field is never a tag (#444).
 *
 * Lives in shared-domain (it was app-core's `lib/tags.ts` copy) so the
 * block-level tag scan in `tag-blocks.ts` reads tags by exactly these rules
 * instead of carrying a sixth copy of the code mask (#837).
 */
import { FRONTMATTER_BLOCK_RE, frontmatterTags } from './frontmatter'

/** An inline `#tag`. Global, so callers reset `lastIndex` or use `matchAll`. */
export const INLINE_TAG_RE = /(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu

export function extractTags(body: string): string[] {
  const seen = new Set<string>()
  for (const tag of frontmatterTags(body)) seen.add(tag)

  const markdownBody = body.replace(FRONTMATTER_BLOCK_RE, '')
  const stripped = stripCodeContent(markdownBody)
  for (const m of stripped.matchAll(INLINE_TAG_RE)) {
    seen.add(m[1] as string)
  }
  return [...seen]
}

/**
 * Blank out fenced and inline code so the tag scanner never reads code as a
 * tag. Fence detection is line-based and indentation-tolerant: a fence nested
 * under a list item is still a code block, so e.g. a C `#include` line inside
 * it is not a tag (#293). Line-preserving: a code line becomes a single space,
 * so line N of the result is line N of the input. Mirrors `stripCodeContent`
 * in apps/desktop/src/main/vault.ts, apps/desktop/src/mcp/vault-ops.ts,
 * packages/app-core/src/lib/wikilinks.ts and internal/vault/parse.go in
 * ZenNotes/znserver: keep all five in sync.
 */
export function stripCodeContent(body: string): string {
  if (!body.includes('`') && !body.includes('~')) return body
  const lines = body.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // `.` never matches `\r`, so the `\r?` is what lets a CRLF-saved fence line match.
    const m = /^[ \t]*(`{3,}|~{3,})(.*)\r?$/.exec(line)
    if (m) {
      const marker = m[1] as string
      const char = marker[0] as string
      const rest = m[2] as string
      if (!inFence) {
        // A backtick fence's info string may not contain a backtick (CommonMark).
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          lines[i] = ' '
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        lines[i] = ' '
        continue
      }
    }
    if (inFence) lines[i] = ' '
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, ' ')
}
