/**
 * Turn a block into a callout, change a callout's type, or remove one (#1016),
 * as pure text edits on a note body. The editor menu, the palette commands and
 * the leader key all go through here, so each action is one change with one
 * rule for what it touches.
 *
 * What a right-click or the caret targets:
 *  - Inside a callout, the innermost callout around the whole selection.
 *  - Otherwise a non-empty selection covers its whole lines (a selection that
 *    ends at the start of a line leaves that line out), and an empty one takes
 *    the paragraph at the caret: the non-blank lines around it, stopping at a
 *    heading, a code fence, and the edge of a quote. A caret in a quote takes
 *    the whole quote.
 *  - A block is never cut in half: a target that reaches into a code fence or
 *    a blockquote (callouts included) grows to hold all of it, so the wrapped
 *    block keeps its own structure inside the new callout.
 *  - Nothing inside a code fence or the leading frontmatter: there the lines
 *    are code and YAML, and a `> ` in front of them would change what they say.
 *
 * Every line reader here splits at `\n` and keeps a `\r` as part of the line
 * ending, so a CRLF body comes back CRLF, new lines included.
 */
import { FENCE_CLOSE_RE, FENCE_OPEN_RE, frontmatterEndIndex } from '@shared/markdown-lines'
import { CALLOUT_TYPES, type CalloutTypeDef } from './callout-types'

export interface CalloutChange {
  from: number
  to: number
  insert: string
}

export interface CalloutSelection {
  anchor: number
  head: number
}

/** One edit: changes in original-document positions, sorted and disjoint (the
 *  shape CodeMirror's `dispatch({ changes })` takes), and the selection after
 *  it, in new-document positions. */
export interface CalloutEdit {
  changes: CalloutChange[]
  selection: CalloutSelection
}

export interface CalloutBlock {
  /** 0-based line of the `> [!type]` title. */
  head: number
  /** 0-based last line of the callout, inclusive. */
  end: number
  /** Quote depth of the callout: 1 for `> [!note]`, 2 for `> > [!note]`. */
  depth: number
  /** The type keyword as written, case kept. */
  type: string
  marker: '-' | '+' | null
  title: string
  /** Offsets of the type keyword between `[!` and `]`. */
  typeFrom: number
  typeTo: number
  /** Offset where the title starts (the line end when there is none). */
  titleFrom: number
}

export type CalloutRefusal = 'code' | 'frontmatter' | 'blank'

export type CalloutTarget =
  | { kind: 'callout'; callout: CalloutBlock }
  | { kind: 'block'; from: number; to: number }
  | { kind: 'refused'; reason: CalloutRefusal }

interface Line {
  from: number
  /** End of the text, before the line ending. */
  to: number
  text: string
  /** `\n`, `\r\n`, or '' on the last line. */
  eol: string
  /** Quote depth the Markdown structure gives this line. Inside a fence, the
   *  fence's own depth: a `>` in the code is code. */
  depth: number
  /** Offsets of the structural `>` markers, outermost first. */
  markers: number[]
  /** Offset of the text after the structural markers and one space. */
  contentFrom: number
  frontmatter: boolean
  /** Index into `fences` when the line opens, sits in, or closes a fence. */
  fence: number
}

interface Fence {
  start: number
  end: number
}

interface Model {
  lines: Line[]
  fences: Fence[]
  callouts: CalloutBlock[]
  /** The ending a new line gets. */
  eol: string
}

/** `[!type]`, an optional fold marker, then the title. Matches what Live
 *  Preview draws as a callout (`CALLOUT_HEAD_RE` in cm-callout-fold.ts), which
 *  also takes a title right after the bracket. */
const HEAD_RE = /^\[!(\w+)\]([-+])?[ \t]?(.*)$/

const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/** A list item's marker and the space after it: its length is the column the
 *  item's text, and its continuation lines, start at. */
const LIST_ITEM_RE = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/

/** Columns `text` takes, a tab counting four. */
function columnWidth(text: string): number {
  let width = 0
  for (const ch of text) width += ch === '\t' ? 4 : 1
  return width
}

/** Columns of leading whitespace. */
function indentWidth(text: string): number {
  return columnWidth(text.match(/^[ \t]*/)?.[0] ?? '')
}

/** The structural `>` markers at the start of `text`: leading whitespace, then
 *  each `>` with the one space after it, allowing spaces between markers. */
function readMarkers(text: string): { markers: number[]; contentAt: number[] } {
  const markers: number[] = []
  // contentAt[k] is where the content starts when only k markers count.
  const contentAt: number[] = []
  let i = 0
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  contentAt.push(0)
  for (;;) {
    let j = i
    if (markers.length > 0) {
      while (j < text.length && text[j] === ' ') j++
    }
    if (text[j] !== '>') break
    markers.push(j)
    j++
    if (text[j] === ' ' || text[j] === '\t') j++
    contentAt.push(j)
    i = j
  }
  return { markers, contentAt }
}

function parse(doc: string): Model {
  const raw = doc.split('\n')
  const lines: Line[] = []
  const fences: Fence[] = []
  const frontmatterEnd = frontmatterEndIndex(raw.map((r) => r.replace(/\r$/, '')))
  let open: { marker: string; depth: number; index: number } | null = null
  let offset = 0

  for (let i = 0; i < raw.length; i++) {
    const last = i === raw.length - 1
    let text = raw[i]
    let eol = last ? '' : '\n'
    if (text.endsWith('\r')) {
      text = text.slice(0, -1)
      eol = '\r' + eol
    }
    const from = offset
    offset += raw[i].length + (last ? 0 : 1)
    const line: Line = {
      from,
      to: from + text.length,
      text,
      eol,
      depth: 0,
      markers: [],
      contentFrom: from,
      frontmatter: i <= frontmatterEnd,
      fence: -1
    }
    lines.push(line)
    if (line.frontmatter) continue

    const { markers, contentAt } = readMarkers(text)
    if (open && markers.length < open.depth) {
      // The quote holding the fence ended, and the fence with it.
      fences[open.index].end = i - 1
      open = null
    }
    const depth: number = open ? open.depth : markers.length
    line.depth = depth
    line.markers = markers.slice(0, depth).map((m) => from + m)
    line.contentFrom = from + contentAt[depth]
    const content = text.slice(contentAt[depth])

    if (open) {
      line.fence = open.index
      const close = content.match(FENCE_CLOSE_RE)
      if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
        fences[open.index].end = i
        open = null
      }
      continue
    }
    const opener = content.match(FENCE_OPEN_RE)
    // A backtick fence's info string may not hold a backtick: such a line is
    // an inline code span, the same rule as scanMarkdownLines.
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      open = { marker: opener[1], depth, index: fences.length }
      fences.push({ start: i, end: raw.length - 1 })
      line.fence = open.index
    }
  }

  const callouts: CalloutBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.frontmatter || line.fence >= 0 || line.depth === 0) continue
    // A title opens its quote: on a line that continues a quote at the same
    // depth, `[!type]` is just text in that quote.
    if (i > 0 && !lines[i - 1].frontmatter && lines[i - 1].depth >= line.depth) continue
    const content = line.text.slice(line.contentFrom - line.from)
    const m = content.match(HEAD_RE)
    if (!m) continue
    let end = i
    while (end + 1 < lines.length && lines[end + 1].depth >= line.depth) end++
    const typeFrom = line.contentFrom + 2
    const rest = m[3]
    const title = rest.trim()
    callouts.push({
      head: i,
      end,
      depth: line.depth,
      type: m[1],
      marker: (m[2] as '-' | '+' | undefined) ?? null,
      title,
      typeFrom,
      typeTo: typeFrom + m[1].length,
      titleFrom: title ? line.to - rest.trimStart().length : line.to
    })
  }

  return { lines, fences, callouts, eol: doc.includes('\r\n') ? '\r\n' : '\n' }
}

function lineIndexAt(lines: Line[], pos: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].from <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

function isBlank(line: Line): boolean {
  return line.text.trim() === ''
}

/** The callout, block or refusal a selection from `from` to `to` targets. */
export function calloutTargetAt(doc: string, range: { from: number; to: number }): CalloutTarget {
  return targetIn(parse(doc), range)
}

function targetIn(model: Model, range: { from: number; to: number }): CalloutTarget {
  const { lines, fences, callouts } = model
  const from = Math.max(0, Math.min(range.from, range.to))
  const to = Math.max(range.from, range.to)
  let a = lineIndexAt(lines, from)
  let b = lineIndexAt(lines, to)
  if (to > from && b > a && to === lines[b].from) b--

  let inner: CalloutBlock | null = null
  for (const c of callouts) {
    if (c.head <= a && c.end >= b && (!inner || c.depth > inner.depth)) inner = c
  }
  if (inner) return { kind: 'callout', callout: inner }

  while (a <= b && lines[a].frontmatter) a++
  if (a > b) return { kind: 'refused', reason: 'frontmatter' }

  const fa = lines[a].fence
  if (fa >= 0 && lines[b].fence === fa && !(a === fences[fa].start && b === fences[fa].end)) {
    return { kind: 'refused', reason: 'code' }
  }

  if (from === to) {
    if (isBlank(lines[a])) return { kind: 'refused', reason: 'blank' }
    const quoted = lines[a].depth > 0
    const joins = (n: number): boolean => {
      const l = lines[n]
      if (l.frontmatter || isBlank(l)) return false
      if (quoted) return l.depth > 0
      return l.depth === 0 && l.fence < 0 && !ATX_HEADING_RE.test(l.text)
    }
    // A heading is a paragraph of its own. Outside a quote, a line indented
    // less than the paragraph is another block (the next item of the list
    // whose item the paragraph sits in), except the item a continuation line
    // belongs to: from there on the paragraph is that item's whole list.
    if (quoted || !ATX_HEADING_RE.test(lines[a].text)) {
      let base = indentWidth(lines[a].text)
      for (;;) {
        if (a === 0 || !joins(a - 1)) break
        const up = lines[a - 1].text
        const width = indentWidth(up)
        if (!quoted && width < base) {
          const item = up.match(LIST_ITEM_RE)
          if (!item || columnWidth(item[0]) > indentWidth(lines[a].text)) break
          base = width
        }
        a--
      }
      while (
        b + 1 < lines.length &&
        joins(b + 1) &&
        (quoted || indentWidth(lines[b + 1].text) >= base)
      ) {
        b++
      }
    }
  } else {
    while (a < b && isBlank(lines[a])) a++
    while (b > a && isBlank(lines[b])) b--
    if (isBlank(lines[a])) return { kind: 'refused', reason: 'blank' }
  }

  // Grow to whole fences and whole quotes until nothing more is cut.
  for (let changed = true; changed; ) {
    changed = false
    const startFence = lines[a].fence
    if (startFence >= 0 && fences[startFence].start < a) {
      a = fences[startFence].start
      changed = true
    }
    const endFence = lines[b].fence
    if (endFence >= 0 && fences[endFence].end > b) {
      b = fences[endFence].end
      changed = true
    }
    while (lines[a].depth > 0 && a > 0 && lines[a - 1].depth > 0 && !lines[a - 1].frontmatter) {
      a--
      changed = true
    }
    while (lines[b].depth > 0 && b + 1 < lines.length && lines[b + 1].depth > 0) {
      b++
      changed = true
    }
  }
  return { kind: 'block', from: lines[a].from, to: lines[b].to }
}

/** Where `pos` lands after `changes`. `assoc` > 0 puts it after text inserted
 *  exactly there; a position inside deleted text lands where the deletion was. */
export function mapCalloutPos(changes: CalloutChange[], pos: number, assoc: -1 | 1 = 1): number {
  let delta = 0
  for (const c of changes) {
    if (c.to < pos || (c.to === pos && (c.from < pos || assoc > 0))) {
      delta += c.insert.length - (c.to - c.from)
      continue
    }
    if (c.from < pos && pos < c.to) {
      return c.from + delta + (assoc > 0 ? c.insert.length : 0)
    }
    break
  }
  return pos + delta
}

/** Apply an edit's changes to a string (tests, and callers without an editor). */
export function applyCalloutChanges(doc: string, changes: CalloutChange[]): string {
  let out = doc
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]
    out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  }
  return out
}

function edit(changes: CalloutChange[], selection: CalloutSelection): CalloutEdit {
  return {
    changes,
    selection: {
      anchor: mapCalloutPos(changes, selection.anchor),
      head: mapCalloutPos(changes, selection.head)
    }
  }
}

function commonIndent(lines: Line[]): string {
  let indent: string | null = null
  for (const line of lines) {
    if (isBlank(line)) continue
    const lead = line.text.match(/^[ \t]*/)?.[0] ?? ''
    if (indent === null) {
      indent = lead
      continue
    }
    let k = 0
    while (k < indent.length && k < lead.length && indent[k] === lead[k]) k++
    indent = indent.slice(0, k)
  }
  return indent ?? ''
}

/**
 * Wrap the lines from `target.from` to `target.to` (a `block` target) in a
 * `> [!type]` callout. Each line gets `> ` (a blank one `>`) after the
 * indentation the lines share, so a callout made inside a list item stays in
 * it. A target that is one plain blockquote already has its `>`: it only gets
 * the title line above it.
 *
 * Markdown reads a quote line right under text as more of that text's quote,
 * and text right under a quote as more of the quote. So a callout made from
 * part of a paragraph, or from a paragraph that touches a quote, gets a blank
 * line where it would otherwise run into its neighbor: without one, the title
 * under a quote is no callout at all, and the line below joins the callout.
 */
export function turnIntoCallout(
  doc: string,
  target: { from: number; to: number },
  type: string,
  selection: CalloutSelection
): CalloutEdit {
  const { lines, eol: docEol } = parse(doc)
  const a = lineIndexAt(lines, target.from)
  const b = lineIndexAt(lines, target.to)
  const range = lines.slice(a, b + 1)
  const indent = commonIndent(range)
  const eol = range[0].eol || docEol
  const header = `> [!${type}]`
  const changes: CalloutChange[] = []
  if (range.every((line) => line.depth > 0)) {
    const at = range[0].from + indent.length
    changes.push({ from: at, to: at, insert: header + eol + indent })
    return edit(changes, selection)
  }
  const above = a > 0 ? lines[a - 1] : null
  const below = b + 1 < lines.length ? lines[b + 1] : null
  const blankAbove = !!above && !above.frontmatter && !isBlank(above) && above.depth > 0
  // A quote line joins whatever quote is above it. Plain text joins only a
  // paragraph, and only when it does not start a block of its own.
  const last = range[range.length - 1]
  const lastIsText = last.fence < 0 && !ATX_HEADING_RE.test(last.text)
  const blankBelow =
    !!below &&
    !isBlank(below) &&
    (below.depth > 0 ||
      (lastIsText &&
        below.fence < 0 &&
        !ATX_HEADING_RE.test(below.text) &&
        !LIST_ITEM_RE.test(below.text) &&
        !THEMATIC_BREAK_RE.test(below.text)))
  range.forEach((line, k) => {
    if (isBlank(line)) {
      changes.push({ from: line.from, to: line.to, insert: indent + '>' })
      return
    }
    const at = line.from + indent.length
    const lead = k === 0 ? header + eol + indent : ''
    if (k === 0 && blankAbove) {
      if (indent) changes.push({ from: line.from, to: line.from, insert: eol })
      changes.push({ from: at, to: at, insert: (indent ? '' : eol) + lead + '> ' })
      return
    }
    changes.push({ from: at, to: at, insert: lead + '> ' })
  })
  // At the start of the next line, so a caret at the end of the last wrapped
  // line stays there instead of following the new line break.
  if (below && blankBelow) changes.push({ from: below.from, to: below.from, insert: eol })
  return edit(changes, selection)
}

/** The CALLOUT_TYPES entry a keyword names, by type or alias, any case. */
export function calloutTypeDef(keyword: string): CalloutTypeDef | null {
  const k = keyword.toLowerCase()
  return CALLOUT_TYPES.find((def) => def.type === k || def.aliases.includes(k)) ?? null
}

/**
 * Rewrite only the `[!type]` keyword, keeping the fold marker and the title.
 * Null when the callout already is that type (an alias counts: `[!error]` is
 * already a danger callout, and stays written as `error`).
 */
export function changeCalloutType(
  callout: CalloutBlock,
  type: string,
  selection: CalloutSelection
): CalloutEdit | null {
  const current = calloutTypeDef(callout.type)
  if (current ? current.type === type : callout.type.toLowerCase() === type) return null
  return edit([{ from: callout.typeFrom, to: callout.typeTo, insert: type }], selection)
}

/**
 * Take a callout back to plain text: its title line goes (a custom title stays
 * as a plain first line) and every line loses one level of `> `, the
 * callout's own, so a quote or callout nested inside it keeps its markers.
 */
export function removeCallout(
  doc: string,
  callout: CalloutBlock,
  selection: CalloutSelection
): CalloutEdit {
  const { lines } = parse(doc)
  const level = callout.depth - 1
  const changes: CalloutChange[] = []
  const head = lines[callout.head]
  if (callout.title) {
    changes.push({ from: head.markers[level], to: callout.titleFrom, insert: '' })
  } else if (callout.head + 1 < lines.length) {
    changes.push({ from: head.from, to: lines[callout.head + 1].from, insert: '' })
  } else if (callout.head > 0) {
    changes.push({ from: lines[callout.head - 1].to, to: head.to, insert: '' })
  } else {
    changes.push({ from: head.from, to: head.to, insert: '' })
  }
  for (let n = callout.head + 1; n <= callout.end; n++) {
    const line = lines[n]
    const marker = line.markers[level]
    let to = marker + 1
    const next = line.text[to - line.from]
    if (next === ' ' || next === '\t') to++
    changes.push({ from: marker, to, insert: '' })
  }
  return edit(changes, selection)
}

/** One row of the callout type menu. */
export interface CalloutTypeChoice {
  type: string
  label: string
  icon: string
  /** The callout's current type, an alias resolved to its entry. */
  checked: boolean
  /** The aliases, so the menu's filter finds `caution` or `tldr`. */
  keywords: string[]
}

/** Danger is the type an Error callout is: `error` is its alias and renders
 *  red with it. The issue asked for Error by name, so the menu says so. */
const PICKER_LABELS: Record<string, string> = { danger: 'Danger (Error)' }

/** Every callout type in CALLOUT_TYPES order, the current one checked. */
export function calloutTypeChoices(current: string | null): CalloutTypeChoice[] {
  const currentDef = current ? calloutTypeDef(current) : null
  return CALLOUT_TYPES.map((def) => ({
    type: def.type,
    label: PICKER_LABELS[def.type] ?? def.label,
    icon: def.icon,
    checked: currentDef?.type === def.type,
    keywords: def.aliases
  }))
}

/** What the editor menu offers for a target: the actions in order, or a
 *  disabled Turn into with the reason it cannot apply. */
export interface CalloutMenuEntry {
  action: 'turn-into' | 'change-type' | 'remove'
  label: string
  disabled?: boolean
  reason?: string
}

export const CALLOUT_REFUSAL_REASON: Record<CalloutRefusal, string> = {
  code: 'in a code block',
  frontmatter: 'in properties',
  blank: 'on a blank line'
}

export function calloutMenuEntries(target: CalloutTarget): CalloutMenuEntry[] {
  if (target.kind === 'callout') {
    return [
      { action: 'change-type', label: 'Change callout type…' },
      { action: 'remove', label: 'Remove callout' }
    ]
  }
  if (target.kind === 'block') return [{ action: 'turn-into', label: 'Turn into callout…' }]
  // A blank line has nothing to turn into anything, and it is where a paste
  // usually goes: no row at all beats a dead one there.
  if (target.reason === 'blank') return []
  return [
    {
      action: 'turn-into',
      label: 'Turn into callout…',
      disabled: true,
      reason: CALLOUT_REFUSAL_REASON[target.reason]
    }
  ]
}
