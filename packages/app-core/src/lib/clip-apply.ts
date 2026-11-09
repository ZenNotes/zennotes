/**
 * Writes a clip (a `zennotes://new` or `zennotes://daily` link; see
 * docs/web-clipper-link.md) into the vault this window shows. Desktop main
 * has validated the link and the clipboard and picked this window because its
 * vault is the one the link names. It is written here, not in main, because
 * an open note's unsaved edits live in this window: adding to a note goes
 * through its buffer (`editOpenNote`), so typing in today's daily note while
 * a clip lands into it loses nothing and stays undoable.
 *
 * Paths, titles and insertion are clip-plan's, shared with main's writer.
 */
import type { ClipApplyRequest } from '@zennotes/bridge-contract/clip'
import { useStore } from '../store'
import { normalizeVaultSettings } from './vault-layout'
import { isNoteEditingLocked } from './note-lifecycle-lock'
import { editOpenNote } from './open-note-edit'
import { useToastStore } from './toast'
import {
  CLIP_MESSAGES,
  clipLandedMessage,
  clipNotePath,
  clipNoteTitle,
  findClipNote,
  insertClipText
} from './clip-plan'

type Outcome = { ok: true; path: string } | { ok: false; message: string }

function samePath(a: string, b: string): boolean {
  const clean = (value: string): string => value.replace(/[\\/]+$/u, '')
  return clean(a) === clean(b)
}

async function insertInto(path: string, text: string, position: 'append' | 'prepend'): Promise<Outcome> {
  const state = useStore.getState()
  if (isNoteEditingLocked(state.vault, path)) return { ok: false, message: CLIP_MESSAGES.locked }
  if (state.noteContents[path]) {
    const changed = await editOpenNote(path, (body) => insertClipText(body, text, position), 'input.clip')
    return changed ? { ok: true, path } : { ok: false, message: CLIP_MESSAGES.failed }
  }
  const current = await window.zen.readNote(path)
  await window.zen.writeNote(path, insertClipText(current.body, text, position))
  return { ok: true, path }
}

async function createClipNote(request: ClipApplyRequest, now: Date): Promise<Outcome> {
  const title = clipNoteTitle(request.name, request.text, now)
  const meta = await useStore.getState().createNoteInPlace('inbox', request.folder, title ?? 'Untitled')
  if (!meta) return { ok: false, message: CLIP_MESSAGES.failed }
  if (request.text !== null) await window.zen.writeNote(meta.path, request.text)
  return { ok: true, path: meta.path }
}

async function writeClip(request: ClipApplyRequest, now: Date): Promise<Outcome> {
  const state = useStore.getState()
  const settings = normalizeVaultSettings(state.vaultSettings)

  if (request.action === 'daily') {
    if (!settings.dailyNotes.enabled) return { ok: false, message: CLIP_MESSAGES.dailyOff }
    const note = await state.ensureDailyNoteForDate(now)
    if (!note) return { ok: false, message: CLIP_MESSAGES.failed }
    if (request.text === null) return { ok: true, path: note.path }
    return insertInto(note.path, request.text, request.position === 'prepend' ? 'prepend' : 'append')
  }

  if (request.position !== 'create' && request.name !== null && request.text !== null) {
    const existing = findClipNote(state.notes, clipNotePath(settings, request.folder, request.name))
    if (existing) return insertInto(existing.path, request.text, request.position)
  }
  return createClipNote(request, now)
}

let clipChain: Promise<void> = Promise.resolve()

/** Apply clips one at a time, in the order they arrived: two clips into the
 *  same daily note must not both read it before either writes. */
export function enqueueClip(request: ClipApplyRequest): void {
  clipChain = clipChain.then(() => applyClip(request)).catch((err) => console.error('clip failed', err))
}

/** Apply one clip and tell the user where it went (or why it did not). */
export async function applyClip(request: ClipApplyRequest): Promise<void> {
  const toast = useToastStore.getState()
  const state = useStore.getState()
  if (!state.vault || (request.vaultRoot !== null && !samePath(state.vault.root, request.vaultRoot))) {
    toast.addToast(CLIP_MESSAGES.wrongVault, 'error')
    return
  }

  // A bare `zennotes://new` is the New Note command, the way the phone
  // widgets have always fired it.
  if (request.action === 'new' && request.name === null && request.text === null) {
    await state.createAndOpen('inbox', request.folder)
    return
  }

  let outcome: Outcome
  try {
    outcome = await writeClip(request, new Date())
  } catch (err) {
    console.error('clip failed', err)
    outcome = { ok: false, message: CLIP_MESSAGES.failed }
  }
  if (!outcome.ok) {
    toast.addToast(outcome.message, 'error')
    return
  }
  const path = outcome.path
  // A link that only opens or makes a note clipped nothing: no toast.
  if (request.text === null) {
    if (!request.silent) await useStore.getState().openNoteInTab(path)
    return
  }
  if (request.silent) {
    toast.addToast(clipLandedMessage(path), 'success', {
      label: 'Open',
      onClick: () => void useStore.getState().openNoteInTab(path)
    }, 6000)
    return
  }
  await useStore.getState().openNoteInTab(path)
  toast.addToast(clipLandedMessage(path), 'success')
}
