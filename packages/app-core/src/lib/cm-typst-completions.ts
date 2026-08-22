/**
 * Typst math completion, the sibling of cm-latex-completions for notes whose
 * typesetter is Typst. Typst has no backslash: commands are bare words
 * (`sum`, `alpha`, `frac(a, b)`), so the trigger is the identifier being
 * typed (from two letters on, to stay out of the way of one-letter
 * variables) inside the same `$…$` / `$$…$$` regions.
 *
 * Where LaTeX previews need KaTeX, most Typst entries are single glyphs with
 * an exact Unicode form (α, ∑, ∫, ℝ, ∀ …), shown directly in the icon slot.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { snippet } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import { isInMathContext } from './cm-latex-completions'
import { mathRendererOf } from './cm-math-render'
import { peekTypstMathSvg, renderTypstMathToSvg } from './typst-math-render'

interface TypstCommand {
  /** The word as typed: `sum`, `alpha`, `frac`. */
  label: string
  detail: string
  /** Snippet template when the function takes arguments. */
  template?: string
  /** Unicode glyph (or short sketch) for the icon slot. */
  icon: string
  /** Typst math compiled for the icon slot; the glyph paints while it loads.
   *  Constructs need this: no single glyph says `mat(1, 2; 3, 4)`. */
  preview?: string
  boost?: number
}

const GREEK: Array<[string, string]> = [
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['iota', 'ι'], ['kappa', 'κ'],
  ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'], ['rho', 'ρ'],
  ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'φ'], ['chi', 'χ'],
  ['psi', 'ψ'], ['omega', 'ω'],
  ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'],
  ['Pi', 'Π'], ['Sigma', 'Σ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω']
]

const SYMBOLS: Array<[string, string, string]> = [
  // [word, glyph, detail]
  ['oo', '∞', 'infinity'],
  ['diff', '∂', 'partial'],
  ['nabla', '∇', 'nabla'],
  ['forall', '∀', 'for all'],
  ['exists', '∃', 'exists'],
  ['in', '∈', 'element of'],
  ['union', '∪', 'set union'],
  ['subset', '⊂', 'subset'],
  ['supset', '⊃', 'superset'],
  ['approx', '≈', 'approximately'],
  ['equiv', '≡', 'equivalent'],
  ['prop', '∝', 'proportional'],
  ['times', '×', 'times'],
  ['dot.op', '⋅', 'dot operator'],
  ['plus.minus', '±', 'plus-minus'],
  ['RR', 'ℝ', 'reals'],
  ['NN', 'ℕ', 'naturals'],
  ['ZZ', 'ℤ', 'integers'],
  ['QQ', 'ℚ', 'rationals'],
  ['CC', 'ℂ', 'complexes'],
  ['dots.h', '⋯', 'horizontal dots'],
  ['dots.v', '⋮', 'vertical dots'],

  // Arrows. Typst also accepts the ASCII shorthands noted in the detail.
  ['arrow.r', '→', 'right arrow, or ->'],
  ['arrow.l', '←', 'left arrow, or <-'],
  ['arrow.l.r', '↔', 'left-right arrow, or <->'],
  ['arrow.r.double', '⇒', 'implies, or =>'],
  ['arrow.l.r.double', '⇔', 'if and only if, or <=>'],
  ['arrow.r.bar', '↦', 'maps to, or |->'],
  ['arrow.t', '↑', 'up arrow'],
  ['arrow.b', '↓', 'down arrow'],

  // Comparisons.
  ['lt.eq', '≤', 'less or equal, or <='],
  ['gt.eq', '≥', 'greater or equal, or >='],
  ['eq.not', '≠', 'not equal, or !='],

  // Sets.
  ['inter', '∩', 'set intersection'],
  ['nothing', '∅', 'empty set'],
  ['subset.eq', '⊆', 'subset or equal'],
  ['supset.eq', '⊇', 'superset or equal'],
  ['in.not', '∉', 'not element of'],

  // Operators.
  ['compose', '∘', 'function composition'],
  ['plus.o', '⊕', 'direct sum'],
  ['times.o', '⊗', 'tensor product'],
  ['dif', 'd', 'differential: dif x in integrals']
]

const FUNCTIONS = [
  'sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'exp', 'log', 'ln', 'det', 'max', 'min', 'sup', 'inf', 'arg', 'gcd', 'mod'
]

const TYPST_COMMANDS: TypstCommand[] = [
  // Everyday constructs, boosted to the top; templates are valid Typst math.
  { label: 'frac', detail: 'fraction, or just a/b', template: 'frac(${a}, ${b})', icon: '⅟', boost: 99 },
  { label: 'sqrt', detail: 'square root', template: 'sqrt(${x})', icon: '√', boost: 98 },
  { label: 'root', detail: 'nth root', template: 'root(${n}, ${x})', icon: '∛' },
  { label: 'sum', detail: 'sum', template: 'sum_(${i=1})^(${n})', icon: '∑', boost: 97 },
  { label: 'integral', detail: 'integral', template: 'integral_(${a})^(${b})', icon: '∫', boost: 96 },
  { label: 'lim', detail: 'limit', template: 'lim_(${x -> 0})', icon: 'lim', boost: 95 },
  { label: 'product', detail: 'product', template: 'product_(${i=1})^(${n})', icon: '∏', boost: 90 },
  { label: 'binom', detail: 'binomial', template: 'binom(${n}, ${k})', icon: '(ⁿₖ)' },
  { label: 'mat', detail: 'matrix (; ends a row)', template: 'mat(${1, 2; 3, 4})', icon: '⊞' },
  { label: 'vec', detail: 'column vector', template: 'vec(${a}, ${b})', icon: '⇣' },
  { label: 'cases', detail: 'case distinction', template: 'cases(${x &"if" x > 0}, ${-x &"else"})', icon: '{' },
  { label: 'abs', detail: 'absolute value', template: 'abs(${x})', icon: '|x|' },
  { label: 'norm', detail: 'norm', template: 'norm(${x})', icon: '‖x‖' },
  { label: 'floor', detail: 'floor', template: 'floor(${x})', icon: '⌊x⌋' },
  { label: 'ceil', detail: 'ceiling', template: 'ceil(${x})', icon: '⌈x⌉' },

  // Accents.
  { label: 'hat', detail: 'hat accent', template: 'hat(${x})', icon: 'x̂' },
  { label: 'tilde', detail: 'tilde accent', template: 'tilde(${x})', icon: 'x̃' },
  { label: 'dot', detail: 'dot accent', template: 'dot(${x})', icon: 'ẋ' },
  { label: 'arrow', detail: 'vector arrow', template: 'arrow(${x})', icon: 'x⃗' },
  { label: 'overline', detail: 'overline', template: 'overline(${x})', icon: 'x̄' },
  { label: 'underline', detail: 'underline', template: 'underline(${x})', icon: 'x̲' },

  // Text styles.
  { label: 'bold', detail: 'bold', template: 'bold(${x})', icon: '𝐱' },
  { label: 'upright', detail: 'upright (non-italic)', template: 'upright(${x})', icon: 'x' },
  { label: 'cal', detail: 'calligraphic', template: 'cal(${A})', icon: '𝒜' },
  { label: 'bb', detail: 'blackboard bold', template: 'bb(${A})', icon: '𝔸' },

  ...GREEK.map(([label, icon]): TypstCommand => ({ label, icon, detail: 'greek' })),
  ...SYMBOLS.map(([label, icon, detail]): TypstCommand => ({ label, icon, detail })),
  ...FUNCTIONS.map((label): TypstCommand => ({ label, icon: 'ƒ', detail: 'function' }))
]

/** The word being typed at `pos`, or null. Two letters minimum unless the
 *  completion was summoned explicitly: one-letter variables are the normal
 *  case in math and must not pop a menu. Dotted names (`dots.h`) match too. */
export function typstTokenBefore(
  state: EditorState,
  pos: number,
  explicit = false
): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos)
  const textBefore = state.doc.sliceString(line.from, pos)
  const match = textBefore.match(/[A-Za-z][A-Za-z.]*$/)
  if (!match) return null
  if (!explicit && match[0].length < 2) return null
  return { from: pos - match[0].length, query: match[0] }
}

/** The compiled preview is the template with its `${…}` fields unwrapped:
 *  `frac(${a}, ${b})` previews as `frac(a, b)`. Deriving it keeps preview and
 *  insertion from ever drifting apart. Exported for tests. */
export function previewSourceOf(cmd: { template?: string; preview?: string }): string | null {
  if (cmd.preview) return cmd.preview
  if (!cmd.template) return null
  return cmd.template.replace(/\$\{([^}]*)\}/g, '$1')
}

let cachedOptions: Completion[] | null = null

function buildOptions(): Completion[] {
  cachedOptions ??= TYPST_COMMANDS.map(
    (cmd): Completion =>
      ({
        label: cmd.label,
        detail: cmd.detail,
        type: 'keyword',
        boost: cmd.boost ?? 0,
        _kind: 'typst',
        _icon: cmd.icon,
        _preview: previewSourceOf(cmd),
        apply: cmd.template ? snippet(cmd.template) : undefined
      }) as Completion & { _kind: string; _icon: string; _preview: string | null }
  )
  return cachedOptions
}

/** Full option row for a Typst completion. The Unicode glyph paints
 *  immediately; entries with arguments swap in the compiled Typst preview as
 *  soon as the shared render queue produces it (cached across popups, so the
 *  swap only happens the first time). Null for every other completion kind. */
export function renderTypstCompletion(completion: Completion): HTMLElement | null {
  const { _kind, _icon, _preview } = completion as Completion & {
    _kind?: string
    _icon?: string
    _preview?: string | null
  }
  if (_kind !== 'typst') return null

  const el = document.createElement('div')
  el.className = 'slash-cmd-item'

  const icon = document.createElement('span')
  icon.className = 'slash-cmd-icon typst-cmd-icon'
  icon.style.fontSize = '0.8em'
  icon.style.lineHeight = '1'
  icon.style.display = 'inline-flex'
  icon.style.alignItems = 'center'
  icon.style.justifyContent = 'center'
  icon.style.overflow = 'hidden'
  icon.textContent = _icon ?? ''
  if (_preview) {
    const showSvg = (svg: string): void => {
      icon.innerHTML = svg
      const svgEl = icon.querySelector('svg')
      if (svgEl) {
        svgEl.style.maxWidth = '2.6em'
        svgEl.style.maxHeight = '2.2em'
      }
    }
    const cached = peekTypstMathSvg(_preview, false)
    if (cached?.ok) {
      showSvg(cached.svg)
    } else if (!cached) {
      renderTypstMathToSvg(_preview, false)
        .then((res) => {
          // A closed popup leaves the node detached; the warm cache still
          // pays off on the next open.
          if (res.ok && icon.isConnected) showSvg(res.svg)
        })
        .catch(() => undefined)
    }
    // A cached error keeps the glyph: it said all it had to say once.
  }

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

export function typstCommandSource(context: CompletionContext): CompletionResult | null {
  if (mathRendererOf(context.state) !== 'typst') return null
  const token = typstTokenBefore(context.state, context.pos, context.explicit)
  if (!token) return null
  if (!isInMathContext(context.state, token.from)) return null
  return {
    from: token.from,
    options: buildOptions(),
    validFor: /^[A-Za-z][A-Za-z.]*$/
  }
}
