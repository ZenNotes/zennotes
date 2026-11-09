// What a clip link (`zennotes://new`, `zennotes://daily`; see
// docs/web-clipper-link.md) writes, decided the same way wherever it is
// written: in the window that shows the vault (lib/clip-apply.ts, where open
// notes and their unsaved edits live) or by desktop main when no window shows
// it (apps/desktop/src/main/clip-links.ts). Store-free, so main imports it
// the way the MCP imports vault-layout.

import type { NoteMeta, VaultSettings } from '@shared/ipc'
import { FRONTMATTER_BLOCK_RE } from '@shared/frontmatter'
import { appendToBody, prependToBody } from '@shared/note-body-insert'
import { sanitizeNoteFileTitle } from '@shared/note-file-title'
import { deriveTitleFromBody, timestampTitle } from '@shared/quick-note-title'
import { vaultRelativeFolderPath } from './vault-layout'

/** The title a created note takes: the link's name, else the text's first
 *  line (below any frontmatter, which a clipped page always starts with),
 *  as Quick Capture names notes. Undefined for a blank note, which the app
 *  names the way it names any new note. */
export function clipNoteTitle(name: string | null, text: string | null, now = new Date()): string | undefined {
  if (name !== null) return name
  if (text === null) return undefined
  return deriveTitleFromBody(text.replace(FRONTMATTER_BLOCK_RE, '')) || timestampTitle(now)
}

/** The vault-relative path of the note a link names: `folder/name` inside the
 *  notes area (the vault's top level in an Obsidian-style vault, the Inbox
 *  otherwise), with the name made a filename exactly as note creation does. */
export function clipNotePath(settings: VaultSettings | null | undefined, folder: string, name: string): string {
  const dir = vaultRelativeFolderPath('inbox', folder, settings)
  const file = `${sanitizeNoteFileTitle(name)}.md`
  return dir ? `${dir}/${file}` : file
}

/** The note a link appends to, from the vault's note list: the exact path,
 *  else the one note that matches it ignoring case (macOS and Windows find
 *  `clippings/log.md` at `Clippings/Log.md`, so creating it would make
 *  `Log 2`). */
export function findClipNote(notes: readonly NoteMeta[], path: string): NoteMeta | null {
  const exact = notes.find((note) => note.path === path)
  if (exact) return exact
  const lower = path.toLowerCase()
  const loose = notes.filter((note) => note.path.toLowerCase() === lower)
  return loose.length === 1 ? loose[0] : null
}

/** A clip added to a note. Appending first folds the note's trailing blank
 *  lines into one, so a note just made (`# Title` and a blank line) takes the
 *  clip one blank line below its heading; `zn append` keeps its own bytes. */
export function insertClipText(body: string, text: string, position: 'append' | 'prepend'): string {
  if (position === 'prepend') return prependToBody(body, text)
  return appendToBody(body.replace(/(?:\r?\n)+$/u, '\n'), text)
}

/** One sentence for each way a clip can fail, the same from either writer. */
export const CLIP_MESSAGES = {
  dailyOff: 'Daily notes are off for this vault. Turn them on in Settings, then clip again.',
  locked: 'That note is locked for editing, so the clip was not added.',
  failed: 'The clip could not be saved.',
  wrongVault: 'The vault changed before the clip arrived. Clip it again.'
} as const

/** Where a success toast says the clip went. */
export function clipLandedMessage(path: string): string {
  return `Clipped to ${path.replace(/\.md$/i, '')}`
}
