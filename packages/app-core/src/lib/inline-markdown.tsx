/**
 * Lightweight inline-markdown renderer for compact surfaces — task cards
 * in the List, Kanban, and Calendar views — where the full block-level
 * `renderMarkdown` pipeline would be both too heavy and visually wrong
 * (it wraps content in `<p>` and pulls in KaTeX / highlight / mermaid).
 *
 * Scope is deliberately the inline subset that shows up on a single task
 * line: bold, italic, strikethrough, inline code, links, `[[wikilinks]]`,
 * and `#tags`. Block constructs (headings, lists, fences) are never
 * present in a task's display `content`, so they are not handled.
 *
 * Two halves:
 *   - `parseInlineTokens` — a pure tokenizer (unit-tested without a DOM).
 *   - `InlineMarkdown`     — a thin React renderer over those tokens.
 *
 * Links render as their label, not the raw URL. Where the host element is
 * itself interactive (a `<button>` chip), pass `interactiveLinks={false}`
 * so links render as styled text instead of nested anchors (invalid HTML).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'del'; children: InlineToken[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineToken[] }
  | { type: 'wikilink'; target: string; label: string }
  | { type: 'tag'; tag: string }

// Recursion is bounded by the input length (every level strips at least a
// delimiter pair), but cap it anyway so a pathological line can never blow
// the stack — beyond the cap we just keep the remainder as plain text.
const MAX_DEPTH = 12

interface Matcher {
  re: RegExp
  build: (m: RegExpExecArray, depth: number) => InlineToken
}

/**
 * Ordered by priority — when two matchers tie on position, the earlier
 * entry wins. Inline code comes first (its body is literal); the `**`/`__`
 * strong forms precede the single-char emphasis forms so `**x**` is never
 * mis-read as emphasis wrapping `*x*`. Emphasis bodies use `[^delim]`
 * classes (not `.`) and require non-space flanking, which both prevents
 * catastrophic backtracking and rejects `2 * 3 * 4`-style false positives.
 * Underscore forms additionally require word boundaries so `snake_case`
 * stays intact.
 */
const MATCHERS: Matcher[] = [
  {
    re: /`([^`]+?)`/g,
    build: (m) => ({ type: 'code', value: m[1] })
  },
  {
    re: /\[\[([^[\]]+?)\]\]/g,
    build: (m) => {
      const [rawTarget, rawLabel] = m[1].split('|', 2)
      const target = (rawTarget ?? '').trim()
      const label = (rawLabel ?? rawTarget ?? '').trim()
      return { type: 'wikilink', target, label }
    }
  },
  {
    re: /\[([^[\]]+?)\]\(([^()\s]+)\)/g,
    build: (m, depth) => ({
      type: 'link',
      href: m[2],
      children: parseInline(m[1], depth + 1)
    })
  },
  {
    re: /\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g,
    build: (m, depth) => ({ type: 'strong', children: parseInline(m[1], depth + 1) })
  },
  {
    re: /(?<![\w])__([^\s_](?:[^_]*?[^\s_])?)__(?![\w])/g,
    build: (m, depth) => ({ type: 'strong', children: parseInline(m[1], depth + 1) })
  },
  {
    re: /~~([^\s~](?:[^~]*?[^\s~])?)~~/g,
    build: (m, depth) => ({ type: 'del', children: parseInline(m[1], depth + 1) })
  },
  {
    re: /\*([^\s*](?:[^*]*?[^\s*])?)\*/g,
    build: (m, depth) => ({ type: 'em', children: parseInline(m[1], depth + 1) })
  },
  {
    re: /(?<![\w])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w])/g,
    build: (m, depth) => ({ type: 'em', children: parseInline(m[1], depth + 1) })
  }
]

// `#tag` tokens are pulled out of plain-text runs only — never from inside
// code spans or URLs. Mirrors the boundary rule the note renderer uses.
const TAG_RE = /(^|\s)#([a-zA-Z][\w/-]*)/g

function pushText(tokens: InlineToken[], text: string): void {
  if (!text) return
  TAG_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text)) !== null) {
    const start = m.index + m[1].length
    if (start > last) tokens.push({ type: 'text', value: text.slice(last, start) })
    tokens.push({ type: 'tag', tag: m[2] })
    last = TAG_RE.lastIndex
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) })
}

function parseInline(input: string, depth: number): InlineToken[] {
  const tokens: InlineToken[] = []
  if (depth > MAX_DEPTH) {
    pushText(tokens, input)
    return tokens
  }

  let rest = input
  while (rest.length > 0) {
    let best: { index: number; matcher: Matcher; m: RegExpExecArray } | null = null
    for (const matcher of MATCHERS) {
      matcher.re.lastIndex = 0
      const m = matcher.re.exec(rest)
      if (!m) continue
      if (!best || m.index < best.index) best = { index: m.index, matcher, m }
      if (best.index === 0) break // nothing can start earlier than the start
    }

    if (!best) {
      pushText(tokens, rest)
      break
    }
    if (best.index > 0) pushText(tokens, rest.slice(0, best.index))
    tokens.push(best.matcher.build(best.m, depth))
    rest = rest.slice(best.index + best.m[0].length)
  }

  return tokens
}

/** Parse a single line of inline markdown into a token tree. Pure — safe to
 *  unit-test without a DOM. */
export function parseInlineTokens(input: string): InlineToken[] {
  return parseInline(input, 0)
}

export interface InlineMarkdownProps {
  text: string
  /** Render links as clickable anchors that open externally. Set false when
   *  the host element is itself interactive (e.g. a `<button>` chip), where a
   *  nested `<a>` would be invalid HTML — links then render as styled text. */
  interactiveLinks?: boolean
  /** Optional wrapper class. When set, output is wrapped in a `<span>`;
   *  otherwise it renders as a bare fragment (no extra DOM). */
  className?: string
}

function openExternal(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer')
}

function renderLink(
  token: Extract<InlineToken, { type: 'link' }>,
  key: number,
  interactiveLinks: boolean
): ReactNode {
  const label = renderTokens(token.children, interactiveLinks)
  const isExternal = /^(?:https?:|mailto:)/i.test(token.href)
  if (interactiveLinks && isExternal) {
    return (
      <a
        key={key}
        href={token.href}
        className="text-accent underline underline-offset-2 hover:opacity-80"
        // Stop the press/click from reaching the card: a link click should
        // open the URL, not open the note or start a Kanban drag.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openExternal(token.href)
        }}
      >
        {label}
      </a>
    )
  }
  return (
    <span key={key} className="text-accent/90 underline underline-offset-2">
      {label}
    </span>
  )
}

function renderToken(token: InlineToken, key: number, interactiveLinks: boolean): ReactNode {
  switch (token.type) {
    case 'text':
      return token.value
    case 'strong':
      return (
        <strong key={key} className="font-semibold">
          {renderTokens(token.children, interactiveLinks)}
        </strong>
      )
    case 'em':
      return <em key={key}>{renderTokens(token.children, interactiveLinks)}</em>
    case 'del':
      return (
        <del key={key} className="opacity-70">
          {renderTokens(token.children, interactiveLinks)}
        </del>
      )
    case 'code':
      return (
        <code key={key} className="rounded bg-current/10 px-1 py-0.5 font-mono text-[0.85em]">
          {token.value}
        </code>
      )
    case 'tag':
      return (
        <span key={key} className="text-accent/80">
          #{token.tag}
        </span>
      )
    case 'wikilink':
      return (
        <span key={key} className="text-accent/80">
          {token.label}
        </span>
      )
    case 'link':
      return renderLink(token, key, interactiveLinks)
  }
}

function renderTokens(tokens: InlineToken[], interactiveLinks: boolean): ReactNode[] {
  return tokens.map((token, i) => renderToken(token, i, interactiveLinks))
}

export function InlineMarkdown({
  text,
  interactiveLinks = true,
  className
}: InlineMarkdownProps): JSX.Element {
  const tokens = useMemo(() => parseInlineTokens(text), [text])
  const content = renderTokens(tokens, interactiveLinks)
  if (className) return <span className={className}>{content}</span>
  return <>{content}</>
}
