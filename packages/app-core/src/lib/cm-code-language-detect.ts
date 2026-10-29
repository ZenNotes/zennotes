/**
 * Edit mode's guess at the language of a code block that names none (#1014):
 * the block is highlighted with the guessed grammar and its label reads
 * "python · detected". The guess is never written to the file; the picker's
 * "Python (detected)" row does that.
 *
 * Three parts:
 *
 * - `guessField` holds the guess per block, keyed by where the block's fence
 *   starts and mapped through edits, so a block keeps its guess (and its
 *   colours) while it is typed in, until the next guess replaces it.
 * - The detector guesses off the typing path: a while after the last edit or
 *   scroll, in idle time, a few blocks per slice, with the guesser
 *   (code-language-detect.ts) loaded on first need and cached by the block's
 *   text.
 * - The highlighter parses a guessed block with the guessed language's own
 *   CodeMirror parser, over exactly the ranges the markdown parser hands a
 *   labeled block's language, and draws `highlightTree` with the editor's own
 *   highlight style. A guessed block looks exactly like a labeled one.
 */
import {
  highlightingFor,
  Language,
  LanguageDescription,
  syntaxTree
} from '@codemirror/language'
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  MapMode,
  RangeSetBuilder,
  StateEffect,
  StateField
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'
import { resolveCodeLanguage } from './cm-code-languages'
import { codeFenceFromNode, codeFenceText, type CodeFence } from './code-language-menu'

type Detector = typeof import('./code-language-detect')

interface Guess {
  /** Where the block's opening fence starts. */
  from: number
  tag: string
}

/** New guesses, or null to drop one, by fence start. */
const setGuesses = StateEffect.define<ReadonlyArray<{ from: number; tag: string | null }>>()
/** Draw the guessed blocks again: a grammar finished loading, or typing in
 *  a long block paused. */
const redrawHighlights = StateEffect.define<null>()

function mapGuesses(guesses: readonly Guess[], changes: ChangeDesc): Guess[] {
  const out: Guess[] = []
  for (const guess of guesses) {
    const from = changes.mapPos(guess.from, 1, MapMode.TrackDel)
    if (from !== null) out.push({ from, tag: guess.tag })
  }
  return out
}

interface Guesses {
  readonly list: readonly Guess[]
  /** Bumps when a guess is made or dropped, not when an edit only moves
   *  one: typing must not count as a new guess, or every keystroke in a
   *  guessed block would redraw (and re-parse) it. */
  readonly revision: number
}

const guessField = StateField.define<Guesses>({
  create: () => ({ list: [], revision: 0 }),
  update(value, tr) {
    let list = tr.docChanged && value.list.length > 0 ? mapGuesses(value.list, tr.changes) : value.list
    let revision = value.revision
    for (const effect of tr.effects) {
      if (!effect.is(setGuesses)) continue
      const byFrom = new Map(list.map((guess) => [guess.from, guess.tag]))
      for (const { from, tag } of effect.value) {
        if (tag === null) byFrom.delete(from)
        else byFrom.set(from, tag)
      }
      list = [...byFrom].map(([from, tag]) => ({ from, tag }))
      revision++
    }
    return list === value.list ? value : { list, revision }
  }
})

const guessesOf = (state: EditorState): readonly Guess[] => state.field(guessField, false)?.list ?? []

/** The guess for the block whose fence starts at `fenceFrom`, or null. Only
 *  meaningful for a block that names no language. */
export function detectedCodeLanguage(state: EditorState, fenceFrom: number): string | null {
  return guessesOf(state).find((guess) => guess.from === fenceFrom)?.tag ?? null
}

/** True when the transaction made or dropped a guess, for views that redraw
 *  on it (the code block label). An edit that only moves a guess is not one. */
export function codeLanguageGuessesChanged(update: ViewUpdate): boolean {
  return (
    (update.startState.field(guessField, false)?.revision ?? 0) !==
    (update.state.field(guessField, false)?.revision ?? 0)
  )
}

function windowsAround(view: EditorView, margin: number): Array<{ from: number; to: number }> {
  const length = view.state.doc.length
  return view.visibleRanges.map((range) => ({
    from: Math.max(0, range.from - margin),
    to: Math.min(length, range.to + margin)
  }))
}

/** The unlabeled blocks in (or near) the viewport, in document order. */
function unlabeledFences(view: EditorView, margin: number): CodeFence[] {
  const { state } = view
  const out: CodeFence[] = []
  const seen = new Set<number>()
  const tree = syntaxTree(state)
  for (const window of windowsAround(view, margin)) {
    tree.iterate({
      from: window.from,
      to: window.to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return
        if (seen.has(node.from)) return false
        seen.add(node.from)
        const fence = codeFenceFromNode(state, node.node)
        if (fence && fence.language === null && fence.body.length > 0) out.push(fence)
        return false
      }
    })
  }
  return out
}

/* ------------------------------------------------------------------------ */
/* The detector                                                             */
/* ------------------------------------------------------------------------ */

/** Quiet time after an edit or a scroll before guessing again. */
const SETTLE_MS = 400
/** The most one idle slice spends guessing, before yielding. */
const SLICE_MS = 12
/** How far past the viewport to guess, so a scroll lands on colour. */
const DETECT_MARGIN = 4_000

let detectorModule: Promise<Detector> | null = null

function loadDetector(): Promise<Detector> {
  // The editor does not import highlight.js itself: the first unlabeled block
  // asks for the guesser, which the reading view's pipeline shares.
  detectorModule ??= import('./code-language-detect')
  return detectorModule
}

type IdleHandle = { cancel: () => void }

function whenIdle(run: () => void): IdleHandle {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 1_000 })
    return { cancel: () => w.cancelIdleCallback?.(id) }
  }
  const id = window.setTimeout(run, 16)
  return { cancel: () => window.clearTimeout(id) }
}

class DetectorPlugin {
  private timer: number | null = null
  private idle: IdleHandle | null = null
  private destroyed = false

  constructor(private readonly view: EditorView) {
    this.schedule(0)
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.schedule(SETTLE_MS)
    }
  }

  private schedule(delay: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.idle?.cancel()
    this.idle = null
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.idle = whenIdle(() => {
        this.idle = null
        void this.run()
      })
    }, delay)
  }

  /** Guesses for blocks in the scanned window that are no longer an
   *  unlabeled block there: it gained a language, or lost its fence. A guess
   *  outside the window is kept, so scrolling back finds it in place. */
  private staleGuesses(fences: readonly CodeFence[]): Array<{ from: number; tag: null }> {
    const windows = windowsAround(this.view, DETECT_MARGIN)
    return guessesOf(this.view.state)
      .filter(
        (guess) =>
          windows.some((w) => guess.from >= w.from && guess.from <= w.to) &&
          !fences.some((fence) => fence.from === guess.from)
      )
      .map(({ from }) => ({ from, tag: null }))
  }

  private again(): void {
    this.idle = whenIdle(() => {
      this.idle = null
      void this.run()
    })
  }

  private async run(): Promise<void> {
    if (unlabeledFences(this.view, DETECT_MARGIN).length === 0) {
      const stale = this.staleGuesses([])
      if (stale.length) this.dispatch(stale)
      return
    }
    const detector = await loadDetector()
    if (this.destroyed) return
    const deadline = performance.now() + SLICE_MS
    // The first guess compiles every grammar's regexes, about 70 ms in all;
    // spend that a few grammars per idle slice instead of in one long task.
    let warming = true
    while (warming && performance.now() < deadline) warming = detector.warmCodeLanguageDetector()
    if (warming) {
      this.again()
      return
    }
    const { state } = this.view
    const fences = unlabeledFences(this.view, DETECT_MARGIN)
    const known = guessesOf(state)
    const updates: Array<{ from: number; tag: string | null }> = this.staleGuesses(fences)
    let unfinished = false
    for (const fence of fences) {
      const text = codeFenceText(state, fence)
      let result = detector.cachedCodeLanguage(text)
      if (result === undefined) {
        if (performance.now() > deadline) {
          unfinished = true
          continue
        }
        result = detector.detectCodeLanguage(text)
      }
      const tag = result?.tag ?? null
      const before = known.find((guess) => guess.from === fence.from)?.tag ?? null
      if (tag !== before) updates.push({ from: fence.from, tag })
    }
    if (updates.length) this.dispatch(updates)
    if (unfinished) this.again()
  }

  private dispatch(updates: ReadonlyArray<{ from: number; tag: string | null }>): void {
    if (this.destroyed) return
    this.view.dispatch({ effects: setGuesses.of(updates) })
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.idle?.cancel()
  }
}

/* ------------------------------------------------------------------------ */
/* The highlighter                                                          */
/* ------------------------------------------------------------------------ */

/** A block this long or shorter is re-highlighted on every keystroke; a
 *  longer one keeps its colours mapped through the edit and is redrawn once
 *  typing pauses, so typing in a long block costs nothing extra. */
const SYNC_HIGHLIGHT_CHARS = 6_000
const REDRAW_MS = 250
/** Colour this far past the viewport. */
const HIGHLIGHT_MARGIN = 2_000

interface Token {
  from: number
  to: number
  cls: string
}

const TOKEN_CACHE_LIMIT = 48
const tokenCache = new Map<string, Token[]>()
const markCache = new Map<string, Decoration>()

function markFor(cls: string): Decoration {
  let mark = markCache.get(cls)
  if (!mark) {
    mark = Decoration.mark({ class: cls })
    markCache.set(cls, mark)
  }
  return mark
}

/** The guessed grammar, loading it first when language-data has it lazily. */
function grammarFor(tag: string, view: EditorView): Language | null {
  const resolved = resolveCodeLanguage(tag)
  if (!resolved) return null
  if (resolved instanceof Language) return resolved
  if (resolved instanceof LanguageDescription) {
    if (resolved.support) return resolved.support.language
    void resolved.load().then(
      () => view.dispatch({ effects: redrawHighlights.of(null) }),
      () => {
        /* no grammar after all: the block stays plain */
      }
    )
  }
  return null
}

/** Tokens of a guessed block, relative to its first piece, cached by the
 *  language, the text and the layout of its pieces. */
function tokensFor(state: EditorState, fence: CodeFence, tag: string, language: Language): Token[] {
  const base = fence.body[0].from
  const end = fence.body[fence.body.length - 1].to
  const source = state.doc.sliceString(base, end)
  const ranges = fence.body.map((piece) => ({ from: piece.from - base, to: piece.to - base }))
  const key = `${tag}\0${ranges.map((r) => `${r.from}-${r.to}`).join(',')}\0${source}`
  const cached = tokenCache.get(key)
  if (cached) {
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return cached
  }
  const tree = language.parser.parse(source, [], ranges)
  const tokens: Token[] = []
  const highlighter = {
    // Scoped to the nested language, the way a labeled block's tokens are.
    style: (tags: Parameters<typeof highlightingFor>[1]) => highlightingFor(state, tags, tree.type)
  }
  highlightTree(tree, highlighter, (from, to, cls) => {
    if (to > from) tokens.push({ from, to, cls })
  })
  tokenCache.set(key, tokens)
  while (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    tokenCache.delete(oldest)
  }
  return tokens
}

function buildHighlights(view: EditorView): DecorationSet {
  const { state } = view
  const guesses = guessesOf(state)
  if (guesses.length === 0) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  const windows = windowsAround(view, HIGHLIGHT_MARGIN)
  for (const fence of unlabeledFences(view, HIGHLIGHT_MARGIN)) {
    const tag = guesses.find((guess) => guess.from === fence.from)?.tag
    if (!tag) continue
    const language = grammarFor(tag, view)
    if (!language) continue
    const base = fence.body[0].from
    for (const token of tokensFor(state, fence, tag, language)) {
      const from = base + token.from
      const to = base + token.to
      if (!windows.some((w) => to > w.from && from < w.to)) continue
      builder.add(from, to, markFor(token.cls))
    }
  }
  return builder.finish()
}

/** The size of the largest guessed block the edit touched (the parse a
 *  keystroke would pay for), or -1 when it touched none. */
function touchedGuessedBlock(view: EditorView, update: ViewUpdate): number {
  let largest = -1
  const guesses = guessesOf(view.state)
  if (guesses.length === 0) return -1
  for (const fence of unlabeledFences(view, 0)) {
    if (!guesses.some((guess) => guess.from === fence.from)) continue
    let touched = false
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (toB >= fence.from && fromB <= fence.to) touched = true
    })
    if (touched) largest = Math.max(largest, fence.to - fence.from)
  }
  return largest
}

class HighlightPlugin {
  decorations: DecorationSet
  private timer: number | null = null

  constructor(private readonly view: EditorView) {
    this.decorations = buildHighlights(view)
  }

  update(update: ViewUpdate): void {
    const redraw =
      codeLanguageGuessesChanged(update) ||
      update.transactions.some((tr) => tr.effects.some((effect) => effect.is(redrawHighlights)))
    if (redraw) {
      this.decorations = buildHighlights(update.view)
      return
    }
    if (update.docChanged) {
      const touched = touchedGuessedBlock(update.view, update)
      if (touched < 0) {
        // Typing elsewhere: the colours only move.
        this.decorations = this.decorations.map(update.changes)
      } else if (touched > SYNC_HIGHLIGHT_CHARS) {
        this.decorations = this.decorations.map(update.changes)
        this.scheduleRedraw()
      } else {
        this.decorations = buildHighlights(update.view)
      }
      return
    }
    // A scroll brings new blocks into view, and a parse cut short by its time
    // budget finishes in a later update that can bring a block into the
    // tree. Every keystroke also moves the viewport and reparses the note,
    // though: while a long block's redraw is pending, redrawing here would be
    // the very parse that redraw is there to defer.
    if (
      (update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) &&
      this.timer === null
    ) {
      this.decorations = buildHighlights(update.view)
    }
  }

  private scheduleRedraw(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.view.dispatch({ effects: redrawHighlights.of(null) })
    }, REDRAW_MS)
  }

  destroy(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
  }
}

const detectorPlugin = ViewPlugin.fromClass(DetectorPlugin)
const highlightPlugin = ViewPlugin.fromClass(HighlightPlugin, {
  decorations: (plugin) => plugin.decorations
})

/** Guess and highlight the language of every unlabeled code block. Edit mode
 *  only, beside the code block label that says so; off with the "Detect code
 *  block languages" setting. */
export function codeLanguageDetection(): Extension {
  return [guessField, detectorPlugin, highlightPlugin]
}
