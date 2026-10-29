/**
 * Guess the language of a code block that names none (#1014), for the editor's
 * "python · detected" label and highlighting, and for the reading view, so the
 * two surfaces agree on every block.
 *
 * highlight.js scores the text in each language of a small subset, the ones
 * people paste into notes and that the editor can also highlight, and the
 * best score wins only when it is a confident one:
 *
 * - The block has at least MIN_LINES lines and MIN_CHARS characters. A one-liner
 *   is too little to tell `x = 1` in Python from the same line in Ruby or INI.
 * - The winner's relevance reaches MIN_RELEVANCE. Below it, prose and logs win
 *   on accidents: a paragraph scores 6 as CSS because "a", "code" and "line"
 *   are HTML tag names a CSS selector may use.
 * - The text shows a hallmark of the winner (`fn` or `::` for Rust, `end` for
 *   Ruby, a `{ prop: value; }` rule for CSS). Relevance only adds up, so a
 *   long enough paragraph clears any threshold as CSS; a hallmark is a fact
 *   about the text that a paragraph does not have. A winner without one
 *   yields to the next language that clears the bar.
 * - No language of another family (JavaScript and TypeScript are one, C and
 *   C++ another) ties it. A tie between Java and C# is not a guess.
 *
 * The numbers were tuned on real snippets in code-language-detect.test.ts.
 * Only the first MAX_SAMPLE_CHARS are scored, and a block over
 * MAX_DETECT_CHARS is never guessed at, so a pasted log costs nothing.
 */
import HighlightJS from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { LanguageFn } from 'highlight.js'

export const MIN_LINES = 2
export const MIN_CHARS = 24
export const MIN_RELEVANCE = 8
export const MIN_MARGIN = 2
export const MAX_SAMPLE_CHARS = 2_000
export const MAX_DETECT_CHARS = 50_000

export interface DetectedCodeLanguage {
  /** The fence tag the guess would write, as the editor and the reading view
   *  both read it (`html`, not highlight.js' `xml`). */
  tag: string
  /** highlight.js' relevance for it, on the sample. */
  relevance: number
}

/**
 * The subset, in the order that breaks a tie inside a family. Every name is
 * one lowlight's `common` set registers too, so the reading view can
 * highlight what the editor guessed, and every tag it maps to is one the
 * editor highlights (cm-code-languages.ts).
 */
const SUBSET: ReadonlyArray<readonly [string, LanguageFn]> = [
  ['javascript', javascript],
  ['typescript', typescript],
  ['python', python],
  ['bash', bash],
  ['json', json],
  ['yaml', yaml],
  ['sql', sql],
  ['xml', xml],
  ['css', css],
  ['scss', scss],
  ['go', go],
  ['rust', rust],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['php', php],
  ['ruby', ruby],
  ['kotlin', kotlin],
  ['swift', swift],
  ['diff', diff],
  ['ini', ini]
]

export const DETECTABLE_LANGUAGES: readonly string[] = SUBSET.map(([name]) => name)

const FAMILY: Readonly<Record<string, string>> = {
  javascript: 'js',
  typescript: 'js',
  json: 'js',
  c: 'c',
  cpp: 'c',
  css: 'css',
  scss: 'css'
}

const familyOf = (name: string): string => FAMILY[name] ?? name

const KEY_LINE = /^(?:- )?["']?[A-Za-z_][\w .-]*["']?[ \t]*:(?:[ \t]|$)/m
const NESTED_KEY_LINE = /^[ \t]+(?:- )?["']?[A-Za-z_][\w.-]*["']?[ \t]*:(?:[ \t]|$)/m

/** What the text has to show before a language may win. Necessary, never
 *  sufficient: relevance still has to clear the bar. */
const HALLMARK: Readonly<Record<string, (text: string) => boolean>> = {
  // Markup opens with a tag and says `class="…"`; Lua shares `function` and
  // `return` and closes blocks with `end`; Scala shares `=>` and declares
  // with `val` and `def`; pseudocode assigns with `<-`.
  javascript: (t) =>
    !/^\s*</.test(t) &&
    /\b(?:const|let|var|function|return|import|export|require|async|await|console|document|window)\b|\bclass\s+[A-Za-z_$]|=>/.test(t) &&
    !/^[ \t]*end\b|\bthen[ \t]*$|\blocal\s+\w+|\b(?:val|def)\s+\w+|\bcase\s+class\b|\s<-\s/m.test(t),
  typescript: (t) => HALLMARK.javascript(t),
  // Python never closes a block with `end`, and seldom ends two lines with
  // a semicolon, which is how Perl and C read under its keywords.
  python: (t) =>
    /^[ \t]*(?:def|class|import|from|if|elif|for|while|with|try|except|return|print|async|@\w)\b/m.test(t) &&
    !/^[ \t]*end\b/m.test(t) &&
    (t.match(/;[ \t]*$/gm)?.length ?? 0) < 2,
  // A line that runs a command. A `$name` alone is PHP, Perl or GraphQL too.
  bash: (t) =>
    /^#!|^[ \t]*(?:echo|cd|export|source|sudo|if \[|for \w+ in|while|case|function \w+|\w+\(\) *\{|set -|local|alias|git|npm|npx|brew|apt|apt-get|curl|wget|grep|sed|awk|ls|mkdir|rm|cp|mv|cat|chmod|chown|docker|make)\b/m.test(t),
  json: (t) => /^\s*[[{]/.test(t) && /"[^"\n]*"\s*:/.test(t),
  // A colon-keyed line alone is a chat log or a form; YAML also nests, or
  // lists, or starts a document.
  yaml: (t) => KEY_LINE.test(t) && (NESTED_KEY_LINE.test(t) || /^[ \t]*- \S|^---[ \t]*$/m.test(t)),
  // A statement opens a line: "please select the items from the list" is
  // a sentence with SQL's words in it.
  sql: (t) =>
    /^[ \t]*(?:select\b[\s\S]*\bfrom|insert\s+into|update\s+\S+\s+set|delete\s+from|create\s+(?:or\s+replace\s+)?(?:temporary\s+)?(?:table|index|unique\s+index|view|database|schema|function|trigger)|alter\s+table|drop\s+(?:table|index|view|database)|with\s+\w+\s+as\s*\()\b/im.test(t),
  xml: (t) => /<[A-Za-z!?][^>]*>/.test(t) && /<\/[A-Za-z][\w:.-]*\s*>|\/>|<\?xml|<!DOCTYPE/i.test(t),
  // A declaration starts its line or follows a brace: `proxy_pass http://…;`
  // in an nginx block has a colon too, in the middle of a value.
  css: (t) => /\{/.test(t) && /(?:^|[{;])[ \t]*[\w-]+[ \t]*:[ \t]*[^;{}\n]+(?:;|$)/m.test(t),
  scss: (t) => HALLMARK.css(t),
  go: (t) => /\bfunc\b|:=|^package\s+\w+\s*$/m.test(t),
  rust: (t) => /\bfn\s+\w+|\blet\s+(?:mut\s+)?\w+|\bimpl\b|\bpub\s+(?:fn|struct|enum|mod)\b|\w+!\(|::<?\w/.test(t),
  java: (t) =>
    /\b(?:class|interface|enum|public|private|protected|static|void|import|package|extends|implements|final)\b/.test(t) &&
    /;[ \t]*$/m.test(t),
  c: (t) =>
    /#include\b|\b(?:int|void|char|float|double|struct|typedef|unsigned|long|size_t)\b/.test(t) && /;[ \t]*$/m.test(t),
  cpp: (t) => HALLMARK.c(t),
  csharp: (t) =>
    /\b(?:using|namespace|class|interface|public|private|protected|void|var)\b/.test(t) &&
    /;[ \t]*$|\{\s*get;/m.test(t),
  // Perl's variables carry a sigil too, declared with `my`.
  php: (t) =>
    /<\?php|\$[A-Za-z_]\w*/.test(t) && /;[ \t]*$/m.test(t) && !/\bmy\s+[$@%]/.test(t),
  // Elixir closes `do` blocks with `end` too; `defmodule` and `|>` are its own.
  ruby: (t) =>
    /^[ \t]*(?:def|class|module|require|puts|attr_\w+|if|unless|do)\b|\bdo\s*(?:\|[^|]*\|)?\s*$/m.test(t) &&
    /^[ \t]*end\b/m.test(t) &&
    !/\bdefmodule\b|\|>|\bdo:/.test(t),
  kotlin: (t) => /\bfun\s+\w+|\bval\s+\w+|\bdata\s+class\b/.test(t),
  swift: (t) => /\bfunc\s+\w+|\bguard\s+let\b|\blet\s+\w+\s*[:=]|\bvar\s+\w+\s*[:=]|\bimport\s+(?:Foundation|SwiftUI|UIKit)\b/.test(t),
  diff: (t) => /^(?:@@ |--- |\+\+\+ |diff --git )/m.test(t),
  ini: (t) => /^[ \t]*\[[^\]\n]+\][ \t]*$/m.test(t) && /^[ \t]*[\w.-]+[ \t]*=/m.test(t)
}

/** TypeScript-only syntax: annotations, interfaces, type aliases, generics. A
 *  JavaScript snippet scores as high in TypeScript, so without one of these
 *  the family's pick is JavaScript. */
const TYPESCRIPT_SYNTAX =
  /:\s*(?:string|number|boolean|void|unknown|any|never|bigint|object)\b|\binterface\s+[A-Z]\w*|\btype\s+[A-Z]\w*(?:<[^>]*>)?\s*=|\benum\s+[A-Z]\w*|\bas\s+const\b|\w<[A-Z]\w*(?:,\s*[A-Z]\w*)*>\(|\b(?:readonly|private|public|protected)\s+\w+\s*[:;=(]/

const CPP_SYNTAX =
  /std::|\bnamespace\b|\btemplate\s*<|\bclass\s+\w+|\b(?:public|private|protected):|#include\s*<[a-z_]+>|\bnullptr\b|\bcout\b|\bauto\b|\w+::\w+/

const SCSS_SYNTAX = /\$[\w-]+\s*:|&[:.\w-]|@(?:mixin|include|use|extend|each|if)\b|\/\/ /

const HTML_SYNTAX =
  /<(?:!doctype\s+html|html|head|body|div|span|p|a|ul|ol|li|table|tr|td|section|main|nav|header|footer|article|script|style|img|h[1-6]|button|form|input|label|br)\b/i

const TOML_SYNTAX = /^[ \t]*[\w.-]+[ \t]*=[ \t]*(?:"|'|\[|\{|true\b|false\b)/m

function tagFor(name: string, text: string): string {
  if (name === 'javascript' || name === 'typescript') {
    return TYPESCRIPT_SYNTAX.test(text) ? 'typescript' : 'javascript'
  }
  if (name === 'c' || name === 'cpp') return CPP_SYNTAX.test(text) ? 'cpp' : 'c'
  if (name === 'css' || name === 'scss') return SCSS_SYNTAX.test(text) ? 'scss' : 'css'
  if (name === 'xml') return HTML_SYNTAX.test(text) ? 'html' : 'xml'
  if (name === 'ini') return TOML_SYNTAX.test(text) ? 'toml' : 'ini'
  return name
}

/** What a first line alone settles: a shebang names its interpreter. */
function shebangLanguage(text: string): string | null {
  const match = /^#!\S*(?:\s+\S+)*/.exec(text)
  if (!match) return null
  const line = match[0]
  if (/\b(?:bash|sh|zsh|ksh|dash)\b/.test(line)) return 'bash'
  if (/\bpython[\d.]*\b/.test(line)) return 'python'
  if (/\b(?:node|deno|bun)\b/.test(line)) return 'javascript'
  if (/\bruby\b/.test(line)) return 'ruby'
  if (/\bphp\b/.test(line)) return 'php'
  return null
}

function isJsonDocument(text: string): boolean {
  if (!/^[[{]/.test(text)) return false
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null
  } catch {
    return false
  }
}

let engine: ReturnType<typeof HighlightJS.newInstance> | null = null
const warmed = new Set<string>()

function hljs(): ReturnType<typeof HighlightJS.newInstance> {
  if (engine) return engine
  // An instance of our own: lowlight registers into its own as well, and
  // neither should see the other's configuration.
  engine = HighlightJS.newInstance()
  for (const [name, language] of SUBSET) engine.registerLanguage(name, language)
  return engine
}

function relevance(name: string, sample: string): number {
  const result = hljs().highlight(sample, { language: name, ignoreIllegals: false })
  return result.illegal ? -1 : result.relevance
}

/** The first MAX_SAMPLE_CHARS of the text, cut back to a whole line. */
function sampleOf(text: string): string {
  if (text.length <= MAX_SAMPLE_CHARS) return text
  const cut = text.lastIndexOf('\n', MAX_SAMPLE_CHARS)
  return text.slice(0, cut > 0 ? cut : MAX_SAMPLE_CHARS)
}

function countLines(text: string): number {
  let lines = 0
  for (const line of text.split('\n')) if (line.trim() !== '') lines++
  return lines
}

function guess(raw: string): DetectedCodeLanguage | null {
  const text = raw.trim()
  if (text.length < MIN_CHARS || text.length > MAX_DETECT_CHARS) return null
  if (countLines(text) < MIN_LINES) return null

  const named = shebangLanguage(text) ?? (/^<\?php\b/.test(text) ? 'php' : null)
  if (named) return { tag: named, relevance: Number.POSITIVE_INFINITY }
  if (isJsonDocument(text)) return { tag: 'json', relevance: Number.POSITIVE_INFINITY }

  const sample = sampleOf(text)
  const scored = DETECTABLE_LANGUAGES.map((name) => ({ name, relevance: relevance(name, sample) }))
    // Stable: the subset's order breaks a tie, JavaScript before TypeScript.
    .sort((a, b) => b.relevance - a.relevance)
  const candidates = scored.filter(
    (entry) => entry.relevance >= MIN_RELEVANCE && HALLMARK[entry.name](sample)
  )
  const best = candidates[0]
  if (!best) return null
  const rival = candidates.find((entry) => familyOf(entry.name) !== familyOf(best.name))
  if (rival && best.relevance - rival.relevance < MIN_MARGIN) return null
  return { tag: tagFor(best.name, sample), relevance: best.relevance }
}

const CACHE_LIMIT = 256
const cache = new Map<string, DetectedCodeLanguage | null>()

/**
 * The confident guess for a code block's text, or null. Cached by the text,
 * least recently used first out, so a note that is re-rendered or scrolled
 * pays for each block once.
 */
export function detectCodeLanguage(text: string): DetectedCodeLanguage | null {
  if (text.length > MAX_DETECT_CHARS) return null
  if (cache.has(text)) {
    const hit = cache.get(text) ?? null
    cache.delete(text)
    cache.set(text, hit)
    return hit
  }
  const result = guess(text)
  cache.set(text, result)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return result
}

/** The answer already worked out for this text, without working it out:
 *  undefined when it has not been. */
export function cachedCodeLanguage(text: string): DetectedCodeLanguage | null | undefined {
  return cache.has(text) ? (cache.get(text) ?? null) : undefined
}

/**
 * Compile one more of the subset's grammars, ahead of the first guess. The
 * first `highlight` call in a language compiles its regexes, about 70 ms for
 * the whole subset at once; the editor spends that in idle slices instead.
 * False once every grammar is compiled.
 */
export function warmCodeLanguageDetector(): boolean {
  const instance = hljs()
  const next = DETECTABLE_LANGUAGES.find((name) => !warmed.has(name))
  if (!next) return false
  warmed.add(next)
  instance.highlight('', { language: next, ignoreIllegals: true })
  return warmed.size < DETECTABLE_LANGUAGES.length
}
