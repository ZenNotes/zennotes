/**
 * Harper, the offline grammar and spell checker, as one session per app.
 *
 * Off by default and loaded only once Settings turns it on: the 15 MB wasm and
 * the worker that runs it must stay off the boot path, so everything here sits
 * behind a dynamic import and a memoized promise (the mermaid-render shape).
 * Linting runs in Harper's own Web Worker, so a long note never blocks a
 * keystroke. harper.js also instantiates the module on the main thread to
 * (de)serialize lints across the worker boundary; that second instance is the
 * library's design, not ours, and is the price of a responsive editor.
 *
 * Offsets: Harper reports spans in UTF-16 code units, the unit CodeMirror uses,
 * so a span maps to editor positions with no conversion (pinned by a test that
 * puts an emoji before the misspelling).
 *
 * The user's own words and ignored suggestions travel with the vault in
 * vault.json (see `HarperVaultState`). Ignored suggestions are Harper's
 * privacy-safe context hashes: unsigned 64-bit integers that JSON.parse would
 * round, so they are carried as digit strings and never parsed as numbers.
 */
import type { Lint, Linter, Suggestion } from 'harper.js'
import wasmUrl from 'harper.js/dist/harper_wasm_slim_bg.wasm?url'
import {
  harperIgnoredLintHashes,
  harperIgnoredLintsJson,
  type HarperDialect,
  type HarperLintConfig,
  type HarperVaultState
} from '@shared/harper-settings'
import { bundledAssetUrl } from './bundled-asset-url'

export type { HarperDialect, HarperLintConfig, HarperVaultState } from '@shared/harper-settings'

/** Past this many characters a note is not linted, the same threshold at
 *  which live preview defers. Harper itself is fast; it is the diagnostics
 *  churn on every keystroke of a huge note that is not worth it. */
export const HARPER_LINT_CHAR_LIMIT = 120_000

export type HarperSuggestionKind = 'replace' | 'remove' | 'insert-after'

export interface HarperSuggestion {
  kind: HarperSuggestionKind
  /** The replacement (or, for insert-after, the inserted) text. */
  text: string
  /** What the resolver shows for this suggestion. */
  label: string
}

export interface HarperLint {
  from: number
  to: number
  /** Harper's rule family, e.g. `Spelling`, `Typo`, `Capitalization`. */
  kind: string
  /** The rule family as Harper words it for people ("Boundary Error"). */
  kindLabel: string
  message: string
  /** The offending text, as Harper saw it. */
  problem: string
  suggestions: HarperSuggestion[]
  /** Harper's own object, needed to ignore this exact suggestion later. */
  raw: Lint
}

export interface HarperSessionOptions {
  dialect: HarperDialect
  lintConfig: HarperLintConfig
  state: HarperVaultState
}

export interface HarperSession {
  lint(text: string): Promise<HarperLint[]>
  addWord(word: string): Promise<void>
  ignore(text: string, lint: HarperLint): Promise<void>
  exportState(): Promise<HarperVaultState>
  configure(options: { dialect: HarperDialect; lintConfig: HarperLintConfig }): Promise<void>
  importState(state: HarperVaultState): Promise<void>
}

type HarperModule = typeof import('harper.js')

let sessionPromise: Promise<HarperSession & { dispose(): void }> | null = null

/** Load Harper (once) and return the shared session. */
export function loadHarper(options: HarperSessionOptions): Promise<HarperSession> {
  sessionPromise ??= createSession(options).catch((error: unknown) => {
    sessionPromise = null
    throw error
  })
  return sessionPromise
}

export function harperLoaded(): boolean {
  return sessionPromise !== null
}

/** Free the worker and both wasm instances; the next `loadHarper` starts over. */
export function disposeHarper(): void {
  const pending = sessionPromise
  sessionPromise = null
  void pending?.then((session) => session.dispose()).catch(() => undefined)
}

/**
 * Build a session from an already-constructed linter. Exported for tests,
 * which run Harper's `LocalLinter` under Node; the app only ever goes through
 * `loadHarper`.
 */
export function harperSessionFromLinter(
  harper: Pick<HarperModule, 'Dialect' | 'SuggestionKind'>,
  linter: Linter
): HarperSession & { dispose(): void } {
  return {
    async lint(text) {
      if (text.length > HARPER_LINT_CHAR_LIMIT) return []
      const lints = await linter.lint(text, { language: 'markdown' })
      return lints.map((lint) => toHarperLint(harper, lint))
    },
    async addWord(word) {
      const cleaned = word.trim()
      if (!cleaned) return
      await linter.importWords([cleaned])
    },
    async ignore(text, lint) {
      await linter.ignoreLint(text, lint.raw)
    },
    async exportState() {
      return {
        words: await linter.exportWords(),
        ignoredLints: harperIgnoredLintHashes(await linter.exportIgnoredLints())
      }
    },
    async configure(options) {
      await linter.setDialect(toDialect(harper.Dialect, options.dialect))
      await linter.setLintConfig(options.lintConfig)
    },
    async importState(state) {
      await linter.clearWords()
      await linter.clearIgnoredLints()
      if (state.words.length > 0) await linter.importWords(state.words)
      const json = harperIgnoredLintsJson(state.ignoredLints)
      if (json) await linter.importIgnoredLints(json)
    },
    dispose() {
      void linter.dispose?.()
    }
  }
}

async function createSession(
  options: HarperSessionOptions
): Promise<HarperSession & { dispose(): void }> {
  const harper = await import('harper.js')
  const binary = harper.createBinaryModuleFromUrl(bundledAssetUrl(wasmUrl, 'zen-harper'), 'slim')
  const linter = new harper.WorkerLinter({
    binary,
    dialect: toDialect(harper.Dialect, options.dialect)
  })
  await linter.setup()
  const session = harperSessionFromLinter(harper, linter)
  await session.configure({ dialect: options.dialect, lintConfig: options.lintConfig })
  await session.importState(options.state)
  return session
}

function toDialect(dialects: HarperModule['Dialect'], dialect: HarperDialect): number {
  switch (dialect) {
    case 'british':
      return dialects.British
    case 'australian':
      return dialects.Australian
    case 'canadian':
      return dialects.Canadian
    case 'indian':
      return dialects.Indian
    default:
      return dialects.American
  }
}

function toHarperLint(harper: Pick<HarperModule, 'SuggestionKind'>, lint: Lint): HarperLint {
  const span = lint.span()
  const problem = lint.get_problem_text()
  const suggestions = lint.suggestions().map((suggestion) => toHarperSuggestion(harper, suggestion))
  // A heading lint spans the `# ` marker too, and its fix repeats it. Keep the
  // marker out of the underline and the replacement; the fix still lands.
  const marker = /^#{1,6}\s+/.exec(problem)?.[0] ?? ''
  const trimmable =
    marker.length > 0 &&
    suggestions.every(
      (suggestion) => suggestion.kind !== 'replace' || suggestion.text.startsWith(marker)
    )
  return {
    from: span.start + (trimmable ? marker.length : 0),
    to: span.end,
    kind: lint.lint_kind(),
    kindLabel: lint.lint_kind_pretty(),
    message: lint.message(),
    problem: trimmable ? problem.slice(marker.length) : problem,
    suggestions: trimmable
      ? suggestions.map((suggestion) =>
          suggestion.kind === 'replace'
            ? { ...suggestion, text: suggestion.text.slice(marker.length), label: suggestion.text.slice(marker.length) }
            : suggestion
        )
      : suggestions,
    raw: lint
  }
}

function toHarperSuggestion(
  harper: Pick<HarperModule, 'SuggestionKind'>,
  suggestion: Suggestion
): HarperSuggestion {
  const text = suggestion.get_replacement_text()
  const kind = suggestion.kind()
  if (kind === harper.SuggestionKind.Remove) {
    return { kind: 'remove', text: '', label: 'Remove' }
  }
  if (kind === harper.SuggestionKind.InsertAfter) {
    return { kind: 'insert-after', text, label: `Insert "${text}" after` }
  }
  return { kind: 'replace', text, label: text }
}

/** The document change that applies one suggestion, in editor terms. */
export function harperSuggestionChange(
  lint: Pick<HarperLint, 'from' | 'to'>,
  suggestion: HarperSuggestion
): { from: number; to: number; insert: string } {
  if (suggestion.kind === 'insert-after') return { from: lint.to, to: lint.to, insert: suggestion.text }
  return { from: lint.from, to: lint.to, insert: suggestion.text }
}
