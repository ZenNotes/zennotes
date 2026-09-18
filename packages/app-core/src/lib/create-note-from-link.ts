import { promptApp } from './prompt-requests'
import { parseCreateNotePath, suggestCreateNotePath } from './wikilinks'
import { useStore } from '../store'

/**
 * Offer to create a note for a dead link `target`, confirming first. Shared by
 * the cmd/ctrl-click and `gd` follow-link paths so a link to a not-yet-existing
 * note is never a silent dead end: the user is asked whether to create it (and
 * where), and only then is the note made and opened. If the resolved path turns
 * out to already exist, that note is opened instead.
 */
export async function offerCreateNoteFromLink(target: string): Promise<void> {
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
 * note that already exists at that path is opened instead.
 */
export async function createNoteFromLinkNow(target: string): Promise<void> {
  await createNoteAtPath(suggestCreateNotePath(target))
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
