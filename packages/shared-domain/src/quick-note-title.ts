/**
 * The title a quick note takes from its text. Quick Capture names its note
 * from the first line you type, and a capture shared from another app
 * (the macOS Share menu) falls back to the same rule when the page it came
 * from has no title, so both surfaces name notes alike.
 */

/** Derive the note title from the body's first non-empty line. A leading
 *  `# ` heading or list/quote marker is stripped so the title reads
 *  cleanly. Returns '' for an empty buffer: callers decide the fallback,
 *  this never invents a timestamp. */
export function deriveTitleFromBody(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+)$/u)
    if (heading) return heading[1].trim().slice(0, 80)
    return line.replace(/^[*\-+>\s]+/u, '').slice(0, 80)
  }
  return ''
}

/** Fallback title for a body with no usable first line, so a note never
 *  lands as "Untitled". */
export function timestampTitle(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Quick capture ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
}
