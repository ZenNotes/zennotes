import { confirmApp } from './confirm-requests'
import { promptApp } from './prompt-requests'
import { dateNoteForTitle, type DateNoteInfo } from './vault-layout'
import { parseCreateNotePath, stripWikilinkAnchor, suggestCreateNotePath } from './wikilinks'
import { useStore } from '../store'

const DATE_NOTE_LABEL: Record<DateNoteInfo['kind'], string> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly'
}

/**
 * The periodic note a dead link names: a bare `[[2026-11-03]]` while daily
 * notes are on, `[[2026-W45]]` for weekly notes, and so on. It is created the
 * way the calendar creates it, in the folder its pattern gives and from its
 * template; made as a plain note from the link text it landed in the Inbox
 * root, where the calendar never counted it as that day's note and creating
 * the day there later made a second note of the same name. A link that names
 * a folder (`journal/2026-11-03`) says where the note goes, so it keeps the
 * plain path.
 */
function dateNoteForLink(target: string): { info: DateNoteInfo; title: string } | null {
  const title = stripWikilinkAnchor(target).trim().replace(/\.md$/i, '')
  if (!title || title.includes('/') || title.includes('\\')) return null
  const info = dateNoteForTitle(title, useStore.getState().vaultSettings)
  return info ? { info, title } : null
}

async function openDateNote(info: DateNoteInfo): Promise<void> {
  const state = useStore.getState()
  if (info.kind === 'daily') await state.openDailyNoteForDate(info.date)
  else if (info.kind === 'weekly') await state.openWeeklyNoteForDate(info.date)
  else await state.openMonthlyNoteForDate(info.date)
}

/**
 * Offer to create a note for a dead link `target`, confirming first. Shared by
 * the cmd/ctrl-click and `gd` follow-link paths so a link to a not-yet-existing
 * note is never a silent dead end: the user is asked whether to create it (and
 * where), and only then is the note made and opened. If the resolved path turns
 * out to already exist, that note is opened instead.
 */
export async function offerCreateNoteFromLink(target: string): Promise<void> {
  const dateNote = dateNoteForLink(target)
  if (dateNote) {
    const kind = DATE_NOTE_LABEL[dateNote.info.kind]
    const ok = await confirmApp({
      title: `New ${kind} note`,
      description: `${dateNote.title} does not exist yet. Create it as your ${kind} note?`,
      confirmLabel: 'Create',
      cancelLabel: 'Never mind'
    })
    if (ok) await openDateNote(dateNote.info)
    return
  }
  const value = await promptApp({
    title: `Create note for "${target}"?`,
    description:
      'No matching note exists. Use /my/path/note.md for Inbox-relative paths, or inbox/my/path/note.md for an explicit top folder.',
    initialValue: suggestCreateNotePath(target),
    placeholder: '/my/path/note.md',
    okLabel: 'Create',
    validate: (input) => {
      try {
        parseCreateNotePath(input)
        return null
      } catch (err) {
        return (err as Error).message
      }
    }
  })
  if (!value) return
  await createNoteAtPath(value)
}

/**
 * Create the note a dead link `target` points to without asking, at the path
 * the prompt would have suggested: the link text as the file name, in Inbox
 * unless the link names a top folder. The fast path behind a Cmd/Ctrl-click on
 * an unresolved wikilink and the `gD` motion (#768): when the note belongs
 * where the link already says, the confirmation only costs a keystroke. A
 * note that already exists at that path is opened instead, and a link that
 * names a periodic note creates that note where its pattern puts it.
 */
export async function createNoteFromLinkNow(target: string): Promise<void> {
  const dateNote = dateNoteForLink(target)
  if (dateNote) {
    await openDateNote(dateNote.info)
    return
  }
  await createNoteAtPath(suggestCreateNotePath(target))
}

/**
 * Create the note a dead link names without opening it, so the link popover
 * can be the place it is written, over the note that links to it. Same
 * destination as `createNoteFromLinkNow`: named after the link, in Inbox
 * unless the link names a top folder, and a link named like a daily note
 * makes that day's daily note (template included).
 *
 * Resolves to the note's path: the new note, or one already at that path.
 * Null when only opening can make the note (a weekly or monthly note, which
 * the calendar creates as it opens it) or when creating failed; the caller
 * falls back to `createNoteFromLinkNow`.
 */
export async function createNoteForLinkInPlace(target: string): Promise<string | null> {
  const dateNote = dateNoteForLink(target)
  if (dateNote) {
    if (dateNote.info.kind !== 'daily') return null
    const daily = await useStore.getState().ensureDailyNoteForDate(dateNote.info.date)
    return daily?.path ?? null
  }
  let parsed: ReturnType<typeof parseCreateNotePath>
  try {
    parsed = parseCreateNotePath(suggestCreateNotePath(target))
  } catch {
    return null
  }
  const state = useStore.getState()
  const existing = state.notes.find(
    (note) => note.folder !== 'trash' && note.path.toLowerCase() === parsed.relPath.toLowerCase()
  )
  if (existing) return existing.path
  const created = await state.createNoteInPlace(parsed.folder, parsed.subpath, parsed.title)
  return created?.path ?? null
}

async function createNoteAtPath(value: string): Promise<void> {
  const focusEditorSoon = (): void => {
    useStore.getState().setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }

  try {
    const parsed = parseCreateNotePath(value)
    const state = useStore.getState()
    const existing = state.notes.find(
      (note) => note.folder !== 'trash' && note.path.toLowerCase() === parsed.relPath.toLowerCase()
    )
    if (existing) {
      await state.selectNote(existing.path)
      focusEditorSoon()
      return
    }
    await state.createAndOpen(parsed.folder, parsed.subpath, { title: parsed.title })
    focusEditorSoon()
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err))
  }
}
