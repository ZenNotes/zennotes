import type { FolderEntry, NoteFolder, NoteMeta, VaultSettings } from '@shared/ipc'
import { formDirContaining } from '@shared/databases'
import { parseCreateNotePath } from './wikilinks'
import { noteFolderSubpath } from './vault-layout'
import { rankTagCompletions, type RankedTag } from './tags'

/**
 * Creating a note from the search palette (#826). The pure half of the flow:
 * turning the query into a draft, reading the Folder field, checking the Name
 * field, spotting a note that already has the name, listing the folders the
 * picker offers, and shaping the tags. The form itself lives in
 * `SearchCreateForm.tsx`.
 */

export interface NoteDestination {
  folder: NoteFolder
  subpath: string
}

/** The user's answer to the Folder field, or why it is not one. */
export type DestinationParse =
  | { destination: NoteDestination; error: null }
  | { destination: null; error: string }

/** The user's answer to the Name field, or why it is not one. */
export type NameCheck = { title: string; error: null } | { title: null; error: string }

/** What the New note form opens with, read off the search query. */
export interface SearchCreateDraft {
  /** Prefilled Name field. Raw query text when it cannot be a name, so the
   *  form can show the reason instead of the palette silently doing nothing. */
  name: string
  /** Prefilled Folder field, in the text form `destinationText` produces. */
  folderText: string
  /** Prefilled tags: the `#tag` words of the query, so a search like
   *  `#ops runbook` becomes a note that already carries #ops. */
  tags: string[]
}

/**
 * The Folder field speaks the `:e` dialect the rest of the app uses for paths:
 * empty is the Inbox root, `projects/ideas` nests under Inbox, and a leading
 * top folder (`archive`, `quick/x`) picks that folder. Never a literal on-disk
 * path: system folders can be remapped, so `inbox/x` as a string means nothing.
 */
export function destinationText(destination: NoteDestination): string {
  if (destination.folder === 'inbox') return destination.subpath
  return destination.subpath ? `${destination.folder}/${destination.subpath}` : destination.folder
}

const TRASH_ERROR = 'Notes cannot be created in the Trash.'
const DATABASE_ERROR = 'Databases hold rows, not notes. Pick a folder.'

/** Read the Folder field. Typed folders need not exist yet: creating makes them. */
export function parseDestinationText(text: string): DestinationParse {
  const trimmed = text.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!trimmed) return { destination: { folder: 'inbox', subpath: '' }, error: null }
  // The path parser wants a file at the end; a placeholder name turns the
  // folder text into "that folder, any file" and its checks apply unchanged.
  let parsed: ReturnType<typeof parseCreateNotePath>
  try {
    parsed = parseCreateNotePath(`${trimmed}/-`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { destination: null, error: message.replace(/^File names/, 'Folder names') }
  }
  if (parsed.folder === 'trash') return { destination: null, error: TRASH_ERROR }
  if (formDirContaining(parsed.subpath)) return { destination: null, error: DATABASE_ERROR }
  return { destination: { folder: parsed.folder, subpath: parsed.subpath }, error: null }
}

/**
 * Read the Name field. The name is one file name, never a path: the Folder
 * field owns the directory, so a slash here is a mistake worth naming. Leading
 * the name with `/` when parsing keeps a note called "Inbox" or "archive" a
 * plain title instead of a top-folder prefix.
 */
export function checkNoteName(name: string): NameCheck {
  const trimmed = name.trim()
  if (!trimmed) return { title: null, error: 'Enter a name.' }
  if (/[\\/]/.test(trimmed)) {
    return { title: null, error: 'Names cannot contain a slash. Pick the folder in the Folder field.' }
  }
  try {
    return { title: parseCreateNotePath(`/${trimmed}`).title, error: null }
  } catch (err) {
    return { title: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * What the search query asks to create. Null when there is nothing to name a
 * note after (an empty or tag-only query). A query that parses as a path is
 * split into its folder and name; one that does not is split at its last
 * slash so each field shows its own complaint.
 */
export function searchCreateDraft(
  freeText: string,
  tagTokens: readonly string[]
): SearchCreateDraft | null {
  const text = freeText.trim()
  if (!text) return null
  const tags = tagTokens.reduce<string[]>((acc, tag) => addTag(acc, tag), [])
  try {
    const parsed = parseCreateNotePath(text)
    return {
      name: parsed.title,
      folderText: destinationText({ folder: parsed.folder, subpath: parsed.subpath }),
      tags
    }
  } catch {
    const normalized = text.replace(/\\/g, '/')
    const slash = normalized.lastIndexOf('/')
    if (slash < 0) return { name: normalized, folderText: '', tags }
    return { name: normalized.slice(slash + 1).trim(), folderText: normalized.slice(0, slash), tags }
  }
}

export interface NameCollision {
  note: NoteMeta
  /** True when the note sits in the chosen folder, where creating would only
   *  make a "Title 2" twin; false for a same-named note somewhere else. */
  sameFolder: boolean
}

/**
 * The live note that already carries `title`, if any. Same-folder matches win
 * over matches elsewhere; the Trash never counts. Titles and folders compare
 * case-insensitively because that is how the default macOS file system sees
 * them, and a false alarm on Linux costs less than a missed twin on a Mac.
 */
export function findNameCollision(
  title: string,
  destination: NoteDestination,
  notes: readonly NoteMeta[],
  settings: VaultSettings | null | undefined
): NameCollision | null {
  const wanted = title.trim().toLowerCase()
  if (!wanted) return null
  const subpath = destination.subpath.toLowerCase()
  let elsewhere: NoteMeta | null = null
  for (const note of notes) {
    if (note.folder === 'trash' || note.title.trim().toLowerCase() !== wanted) continue
    if (
      note.folder === destination.folder &&
      noteFolderSubpath(note, settings).toLowerCase() === subpath
    ) {
      return { note, sameFolder: true }
    }
    elsewhere ??= note
  }
  return elsewhere ? { note: elsewhere, sameFolder: false } : null
}

export interface DestinationChoice {
  /** Folder field text this row fills in (`destinationText`). */
  value: string
  /** `Inbox`, `Inbox › projects/ideas`, `Archive › old`. */
  label: string
  destination: NoteDestination
}

/** Areas the picker offers, in the order they appear. The Trash never does. */
const PICKER_AREAS: readonly Exclude<NoteFolder, 'trash'>[] = ['inbox', 'quick', 'archive']

/** What each top folder is called on screen. The caller resolves renamed
 *  system folders, and a vault that keeps its notes at the root passes the
 *  vault's name for `inbox`, the way the note list heading does. */
export type AreaLabels = Record<NoteFolder, string>

/** `Inbox`, `Inbox › projects/ideas`, `Archive › old`: how the form names a
 *  destination. Never the on-disk path, which remapped folders make wrong. */
export function destinationLabel(destination: NoteDestination, labels: AreaLabels): string {
  const area = labels[destination.folder]
  return destination.subpath ? `${area} › ${destination.subpath}` : area
}

/**
 * The folders the picker offers: each area's root, then its subfolders by
 * depth and name. `folders` is the store's list of real subfolders; database
 * folders (`.base`) are skipped because they hold rows, not notes.
 */
export function buildDestinationChoices(
  folders: readonly FolderEntry[],
  labels: AreaLabels
): DestinationChoice[] {
  const choices: DestinationChoice[] = []
  const push = (destination: NoteDestination): void => {
    choices.push({
      value: destinationText(destination),
      label: destinationLabel(destination, labels),
      destination
    })
  }
  for (const area of PICKER_AREAS) {
    push({ folder: area, subpath: '' })
    const seen = new Set<string>()
    const subs = folders
      .filter((entry) => entry.folder === area && entry.subpath && !formDirContaining(entry.subpath))
      .filter((entry) => !seen.has(entry.subpath) && seen.add(entry.subpath))
      .sort((a, b) => {
        const depth = a.subpath.split('/').length - b.subpath.split('/').length
        return depth || a.subpath.localeCompare(b.subpath)
      })
    for (const entry of subs) push({ folder: area, subpath: entry.subpath })
  }
  return choices
}

const MAX_DESTINATION_ROWS = 12

/**
 * Narrow the picker to what the Folder field says, ranked the way the other
 * folder prompts rank: an exact value, then values and labels that start
 * with the text, then anything containing it. Empty text lists everything.
 */
export function filterDestinationChoices(
  choices: readonly DestinationChoice[],
  text: string
): DestinationChoice[] {
  const query = text.trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!query) return choices.slice(0, MAX_DESTINATION_ROWS)
  return choices
    .map((choice, index) => {
      const value = choice.value.toLowerCase()
      const label = choice.label.toLowerCase()
      const rank =
        value === query
          ? 0
          : value.startsWith(query)
            ? 1
            : label.startsWith(query)
              ? 2
              : value.includes(query) || label.includes(query)
                ? 3
                : null
      return rank === null ? null : { choice, rank, index }
    })
    .filter((entry): entry is { choice: DestinationChoice; rank: number; index: number } => !!entry)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_DESTINATION_ROWS)
    .map((entry) => entry.choice)
}

/** The same shape `extractTags` accepts: a letter, then letters, digits, `_`, `-`, `/`. */
const TAG_RE = /^\p{L}[\p{L}\d_/-]*$/u

/** A typed tag without its `#`, or null when it could never be one. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, '')
  return TAG_RE.test(tag) ? tag : null
}

/**
 * Add a typed tag to the chips. Nothing changes for text that is not a tag or
 * a tag already present (case-insensitively). When the vault already spells
 * the tag some way, that spelling wins over the typed one, so `ops` and `Ops`
 * never become two tags.
 */
export function addTag(
  tags: readonly string[],
  raw: string,
  known?: ReadonlyMap<string, number>
): string[] {
  const normalized = normalizeTag(raw)
  if (!normalized) return [...tags]
  const lower = normalized.toLowerCase()
  if (tags.some((tag) => tag.toLowerCase() === lower)) return [...tags]
  const canonical = known ? [...known.keys()].find((tag) => tag.toLowerCase() === lower) : undefined
  return [...tags, canonical ?? normalized]
}

/**
 * Suggestions for the Tags field. The tag the text spells exactly leads (so
 * Enter picks the vault's spelling), then the usual prefix-then-substring
 * ranking, minus tags already chosen.
 */
export function rankTagChoices(
  text: string,
  counts: ReadonlyMap<string, number>,
  chosen: readonly string[]
): RankedTag[] {
  const query = text.trim().replace(/^#+/, '')
  const lower = query.toLowerCase()
  const taken = new Set(chosen.map((tag) => tag.toLowerCase()))
  const ranked: RankedTag[] = []
  if (lower) {
    for (const [tag, count] of counts) {
      if (tag.toLowerCase() === lower && !taken.has(lower)) ranked.push({ tag, count })
    }
  }
  for (const entry of rankTagCompletions(query, counts)) {
    if (!taken.has(entry.tag.toLowerCase())) ranked.push(entry)
  }
  return ranked
}

/**
 * The body a note created with tags starts from: the heading every new note
 * gets, then one line of `#tags`. Mirrors `composeBody` in the CLI's capture
 * and notes commands so a note made in the app and one made from a terminal
 * look the same.
 */
export function composeNewNoteBody(title: string, tags: readonly string[]): string {
  const tagLine = tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') + '\n\n' : ''
  return `# ${title}\n\n${tagLine}`
}
