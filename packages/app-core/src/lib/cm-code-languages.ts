/**
 * Eager code-fence language registry for the markdown editor.
 *
 * `@codemirror/language-data` is the canonical source of truth for
 * language descriptions but it drives loading through dynamic
 * `import('@codemirror/lang-…')` calls that don't resolve reliably in
 * our Electron bundling pipeline — the result is fenced code blocks for
 * Python/Go/Rust/etc. rendering as plaintext in edit mode while
 * TypeScript (already loaded via the markdown grammar's dependency
 * chain) works fine.
 *
 * We fix that by pre-importing each grammar we care about and exposing
 * a resolver function in the shape that `markdown({ codeLanguages })`
 * accepts. The resolver also falls back to `language-data`'s lazy list
 * so less common languages still get a chance to load if bundling
 * happens to work for them.
 */
import { LanguageDescription, type Language, LanguageSupport } from '@codemirror/language'
import { languages as lazyLanguages } from '@codemirror/language-data'

import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'

/** Map from fence-tag alias (lowercased, no dashes) to an eagerly loaded grammar. */
type Entry = { aliases: string[]; support: LanguageSupport }

const EAGER: Entry[] = [
  {
    aliases: ['javascript', 'js', 'jsx', 'node', 'nodejs'],
    support: javascript({ jsx: true })
  },
  {
    aliases: ['typescript', 'ts', 'tsx'],
    support: javascript({ jsx: true, typescript: true })
  },
  { aliases: ['python', 'py', 'python3'], support: python() },
  { aliases: ['rust', 'rs'], support: rust() },
  { aliases: ['go', 'golang'], support: go() },
  { aliases: ['json', 'jsonc'], support: json() },
  {
    aliases: ['cpp', 'c++', 'c', 'cc', 'cxx', 'hpp', 'h'],
    support: cpp()
  },
  { aliases: ['java'], support: java() },
  { aliases: ['html', 'htm'], support: html() },
  { aliases: ['css'], support: css() },
  { aliases: ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite'], support: sql() },
  { aliases: ['xml', 'svg'], support: xml() },
  { aliases: ['yaml', 'yml'], support: yaml() },
  { aliases: ['markdown', 'md'], support: markdown() },
  { aliases: ['php'], support: php() }
]

const aliasMap = new Map<string, LanguageSupport>()
for (const entry of EAGER) {
  for (const a of entry.aliases) aliasMap.set(a, entry.support)
}

function normalize(info: string): string {
  return info.trim().toLowerCase().replace(/[^a-z0-9+#]/g, '')
}

/**
 * Resolver function passed to `markdown({ codeLanguages: … })`. Returns
 * a `Language` for an already-loaded grammar, a `LanguageDescription`
 * for a lazy fallback from `@codemirror/language-data`, or `null` when
 * no grammar is available.
 */
export function resolveCodeLanguage(
  info: string
): Language | LanguageDescription | null {
  const key = normalize(info)
  if (!key) return null
  const eager = aliasMap.get(key)
  if (eager) return eager.language
  // Fall back to language-data's lazy list for less common fence tags
  // (shell/bash, powershell, lua, etc.).
  return LanguageDescription.matchLanguageName(lazyLanguages, key, true)
}
