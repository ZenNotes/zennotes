/**
 * Live template tokens (#784).
 *
 * `{{modified_date}}`, `{{modified_time}}` and `{{modified_datetime}}` (each
 * optionally `:FORMAT`, with the same tokens `{{date:FORMAT}}` takes) are the
 * one family of template variables that `renderTemplate` deliberately leaves
 * in the note. Where `{{date}}` freezes the creation date into the text, these
 * keep reading the note's file modification time, so an `Updated:` line stays
 * true without anyone editing it. The editor (live preview) and the reading
 * view render them from the note's `updatedAt`; the raw markdown, and any other
 * reader of the file, sees the token itself.
 */
import { formatDate, formatISODate, formatTime } from './template-render'

export type LiveTokenKind = 'modified_date' | 'modified_time' | 'modified_datetime'

export interface LiveToken {
  kind: LiveTokenKind
  /** Custom `formatDate` pattern from `{{modified_date:FORMAT}}`, or null. */
  format: string | null
}

const TOKEN_BODY = String.raw`\{\{\s*(modified_date|modified_time|modified_datetime)(?::([^}]*?))?\s*\}\}`

/** Global matcher for live tokens; group 1 is the kind, group 2 the format. */
export const LIVE_TOKEN_RE = new RegExp(TOKEN_BODY, 'g')

// Code first, so a token documented inside a span or fence stays literal.
const CODE_OR_TOKEN_RE = new RegExp(
  String.raw`(${'```'}[\s\S]*?${'```'}|~~~[\s\S]*?~~~|${'`'}[^${'`'}\n]*${'`'})|${TOKEN_BODY}`,
  'g'
)

export function liveTokenFromMatch(kind: string, format: string | undefined): LiveToken {
  const trimmed = format?.trim()
  return { kind: kind as LiveTokenKind, format: trimmed ? trimmed : null }
}

/** The text a live token shows for a note last saved at `modified`. */
export function formatLiveToken(token: LiveToken, modified: Date): string {
  if (token.format) return formatDate(modified, token.format)
  switch (token.kind) {
    case 'modified_time':
      return formatTime(modified)
    case 'modified_datetime':
      return `${formatISODate(modified)} ${formatTime(modified)}`
    default:
      return formatISODate(modified)
  }
}

/**
 * Expand the live tokens in `markdown` for a rendered, read-only surface (the
 * reading view, exports). `updatedAt` is the note's modification time in ms;
 * without one the tokens are left as written. Code is skipped.
 */
export function substituteLiveTokens(markdown: string, updatedAt: number | null | undefined): string {
  if (!updatedAt || !markdown.includes('{{')) return markdown
  const modified = new Date(updatedAt)
  return markdown.replace(
    CODE_OR_TOKEN_RE,
    (full: string, code: string | undefined, kind: string | undefined, format: string | undefined) => {
      if (code !== undefined || kind === undefined) return full
      return formatLiveToken(liveTokenFromMatch(kind, format), modified)
    }
  )
}
