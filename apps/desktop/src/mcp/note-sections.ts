/**
 * A note's sections, for reading and editing part of a note by its heading
 * instead of by line numbers or the whole body. Headings come from the app's
 * outline, so frontmatter and fenced code never count. Mirrors
 * internal/vault/sections.go in ZenNotes/tui.
 */

import { goQuote } from '@shared/mcp-scope'
import { ATX_RE, parseOutline } from '@renderer/lib/outline'

/** A heading and what sits under it, up to the next heading of the same or a
 *  higher level. Lines are zero-based, as in insert_at_line and a task's
 *  lineNumber; `endLineNumber` is exclusive. */
export interface NoteSection {
  level: number
  text: string
  lineNumber: number
  endLineNumber: number
}

interface SectionExtent extends NoteSection {
  /** The first line after the heading (a setext heading has two). */
  bodyStart: number
  /** Where its own text stops: its first subheading, else the section's end. */
  ownEnd: number
}

export type SectionEditMode = 'append' | 'prepend' | 'replace'

const SECTION_LIST_ITEM_RE = /^\s*(?:[-+*]|\d+[.)])\s/

/** Whether every line break of a note is CRLF, so an edit made in LF can be put
 *  back. A note with mixed endings comes out in LF. */
export function usesCrlf(body: string): boolean {
  return body.includes('\r\n') && !/(^|[^\r])\n/.test(body)
}

function splitNoteLines(body: string): string[] {
  return body.replace(/\r\n/g, '\n').split('\n')
}

function sectionExtents(body: string): SectionExtent[] {
  const normalized = body.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const outline = parseOutline(normalized)
  return outline.map((item, i) => {
    const line = item.line - 1
    const bodyStart = ATX_RE.test(lines[line]) ? line + 1 : line + 2
    let end = lines.length
    for (const later of outline.slice(i + 1)) {
      if (later.level <= item.level) {
        end = later.line - 1
        break
      }
    }
    const next = outline[i + 1]
    const ownEnd = next && next.line - 1 < end ? next.line - 1 : end
    return { level: item.level, text: item.text, lineNumber: line, endLineNumber: end, bodyStart, ownEnd }
  })
}

/** Every heading of a note with its extent. */
export function noteSections(body: string): NoteSection[] {
  return sectionExtents(body).map(({ level, text, lineNumber, endLineNumber }) => ({
    level,
    text,
    lineNumber,
    endLineNumber
  }))
}

/** The section a heading names, ignoring case and any leading `#`s. `line`, when
 *  given, says which one when a heading appears more than once. */
export function findSection(body: string, heading: string, line?: number): SectionExtent {
  const sections = sectionExtents(body)
  const want = heading.trim().replace(/^#+/, '').trim().toLowerCase()
  const matches = sections.filter(
    (s) => s.text.toLowerCase() === want && (line === undefined || s.lineNumber === line)
  )
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    const names = sections.map((s) => s.text)
    const listed = names.length > 20 ? [...names.slice(0, 20), '...'] : names
    if (listed.length === 0) {
      throw new Error(`No heading ${goQuote(heading)}: this note has no headings.`)
    }
    throw new Error(`No heading ${goQuote(heading)}. Headings: ${listed.join(' | ')}.`)
  }
  throw new Error(
    `Heading ${goQuote(heading)} appears more than once, on lines ${matches.map((s) => s.lineNumber).join(', ')}; pass lineNumber to pick one.`
  )
}

function trimBlankLines(lines: string[]): { lead: number; core: string[] } {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end -= 1
  let lead = 0
  while (lead < end && !lines[lead].trim()) lead += 1
  return { lead, core: lines.slice(lead, end) }
}

/** The text under a heading, without the heading or the blank lines around it. */
export function sectionBody(body: string, section: SectionExtent): string {
  const lines = splitNoteLines(body)
  const start = Math.min(section.bodyStart, section.endLineNumber)
  return trimBlankLines(lines.slice(start, section.endLineNumber)).core.join('\n')
}

/**
 * Replaces what sits under a heading, subheadings included, or adds text at the
 * start of it or at the end of its own text, above any subheading. The heading
 * and everything else keep their text, and one blank line separates the edit
 * from the next heading.
 */
export function editSectionInBody(
  body: string,
  section: SectionExtent,
  mode: SectionEditMode,
  text: string
): string {
  const lines = splitNoteLines(body)
  const start = Math.min(section.bodyStart, section.endLineNumber)
  const end = mode === 'append' ? Math.max(start, section.ownEnd) : section.endLineNumber
  const trimmed = trimBlankLines(lines.slice(start, end))
  let { lead } = trimmed
  const { core } = trimmed
  const stripped = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const inserted = stripped ? stripped.split('\n') : []

  let content: string[]
  if (mode === 'replace') {
    content = inserted
  } else if (mode === 'prepend') {
    content = core.length > 0 ? [...inserted, '', ...core] : [...inserted]
  } else {
    content = [...core]
    if (core.length > 0 && inserted.length > 0) {
      // A list grows by one item; anything else gets its own paragraph.
      if (
        !SECTION_LIST_ITEM_RE.test(core[core.length - 1]) ||
        !SECTION_LIST_ITEM_RE.test(inserted[0])
      ) {
        content.push('')
      }
    }
    content.push(...inserted)
  }

  const out = lines.slice(0, start)
  if (content.length > 0) {
    // Keep a heading's blank line as written; an empty section gets one.
    if (core.length === 0 || mode === 'replace') lead = 1
    for (let i = 0; i < lead; i += 1) out.push('')
    out.push(...content)
  }
  // A section that ended the note still ends it with a newline.
  out.push('')
  if (end < lines.length) out.push(...lines.slice(end))
  const edited = out.join('\n')
  return usesCrlf(body) ? edited.replace(/\n/g, '\r\n') : edited
}
