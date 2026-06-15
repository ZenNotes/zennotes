/**
 * `zen` note-management subcommands. Operations are filesystem-direct
 * via vault-ops.ts — same engine the MCP server uses, no network
 * round-trip, works whether the desktop app is open or closed.
 */

import {
  appendToNote,
  archiveNote,
  createNote,
  deleteNote,
  duplicateNote,
  listNotes,
  moveNote,
  moveToTrash,
  prependToNote,
  readNote,
  renameNote,
  restoreFromTrash,
  unarchiveNote,
  writeNote,
  type NoteFolder,
  type NoteMeta
} from '../../mcp/vault-ops.js'
import {
  getBool,
  getMany,
  getNumber,
  getString,
  resolveBody,
  type ParsedArgs
} from '../args.js'
import { emitJson, emitLine, emitOk, formatRelativeAge, pad, truncate } from '../format.js'

const VALID_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

function parseFolderFlag(value: string | undefined): NoteFolder | undefined {
  if (value == null) return undefined
  if (!VALID_FOLDERS.includes(value as NoteFolder)) {
    throw new Error(
      `--folder must be one of ${VALID_FOLDERS.join(', ')} (got "${value}")`
    )
  }
  return value as NoteFolder
}

export async function cmdList(vault: string, args: ParsedArgs): Promise<void> {
  const folder = parseFolderFlag(getString(args, 'folder'))
  const tag = getString(args, 'tag')?.toLowerCase()
  const limit = getNumber(args, 'limit') ?? 50
  let notes = await listNotes(vault)
  notes = folder
    ? notes.filter((n) => n.folder === folder)
    : notes.filter((n) => n.folder !== 'trash')
  if (tag) {
    notes = notes.filter((n) =>
      n.tags.map((t) => t.toLowerCase()).includes(tag.replace(/^#/, ''))
    )
  }
  notes.sort((a, b) => b.updatedAt - a.updatedAt)
  notes = notes.slice(0, limit)

  if (getBool(args, 'json')) {
    emitJson(notes)
    return
  }
  if (notes.length === 0) {
    emitLine('No notes found.')
    return
  }
  // Two-column terse layout: "<age>  <folder>  <path>".
  const widestFolder = notes.reduce((w, n) => Math.max(w, n.folder.length), 0)
  for (const n of notes) {
    emitLine(
      `${pad(formatRelativeAge(n.updatedAt), 10)}  ${pad(n.folder, widestFolder)}  ${n.path}`
    )
  }
}

export async function cmdRead(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const note = await readNote(vault, rel)
  if (getBool(args, 'json')) {
    emitJson(note)
    return
  }
  if (getBool(args, 'meta')) {
    const { body: _body, ...meta } = note
    emitJson(meta)
    return
  }
  process.stdout.write(note.body)
  if (!note.body.endsWith('\n')) process.stdout.write('\n')
}

export async function cmdCreate(vault: string, args: ParsedArgs): Promise<void> {
  const folder = parseFolderFlag(getString(args, 'folder')) ?? 'inbox'
  if (folder === 'trash') {
    throw new Error('Refusing to create a note directly in trash.')
  }
  const title = getString(args, 'title') ?? args.positionals[0]
  const subpath = getString(args, 'subpath') ?? ''
  const tags = getMany(args, 'tag').map((t) => t.replace(/^#/, ''))
  const inputBody = await resolveBody(args)
  const composed = composeBody(title, inputBody, tags)
  const meta = await createNote(vault, folder, title, subpath, composed)
  emitCreated(meta, args)
}

function composeBody(
  title: string | undefined,
  body: string | undefined,
  tags: string[]
): string | undefined {
  if (body == null && tags.length === 0) return undefined
  const heading = title ? `# ${title}\n\n` : ''
  const tagLine = tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') + '\n\n' : ''
  const bodyText = body ?? ''
  const out = `${heading}${tagLine}${bodyText}`
  return out.endsWith('\n') ? out : out + '\n'
}

export async function cmdWrite(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const body = await resolveBody(args)
  if (body == null) {
    throw new Error('zen write requires --body, a positional body, or piped stdin.')
  }
  const meta = await writeNote(vault, rel, body)
  emitWritten(meta, args)
}

export async function cmdAppend(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const body = await resolveBody(args)
  if (body == null || body.trim() === '') {
    throw new Error('zen append requires --body, a positional body, or piped stdin.')
  }
  const meta = await appendToNote(vault, rel, body)
  emitWritten(meta, args)
}

export async function cmdPrepend(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const body = await resolveBody(args)
  if (body == null || body.trim() === '') {
    throw new Error('zen prepend requires --body, a positional body, or piped stdin.')
  }
  const meta = await prependToNote(vault, rel, body)
  emitWritten(meta, args)
}

export async function cmdRename(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const to = getString(args, 'to')
  if (!to) throw new Error('zen rename requires --to <new title>.')
  const meta = await renameNote(vault, rel, to)
  emitWritten(meta, args, 'Renamed')
}

export async function cmdMove(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  const folder = parseFolderFlag(getString(args, 'folder'))
  if (!folder) throw new Error('zen move requires --folder <inbox|quick|archive|trash>.')
  const sub = getString(args, 'subpath') ?? ''
  const meta = await moveNote(vault, rel, folder, sub)
  emitWritten(meta, args, 'Moved')
}

export async function cmdArchive(vault: string, args: ParsedArgs): Promise<void> {
  const handle = await archiveNote(vault, requirePath(args))
  emitHandled(handle, args, 'Archived')
}

export async function cmdUnarchive(vault: string, args: ParsedArgs): Promise<void> {
  const meta = await unarchiveNote(vault, requirePath(args))
  emitWritten(meta, args, 'Unarchived')
}

export async function cmdTrash(vault: string, args: ParsedArgs): Promise<void> {
  const handle = await moveToTrash(vault, requirePath(args))
  emitHandled(handle, args, 'Moved to trash')
}

export async function cmdRestore(vault: string, args: ParsedArgs): Promise<void> {
  const meta = await restoreFromTrash(vault, requirePath(args))
  emitWritten(meta, args, 'Restored')
}

export async function cmdDelete(vault: string, args: ParsedArgs): Promise<void> {
  const rel = requirePath(args)
  if (!getBool(args, 'yes')) {
    throw new Error(
      'zen delete is permanent. Re-run with --yes to confirm, or use `zen trash` for the reversible alternative.'
    )
  }
  await deleteNote(vault, rel)
  if (getBool(args, 'json')) {
    emitJson({ ok: true, path: rel })
    return
  }
  emitOk(`Deleted ${rel}`)
}

export async function cmdDuplicate(vault: string, args: ParsedArgs): Promise<void> {
  const meta = await duplicateNote(vault, requirePath(args))
  emitWritten(meta, args, 'Duplicated')
}

/* ---------- helpers -------------------------------------------------- */

function requirePath(args: ParsedArgs): string {
  const fromFlag = getString(args, 'path')
  const fromPositional = args.positionals[0]
  const value = fromFlag ?? fromPositional
  if (!value) throw new Error('A note path is required.')
  return value
}

function emitCreated(meta: NoteMeta, args: ParsedArgs): void {
  if (getBool(args, 'json')) {
    emitJson(meta)
    return
  }
  emitOk(`Created ${meta.path}`)
  if (meta.excerpt) emitLine(`  ${truncate(meta.excerpt, 80)}`)
}

function emitWritten(meta: NoteMeta, args: ParsedArgs, verb = 'Updated'): void {
  if (getBool(args, 'json')) {
    emitJson(meta)
    return
  }
  emitOk(`${verb} ${meta.path}`)
}

function emitHandled(handle: string, args: ParsedArgs, verb: string): void {
  if (getBool(args, 'json')) {
    emitJson({ ok: true, handle })
    return
  }
  emitOk(`${verb} ${handle}`)
}
