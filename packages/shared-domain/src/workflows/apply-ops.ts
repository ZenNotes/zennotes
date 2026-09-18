// Pure text transforms for the `WorkflowOp`s that edit a file's contents.
//
// Everything here is `(before, op) -> after`: no filesystem, no clock, no
// randomness. That is what lets the *semantics* of applying a workflow be unit
// tested without a vault, and mirrored by the Go engine later without anyone
// having to read Node code. The applier that sits on top shrinks to four steps
// it cannot get subtly wrong: read the file, call this, write the result,
// record the bytes it replaced.
//
// Four rules keep the file honest:
//
//   1. A no-op returns `before` itself, byte for byte. The applier can compare
//      and skip the write, which keeps the undo journal down to the files a run
//      actually changed.
//   2. Nothing throws and nothing guesses. An op that cannot be expressed
//      safely (a tag that is not a legal tag, a frontmatter key containing a
//      colon) returns the input unchanged rather than writing an approximation
//      of what the author might have meant.
//   3. Ops that touch paths or the outside world (`move`, `rename`, `archive`,
//      `trash`, `notify`, `clipboard`) return null. They are not text, and
//      pretending otherwise would scatter the applier's path handling.
//   4. Frontmatter stays at byte 0. `prepend` and `apply-template` insert at the
//      top of the *body*, never above the `---` block, because a note whose
//      frontmatter moved down one line has silently lost every field it had.
//
// Idempotence is a feature here, not an accident. Workflows fire on events and
// on a schedule, so the same op WILL hit the same note twice. `add-tag` checks
// before it adds, `write-section` replaces rather than accumulates, and both
// refuse a note that ends inside an unclosed code fence (where what they wrote
// would be code, invisible to the next run, which would write it again). The
// only op that accumulates on purpose is `append`, which is what it means.
//
// Scope: this module owns *inline* `#tag` text and flat scalar frontmatter,
// which is exactly the pair that `parseFrontmatter` and the vault's tag
// extraction already agree on. It deliberately never rewrites a frontmatter
// `tags:` list: that is a different, riskier edit, and `set-frontmatter` is the
// op for frontmatter.

import { parseFrontmatter } from '../template-files'
import type { WorkflowOp } from './types'

/* -------------------------------------------------------------------------- */
/*  Which ops are text ops                                                    */
/* -------------------------------------------------------------------------- */

/** The `WorkflowOp` kinds whose whole effect is "these bytes become those bytes". */
export type TextOpKind =
  | 'set-frontmatter'
  | 'add-tag'
  | 'remove-tag'
  | 'append'
  | 'prepend'
  | 'write-section'
  | 'write-note'
  | 'create-note'
  | 'apply-template'

export type TextOp = Extract<WorkflowOp, { kind: TextOpKind }>

export const TEXT_OP_KINDS: ReadonlySet<WorkflowOp['kind']> = new Set<TextOpKind>([
  'set-frontmatter',
  'add-tag',
  'remove-tag',
  'append',
  'prepend',
  'write-section',
  'write-note',
  'create-note',
  'apply-template'
])

/**
 * Does this op change a single file's text? The applier uses it to decide which
 * ops need the file read (and journalled) before they run.
 */
export function isTextOp(op: WorkflowOp): op is TextOp {
  return TEXT_OP_KINDS.has(op.kind)
}

/* -------------------------------------------------------------------------- */
/*  The entry point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Apply one op to one file's text.
 *
 * `before` is the file's current content, or `''` for a file that does not
 * exist yet. Returns the new content, or null when `op` is not a text op (the
 * caller owns moves, renames, archive, trash, notifications and the clipboard).
 *
 * The returned string is `before` itself when the op changes nothing, so
 * `result === before` is a reliable "skip this write" test.
 */
export function applyTextOp(before: string, op: WorkflowOp): string | null {
  switch (op.kind) {
    case 'set-frontmatter':
      return setFrontmatterField(before, op.field, op.value)
    case 'add-tag':
      return addInlineTag(before, op.tag)
    case 'remove-tag':
      return removeInlineTag(before, op.tag)
    case 'append':
      return appendBlock(before, op.text)
    case 'prepend':
      return prependBlock(before, op.text)
    case 'write-section':
      return writeSection(before, op.heading, op.text)
    case 'write-note':
      return wholeFile(op.text)
    case 'create-note':
      return wholeFile(op.body)
    case 'apply-template':
      // Templates are resolved by the CALLER: it looks `op.template` up and
      // hands us an op whose `template` field is the template's body. When it
      // does not, the name lands in the note verbatim, which is a visible
      // failure the author can see and fix rather than a silent no-op.
      return prependBlock(before, op.template)
    case 'move':
    case 'rename':
    case 'archive':
    case 'trash':
    case 'notify':
    case 'clipboard':
      // Paths and the outside world, not bytes. No `default` on purpose: a new
      // op kind must fail to compile here until someone decides which side of
      // this line it falls on.
      return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Lines                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One line and the line ending that followed it (`''` at end of file when the
 * text did not end with a break). Carrying the ending per line is what lets
 * every transform below rebuild the untouched parts of a file byte for byte,
 * including a CRLF file written on Windows.
 */
interface Line {
  text: string
  eol: string
}

function splitLines(text: string): Line[] {
  const out: Line[] = []
  const re = /\r?\n/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), eol: m[0] })
    start = re.lastIndex
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: '' })
  return out
}

function joinLines(lines: readonly Line[]): string {
  let out = ''
  for (const line of lines) out += line.text + line.eol
  return out
}

/** The file's own line ending, taken from its first break. New separators use
 *  it so a CRLF note stays a CRLF note. */
function firstEol(text: string): string {
  const m = /\r?\n/.exec(text)
  return m ? m[0] : '\n'
}

const LEADING_BREAKS = /^(?:\r?\n)+/
const TRAILING_BREAKS = /(?:\r?\n)+$/

function endsWithBreak(text: string): boolean {
  return TRAILING_BREAKS.test(text)
}

function ensureTrailingBreak(text: string, eol: string): string {
  return text === '' || endsWithBreak(text) ? text : text + eol
}

function countBreaks(run: string): number {
  let n = 0
  for (const ch of run) if (ch === '\n') n += 1
  return n
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
 * Glue two blocks together with at least `minBreaks` line breaks and never more
 * than two.
 *
 * The wider gap wins. One break is "start on a new line" and is the floor, since
 * running two blocks together would change what the markdown means. Two breaks
 * (one blank line) is what a `head` that already ended with a blank line, or a
 * `tail` that starts with one, asks for. Capping at two is the rule that stops a
 * nightly append from walking a file's bottom edge downwards, one blank line per
 * run, forever.
 */
function joinBlocks(head: string, tail: string, eol: string, minBreaks = 1): string {
  const headCore = head.replace(TRAILING_BREAKS, '')
  const tailCore = tail.replace(LEADING_BREAKS, '')
  if (tailCore === '') return head
  if (headCore === '') return tailCore
  const headGap = countBreaks(head.slice(headCore.length))
  const tailGap = countBreaks(tail.slice(0, tail.length - tailCore.length))
  const gap = Math.min(Math.max(headGap, tailGap, minBreaks), 2)
  return headCore + eol.repeat(gap) + tailCore
}

/* -------------------------------------------------------------------------- */
/*  Code fences and inline code                                               */
/* -------------------------------------------------------------------------- */

interface CodeMap {
  /** True for every line that is fenced code, delimiters included. */
  inCode: boolean[]
  /**
   * True when the file ends with a fence still open. Per CommonMark (and per
   * every copy of `stripCodeContent`) that fence runs to the end of the
   * document, so the end of the file is inside a code block and anything
   * appended there is code, not markdown.
   */
  endsInsideFence: boolean
}

/**
 * Which lines are fenced code.
 *
 * The state machine is lifted from `stripCodeContent` (packages/app-core/src/
 * lib/tags.ts, apps/desktop/src/main/vault.ts, apps/desktop/src/mcp/vault-ops.ts
 * and internal/vault/parse.go in ZenNotes/znserver all carry a copy) so that a `#tag`
 * this module writes, and a `#tag` the vault's indexer reads, can never disagree
 * about what is code. It returns per-line flags instead of a blanked string
 * because we edit the original bytes and therefore need offsets to survive.
 * Indentation tolerant, so a fence nested under a list item still hides its
 * `#include` (#293).
 */
function codeFenceLines(lines: readonly Line[]): CodeMap {
  const inCode = new Array<boolean>(lines.length).fill(false)
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (m) {
      const marker = m[1]
      const char = marker[0]
      const rest = m[2]
      if (!inFence) {
        // A backtick fence's info string may not contain a backtick (CommonMark),
        // which keeps a single-line ``` `inline` ``` out of fence handling.
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          inCode[i] = true
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        inCode[i] = true
        continue
      }
    }
    if (inFence) inCode[i] = true
  }
  return { inCode, endsInsideFence: inFence }
}

/** Blank inline code spans to spaces of the same width, so offsets still line
 *  up with the original line. */
function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line
  return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
}

/** How many leading lines belong to the frontmatter block, per `parseFrontmatter`.
 *  The inline tag scan starts after them: a `#` in some other field is not a tag
 *  (#444). */
function frontmatterLineCount(text: string, lines: readonly Line[]): number {
  const { body } = parseFrontmatter(text)
  let remaining = text.length - body.length
  if (remaining <= 0) return 0
  let count = 0
  for (const line of lines) {
    if (remaining <= 0) break
    remaining -= line.text.length + line.eol.length
    count += 1
  }
  return count
}

/* -------------------------------------------------------------------------- */
/*  set-frontmatter                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Quote a scalar that would otherwise break the block.
 *
 * When to quote mirrors `yamlScalar` in ../template-files and `yamlValue` in
 * ../frontmatter (neither is exported, hence this third copy: keep the three in
 * step). Which quote to use does not: single quotes are preferred because
 * `parseFrontmatter` strips a quote pair without unescaping, so a value
 * containing a double quote survives a write/read round trip only in single
 * quotes. A value containing both quote flavours or a newline falls back to a
 * JSON double-quoted scalar, which is valid YAML and, more to the point, keeps
 * the value on one line so the block cannot be broken.
 */
function frontmatterScalar(value: string): string {
  const needsQuotes = /[:#"'\n\r]/.test(value) || value.trim() !== value || value === ''
  if (!needsQuotes) return value
  if (!value.includes("'") && !/[\n\r]/.test(value)) return `'${value}'`
  return JSON.stringify(value)
}

/** The key a `key: value` line declares, matched exactly the way
 *  `parseFrontmatter` matches it so this writer and that reader agree. */
function frontmatterKey(line: string): string | null {
  const idx = line.indexOf(':')
  if (idx === -1) return null
  const key = line.slice(0, idx).trim()
  return key === '' ? null : key
}

function setFrontmatterField(before: string, field: string, value: string): string {
  // A key with a colon or a newline in it cannot be written back and read as
  // itself, so we refuse rather than corrupt the block.
  const key = field.trim()
  if (key === '' || key.includes(':') || /[\n\r]/.test(key)) return before

  const eol = firstEol(before)
  const { body } = parseFrontmatter(before)
  const headLen = before.length - body.length

  if (headLen === 0) {
    // No block (or a malformed one that the reader does not recognize): create
    // one above whatever is there, exactly as `updateFrontmatterFields` does.
    return `---${eol}${key}: ${frontmatterScalar(value)}${eol}---${eol}${before}`
  }

  // `parseFrontmatter` already vouched for the delimiters; these two only
  // measure them, they do not get a second opinion about what a block is.
  const head = before.slice(0, headLen)
  const open = /^---\r?\n/.exec(head)
  const close = /\r?\n---\r?\n?$/.exec(head)
  if (!open || !close) return before
  const innerStart = open[0].length
  const innerEnd = Math.max(close.index, innerStart)

  const inner = splitLines(before.slice(innerStart, innerEnd))
  const written = `${key}: ${frontmatterScalar(value)}`
  const out: Line[] = []
  let replaced = false
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i]
    // Every matching line is rewritten, not just the first: `parseFrontmatter`
    // lets a later duplicate win, so leaving one behind would mean the value the
    // app reads back is not the value we were asked to set.
    if (frontmatterKey(line.text) !== key) {
      out.push(line)
      continue
    }
    // A bare `key:` owns the indented `- item` lines under it. They are its
    // value, so replacing the value drops them; leaving them would strand a
    // list under a scalar. The rewritten line inherits the last dropped line's
    // ending so the block does not gain a blank line at its foot.
    let eolAfter = line.eol
    if (line.text.slice(line.text.indexOf(':') + 1).trim() === '') {
      while (i + 1 < inner.length && /^\s+-(\s|$)/.test(inner[i + 1].text)) {
        i += 1
        eolAfter = inner[i].eol
      }
    }
    out.push({ text: written, eol: eolAfter })
    replaced = true
  }
  if (!replaced) {
    if (out.length > 0) out[out.length - 1] = { ...out[out.length - 1], eol }
    out.push({ text: written, eol: '' })
  }

  const next = joinLines(out)
  if (next === before.slice(innerStart, innerEnd)) return before
  return before.slice(0, innerStart) + next + before.slice(innerEnd)
}

/* -------------------------------------------------------------------------- */
/*  add-tag / remove-tag                                                      */
/* -------------------------------------------------------------------------- */

/** Same shape the vault's extractor recognizes: a letter in any script (#205)
 *  then letters, digits, `_`, `-` or `/`. */
const INLINE_TAG_RE = /^\p{L}[\p{L}\d_/-]*$/u

/** `(^|whitespace)#tag`, capturing the boundary so we know where the tag starts. */
const TAG_PATTERN = '(^|\\s)#(\\p{L}[\\p{L}\\d_/-]*)'

interface TagHit {
  line: number
  /** Index of the `#` within the line. */
  start: number
  /** Index just past the tag within the line. */
  end: number
}

/**
 * Every inline occurrence of one tag, skipping the frontmatter block, fenced
 * code and inline code spans.
 *
 * Comparison is case-insensitive to match `matchesSelectedTags`: the Tags view
 * treats `#Book` and `#book` as one tag, so `add-tag book` must not add a second
 * spelling of a tag the note already carries. Hierarchical tags compare whole:
 * `project` does not match `#project/compiler`, which is a different tag.
 */
function findInlineTags(
  lines: readonly Line[],
  code: readonly boolean[],
  from: number,
  tag: string
): TagHit[] {
  const target = tag.toLowerCase()
  const hits: TagHit[] = []
  for (let i = from; i < lines.length; i++) {
    if (code[i]) continue
    const masked = maskInlineCode(lines[i].text)
    if (!masked.includes('#')) continue
    const re = new RegExp(TAG_PATTERN, 'gu')
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      if (m[2].toLowerCase() !== target) continue
      const start = m.index + m[1].length
      hits.push({ line: i, start, end: start + 1 + m[2].length })
    }
  }
  return hits
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#/, '').trim()
}

function addInlineTag(before: string, rawTag: string): string {
  const tag = normalizeTag(rawTag)
  if (!INLINE_TAG_RE.test(tag)) return before
  const lines = splitLines(before)
  const code = codeFenceLines(lines)
  // A note that ends inside an unclosed fence has no place to put a tag: the end
  // of the file is code, so the tag would not read back as a tag, and the next
  // run would not see it and would add another. Refusing keeps a malformed note
  // malformed instead of letting a nightly workflow grow it without bound.
  if (code.endsInsideFence) return before
  const from = frontmatterLineCount(before, lines)
  // Idempotent by construction: a workflow that fires twice, or a scheduled one
  // that fires nightly, must not stack `#book #book #book` down a note.
  if (findInlineTags(lines, code.inCode, from, tag).length > 0) return before
  return appendBlock(before, `#${tag}`)
}

function removeInlineTag(before: string, rawTag: string): string {
  const tag = normalizeTag(rawTag)
  if (!INLINE_TAG_RE.test(tag)) return before
  const lines = splitLines(before)
  const from = frontmatterLineCount(before, lines)
  const hits = findInlineTags(lines, codeFenceLines(lines).inCode, from, tag)
  if (hits.length === 0) return before

  const byLine = new Map<number, TagHit[]>()
  for (const hit of hits) {
    const list = byLine.get(hit.line)
    if (list) list.push(hit)
    else byLine.set(hit.line, [hit])
  }

  const next = lines.slice()
  const emptied: number[] = []
  for (const [index, lineHits] of byLine) {
    const original = next[index].text
    let text = original
    // Right to left so earlier offsets stay valid.
    for (const hit of [...lineHits].reverse()) {
      let start = hit.start
      let end = hit.end
      const prevSpace = start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')
      const nextSpace = text[end] === ' ' || text[end] === '\t'
      // Swallow exactly one adjacent space so `Read #book today` becomes
      // `Read today` rather than `Read  today`.
      if (prevSpace && (nextSpace || end >= text.length)) start -= 1
      else if (nextSpace && !prevSpace) end += 1
      text = text.slice(0, start) + text.slice(end)
    }
    next[index] = { ...next[index], text }
    if (isBlank(text) && !isBlank(original)) emptied.push(index)
  }

  // A line that held nothing but the tag goes away with it, and if that leaves a
  // blank line on both sides of the hole, one of them goes too.
  const drop = new Set<number>(emptied)
  for (const index of emptied) {
    const prevBlank = index > 0 && isBlank(next[index - 1].text) && !drop.has(index - 1)
    const nextBlank = index + 1 < next.length && isBlank(next[index + 1].text)
    if (prevBlank && nextBlank) drop.add(index + 1)
  }
  return joinLines(next.filter((_, index) => !drop.has(index)))
}

/* -------------------------------------------------------------------------- */
/*  append / prepend                                                          */
/* -------------------------------------------------------------------------- */

function appendBlock(before: string, text: string): string {
  const eol = firstEol(before)
  const joined = joinBlocks(before, text, eol)
  // A file that ended with a newline still does. Nothing else in the vault
  // strips one, and git would show the whole last line as changed if we did.
  return endsWithBreak(before) ? ensureTrailingBreak(joined, eol) : joined
}

function prependBlock(before: string, text: string): string {
  // Nothing to insert stays byte-identical. Checked here rather than in
  // `joinBlocks` because the text is the *head* of that join, and a head with no
  // content would otherwise take the body's own leading blank lines with it.
  if (text.replace(LEADING_BREAKS, '').replace(TRAILING_BREAKS, '') === '') return before
  // Insert at the top of the BODY. Above the `---` block is not "the top of the
  // note", it is the end of the note having frontmatter at all.
  const { body } = parseFrontmatter(before)
  const head = before.slice(0, before.length - body.length)
  const eol = firstEol(before)
  const joined = joinBlocks(text, body, eol)
  return head + (endsWithBreak(body) ? ensureTrailingBreak(joined, eol) : joined)
}

/* -------------------------------------------------------------------------- */
/*  write-section                                                             */
/* -------------------------------------------------------------------------- */

interface Heading {
  level: number
  title: string
}

/** An ATX heading (`## Title`), CommonMark shaped: up to three leading spaces, a
 *  space after the hashes (so `#tag` is a tag and not a heading), and an
 *  optional closing run of hashes. Setext (`Title` over `====`) is not
 *  supported: sections are addressed by name, and `write-section` creates ATX. */
function atxHeading(line: string): Heading | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line)
  if (!m) return null
  const title = (m[2] ?? '')
    .trim()
    .replace(/[ \t]+#+$/, '')
    .trim()
  return { level: m[1].length, title }
}

/** Read the op's heading argument. A leading run of hashes pins the level, so
 *  `## Finished` matches only an `h2`; a bare `Finished` matches the section at
 *  whatever level the note happens to use. */
function requestedHeading(raw: string): { level: number | null; title: string } {
  const trimmed = raw.trim()
  const m = /^(#{1,6})[ \t]*/.exec(trimmed)
  if (!m) return { level: null, title: trimmed }
  return { level: m[1].length, title: trimmed.slice(m[0].length).trim() }
}

function sameHeading(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Replace the body under a heading, leaving the heading line and everything
 * outside the section untouched.
 *
 * This is the idempotent sink the whole design leans on: a workflow whose last
 * step is `write-section "Log.md" "Finished"` can run every night and the file
 * converges instead of growing. Which means the shape written here has to be a
 * fixpoint, so the section body is always rebuilt in one canonical form (blank
 * line, text, blank line before whatever follows) rather than patched.
 *
 * A section ends at the next heading of the SAME OR HIGHER rank. A `###` inside
 * a `##` section is part of that section, which is the difference between
 * replacing "the Finished section" and replacing "everything to the next `#`
 * character in column one".
 */
function writeSection(before: string, rawHeading: string, text: string): string {
  const want = requestedHeading(rawHeading)
  if (want.title === '') return before

  const eol = firstEol(before)
  const lines = splitLines(before)
  const code = codeFenceLines(lines)
  const from = frontmatterLineCount(before, lines)
  // The canonical shape owns the blank lines around the section, so the text's
  // own edge breaks are dropped rather than added to.
  const body = text.replace(LEADING_BREAKS, '').replace(TRAILING_BREAKS, '')

  let index = -1
  let level = want.level ?? 2
  for (let i = from; i < lines.length; i++) {
    if (code.inCode[i]) continue
    const heading = atxHeading(lines[i].text)
    if (!heading || !sameHeading(heading.title, want.title)) continue
    if (want.level !== null && heading.level !== want.level) continue
    index = i
    level = heading.level
    break
  }

  if (index === -1) {
    // Absent, and the file ends inside an unclosed fence: a heading written
    // there would be code, so the next run would not find it and would write
    // another. Same reasoning as `add-tag`, same refusal.
    if (code.endsInsideFence) return before
    // Absent: create it at the end, one blank line clear of what is there.
    const title = headingLine(level, want.title)
    const block = body === '' ? title : `${title}${eol}${eol}${body}`
    const joined = joinBlocks(before, block, eol, 2)
    return endsWithBreak(before) || before === '' ? ensureTrailingBreak(joined, eol) : joined
  }

  let end = lines.length
  for (let i = index + 1; i < lines.length; i++) {
    if (code.inCode[i]) continue
    const heading = atxHeading(lines[i].text)
    if (heading && heading.level <= level) {
      end = i
      break
    }
  }

  const section: Line[] = []
  if (body !== '') {
    section.push({ text: '', eol })
    for (const part of body.split(/\r?\n/)) section.push({ text: part, eol })
  }
  if (end < lines.length) section.push({ text: '', eol })

  const head = lines.slice(0, index + 1)
  if (section.length > 0 && head[head.length - 1].eol === '') {
    // The file ended on the heading line; it needs a break before its new body.
    head[head.length - 1] = { ...head[head.length - 1], eol }
  }
  if (end >= lines.length && section.length > 0 && !endsWithBreak(before)) {
    // The file did not end with a newline, so it still does not.
    section[section.length - 1] = { ...section[section.length - 1], eol: '' }
  }

  const next = joinLines([...head, ...section, ...lines.slice(end)])
  return next === before ? before : next
}

function headingLine(level: number, title: string): string {
  return `${'#'.repeat(level)} ${title}`
}

/* -------------------------------------------------------------------------- */
/*  write-note / create-note                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whole-file replacement. `before` is ignored on purpose: these two ops carry
 * the complete intended contents, and the previous bytes are the applier's
 * business (it journals them so undo can put them back).
 *
 * The one liberty taken is a trailing newline on non-empty content: rendered
 * text arrives joined with `\n` and no terminator, and a generated file that
 * ends mid-line is a diff smell in every tool that will ever read the vault.
 */
function wholeFile(text: string): string {
  if (text === '') return ''
  return ensureTrailingBreak(text, firstEol(text))
}
