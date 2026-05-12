/**
 * Count words in a markdown body the way Obsidian does: strip the
 * YAML frontmatter, then treat every whitespace-separated token as
 * a word. Code blocks and inline code stay counted — Obsidian
 * counts the words inside them and an earlier implementation
 * stripping them caused issue #43 (huge undercounts on code-heavy
 * notes).
 */
export function countWords(body: string): number {
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const matches = stripped.match(/\S+/g)
  return matches?.length ?? 0
}
