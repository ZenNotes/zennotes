// Shared note-template contract types. Lives in bridge-contract because both
// the main process (custom-template CRUD over IPC) and the renderer (palette,
// substitution) need this shape, and the IPC bridge return types reference it.
import type { NoteFolder } from './ipc.js'

export type TemplateCategory = 'Engineering' | 'Personal' | 'Custom'

/**
 * Where a template comes from: shipped with the app (`builtin`), a file in
 * `.zennotes/templates/` (`custom`), or a note in the vault's template folder
 * (`folder`, #1024).
 */
export type TemplateSource = 'builtin' | 'custom' | 'folder'

/**
 * A note template: a built-in (shipped as a code constant), a custom one
 * authored by the user and stored as a `.md` file under `.zennotes/templates/`,
 * or a note in the vault's template folder (#1024). A custom template's `body`
 * has had its frontmatter stripped; a template-folder note keeps a frontmatter
 * of its own, for the new note to carry. Either may still contain `{{...}}`
 * substitution tokens.
 */
export interface NoteTemplate {
  /** `builtin.adr` for built-ins, `custom:<slug>` for user templates,
   *  `folder:<path inside the template folder, no extension>` for notes in
   *  the template folder. */
  id: string
  /** Display name. */
  name: string
  description: string
  category: TemplateCategory
  /** Markdown body with `{{title}}`, `{{date}}`, `{{cursor}}`, … tokens. */
  body: string
  /** Optional title pattern, e.g. `{{date:YYYY-MM-DD}} — `. */
  titleTemplate?: string
  /** Default destination folder; never `trash`. Defaults to `inbox`. */
  targetFolder?: NoteFolder
  /** Default subpath within the target folder. */
  targetSubpath?: string
  builtin: boolean
  /** Where the template lives. Absent means the `builtin` flag decides
   *  (`builtin` or `custom`); read it through `templateSource`. */
  source?: TemplateSource
  /** Custom and template-folder templates: vault-relative path to the
   *  source `.md`. */
  sourcePath?: string
  /**
   * When a custom template is an edited copy of a built-in, this is the
   * built-in's id (e.g. `builtin.adr`). Such a custom template shadows the
   * built-in in every list/picker; deleting it restores the built-in.
   */
  builtinId?: string
}

/**
 * Raw custom-template file as it lives on disk. The main process only does
 * file I/O and returns these; the renderer owns all frontmatter parsing and
 * substitution, so parsing logic has a single home (`@shared/template-files`).
 */
export interface CustomTemplateFile {
  /** Vault-relative path, e.g. `.zennotes/templates/adr.md`. */
  sourcePath: string
  /** Raw `.md` contents including YAML frontmatter. */
  raw: string
}

/** Payload for creating or updating a custom template file. */
export interface WriteTemplateInput {
  /** Filename stem (no extension); derived from the template name. */
  slug: string
  /** Raw `.md` contents including YAML frontmatter. */
  raw: string
  /** When renaming during an edit, the prior sourcePath to remove. */
  previousSourcePath?: string
}
