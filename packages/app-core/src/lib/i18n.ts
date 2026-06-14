/**
 * Minimal, zero-dependency i18n for the app chrome.
 *
 * Strings are keyed by their English source text ("natural keys"): a
 * component writes `t('Appearance')`, and the translation layer returns the
 * Chinese string when the UI language is `zh`, or the English key itself
 * otherwise. That keeps English as a guaranteed fallback (an untranslated
 * key just renders in English) and avoids inventing/maintaining key names.
 *
 * Only UI chrome is translated — note content, file paths, and user data are
 * never passed through `t()`.
 */
import { useStore, type Language } from '../store'
import { ZH } from './i18n-zh'

const DICTS: Record<Exclude<Language, 'en'>, Record<string, string>> = {
  zh: ZH
}

/** Translate a single source string for the given language. */
export function translate(language: Language, source: string): string {
  if (language === 'en') return source
  return DICTS[language]?.[source] ?? source
}

/**
 * Hook returning a `t()` bound to the current UI language. Re-renders the
 * caller when the language changes (it subscribes to `language` in the store).
 */
export function useT(): (source: string) => string {
  const language = useStore((s) => s.language)
  return (source: string): string => translate(language, source)
}
