/**
 * Shared logic for rendering a note's YAML frontmatter as an Obsidian-style
 * "properties" panel. Both the preview (read-only HTML) and the in-editor
 * widget (interactive DOM) build on the type inference, value formatting, and
 * type icons defined here so the two surfaces stay visually identical.
 *
 * Like Obsidian, a property's *type* is encoded in its YAML value rather than
 * stored separately: `5` is a number, `"5"` (quoted) is text, `true` is a
 * checkbox, `[a, b]` a list, `2025-11-02` a date. So inference reads the RAW
 * value (quotes included), and changing a type just rewrites the value into the
 * target type's YAML form (see `coerceToKind`).
 */

import { splitMultiSelect, isCheckboxTrue } from '@shared/database-transforms'
import type { FieldType, SelectOption } from '@shared/databases'

/** The value shapes we render distinctly, à la Obsidian. */
export type PropKind = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'list'

const NUMBER_RE = /^-?\d+(\.\d+)?$/
const DATE_RE = /^\d{4}[-/]\d{2}[-/]\d{2}$/
const DATETIME_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/

/** True when the raw value is wrapped in matching quotes (an explicit string). */
function isQuoted(raw: string): boolean {
  const v = raw.trim()
  return (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  )
}

/** Drop one layer of surrounding quotes, if present. */
export function stripQuotes(raw: string): string {
  const v = raw.trim()
  return isQuoted(v) ? v.slice(1, -1) : v
}

/** Infer kind from a bare (unquoted) value. */
function inferBareKind(bare: string): PropKind {
  const v = bare.trim()
  if (v === '') return 'text'
  const lower = v.toLowerCase()
  if (lower === 'true' || lower === 'false') return 'checkbox'
  if (NUMBER_RE.test(v)) return 'number'
  if (DATETIME_RE.test(v)) return 'datetime'
  if (DATE_RE.test(v)) return 'date'
  if (/^\[.*\]$/.test(v) || v.includes(',')) return 'list'
  return 'text'
}

/**
 * Infer a property's kind from its RAW YAML value. A quoted value is always
 * text (that is how YAML — and Obsidian — pin a numeric-looking string to the
 * text type); everything else is classified by its bare shape.
 */
export function inferPropKind(rawValue: string): PropKind {
  if (isQuoted(rawValue)) return 'text'
  return inferBareKind(rawValue)
}

/** True/false from a checkbox value. */
export function isChecked(rawValue: string): boolean {
  return stripQuotes(rawValue).toLowerCase() === 'true'
}

/** Split a list value (`[a, b]` or `a, b`) into trimmed, non-empty items. */
export function splitList(rawValue: string): string[] {
  return rawValue
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** Normalize a date value to Obsidian's `YYYY/MM/DD` display form. */
export function formatDateDisplay(rawValue: string): string {
  return stripQuotes(rawValue).replace(/-/g, '/')
}

/**
 * Rewrite a raw value into the YAML form of a target kind. Returns the new YAML
 * value plus whether existing data was incompatible (so the caller can warn,
 * like Obsidian's "your data will be adjusted" dialog). Lossless reformats
 * (e.g. `5` → `"5"`) report `lossy: false` but still change the stored text.
 */
export function coerceToKind(rawValue: string, toKind: PropKind): { yaml: string; lossy: boolean } {
  const bare = stripQuotes(rawValue)
  switch (toKind) {
    case 'checkbox': {
      const ok = /^(true|false)$/i.test(bare)
      return { yaml: ok ? bare.toLowerCase() : 'false', lossy: !ok && bare !== '' }
    }
    case 'number': {
      const ok = NUMBER_RE.test(bare)
      return { yaml: ok ? bare : '0', lossy: !ok && bare !== '' }
    }
    case 'date': {
      const ok = DATE_RE.test(bare) || DATETIME_RE.test(bare)
      return { yaml: ok ? bare.slice(0, 10).replace(/\//g, '-') : '', lossy: !ok && bare !== '' }
    }
    case 'datetime': {
      if (DATETIME_RE.test(bare)) return { yaml: bare.replace(/\//g, '-').replace(' ', 'T'), lossy: false }
      if (DATE_RE.test(bare)) return { yaml: `${bare.replace(/\//g, '-')}T00:00`, lossy: false }
      return { yaml: '', lossy: bare !== '' }
    }
    case 'list': {
      if (bare === '') return { yaml: '[]', lossy: false }
      return { yaml: `[${splitList(bare).join(', ')}]`, lossy: false }
    }
    case 'text':
    default: {
      if (bare === '') return { yaml: '', lossy: false }
      // Quote when the bare value would otherwise be read as another type.
      const needsQuote = inferBareKind(bare) !== 'text'
      return { yaml: needsQuote ? `"${bare.replace(/"/g, '\\"')}"` : bare, lossy: false }
    }
  }
}

/** Ordered `key → raw value` pairs from leading frontmatter (quotes kept). */
export function parseFrontmatterRaw(text: string): Array<{ key: string; raw: string }> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return []
  const rows: Array<{ key: string; raw: string }> = []
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    rows.push({ key, raw: line.slice(idx + 1).trim() })
  }
  return rows
}

// --- frontmatter editing (note body ⇄ properties) -----------------------
// Pure string transforms the interactive Properties card uses to write edits
// straight back into the note's leading `---` block (the single source of
// truth), creating or removing the block as needed.

const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function splitFrontmatter(body: string): { has: boolean; inner: string; rest: string } {
  const m = FRONTMATTER_BLOCK_RE.exec(body)
  if (!m) return { has: false, inner: '', rest: body }
  return { has: true, inner: m[1], rest: body.slice(m[0].length) }
}

function joinFrontmatter(inner: string, rest: string): string {
  return `---\n${inner}\n---\n${rest}`
}

function lineKey(line: string): string {
  const idx = line.indexOf(':')
  return idx === -1 ? '' : line.slice(0, idx).trim()
}

/** A `key: value` line, with the value omitted when empty (Obsidian-style). */
function frontmatterLine(key: string, yaml: string): string {
  return yaml ? `${key}: ${yaml}` : `${key}:`
}

/** Replace a property's value (the YAML is already in target-type form). */
export function setFrontmatterValue(body: string, key: string, yaml: string): string {
  const { has, inner, rest } = splitFrontmatter(body)
  if (!has) return body
  const lines = inner
    .split(/\r?\n/)
    .map((line) => (lineKey(line) === key ? frontmatterLine(key, yaml) : line))
  return joinFrontmatter(lines.join('\n'), rest)
}

/** Rename a property's key, preserving its value verbatim. */
export function renameFrontmatterKey(body: string, oldKey: string, newKey: string): string {
  const { has, inner, rest } = splitFrontmatter(body)
  if (!has || !newKey || oldKey === newKey) return body
  const lines = inner.split(/\r?\n/).map((line) => {
    if (lineKey(line) !== oldKey) return line
    const idx = line.indexOf(':')
    return `${newKey}:${idx === -1 ? '' : line.slice(idx + 1)}`
  })
  return joinFrontmatter(lines.join('\n'), rest)
}

/** Append a new property, creating the frontmatter block if there is none. */
export function addFrontmatterProperty(body: string, key: string, yaml: string): string {
  const { has, inner, rest } = splitFrontmatter(body)
  const line = frontmatterLine(key, yaml)
  if (!has) return `---\n${line}\n---\n\n${body}`
  return joinFrontmatter(inner ? `${inner}\n${line}` : line, rest)
}

/** Remove a property; drops the whole block (and its trailing blank) if empty. */
export function removeFrontmatterProperty(body: string, key: string): string {
  const { has, inner, rest } = splitFrontmatter(body)
  if (!has) return body
  const lines = inner.split(/\r?\n/).filter((line) => lineKey(line) !== key)
  if (lines.every((line) => line.trim() === '')) return rest.replace(/^\r?\n/, '')
  return joinFrontmatter(lines.join('\n'), rest)
}

/** Escape a string for safe interpolation into an HTML string. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 16px Tabler-style outline SVG for each property kind, matching the leading
 * icons in Obsidian's properties panel.
 */
export function propIconSvg(kind: PropKind): string {
  const open =
    '<svg class="np-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  const body = ((): string => {
    switch (kind) {
      case 'number':
        return '<path d="M10 4 8 20M16 4l-2 16M4 9h16M3 15h16"/>'
      case 'date':
        return '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/>'
      case 'datetime':
        return '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
      case 'checkbox':
        return '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/>'
      case 'list':
        return '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'
      case 'text':
      default:
        return '<path d="M4 6h16M4 12h16M4 18h10"/>'
    }
  })()
  return `${open}${body}</svg>`
}

function dateValueIconSvg(): string {
  return '<svg class="np-value-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/></svg>'
}

/** Render one property's value cell as an HTML string (read-only / preview). */
function renderValueHtml(kind: PropKind, rawValue: string): string {
  switch (kind) {
    case 'checkbox':
      return `<span class="np-checkbox${isChecked(rawValue) ? ' is-checked' : ''}" role="img" aria-label="${isChecked(rawValue) ? 'true' : 'false'}"></span>`
    case 'date':
    case 'datetime':
      return `<span class="np-value np-value-date">${dateValueIconSvg()}<span>${escapeHtml(formatDateDisplay(rawValue))}</span></span>`
    case 'list': {
      const chips = splitList(rawValue)
      if (chips.length === 0) return '<span class="np-value np-empty"></span>'
      return `<span class="np-chips">${chips
        .map((item) => `<span class="np-chip">${escapeHtml(item)}</span>`)
        .join('')}</span>`
    }
    case 'number':
    case 'text':
    default: {
      const v = stripQuotes(rawValue)
      if (v === '') return '<span class="np-value np-empty"></span>'
      return `<span class="np-value">${escapeHtml(v)}</span>`
    }
  }
}

/**
 * Build the read-only properties panel as an HTML string for preview.
 * `rows` is the ordered list of `{ key, raw }` pairs from `parseFrontmatterRaw`.
 * Returns an empty string when there are no properties so callers can skip it.
 */
export function buildPropertiesPanelHTML(
  rows: Array<{ key: string; raw: string }>,
  title: string
): string {
  if (rows.length === 0) return ''
  const body = rows
    .map(({ key, raw }) => {
      const kind = inferPropKind(raw)
      return (
        `<div class="np-row" data-kind="${kind}">` +
        `<div class="np-key">${propIconSvg(kind)}<span class="np-key-label">${escapeHtml(key)}</span></div>` +
        `<div class="np-cell">${renderValueHtml(kind, raw)}</div>` +
        `</div>`
      )
    })
    .join('')
  return (
    `<div class="note-properties" data-readonly="true">` +
    `<div class="np-title">${escapeHtml(title)}</div>` +
    `<div class="np-rows">${body}</div>` +
    `</div>`
  )
}

/** A database column surfaced as a linked property on a record page. */
export interface LinkedFieldView {
  name: string
  type: FieldType
  value: string
  options?: SelectOption[]
}

/** Map a database field type to the icon kind used by the panel. */
export function fieldIconKind(type: FieldType): PropKind {
  switch (type) {
    case 'checkbox':
      return 'checkbox'
    case 'date':
      return 'date'
    case 'number':
      return 'number'
    case 'select':
    case 'multiSelect':
      return 'list'
    case 'text':
    default:
      return 'text'
  }
}

function optionLabelFor(field: LinkedFieldView, value: string): string {
  return field.options?.find((o) => o.value === value)?.label ?? value
}

/** Read-only value cell for a linked (database-backed) field. */
function renderLinkedValueHtml(field: LinkedFieldView): string {
  const v = field.value.trim()
  switch (field.type) {
    case 'checkbox':
      return `<span class="np-checkbox${isCheckboxTrue(field.value) ? ' is-checked' : ''}" role="img" aria-label="${isCheckboxTrue(field.value) ? 'true' : 'false'}"></span>`
    case 'date':
      return v === ''
        ? '<span class="np-value np-empty"></span>'
        : `<span class="np-value np-value-date">${dateValueIconSvg()}<span>${escapeHtml(formatDateDisplay(v))}</span></span>`
    case 'select': {
      if (v === '') return '<span class="np-value np-empty"></span>'
      return `<span class="np-chips"><span class="np-chip">${escapeHtml(optionLabelFor(field, v))}</span></span>`
    }
    case 'multiSelect': {
      const items = splitMultiSelect(field.value)
      if (items.length === 0) return '<span class="np-value np-empty"></span>'
      return `<span class="np-chips">${items
        .map((item) => `<span class="np-chip">${escapeHtml(optionLabelFor(field, item))}</span>`)
        .join('')}</span>`
    }
    case 'number':
    case 'text':
    default:
      return v === ''
        ? '<span class="np-value np-empty"></span>'
        : `<span class="np-value">${escapeHtml(v)}</span>`
  }
}

/**
 * Build the read-only panel for a record page: linked database fields first,
 * then any independent frontmatter properties (deduped by name — a frontmatter
 * key matching a linked field is shown as the linked one, not twice).
 */
export function buildRecordPanelHTML(
  title: string,
  linked: LinkedFieldView[],
  independent: Array<{ key: string; raw: string }>
): string {
  const linkedNames = new Set(linked.map((f) => f.name))
  const indep = independent.filter((r) => !linkedNames.has(r.key))
  if (linked.length === 0 && indep.length === 0) return ''
  const linkedRows = linked
    .map((field) => {
      const kind = fieldIconKind(field.type)
      return (
        `<div class="np-row np-row-linked" data-kind="${kind}">` +
        `<div class="np-key">${propIconSvg(kind)}<span class="np-key-label">${escapeHtml(field.name)}</span></div>` +
        `<div class="np-cell">${renderLinkedValueHtml(field)}</div>` +
        `</div>`
      )
    })
    .join('')
  const indepRows = indep
    .map(({ key, raw }) => {
      const kind = inferPropKind(raw)
      return (
        `<div class="np-row" data-kind="${kind}">` +
        `<div class="np-key">${propIconSvg(kind)}<span class="np-key-label">${escapeHtml(key)}</span></div>` +
        `<div class="np-cell">${renderValueHtml(kind, raw)}</div>` +
        `</div>`
      )
    })
    .join('')
  return (
    `<div class="note-properties" data-readonly="true">` +
    `<div class="np-title">${escapeHtml(title)}</div>` +
    `<div class="np-rows">${linkedRows}${indepRows}</div>` +
    `</div>`
  )
}
