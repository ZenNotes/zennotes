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
 * reuse the untouched blocks. The two moments the body start moves (the
 * closing fence typed for the first time, or broken) cost one full body
 * parse, the same as opening the note; parseMixed cannot find the old mount
 * across that move. The test file pins both behaviours.
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
    return this.wrap(new NoteParse(input, ranges), input, fragments, ranges)
  }
}

/** The markdown language the body is parsed with: GFM plus the vault's code
 *  fence languages. Its keymap is left off; `vimAwareMarkdownKeymap` adds
 *  the same bindings with Vim deference. */
const noteBody = markdown({
  base: markdownLanguage,
  codeLanguages: resolveCodeLanguage,
  addKeymap: false
})

export const noteLanguage = new Language(
  noteLanguageData,
  new NoteParser(noteBody.language.parser),
  [],
  'markdown'
)

/** Language support for a note editor. Replaces `markdown({...})` in every
 *  editor so they all agree on where frontmatter ends and markdown begins. */
export function noteMarkdown(): LanguageSupport {
  return new LanguageSupport(noteLanguage, noteBody.support)
}
