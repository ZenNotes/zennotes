/**
 * Reads a Logseq Markdown file into its outline: page properties, then a tree
 * of blocks. Every block is a `- ` bullet; its nesting is the bullet's
 * indentation (tabs, as Logseq writes them, or spaces, as an outside editor
 * might), and every following line that is not a bullet belongs to it.
 *
 * This only takes the file apart. What each part turns into is convert.ts's
 * business, so the parse can be tested on its own and nothing here decides
 * what to keep.
 */

export const LOGSEQ_MARKERS = [
  'TODO',
  'DOING',
  'DONE',
  'LATER',
  'NOW',
  'WAITING',
  'WAIT',
  'CANCELED',
  'CANCELLED',
  'IN-PROGRESS',
  'STARTED'
] as const

export type LogseqMarker = (typeof LOGSEQ_MARKERS)[number]

export interface LogseqDate {
  /** YYYY-MM-DD. */
  date: string
  /** Logseq's repeater, `.+1d`, `++1w` or `+1m`, when the timestamp has one. */
  repeat?: string
}

export interface LogseqBlock {
  /** The block's lines with its indentation taken off; the first is the bullet's. */
  lines: string[]
  /** Its properties in the order written, keys lower-cased. */
  properties: Array<{ key: string; value: string }>
  /** Which entries of `lines` are property lines (so a renderer can drop some). */
  propertyLines: Set<number>
  marker?: LogseqMarker
  /** `A`, `B` or `C`, from a `[#A]` on the first line. */
  priority?: string
  scheduled?: LogseqDate
  deadline?: LogseqDate
  /** `:LOGBOOK:` drawers taken out (time tracking, which nothing here reads). */
  logbooks: number
  children: LogseqBlock[]
}

export interface LogseqPage {
  /** `key:: value` lines at the top of the page, or a first block of nothing else. */
  properties: Array<{ key: string; value: string }>
  /** Lines before the first bullet that are not properties (an outside edit). */
  preamble: string[]
  blocks: LogseqBlock[]
}

/** Logseq lets a key hold letters, digits and `-_.?/` ; values run to the line end. */
export const PROPERTY_RE = /^([A-Za-z0-9_][\w.\-?/]*)::(?:[ \t]+(.*))?$/
const BULLET_RE = /^([ \t]*)-(?:[ \t]+(.*))?$/
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/
const MARKER_RE = new RegExp(`^(${LOGSEQ_MARKERS.join('|')})(?:[ \\t]+|$)`)
const PRIORITY_RE = /(^|[ \t])\[#([ABC])\](?=[ \t]|$)/
const TIMESTAMP_RE = /^(SCHEDULED|DEADLINE):[ \t]*<(\d{4}-\d{2}-\d{2})(?:[^>]*?)((?:\.\+|\+\+|\+)\d+[hdwmy])?>[ \t]*$/

function indentWidth(indent: string): number {
  let width = 0
  for (const ch of indent) width += ch === '\t' ? 4 : 1
  return width
}

interface FenceState {
  char: string
  length: number
}

/** A fence line opens or closes `fence`; returns the state after it. */
function stepFence(line: string, fence: FenceState | null): { fence: FenceState | null; isFence: boolean } {
  const match = FENCE_RE.exec(line)
  if (!match) return { fence, isFence: false }
  const char = match[1][0]
  if (!fence) {
    if (char === '`' && match[2].includes('`')) return { fence, isFence: false }
    return { fence: { char, length: match[1].length }, isFence: true }
  }
  if (char === fence.char && match[1].length >= fence.length && !match[2].trim()) {
    return { fence: null, isFence: true }
  }
  return { fence, isFence: false }
}

interface RawBlock {
  indent: number
  indentText: string
  lines: string[]
  children: RawBlock[]
}

/** Take a continuation line's indentation off: the bullet's own, then the two
 *  spaces Logseq puts under a bullet's text. A line written shallower loses
 *  what it has. */
function dedent(line: string, indentText: string): string {
  let rest = line
  if (rest.startsWith(indentText)) rest = rest.slice(indentText.length)
  else rest = rest.replace(/^[ \t]+/, (lead) => (indentWidth(lead) <= indentWidth(indentText) ? '' : lead))
  if (rest.startsWith('  ')) return rest.slice(2)
  if (rest.startsWith('\t')) return rest.slice(1)
  if (rest.startsWith(' ')) return rest.slice(1)
  return rest
}

export function parseLogseqPage(text: string): LogseqPage {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const roots: RawBlock[] = []
  const stack: RawBlock[] = []
  const before: string[] = []
  let current: RawBlock | null = null
  let fence: FenceState | null = null

  for (const line of lines) {
    if (current && fence) {
      current.lines.push(dedent(line, current.indentText))
      fence = stepFence(dedent(line, current.indentText), fence).fence
      continue
    }
    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      const block: RawBlock = {
        indent: indentWidth(bullet[1]),
        indentText: bullet[1],
        lines: [bullet[2] ?? ''],
        children: []
      }
      while (stack.length > 0 && stack[stack.length - 1].indent >= block.indent) stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(block)
      else roots.push(block)
      stack.push(block)
      current = block
      fence = stepFence(block.lines[0], null).fence
      continue
    }
    if (!current) {
      before.push(line)
      continue
    }
    const content = dedent(line, current.indentText)
    current.lines.push(content)
    fence = stepFence(content, fence).fence
  }

  // Trailing blank lines are the file's end, not the last block's text.
  for (const block of walk(roots)) {
    while (block.lines.length > 1 && block.lines[block.lines.length - 1].trim() === '') block.lines.pop()
  }

  const properties: Array<{ key: string; value: string }> = []
  const preamble: string[] = []
  for (const line of before) {
    const prop = PROPERTY_RE.exec(line.trim())
    if (prop && preamble.every((l) => !l.trim())) {
      properties.push({ key: prop[1].toLowerCase(), value: (prop[2] ?? '').trim() })
    } else {
      preamble.push(line)
    }
  }
  while (preamble.length > 0 && !preamble[0].trim()) preamble.shift()
  while (preamble.length > 0 && !preamble[preamble.length - 1].trim()) preamble.pop()

  let blocks = roots.map(finishBlock)
  // An older Logseq wrote page properties as the first block, bullet and all.
  const first = blocks[0]
  if (
    properties.length === 0 &&
    preamble.length === 0 &&
    first &&
    first.children.length === 0 &&
    first.properties.length > 0 &&
    first.lines.every((line, index) => first.propertyLines.has(index) || !line.trim())
  ) {
    properties.push(...first.properties)
    blocks = blocks.slice(1)
  }
  return { properties, preamble, blocks }
}

function* walk(blocks: RawBlock[]): Generator<RawBlock> {
  for (const block of blocks) {
    yield block
    yield* walk(block.children)
  }
}

function parseTimestamp(match: RegExpExecArray): LogseqDate {
  return match[3] ? { date: match[2], repeat: match[3] } : { date: match[2] }
}

function finishBlock(raw: RawBlock): LogseqBlock {
  const block: LogseqBlock = {
    lines: [],
    properties: [],
    propertyLines: new Set(),
    logbooks: 0,
    children: raw.children.map(finishBlock)
  }
  let fence: FenceState | null = null
  let drawer = false
  for (const [index, line] of raw.lines.entries()) {
    if (!fence) {
      if (drawer) {
        if (/^[ \t]*:END:[ \t]*$/.test(line)) drawer = false
        continue
      }
      if (/^[ \t]*:LOGBOOK:[ \t]*$/.test(line)) {
        drawer = true
        block.logbooks += 1
        continue
      }
      const stamp = index > 0 ? TIMESTAMP_RE.exec(line.trim()) : null
      if (stamp) {
        if (stamp[1] === 'SCHEDULED') block.scheduled = parseTimestamp(stamp)
        else block.deadline = parseTimestamp(stamp)
        continue
      }
      const prop = PROPERTY_RE.exec(line)
      if (prop && (index > 0 || raw.lines.length === 1 || PROPERTY_RE.test(raw.lines[1] ?? ''))) {
        block.properties.push({ key: prop[1].toLowerCase(), value: (prop[2] ?? '').trim() })
        block.propertyLines.add(block.lines.length)
        block.lines.push(line)
        continue
      }
    }
    fence = stepFence(line, fence).fence
    block.lines.push(line)
  }
  if (block.lines.length === 0) block.lines.push('')

  const firstIsProperty = block.propertyLines.has(0)
  if (!firstIsProperty) {
    let head = block.lines[0]
    const marker = MARKER_RE.exec(head)
    if (marker) {
      block.marker = marker[1] as LogseqMarker
      head = head.slice(marker[0].length)
    }
    const priority = PRIORITY_RE.exec(head)
    if (priority) {
      block.priority = priority[2]
      const before = head.slice(0, priority.index).trimEnd()
      const after = head.slice(priority.index + priority[0].length).trimStart()
      head = before && after ? `${before} ${after}` : before || after
    }
    block.lines[0] = head
  }
  return block
}
