/**
 * LaTeX command completion for math regions: typing `\su` inside `$…$` or
 * `$$…$$` pops KaTeX commands (`\sum`, `\sqrt`, …) with a rendered preview.
 * Commands that take arguments insert as snippets, so accepting `\frac`
 * lands the cursor in the numerator and Tab moves to the denominator.
 *
 * Math-region detection mirrors cm-math-render's delimiters, but stays a
 * cheap unmatched-delimiter scan: while the user is mid-formula the closing
 * `$` usually does not exist yet, which is exactly when completion matters.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { snippet } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import katex from 'katex'
import { mathRendererOf } from './cm-math-render'

interface LatexCommand {
  /** Command as typed, with the backslash: `\sum`. */
  label: string
  detail: string
  /** Snippet template when the command takes arguments. */
  template?: string
  /** LaTeX rendered in the popup preview; defaults to the label. */
  preview?: string
  /** Ranking bump for everyday commands. */
  boost?: number
}

const g = (name: string): LatexCommand => ({ label: `\\${name}`, detail: 'greek' })
const rel = (name: string): LatexCommand => ({ label: `\\${name}`, detail: 'relation' })
const arr = (name: string): LatexCommand => ({ label: `\\${name}`, detail: 'arrow' })
const bin = (name: string): LatexCommand => ({ label: `\\${name}`, detail: 'operator' })
const fnc = (name: string): LatexCommand => ({ label: `\\${name}`, detail: 'function', preview: `\\${name} x` })
const sym = (name: string, detail = 'symbol'): LatexCommand => ({ label: `\\${name}`, detail })
const env = (name: string, inner: string): LatexCommand => ({
  label: `\\${name}`,
  detail: 'environment',
  template: `\\begin{${name}}\n\t\${}\n\\end{${name}}`,
  preview: `\\begin{${name}}${inner}\\end{${name}}`
})

const LATEX_COMMANDS: LatexCommand[] = [
  // Everyday constructs, boosted to the top.
  { label: '\\frac', detail: 'fraction', template: '\\frac{${}}{${}}', preview: '\\frac{a}{b}', boost: 99 },
  { label: '\\sqrt', detail: 'square root', template: '\\sqrt{${}}', preview: '\\sqrt{x}', boost: 98 },
  { label: '\\sum', detail: 'sum', template: '\\sum_{${i=1}}^{${n}}', preview: '\\sum_{i=1}^{n}', boost: 97 },
  { label: '\\int', detail: 'integral', template: '\\int_{${a}}^{${b}}', preview: '\\int_{a}^{b}', boost: 96 },
  { label: '\\lim', detail: 'limit', template: '\\lim_{${x \\to 0}}', preview: '\\lim_{x \\to 0}', boost: 95 },
  { label: '\\prod', detail: 'product', template: '\\prod_{${i=1}}^{${n}}', preview: '\\prod_{i=1}^{n}', boost: 90 },
  { label: '\\infty', detail: 'infinity', boost: 90 },
  { label: '\\sqrt[n]', detail: 'nth root', template: '\\sqrt[${}]{${}}', preview: '\\sqrt[n]{x}' },
  { label: '\\dfrac', detail: 'display fraction', template: '\\dfrac{${}}{${}}', preview: '\\dfrac{a}{b}' },
  { label: '\\binom', detail: 'binomial', template: '\\binom{${}}{${}}', preview: '\\binom{n}{k}' },

  // Greek.
  ...[
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
    'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'varsigma', 'tau', 'upsilon',
    'phi', 'varphi', 'chi', 'psi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'
  ].map(g),

  // Big operators, scaffolded with their usual bounds like `\sum` above.
  { label: '\\coprod', detail: 'big operator', template: '\\coprod_{${i=1}}^{${n}}', preview: '\\coprod_{i=1}^{n}' },
  { label: '\\iint', detail: 'big operator', template: '\\iint_{${D}}', preview: '\\iint_{D}' },
  { label: '\\iiint', detail: 'big operator', template: '\\iiint_{${V}}', preview: '\\iiint_{V}' },
  { label: '\\oint', detail: 'big operator', template: '\\oint_{${C}}', preview: '\\oint_{C}' },
  { label: '\\limsup', detail: 'big operator', template: '\\limsup_{${n \\to \\infty}}', preview: '\\limsup_{n \\to \\infty}' },
  { label: '\\liminf', detail: 'big operator', template: '\\liminf_{${n \\to \\infty}}', preview: '\\liminf_{n \\to \\infty}' },
  ...['bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigsqcup', 'bigvee', 'bigwedge'].map(
    (name): LatexCommand => ({
      label: `\\${name}`,
      detail: 'big operator',
      template: `\\${name}_{\${i}}`,
      preview: `\\${name}_{i}`
    })
  ),

  // Accents and decorations.
  ...[
    ['hat', '\\hat{x}'], ['bar', '\\bar{x}'], ['vec', '\\vec{x}'], ['dot', '\\dot{x}'], ['ddot', '\\ddot{x}'],
    ['tilde', '\\tilde{x}'], ['widehat', '\\widehat{xy}'], ['widetilde', '\\widetilde{xy}'],
    ['overline', '\\overline{xy}'], ['underline', '\\underline{xy}'],
    ['overbrace', '\\overbrace{xy}'], ['underbrace', '\\underbrace{xy}'], ['boxed', '\\boxed{x}'],
    ['cancel', '\\cancel{x}']
  ].map(([name, preview]): LatexCommand => ({
    label: `\\${name}`,
    detail: 'accent',
    template: `\\${name}{\${}}`,
    preview
  })),

  // Fonts and text.
  ...[
    ['text', '\\text{if}'], ['mathrm', '\\mathrm{d}'], ['mathbb', '\\mathbb{R}'], ['mathcal', '\\mathcal{L}'],
    ['mathfrak', '\\mathfrak{g}'], ['mathbf', '\\mathbf{v}'], ['mathit', '\\mathit{x}'],
    ['mathsf', '\\mathsf{A}'], ['mathtt', '\\mathtt{x}'], ['operatorname', '\\operatorname{op}']
  ].map(([name, preview]): LatexCommand => ({
    label: `\\${name}`,
    detail: 'font',
    template: `\\${name}{\${}}`,
    preview
  })),

  // Stacked constructs.
  { label: '\\overset', detail: 'stack above', template: '\\overset{${}}{${}}', preview: '\\overset{!}{=}' },
  { label: '\\underset', detail: 'stack below', template: '\\underset{${}}{${}}', preview: '\\underset{n}{\\max}' },
  { label: '\\stackrel', detail: 'stack relation', template: '\\stackrel{${}}{${}}', preview: '\\stackrel{def}{=}' },
  { label: '\\substack', detail: 'stacked subscript', template: '\\substack{${}}', preview: '\\sum_{\\substack{i<n}}' },
  { label: '\\xrightarrow', detail: 'labeled arrow', template: '\\xrightarrow{${}}', preview: '\\xrightarrow{f}' },
  { label: '\\xleftarrow', detail: 'labeled arrow', template: '\\xleftarrow{${}}', preview: '\\xleftarrow{f}' },
  { label: '\\overrightarrow', detail: 'over arrow', template: '\\overrightarrow{${}}', preview: '\\overrightarrow{AB}' },

  // Relations.
  ...[
    'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'simeq', 'cong', 'propto', 'll', 'gg', 'prec', 'succ',
    'subset', 'supset', 'subseteq', 'supseteq', 'in', 'notin', 'ni', 'mid', 'parallel', 'perp',
    'models', 'vdash', 'asymp', 'doteq'
  ].map(rel),

  // Arrows.
  ...[
    'to', 'gets', 'leftarrow', 'rightarrow', 'Leftarrow', 'Rightarrow', 'leftrightarrow', 'Leftrightarrow',
    'mapsto', 'longmapsto', 'longrightarrow', 'Longrightarrow', 'longleftarrow', 'uparrow', 'downarrow',
    'Uparrow', 'Downarrow', 'nearrow', 'searrow', 'hookrightarrow', 'rightharpoonup', 'rightleftharpoons',
    'implies', 'iff'
  ].map(arr),

  // Binary operators.
  ...[
    'pm', 'mp', 'times', 'div', 'cdot', 'ast', 'star', 'circ', 'bullet', 'cap', 'cup', 'uplus',
    'sqcap', 'sqcup', 'vee', 'wedge', 'setminus', 'oplus', 'ominus', 'otimes', 'oslash', 'odot', 'dagger'
  ].map(bin),

  // Named functions.
  ...[
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
    'exp', 'log', 'ln', 'lg', 'det', 'gcd', 'deg', 'dim', 'ker', 'arg', 'max', 'min', 'sup', 'inf', 'Pr'
  ].map(fnc),

  // Symbols and misc.
  sym('partial'), sym('nabla'), sym('forall'), sym('exists'), sym('nexists'), sym('neg'),
  sym('emptyset'), sym('varnothing'), sym('angle'), sym('triangle'), sym('square'), sym('aleph'),
  sym('hbar'), sym('ell'), sym('Re'), sym('Im'), sym('prime'), sym('therefore'), sym('because'),
  sym('cdots'), sym('vdots'), sym('ddots'), sym('ldots'), sym('dots'),
  sym('langle', 'delimiter'), sym('rangle', 'delimiter'), sym('lfloor', 'delimiter'),
  sym('rfloor', 'delimiter'), sym('lceil', 'delimiter'), sym('rceil', 'delimiter'),
  { label: '\\left(', detail: 'sized parens', template: '\\left( ${} \\right)', preview: '\\left( x \\right)' },
  { label: '\\quad', detail: 'space', preview: 'a \\quad b' },
  { label: '\\qquad', detail: 'wide space', preview: 'a \\qquad b' },
  { label: '\\displaystyle', detail: 'display style', preview: '\\displaystyle \\sum_i^n' },
  { label: '\\pmod', detail: 'parenthesized mod', template: '\\pmod{${}}', preview: 'a \\pmod{n}' },
  { label: '\\bmod', detail: 'binary mod', preview: 'a \\bmod n' },
  { label: '\\not', detail: 'negate relation', preview: '\\not\\equiv' },

  // Environments.
  env('pmatrix', 'a & b \\\\ c & d'),
  env('bmatrix', 'a & b \\\\ c & d'),
  env('vmatrix', 'a & b \\\\ c & d'),
  env('matrix', 'a & b \\\\ c & d'),
  env('cases', 'a & x>0 \\\\ b & x\\le 0'),
  env('aligned', 'a &= b \\\\ &= c'),
  env('gathered', 'a=b \\\\ c=d')
].flat()

type CodeContext = { kind: 'inline' } | { kind: 'fenced'; lang: string } | null

function codeContext(state: EditorState, pos: number): CodeContext {
  let node = syntaxTree(state).resolveInner(pos, 1)
  for (;;) {
    const n = node.name
    if (n === 'InlineCode') return { kind: 'inline' }
    if (n === 'FencedCode' || n === 'CodeBlock') {
      const info = node.getChild('CodeInfo')
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
      return { kind: 'fenced', lang }
    }
    if (!node.parent) return null
    node = node.parent
  }
}

/** Inside `$…$`, `$$…$$`, or a ```math fence at `pos`? Counts unmatched
 *  dollar delimiters so a formula still being typed (no closing `$` yet)
 *  already counts as math. */
/** Dollars inside code are not delimiters: `echo $$` in a shell block would
 *  otherwise flip the parity and make the rest of the note read as math. */
function countDelimiters(state: EditorState, from: number, text: string, re: RegExp): number {
  let count = 0
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue
    if (codeContext(state, from + match.index + 1)) continue
    count++
  }
  return count
}

export function isInMathContext(state: EditorState, pos: number): boolean {
  const code = codeContext(state, pos)
  // A ```math fence is a math region in its own right (remark-math renders
  // it as display math); every other code region shuts completion off.
  if (code) return code.kind === 'fenced' && code.lang === 'math'
  const blockFences = countDelimiters(
    state,
    0,
    state.doc.sliceString(0, pos),
    /(?<!\\)\$\$/g
  )
  if (blockFences % 2 === 1) return true
  const line = state.doc.lineAt(pos)
  const lineBefore = state.doc.sliceString(line.from, pos)
  // `$$` pairs on this line are block fences, already counted above.
  const singles =
    countDelimiters(state, line.from, lineBefore, /(?<!\\)\$/g) -
    2 * countDelimiters(state, line.from, lineBefore, /(?<!\\)\$\$/g)
  return singles % 2 === 1
}

/** The `\…` token ending at `pos`, or null. Exported for tests. */
export function latexTokenBefore(
  state: EditorState,
  pos: number
): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos)
  const textBefore = state.doc.sliceString(line.from, pos)
  // `\left(` aside, commands are letters only; `\\` (row break) never matches.
  const match = textBefore.match(/(?<!\\)\\([a-zA-Z]*)$/)
  if (!match) return null
  return { from: pos - match[0].length, query: match[1] }
}

let cachedOptions: Completion[] | null = null

function buildOptions(): Completion[] {
  cachedOptions ??= LATEX_COMMANDS.map(
    (cmd): Completion =>
      ({
        label: cmd.label,
        detail: cmd.detail,
        type: 'keyword',
        boost: cmd.boost ?? 0,
        _kind: 'latex',
        _preview: cmd.preview ?? cmd.label,
        apply: cmd.template ? snippet(cmd.template) : undefined
      }) as Completion & { _kind: string; _preview: string }
  )
  return cachedOptions
}

export function latexCommandSource(context: CompletionContext): CompletionResult | null {
  // These are LaTeX commands. A note set to the Typst typesetter takes
  // different syntax, so offering `\frac{}{}` there would only ever be wrong.
  if (mathRendererOf(context.state) !== 'katex') return null
  const token = latexTokenBefore(context.state, context.pos)
  if (!token) return null
  if (!isInMathContext(context.state, token.from)) return null
  return {
    from: token.from,
    options: buildOptions(),
    validFor: /^\\[a-zA-Z]*$/
  }
}

/** KaTeX output for one preview, kept between popups: a bare `\` opens the
 *  whole table at once, and re-typesetting every row each time it opens is the
 *  one visible cost this feature has. */
const previewCache = new Map<string, string>()

function renderPreview(latex: string): string {
  const cached = previewCache.get(latex)
  if (cached !== undefined) return cached
  let html = ''
  try {
    html = katex.renderToString(latex, { throwOnError: false })
  } catch {
    html = ''
  }
  previewCache.set(latex, html)
  return html
}

/** Full option row for a LaTeX completion — the KaTeX-rendered symbol sits in
 *  the icon slot, then label and detail reuse the slash-command layout. Called
 *  first from the shared `renderCompletion`; null for every other kind. */
export function renderLatexCompletion(completion: Completion): HTMLElement | null {
  const { _kind, _preview } = completion as Completion & { _kind?: string; _preview?: string }
  if (_kind !== 'latex') return null

  const el = document.createElement('div')
  el.className = 'slash-cmd-item'

  const icon = document.createElement('span')
  icon.className = 'slash-cmd-icon latex-cmd-icon'
  icon.style.fontSize = '0.72em'
  icon.style.lineHeight = '1'
  icon.style.display = 'inline-flex'
  icon.style.alignItems = 'center'
  icon.style.justifyContent = 'center'
  icon.innerHTML = renderPreview(_preview ?? completion.label)

  const label = document.createElement('span')
  label.className = 'slash-cmd-label'
  label.textContent = completion.label

  const detail = document.createElement('span')
  detail.className = 'slash-cmd-detail'
  detail.textContent = completion.detail ?? ''

  el.appendChild(icon)
  el.appendChild(label)
  el.appendChild(detail)
  return el
}
