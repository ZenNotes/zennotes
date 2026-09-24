/**
 * Convert the Markdown table under the cursor into a `.base` database (#832).
 *
 * A note often starts with a small pipe table that outgrows inline editing.
 * This takes that table, creates a database from it at the configured
 * databases location, and leaves a `[[Database]]` wikilink where the table
 * stood, the same link the `[[` picker inserts for a database, so the note
 * keeps pointing at its data and the grid is one `gd` / click away. The
 * columns are typed the way an adopted CSV would be (number, checkbox, date,
 * text), cell text travels verbatim (inline markdown included; the CSV layer
 * does the RFC 4180 quoting), and column alignment is dropped because a grid
 * has none. Column widths from a `zen:cols` marker become field widths.
 *
 * The replacement is an ordinary editor transaction: autosaved by the pane's
 * update listener and one `u` away. The database itself stays; undo restores
 * the table, it does not delete files.
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { DatabaseSeed } from '@shared/databases'
import type { NoteMeta } from '@shared/ipc'
import { focusedTableAnchor, tableRangeAt } from './cm-table'
import { parseTableBlock, type MarkdownTable } from './markdown-table'
import { noteEditorPath } from './note-editor-context'
import { promptApp } from './prompt-requests'
import { useToastStore } from './toast'
import { normalizeVaultSettings, resolveCreateLocation } from './vault-layout'
import { useStore } from '../store'

export interface TableUnderCursor {
  from: number
  to: number
  /** The exact source the range covers, so the replacement can confirm the
   *  table is still there after the prompt and the write. */
  source: string
  table: MarkdownTable
}

function tableAt(view: EditorView, pos: number): TableUnderCursor | null {
  const range = tableRangeAt(view, pos)
  if (!range) return null
  const source = view.state.sliceDoc(range.from, range.to)
  const table = parseTableBlock(source)
  if (!table) return null
  return { from: range.from, to: range.to, source, table }
}

/**
 * The table the user is working in. When tables render as widgets the caret
 * cannot be inside one, so a cell that holds focus (or held it last, before
 * the palette took over) wins; otherwise the table around the caret, which
 * is how raw pipe tables (Split mode, live tables off) are found.
 */
export function tableUnderCursor(view: EditorView): TableUnderCursor | null {
  const focused = focusedTableAnchor(view)
  if (focused != null) {
    const found = tableAt(view, focused)
    if (found) return found
  }
  return tableAt(view, view.state.selection.main.head)
}

const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/

/**
 * The nearest heading above `pos`, its markers stripped. Read from the
 * syntax tree where it has parsed that far (a `# comment` inside a fenced code
 * block is not a heading), by line scan otherwise.
 */
export function headingAbove(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state)
  if (tree.length >= pos) {
    const last: { range: { from: number; to: number } | null } = { range: null }
    tree.iterate({
      from: 0,
      to: pos,
      enter: (node) => {
        if (/^ATXHeading[1-6]$/.test(node.name) && node.to <= pos) {
          last.range = { from: node.from, to: node.to }
        }
      }
    })
    if (!last.range) return null
    const m = HEADING_LINE_RE.exec(state.sliceDoc(last.range.from, last.range.to))
    return m ? m[1].trim() || null : null
  }
  const doc = state.doc
  for (let n = doc.lineAt(pos).number - 1; n >= 1; n--) {
    const m = HEADING_LINE_RE.exec(doc.line(n).text)
    if (m) return m[1].trim() || null
  }
  return null
}

/** Characters a database name cannot carry and still be a filesystem name
 *  AND a `[[wikilink]]` target: `[`/`]` close the link, `#` and `^` read as
 *  anchors, `|` as display text, and the slashes as directories. */
const UNLINKABLE_RE = /[[\]#^|/\\]/

/** Reduce heading text to something that can name a database: inline
 *  emphasis markers and the characters a link cannot carry become spaces. */
function nameFromHeading(text: string): string {
  return text
    .replace(/[*_~`]+/g, '')
    .replace(/[[\]#^|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The prefilled name: the nearest heading above the table, else the note's
 *  title followed by "table". */
export function defaultDatabaseTitle(
  state: EditorState,
  tableFrom: number,
  noteTitle: string
): string {
  const heading = headingAbove(state, tableFrom)
  const fromHeading = heading ? nameFromHeading(heading) : ''
  if (fromHeading) return fromHeading
  const base = nameFromHeading(noteTitle)
  return base ? `${base} table` : 'Table'
}

export function validateDatabaseTitle(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Enter a database name.'
  if (name.startsWith('.')) return 'Database names cannot start with a dot.'
  if (/[\u0000-\u001f]/.test(name)) return 'Enter a database name without control characters.'
  if (UNLINKABLE_RE.test(name)) return 'A database name cannot contain [ ] # ^ | / or \\, so its [[link]] can find it.'
  return null
}

export function tableToSeed(table: MarkdownTable): DatabaseSeed {
  return {
    headers: [...table.headers],
    rows: table.rows.map((row) => [...row]),
    ...(table.colWidths ? { columnWidths: [...table.colWidths] } : {})
  }
}

/** The note an editor shows, for placement and the post-write guard. */
function noteForEditor(view: EditorView): NoteMeta | null {
  const path = noteEditorPath(view)
  if (!path) return null
  const state = useStore.getState()
  if (state.activeNote?.path === path) return state.activeNote
  return state.notes.find((n) => n.path === path) ?? null
}

/**
 * Prompt for a name, create the database from the table at `anchor` (or under
 * the cursor), and swap the table for a link to it. Reports through toasts;
 * never throws to the caller.
 */
export async function convertTableToDatabase(view: EditorView, anchor?: number): Promise<void> {
  const toast = useToastStore.getState().addToast
  const note = noteForEditor(view)
  if (!note) {
    toast('Open a note to convert its table.', 'info')
    return
  }
  const found = anchor == null ? tableUnderCursor(view) : tableAt(view, anchor)
  if (!found) {
    toast('Put the cursor in a table to convert it.', 'info')
    return
  }
  const rowCount = found.table.rows.length
  const rowsLabel = rowCount === 1 ? '1 row' : `${rowCount} rows`
  const answer = await promptApp({
    title: 'Convert table to database',
    description: `Creates a database from the table's ${found.table.headers.length} columns and ${rowsLabel}, and replaces the table with a [[link]] to it.`,
    initialValue: defaultDatabaseTitle(view.state, found.from, note.title),
    placeholder: 'Database name',
    okLabel: 'Convert',
    validate: validateDatabaseTitle
  })
  const title = answer?.trim()
  if (!title || validateDatabaseTitle(title)) return

  const state = useStore.getState()
  const settings = normalizeVaultSettings(state.vaultSettings)
  const { folder, subpath } = resolveCreateLocation(settings.databasesLocation, note, settings)
  const doc = await state.createDatabase(folder, subpath, title, undefined, {
    seed: tableToSeed(found.table),
    open: false
  })
  if (!doc) return

  // The prompt and the write took time. Only touch the note if this editor
  // still shows it and the table is still exactly where it was; otherwise the
  // database exists and the table stays, which is recoverable, unlike a
  // replacement landing on the wrong text.
  const intact =
    view.dom.isConnected &&
    noteEditorPath(view) === note.path &&
    view.state.sliceDoc(found.from, found.to) === found.source
  const openDatabase = { label: 'Open', onClick: () => void useStore.getState().openDatabase(doc.path) }
  if (!intact) {
    toast(
      `Created database "${doc.title}", but the note changed meanwhile, so the table was left in place.`,
      'info',
      openDatabase
    )
    return
  }
  const link = `[[${doc.title}]]`
  view.dispatch({
    changes: { from: found.from, to: found.to, insert: link },
    selection: { anchor: found.from }
  })
  view.focus()
  toast(`Converted the table to database "${doc.title}"`, 'success', openDatabase)
}
