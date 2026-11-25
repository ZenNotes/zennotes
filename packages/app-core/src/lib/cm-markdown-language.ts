/**
 * The note grammar every ZenNotes editor parses with: a leading YAML
 * frontmatter block carved out of the document, markdown for everything
 * after it.
 *
 * CommonMark knows nothing about frontmatter, so a note parsed as plain
 * markdown reads `key: value` lines followed by the closing `---` as a setext
 * heading (#827: the YAML header shows up in heading type) and the two fences
 * as horizontal rules. The properties card (cm-frontmatter.ts) used to paper
 * over that with CSS, but only inside the card, which does not load with Live
 * Preview off (#616), so the raw view was the one that broke.
 *
 * Why not the two obvious tools:
 *
 * - `yamlFrontmatter` from @codemirror/lang-yaml treats an unclosed `---` as
 *   YAML to the end of the document (a note that opens with a horizontal rule
 *   loses all markdown) and disagrees with `frontmatterRange` about a fence
 *   with stray whitespace, so the card and the grammar would drift apart.
 * - A markdown block-parser extension cannot see the closing fence when it is
 *   typed lines below an existing `---`: Lezer reuses the old HorizontalRule
 *   node from the previous tree and never re-runs the block parser on line 1,
 *   so the stale heading stays until the note is reopened.
 *
 * So this is a tiny outer parser. It re-scans the frontmatter range from the
 * raw input on every parse (O(1) unless line 1 is a fence, one pass to the
 * closing fence otherwise) and mounts the markdown parser onto the body
 * through `parseMixed`. The mount hands the previous markdown tree to the
 * inner parser as fragments, so body parsing stays incremental as long as the
 * body keeps its start: edits anywhere in the body or inside the frontmatter
 * reuse the untouched blocks.
 *
 * Two cases read again text that a plain markdown parser would reuse, and
 * both are kept on purpose. When the body start moves (the closing fence
 * typed for the first time, or broken), the mount is given no older trees
 * (`bodyKeptItsStart` below) and the body is parsed in full, the same as
 * opening the note. And the outer
 * tree always spans the whole note, so when a parse runs out of its 20 ms
 * slice, CodeMirror drops the older tree past that point and the parse that
 * resumes reads the rest again. Reusing the older blocks in those two cases
 * makes the tree go stale more often, because Lezer's markdown reuse can keep
 * a block whose meaning changed with text outside it: an indented code block
 * whose indent was deleted along with the frontmatter, a paragraph whose end
 * moved when a table row under it broke. Checked against a fresh parse 50,000
 * times over 100,000 random edits, this grammar was stale 3 times, the same
 * grammar with that reuse 29 times, and plain `markdown()` 205 times. The
 * cost is small: a typed character parses well inside its slice even in an
 * 800 KB note, and reading the rest after a cut costs what opening the note
 * costs, in background slices. The test file pins both behaviours.
 *
 * One consequence: `syntaxTree(state).length` is always the whole note, so it
 * does not say how far the parse got. Ask `ensureSyntaxTree` or
 * `syntaxTreeAvailable` instead, as `headingAbove` in table-to-database.ts
 * does.
 *
 * The frontmatter content is deliberately left untokenized: with Live Preview
 * off a note reads as its raw text (#616), and the card styles it when on.
 * Only the fences carry a token (`meta`), which the card already hides.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  defineLanguageFacet,
  indentNodeProp,
  Language,
  languageDataProp,
  LanguageSupport
} from '@codemirror/language'
import {
  type Input,
  NodeType,
  Parser,
  type ParseWrapper,
  type PartialParse,
  parseMixed,
  Tree,
  type TreeFragment
} from '@lezer/common'
import { styleTags, tags as t } from '@lezer/highlight'
import { isFrontmatterFence } from '@shared/markdown-lines'
import { resolveCodeLanguage } from './cm-code-languages'
import { headingIndentGuard } from './cm-heading-indent-guard'

type ParseRange = { from: number; to: number }

const noteLanguageData = defineLanguageFacet()

/** Top node. `indentNodeProp` mirrors the markdown Document (`() => null`):
 *  without it the tree's top-level fallback indents to column 0, and Enter on
 *  an indented frontmatter line would drop the indentation instead of
 *  copying it. */
const documentType = NodeType.define({
  id: 0,
  name: 'Document',
  top: true,
  props: [[languageDataProp, noteLanguageData], indentNodeProp.add({ Document: () => null })]
})
/** The whole block, opening fence through the end of the closing fence line;
 *  the same range `frontmatterRange` (cm-frontmatter.ts) computes. */
const frontmatterType = NodeType.define({ id: 1, name: 'Frontmatter' })
/** One `---` fence. */
const frontmatterMarkType = NodeType.define({
  id: 2,
  name: 'FrontmatterMark',
  props: [styleTags({ FrontmatterMark: t.meta })]
})
/** Everything after the frontmatter (the whole document without one). The
 *  markdown tree is mounted here, so this node itself never shows up when
 *  iterating the syntax tree: the markdown Document takes its place. */
const bodyType = NodeType.define({ id: 3, name: 'Body' })

interface FrontmatterSpan {
  /** End of the opening fence line (its text, no line break). */
  openTo: number
  closeFrom: number
  closeTo: number
}

const CHUNK = 4096

/**
 * Find a closed frontmatter block at the start of `[from, to)`, reading the
 * input in chunks so a large note is not sliced whole on every parse. Returns
 * null as soon as line 1 is not a fence, or after reaching the end without a
 * closing fence: an unclosed `---` stays markdown (a horizontal rule).
 */
export function scanFrontmatter(input: Input, from: number, to: number): FrontmatterSpan | null {
  let text = ''
  let textFrom = from
  let lineFrom = from
  let openTo = -1
  for (;;) {
    let newline = text.indexOf('\n', lineFrom - textFrom)
    while (newline < 0 && textFrom + text.length < to) {
      // Drop the lines already consumed before appending, so the working
      // string stays about one chunk long however far the scan goes.
      if (lineFrom > textFrom) {
        text = text.slice(lineFrom - textFrom)
        textFrom = lineFrom
      }
      const end = textFrom + text.length
      const next = input.read(end, Math.min(to, end + CHUNK))
      if (!next) break
      text += next
      newline = text.indexOf('\n', lineFrom - textFrom)
    }
    const lineTo = newline < 0 ? textFrom + text.length : textFrom + newline
    const line = text.slice(lineFrom - textFrom, lineTo - textFrom)
    if (isFrontmatterFence(line)) {
      if (openTo >= 0) return { openTo, closeFrom: lineFrom, closeTo: lineTo }
      openTo = lineTo
    } else if (openTo < 0) {
      return null
    }
    if (newline < 0) return null
    lineFrom = lineTo + 1
  }
}

function buildNoteTree(input: Input, from: number, to: number): Tree {
  const span = scanFrontmatter(input, from, to)
  const children: Tree[] = []
  const positions: number[] = []
  let bodyFrom = from
  if (span) {
    const fences = [
      new Tree(frontmatterMarkType, [], [], span.openTo - from),
      new Tree(frontmatterMarkType, [], [], span.closeTo - span.closeFrom)
    ]
    children.push(new Tree(frontmatterType, fences, [0, span.closeFrom - from], span.closeTo - from))
    positions.push(0)
    bodyFrom = span.closeTo
  }
  children.push(new Tree(bodyType, [], [], to - bodyFrom))
  positions.push(bodyFrom - from)
  return new Tree(documentType, children, positions, to - from)
}

/** The outer parse finishes in one step; `stopAt` is honoured by the mixed
 *  parse, which forwards it to the markdown parse of the body. */
class NoteParse implements PartialParse {
  parsedPos: number
  stoppedAt: number | null = null
  private readonly from: number
  private readonly to: number

  constructor(
    private readonly input: Input,
    ranges: readonly ParseRange[]
  ) {
    this.from = ranges[0].from
    this.to = ranges[ranges.length - 1].to
    this.parsedPos = this.from
  }

  advance(): Tree {
    const tree = buildNoteTree(this.input, this.from, this.to)
    this.parsedPos = this.to
    return tree
  }

  stopAt(pos: number): void {
    this.stoppedAt = pos
  }
}

class NoteParser extends Parser {
  private readonly wrap: ParseWrapper

  constructor(body: Parser) {
    super()
    this.wrap = parseMixed((node) => (node.type === bodyType ? { parser: body } : null))
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly ParseRange[]
  ): PartialParse {
    const from = ranges[0].from
    const to = ranges[ranges.length - 1].to
    const reusable = bodyKeptItsStart(input, from, to, fragments) ? fragments : []
    return this.wrap(new NoteParse(input, ranges), input, reusable, ranges)
  }
}

/** Where the Body node starts in a tree this parser built, or -1 for any
 *  other tree. */
function bodyStartOf(tree: Tree): number {
  const last = tree.children.length - 1
  const body = tree.children[last]
  if (tree.type !== documentType || !(body instanceof Tree) || body.type !== bodyType) return -1
  return tree.positions[last]
}

/**
 * Whether the older trees may be reused for this parse: only while the body
 * is the same stretch of text it was in each of them. That holds for an edit
 * in the body (the start stays where it was) and for an edit inside the
 * frontmatter (the body moves as a whole, its length unchanged). It does not
 * hold when the closing fence is typed for the first time, broken, or joined
 * by another fence above it, nor when the first characters of a note without
 * frontmatter are deleted (an indented code block there can lose its indent
 * and stay a code block): then the body is parsed in full, as the header says
 * and why. Every fragment is checked against its own tree, because the list
 * can still carry pieces of a tree from before such a change.
 *
 * This used to follow from parseMixed losing the old mount when the body
 * moved. @lezer/common 1.5.5 finds the mount again, so the rule is spelled
 * out here and holds on every version.
 */
function bodyKeptItsStart(
  input: Input,
  from: number,
  to: number,
  fragments: readonly TreeFragment[]
): boolean {
  if (!fragments.length) return true
  const span = scanFrontmatter(input, from, to)
  const bodyFrom = span ? span.closeTo : from
  for (const fragment of fragments) {
    const oldBodyFrom = bodyStartOf(fragment.tree)
    if (oldBodyFrom < 0) return false
    const sameStart = oldBodyFrom === bodyFrom - from
    const sameBody = fragment.tree.length - oldBodyFrom === to - bodyFrom
    if (!sameStart && !sameBody) return false
    // A fragment lying over the body's start has to begin with the old body's
    // start. One that does not is what a deletion at the note's very first
    // character leaves: the old text minus its first characters.
    if (
      fragment.from <= bodyFrom &&
      bodyFrom < fragment.to &&
      oldBodyFrom !== bodyFrom + fragment.offset
    ) {
      return false
    }
  }
  return true
}

type MarkdownExtension = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>

/**
 * A lone `-` under a line of text keeps that line a paragraph instead of a
 * setext heading (#898; the shared rule is described in
 * @shared/single-dash-underline). This runs before Lezer's setext parser, under
 * the same conditions (a line of the paragraph's own block, not a lazy one,
 * less than four columns in), and closes the paragraph on the dash line, where
 * the heading would have closed, so the Preview's remark rule parses the
 * lines that follow the same way.
 */
export const singleDashParagraphs: MarkdownExtension = {
  parseBlock: [
    {
      name: 'SingleDashParagraph',
      before: 'SetextHeading',
      leaf: () => ({
        nextLine(cx, line, leaf) {
          const lineDepth = (line as unknown as { depth?: number }).depth ?? cx.depth
          if (lineDepth < cx.depth || line.next !== 45 || line.indent >= line.baseIndent + 4) return false
          if (line.skipSpace(line.pos + 1) !== line.text.length) return false
          // As Lezer's own continuation lines do: container markup becomes
          // spaces, so content offsets stay document offsets.
          leaf.content += `\n${line.baseIndent ? ' '.repeat(line.basePos) + line.text.slice(line.basePos) : line.text}`
          cx.nextLine()
          cx.addLeafElement(
            leaf,
            cx.elt('Paragraph', leaf.start, cx.prevLineEnd(), cx.parser.parseInline(leaf.content, leaf.start))
          )
          return true
        },
        finish: () => false
      })
    }
  ]
}

/** The markdown language the body is parsed with: GFM plus the vault's code
 *  fence languages. Its keymap is left off; `vimAwareMarkdownKeymap` adds
 *  the same bindings with Vim deference. */
const noteBody = markdown({
  base: markdownLanguage,
  codeLanguages: resolveCodeLanguage,
  addKeymap: false,
  extensions: singleDashParagraphs
})

export const noteLanguage = new Language(
  noteLanguageData,
  new NoteParser(noteBody.language.parser),
  [],
  'markdown'
)

/** Language support for a note editor. Replaces `markdown({...})` in every
 *  editor so they all agree on where frontmatter ends and markdown begins.
 *  It also carries the heading indent guard (#925), so every editor that
 *  parses notes keeps Tab and `>>` from turning a heading into code. */
export function noteMarkdown(): LanguageSupport {
  return new LanguageSupport(noteLanguage, [noteBody.support, headingIndentGuard()])
}
