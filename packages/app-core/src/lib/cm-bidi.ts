import { CodeMirror, Vim } from '@replit/codemirror-vim'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

/**
 * Right-to-left lines (#134). Each line takes the direction of its first
 * strong letter, so a Hebrew or Arabic line aligns right and the arrow keys
 * and `h`/`l` move the way they point on screen.
 *
 * The direction is computed here rather than left to `dir="auto"`, because
 * the browser would decide on the first letter of the Markdown source: the
 * `x` of `- [x] مهمة` makes a task line left-to-right. Leading list markers,
 * task boxes, heading hashes and quote markers are skipped first, and the
 * same answer feeds the rendered `dir`, CodeMirror's arrow keys (through
 * `perLineTextDirection`) and the Vim motion, so the three never disagree.
 */

// Letters of the scripts written right to left. Marks and digits are not
// strong, so `123 שלום` is still a right-to-left line.
const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u
// The first strong character: any letter, or an explicit LRM / RLM / ALM.
const FIRST_STRONG = /[\p{L}‎‏؜]/u
const MARKDOWN_PREFIX =
  /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX>/-]\][ \t]+)?)?/

function firstStrongIsRtl(text: string): boolean | null {
  const match = FIRST_STRONG.exec(text)
  if (!match) return null
  const ch = match[0]
  if (ch === '‎') return false
  if (ch === '‏' || ch === '؜') return true
  return RTL_LETTER.test(ch)
}

/** Whether a line of Markdown source reads right to left. */
export function lineIsRtl(text: string): boolean {
  const body = text.slice(MARKDOWN_PREFIX.exec(text)?.[0].length ?? 0)
  return firstStrongIsRtl(body) ?? firstStrongIsRtl(text) ?? false
}

const rtlLine = Decoration.line({ attributes: { dir: 'rtl' } })

function rtlLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { doc } = view.state
  let lastLine = -1
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos)
      if (line.number !== lastLine && lineIsRtl(line.text)) {
        builder.add(line.from, line.from, rtlLine)
      }
      lastLine = line.number
      pos = line.to + 1
    }
  }
  return builder.finish()
}

const rtlLinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = rtlLineDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = rtlLineDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/**
 * Per-line text direction for an editor: right-to-left lines get `dir="rtl"`
 * (so they align right, `text-align` being `start`), and CodeMirror reads the
 * direction of each line, which makes the arrow keys move visually.
 */
export const bidiExtension: Extension = [EditorView.perLineTextDirection.of(true), rtlLinePlugin]

type VimCharCm = { getLine: (line: number) => string }
type VimCharMotionArgs = { forward?: boolean; repeat?: number }

/** `h`/`l` by what is on screen: in a right-to-left line `l` steps back. */
function zenMoveByVisualCharacters(
  cm: VimCharCm,
  head: { line: number; ch: number },
  motionArgs: VimCharMotionArgs
): { line: number; ch: number } {
  const repeat = motionArgs.repeat ?? 1
  const forward = Boolean(motionArgs.forward) !== lineIsRtl(cm.getLine(head.line))
  return new CodeMirror.Pos(head.line, forward ? head.ch + repeat : head.ch - repeat)
}

let visualCharMotionRegistered = false

/**
 * Register the visual `h`/`l` motion on the (per-window) global Vim (#134).
 * Like Vim's 'rightleft', it applies in every context, so `dl` in a
 * right-to-left line deletes the character to the right on screen. `x`, `<BS>`
 * and `<Space>` keep their logical meaning. `<Left>`/`<Right>` are mapped as
 * well: Vim forwards them to its built-in `h`/`l` without remapping, so they
 * would otherwise still move backwards in a right-to-left line. Idempotent.
 */
export function registerVisualCharMotion(): void {
  if (visualCharMotionRegistered) return
  visualCharMotionRegistered = true
  Vim.defineMotion(
    'zenMoveByVisualCharacters',
    zenMoveByVisualCharacters as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  for (const context of ['normal', 'visual', 'operatorPending'] as const) {
    for (const key of ['h', '<Left>']) {
      Vim.mapCommand(key, 'motion', 'zenMoveByVisualCharacters', { forward: false }, { context })
    }
    for (const key of ['l', '<Right>']) {
      Vim.mapCommand(key, 'motion', 'zenMoveByVisualCharacters', { forward: true }, { context })
    }
  }
}
