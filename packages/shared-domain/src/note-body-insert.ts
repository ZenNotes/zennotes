// Adding text to the end or the top of a note. `zn append`/`zn prepend`, the
// MCP's append and prepend tools, and the clip links (`zennotes://new?append`,
// `zennotes://daily`) all compose the same bytes through these, whichever
// side of the wire the note is on and whether or not it is open in an editor.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/g, '')
}

/** The note body with `text` added after a blank line. */
export function appendToBody(body: string, text: string): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const sep = normalized.endsWith('\n') || normalized.length === 0 ? '' : '\n'
  return (
    normalized + sep + (normalized.length > 0 ? '\n' : '') + trimTrailingNewlines(text) + '\n'
  )
}

/** The note body with `text` inserted at the top, below any frontmatter. */
export function prependToBody(body: string, text: string): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const fm = normalized.match(FRONTMATTER_RE)
  const snippet = trimTrailingNewlines(text) + '\n\n'
  if (fm) return fm[0] + snippet + normalized.slice(fm[0].length)
  return snippet + normalized
}
