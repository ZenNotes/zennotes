// Parsing/serialization for custom template `.md` files. Lives in shared-domain
// so both the renderer (palette, preview, save-as-template) and any Node-side
// caller share one frontmatter implementation. The main process only does file
// I/O and never parses, so this is the single source of truth for the format.
import type { NoteFolder } from '@zennotes/bridge-contract/ipc'
import type {
  NoteTemplate,
  TemplateCategory,
  TemplateSource
} from '@zennotes/bridge-contract/templates'
import { templateFolderEntryKey } from './template-folder'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export interface ParsedFrontmatter {
  data: Record<string, string>
  body: string
}

/**
 * Split a leading YAML frontmatter block (flat `key: value` scalars only) from
 * the body. Tolerant: no fence, or a malformed one, yields the whole input as
 * the body with empty data. Never throws.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: raw.slice(match[0].length) }
}

function normalizeCategory(value: string | undefined): TemplateCategory {
  if (value === 'Engineering' || value === 'Personal' || value === 'Custom') return value
  return 'Custom'
}

function normalizeTargetFolder(value: string | undefined): NoteFolder | undefined {
  // 'trash' and anything unknown fall back to undefined (the caller defaults to
  // 'inbox'); never let a template create directly in trash.
  if (value === 'inbox' || value === 'quick' || value === 'archive') return value
  return undefined
}

function filenameStem(sourcePath: string): string {
  const file = sourcePath.split('/').pop() ?? sourcePath
  return file.replace(/\.md$/i, '')
}

/** Turn a display name into a safe, lowercase filename stem. */
export function slugifyTemplateName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'template'
}

/** Parse a raw custom-template file into a NoteTemplate. Never throws. */
export function parseCustomTemplate(raw: string, sourcePath: string): NoteTemplate {
  const { data, body } = parseFrontmatter(raw)
  const stem = filenameStem(sourcePath)
  const name = data.name?.trim() || stem
  return {
    id: `custom:${stem}`,
    name,
    description: data.description?.trim() ?? '',
    category: normalizeCategory(data.category),
    body,
    titleTemplate: data.titleTemplate?.trim() || undefined,
    targetFolder: normalizeTargetFolder(data.targetFolder),
    targetSubpath: data.targetSubpath?.trim() || undefined,
    builtin: false,
    sourcePath,
    builtinId: data.builtinId?.trim() || undefined
  }
}

/** The frontmatter keys a `.zennotes/templates` file uses to describe itself
 *  (`builtinId` included: composeTemplateFile writes it for an edited copy of
 *  a built-in). */
const TEMPLATE_HEADER_KEYS = new Set([
  'name',
  'description',
  'category',
  'titleTemplate',
  'targetFolder',
  'targetSubpath',
  'builtinId'
])

/**
 * Parse a note in the vault's template folder (#1024) into a NoteTemplate.
 * Never throws.
 *
 * A plain note is the Obsidian shape: the whole file is the template, named
 * after the file, and a frontmatter of its own (`tags:`, `created: {{date}}`)
 * belongs to the notes it makes, so it stays in the body. A file whose
 * frontmatter holds nothing but the keys a `.zennotes/templates` file uses
 * (`name`, `description`, `category`, `titleTemplate`, `targetFolder`,
 * `targetSubpath`) is read the way that folder reads it instead, so a
 * template moved from `.zennotes/templates` into the folder keeps its name and
 * settings and does not paste them into every new note. One key of any other
 * kind makes the whole frontmatter note content.
 *
 * A template-folder note never shadows a built-in, even with a `builtinId`:
 * the edited copy of a built-in lives in `.zennotes/templates`, where Reset
 * can find it. The id is the note's path inside the folder (`folder:Work/
 * Standup`), which survives renaming the folder itself.
 */
export function parseFolderTemplate(
  raw: string,
  sourcePath: string,
  folder: string
): NoteTemplate {
  const stem = filenameStem(sourcePath)
  const key = templateFolderEntryKey(sourcePath, folder) ?? stem
  const base = {
    id: `folder:${key}`,
    builtin: false,
    source: 'folder' as const,
    sourcePath
  }
  const fence = FRONTMATTER_RE.exec(raw)
  const { data, body } = parseFrontmatter(raw)
  const keys = Object.keys(data)
  const isHeader = !!fence && keys.length > 0 && keys.every((k) => TEMPLATE_HEADER_KEYS.has(k))
  if (!isHeader) {
    return { ...base, name: stem, description: '', category: 'Custom', body: raw }
  }
  return {
    ...base,
    name: data.name?.trim() || stem,
    description: data.description?.trim() ?? '',
    category: normalizeCategory(data.category),
    body,
    titleTemplate: data.titleTemplate?.trim() || undefined,
    targetFolder: normalizeTargetFolder(data.targetFolder),
    targetSubpath: data.targetSubpath?.trim() || undefined
  }
}

/** Where a template comes from; templates parsed before 2.80 carry no
 *  `source`, and their `builtin` flag decides. */
export function templateSource(template: NoteTemplate): TemplateSource {
  return template.source ?? (template.builtin ? 'builtin' : 'custom')
}

/**
 * The short label the template picker and Settings show beside a template, so
 * two templates of one name can be told apart (#1024): the category for a
 * built-in or a `.zennotes/templates` file, as before, and for a note in the
 * template folder, the folder it sits in (`Templates`, `Templates/Work`).
 */
export function templateSourceLabel(template: NoteTemplate): string {
  if (templateSource(template) !== 'folder' || !template.sourcePath) return template.category
  const end = template.sourcePath.lastIndexOf('/')
  return end === -1 ? template.category : template.sourcePath.slice(0, end)
}

const CATEGORY_ORDER: TemplateCategory[] = ['Engineering', 'Personal', 'Custom']
const SOURCE_ORDER: TemplateSource[] = ['builtin', 'custom', 'folder']

/**
 * Combine built-in and custom templates into one display list, grouped by
 * category (Engineering → Personal → Custom), built-ins before custom within a
 * group, then alphabetical by name. Two templates of one name both stay
 * (#1024): a built-in first, then a `.zennotes/templates` file, then a note in
 * the template folder, so adding a template folder never changes which
 * template an existing `:template NAME` picks.
 */
export function mergeTemplates(
  builtins: NoteTemplate[],
  custom: NoteTemplate[]
): NoteTemplate[] {
  const rank = (c: TemplateCategory): number => {
    const i = CATEGORY_ORDER.indexOf(c)
    return i === -1 ? CATEGORY_ORDER.length : i
  }
  // A custom template carrying `builtinId` is an edited copy of that built-in;
  // it replaces the built-in in the list rather than appearing alongside it.
  const overridden = new Set(custom.map((c) => c.builtinId).filter(Boolean) as string[])
  const effectiveBuiltins = builtins.filter((b) => !overridden.has(b.id))
  // A customized built-in (override) keeps a built-in's standing so it stays in
  // its natural alphabetical spot rather than dropping into the custom group.
  const isPrimary = (t: NoteTemplate): boolean => t.builtin || !!t.builtinId
  return [...effectiveBuiltins, ...custom].sort((a, b) => {
    if (a.category !== b.category) return rank(a.category) - rank(b.category)
    if (isPrimary(a) !== isPrimary(b)) return isPrimary(a) ? -1 : 1
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return (
      SOURCE_ORDER.indexOf(templateSource(a)) - SOURCE_ORDER.indexOf(templateSource(b)) ||
      (a.sourcePath ?? '').localeCompare(b.sourcePath ?? '')
    )
  })
}

/**
 * The template an id names in a merged list. Editing a built-in saves an
 * edited copy under its own id, carrying the built-in's id as `builtinId`,
 * and mergeTemplates drops the built-in it replaces. Anything that stored
 * the built-in's id (the daily, weekly and monthly note templates) has to
 * reach the edited copy through it: looking up the id alone found nothing,
 * so a daily note came out blank once the Daily Note template was edited.
 */
export function findTemplate(
  templates: readonly NoteTemplate[],
  id: string | undefined
): NoteTemplate | undefined {
  if (!id) return undefined
  return templates.find((t) => t.id === id) ?? templates.find((t) => t.builtinId === id)
}

/** The id a setting should store for `template`: the built-in's for an
 *  edited copy, so resetting the copy falls back to the built-in rather
 *  than leaving the setting pointing at a file that is gone. */
export function templateSettingId(template: NoteTemplate): string {
  return template.builtinId ?? template.id
}

export interface ComposeTemplateInput {
  name: string
  description?: string
  category?: TemplateCategory
  titleTemplate?: string
  targetFolder?: NoteFolder
  targetSubpath?: string
  /** Set when this file is an edited copy of a built-in template. */
  builtinId?: string
  body: string
}

function yamlScalar(value: string): string {
  // Quote when the value could be misread as YAML structure or has edge
  // whitespace; JSON.stringify yields a valid double-quoted, escaped scalar.
  if (/[:#"'\n]/.test(value) || value.trim() !== value || value === '') {
    return JSON.stringify(value)
  }
  return value
}

/** Build a raw template `.md` (frontmatter + body) from structured fields. */
export function composeTemplateFile(input: ComposeTemplateInput): string {
  const lines = ['---', `name: ${yamlScalar(input.name)}`]
  if (input.description) lines.push(`description: ${yamlScalar(input.description)}`)
  lines.push(`category: ${input.category ?? 'Custom'}`)
  if (input.titleTemplate) lines.push(`titleTemplate: ${yamlScalar(input.titleTemplate)}`)
  if (input.targetFolder) lines.push(`targetFolder: ${input.targetFolder}`)
  if (input.targetSubpath) lines.push(`targetSubpath: ${yamlScalar(input.targetSubpath)}`)
  if (input.builtinId) lines.push(`builtinId: ${input.builtinId}`)
  lines.push('---')
  // One newline after the closing fence so the parser (which consumes a single
  // trailing newline) round-trips the body without a stray leading blank line.
  return `${lines.join('\n')}\n${input.body.replace(/^\n+/, '')}`
}
