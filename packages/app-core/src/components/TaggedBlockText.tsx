import { Fragment } from 'react'
import type { TagBlock } from '@shared/tag-blocks'

// A `#tag` token where the tag scanner would read one: at the start of the
// text or after whitespace. The capture keeps the token in `split` output.
const TAG_TOKEN_SPLIT_RE = /((?<=^|\s)#\p{L}[\p{L}\d_/-]*)/u

/** Split `text` around every case-insensitive occurrence of `needle`. */
function splitOnMatch(text: string, needle: string): { text: string; match: boolean }[] {
  if (!needle) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let from = 0
  let at = lower.indexOf(needle)
  while (at !== -1) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts
}

/**
 * A tagged block's text (#837): the wanted tags picked out in the accent, the
 * typed filter text marked, and a heading's own line in bold. Shared by the
 * Tags view and the Search notes palette so a block reads the same in both.
 */
export function TaggedBlockText({
  block,
  tags,
  highlight = '',
  clampClassName = 'line-clamp-3'
}: {
  block: TagBlock
  /** Tags to pick out, any case. */
  tags: readonly string[]
  /** Text to mark wherever it occurs, any case. */
  highlight?: string
  clampClassName?: string
}): JSX.Element {
  const wanted = new Set(tags.map((t) => t.toLowerCase()))
  const needle = highlight.trim().toLowerCase()
  return (
    <span
      className={`${clampClassName} block whitespace-pre-line text-xs leading-5 text-current/75`}
    >
      {block.text.split('\n').map((line, li) => (
        <Fragment key={li}>
          {li > 0 ? '\n' : null}
          <span
            className={
              li === 0 && block.kind === 'heading' ? 'font-semibold text-current/90' : undefined
            }
          >
            {line.split(TAG_TOKEN_SPLIT_RE).map((part, pi) =>
              part.startsWith('#') && wanted.has(part.slice(1).toLowerCase()) ? (
                <span key={pi} className="font-medium text-accent">
                  {part}
                </span>
              ) : (
                splitOnMatch(part, needle).map((piece, mi) =>
                  piece.match ? (
                    <mark
                      key={`${pi}-${mi}`}
                      data-block-match=""
                      className="rounded-sm bg-accent/25 text-current"
                    >
                      {piece.text}
                    </mark>
                  ) : (
                    <Fragment key={`${pi}-${mi}`}>{piece.text}</Fragment>
                  )
                )
              )
            )}
          </span>
        </Fragment>
      ))}
    </span>
  )
}
