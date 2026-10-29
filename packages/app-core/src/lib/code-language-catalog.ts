/**
 * Every language the editor can highlight a fence in, as the code block
 * language picker lists it (#1014): the eager grammars, the
 * `@codemirror/language-data` list and the user's own TextMate languages.
 *
 * Each row carries the one tag a pick writes after the fence. That tag is
 * chosen so the editor reads it back as the same language: language-data's
 * names are not always fence tags ("C++", "Properties files"), and its fuzzy
 * matcher reads some spellings as another language entirely, so a language
 * with no tag that survives the round trip is left out rather than offered
 * as a pick that would not highlight.
 */
import { LanguageDescription } from '@codemirror/language'
import { languages as languageData } from '@codemirror/language-data'
import { isReservedCodeFenceTag } from '@shared/custom-code-languages'
import { EAGER_CODE_LANGUAGE_ALIASES, resolveCodeLanguage } from './cm-code-languages'
import { customCodeLanguageRegistry } from './custom-code-languages'

export interface CodeLanguageOption {
  /** What a pick writes after the fence. */
  tag: string
  /** The name the picker shows. */
  name: string
  /** The other fence tags that mean this language, for the find field. */
  aliases: readonly string[]
  /** A TextMate language the user installed. */
  custom: boolean
}

/** The tag people write for a language, where it is not language-data's name.
 *  The name would read back too (`c++`, `c#`, `shell`), but `cpp`, `csharp`
 *  and `fsharp` are what GitHub and highlight.js expect, and highlight.js
 *  reads `shell` as a terminal session, so the reading view would disagree
 *  with the editor about a `Shell` pick. */
const PREFERRED_TAG: Readonly<Record<string, string>> = {
  'C++': 'cpp',
  'C#': 'csharp',
  'F#': 'fsharp',
  Shell: 'bash'
}

const FENCE_TAG_RE = /^[a-z0-9][a-z0-9_+#.-]*$/

function readsBackAs(tag: string, description: LanguageDescription): boolean {
  const resolved = resolveCodeLanguage(tag)
  if (!resolved) return false
  if (resolved instanceof LanguageDescription) return resolved === description
  // An eager grammar owns the tag: `c` highlights with the C++ grammar, `jsx`
  // with JavaScript's. That is the language the editor shows, so it counts.
  return EAGER_CODE_LANGUAGE_ALIASES.some((aliases) => aliases.includes(tag))
}

function builtinOptions(): CodeLanguageOption[] {
  const out: CodeLanguageOption[] = []
  for (const description of languageData) {
    const candidates = [
      PREFERRED_TAG[description.name],
      description.name.toLowerCase(),
      ...description.alias
    ].filter((tag): tag is string => !!tag && FENCE_TAG_RE.test(tag))
    const tag = candidates.find((candidate) => readsBackAs(candidate, description))
    if (!tag) continue
    const aliases = new Set(
      description.alias.filter((alias) => alias !== tag && FENCE_TAG_RE.test(alias))
    )
    out.push({ tag, name: description.name, aliases: [...aliases], custom: false })
  }
  // The eager grammars answer to a few tags language-data does not list
  // (`golang`, `py`, `yml`). Fold each into the row that already owns the
  // grammar's own name, so the find field finds Go by `golang`.
  const taken = new Set(out.map((option) => option.tag))
  for (const aliases of EAGER_CODE_LANGUAGE_ALIASES) {
    const owner = out.find((option) => option.tag === aliases[0] || option.aliases.includes(aliases[0]))
    if (!owner) continue
    const merged = new Set(owner.aliases)
    for (const alias of aliases) if (alias !== owner.tag && !taken.has(alias)) merged.add(alias)
    owner.aliases = [...merged]
  }
  return out
}

let builtinCache: CodeLanguageOption[] | null = null

function customOptions(): CodeLanguageOption[] {
  const out: CodeLanguageOption[] = []
  for (const language of customCodeLanguageRegistry.languages()) {
    // A built-in grammar wins a reserved tag, so the custom row writes the
    // first tag that is really its own.
    const own = language.aliases.filter((alias) => !isReservedCodeFenceTag(alias))
    if (own.length === 0) continue
    out.push({ tag: own[0], name: language.name, aliases: own.slice(1), custom: true })
  }
  return out
}

/** Every language a fence can be set to, by name. */
export function codeLanguageOptions(): CodeLanguageOption[] {
  builtinCache ??= builtinOptions()
  return [...builtinCache, ...customOptions()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

/** The row a fence tag belongs to (by its tag or any alias), or null. */
export function findCodeLanguageOption(
  tag: string,
  options: readonly CodeLanguageOption[] = codeLanguageOptions()
): CodeLanguageOption | null {
  const key = tag.trim().toLowerCase()
  if (!key) return null
  return (
    options.find((option) => option.tag === key) ??
    options.find((option) => option.aliases.includes(key)) ??
    null
  )
}
