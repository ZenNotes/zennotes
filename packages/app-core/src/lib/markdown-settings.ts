/**
 * The render settings the preview pipeline reads, kept in their own module
 * so setting them does not drag the renderer in.
 *
 * `App.tsx` pushes the `mathRenderer`, `looseMathDelimiters` and
 * `detectCodeLanguages` prefs down on every change. When those setters lived in `lib/markdown`, that one import made
 * the whole remark/rehype/highlight stack a static dependency of the app entry
 * chunk, so every launch fetched and evaluated `vendor-markdown` before the user
 * had opened a note. This module is a few bytes of state; `lib/markdown` reads
 * it, and the settings-only importers never touch the renderer.
 *
 * `revision` bumps on every effective change, and `renderMarkdown` folds it into
 * its cache key, so a switch invalidates cached HTML without this module needing
 * a reference back to the cache (the same trick the custom-code-language
 * registry uses).
 */
export type MarkdownMathRenderer = 'katex' | 'typst'

let mathRenderer: MarkdownMathRenderer = 'katex'
let looseMathDelimiters = false
let detectCodeLanguages = true
let revision = 0

/** Point the preview pipeline at KaTeX or Typst. Default KaTeX keeps existing
 *  notes unchanged. */
export function setMarkdownMathRenderer(next: MarkdownMathRenderer): void {
  if (next === mathRenderer) return
  mathRenderer = next
  revision += 1
}

/** Toggle relaxed `$$` display-math delimiters (prose before/after the fence). */
export function setMarkdownLooseMathDelimiters(next: boolean): void {
  if (next === looseMathDelimiters) return
  looseMathDelimiters = next
  revision += 1
}

/** Guess the language of a code block that names none (#1014). Off, an
 *  unlabeled block renders plain, as it does in the editor. */
export function setMarkdownDetectCodeLanguages(next: boolean): void {
  if (next === detectCodeLanguages) return
  detectCodeLanguages = next
  revision += 1
}

export function markdownMathRenderer(): MarkdownMathRenderer {
  return mathRenderer
}

export function markdownLooseMathDelimiters(): boolean {
  return looseMathDelimiters
}

export function markdownDetectCodeLanguages(): boolean {
  return detectCodeLanguages
}

/** Increments whenever a setting effectively changes. Part of the
 *  `renderMarkdown` cache key. */
export function markdownSettingsRevision(): number {
  return revision
}
