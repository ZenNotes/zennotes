/**
 * The language word of a code fence's opening line, and the one edit that
 * changes it (#1014). Pure string work on a single line, so the picker, the
 * label and the tests agree on what "the language" is.
 *
 * The language is the first word of the info string, the way CommonMark,
 * GitHub and highlight.js read it: in ```` ```ts title="a.ts" ```` it is `ts`,
 * and `title="a.ts"` is left to whatever reads it. A word starting with `{`
 * is a Pandoc-style attribute block, not a language.
 */

export interface FenceLanguageEdit {
  /** Offsets in the line. */
  from: number
  to: number
  insert: string
}

/** The fence tags that mean "no highlighting". A fence labeled one of these
 *  has made its choice, so it is never guessed at either. */
export const PLAIN_TEXT_FENCE_TAGS: ReadonlySet<string> = new Set([
  'text',
  'txt',
  'plain',
  'plaintext',
  'nohighlight',
  'no-highlight'
])

export function isPlainTextFenceTag(tag: string): boolean {
  return PLAIN_TEXT_FENCE_TAGS.has(tag.trim().toLowerCase())
}

interface LanguageSpan {
  /** Offset of the language word in the line (or where one would go). */
  from: number
  to: number
  word: string
}

function languageSpan(line: string, markEnd: number): LanguageSpan {
  const rest = line.slice(markEnd)
  const lead = /^[ \t]*/.exec(rest)?.[0] ?? ''
  const word = /^[^\s`{]*/.exec(rest.slice(lead.length))?.[0] ?? ''
  const from = markEnd + lead.length
  return { from, to: from + word.length, word }
}

/** The language word of an opening fence line, as written, or null. `markEnd`
 *  is the offset just past the fence's backticks or tildes. */
export function fenceLanguageToken(line: string, markEnd: number): string | null {
  return languageSpan(line, markEnd).word || null
}

/**
 * The edit that makes `tag` the fence's language, or null when it already is.
 * Only the language word changes: the fence characters, their count, the
 * whitespace before the word and anything after it (attributes, a title, a
 * stray `\r`) stay as they are. `tag === null` takes the language away; when
 * attributes follow it, the word becomes `text` instead, since deleting it
 * would promote the first attribute to the language.
 */
export function fenceLanguageEdit(
  line: string,
  markEnd: number,
  tag: string | null
): FenceLanguageEdit | null {
  const span = languageSpan(line, markEnd)
  const after = line.slice(span.to)
  if (tag === null) {
    if (!span.word) return null
    if (after.trim() !== '') {
      return isPlainTextFenceTag(span.word) ? null : { from: span.from, to: span.to, insert: 'text' }
    }
    // Take the gap between the fence and the word with it, so ```` ``` py ````
    // becomes a bare ```` ``` ````, not one with a trailing space.
    return { from: markEnd, to: span.to, insert: '' }
  }
  if (span.word === tag) return null
  if (span.word) return { from: span.from, to: span.to, insert: tag }
  // No language yet. Write it against the fence, and keep a space before an
  // attribute block that sat there: ```` ```{.wide} ```` becomes
  // ```` ```python {.wide} ````.
  const next = line.charAt(markEnd)
  const needsGap = next !== '' && !/\s/.test(next)
  return { from: markEnd, to: markEnd, insert: needsGap ? `${tag} ` : tag }
}
