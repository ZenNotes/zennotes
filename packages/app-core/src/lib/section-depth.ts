/**
 * How far in a line sits when sections are indented under their headings:
 * a heading and everything after it, up to the next heading, take depth
 * `level - shallowest level in the note`. Text before the first heading is
 * depth 0. Shared by the editor (per line) and Preview (per block).
 */
export interface SectionHeading {
  /** 1-based line (editor) or block index (Preview); only the order matters. */
  line: number
  level: number
}

export function sectionDepthsFromHeadings(headings: readonly SectionHeading[]): (line: number) => number {
  if (headings.length === 0) return () => 0
  let shallowest = 6
  for (const heading of headings) shallowest = Math.min(shallowest, heading.level)
  return (line: number): number => {
    // The last heading at or before `line`, by binary search over sorted lines.
    let lo = 0
    let hi = headings.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (headings[mid]!.line <= line) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found < 0 ? 0 : headings[found]!.level - shallowest
  }
}
