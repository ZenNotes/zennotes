import type { EditorView } from '@codemirror/view'
import type { NoteMeta } from '@shared/ipc'
import { parseTasksFromBody, type VaultTask } from '@shared/tasks'
import type { PromptOptions } from '../components/PromptModal'
import { promptApp } from './prompt-requests'
import { useStore } from '../store'

/** The note fields the destination picker needs. */
type ForwardCandidate = Pick<NoteMeta, 'path' | 'title' | 'folder'>

export interface ForwardTaskPrompt {
  options: PromptOptions
  /** Map the picker's answer (a suggestion value, or a typed title/path) to a note path. */
  resolveTargetPath: (chosen: string) => string | undefined
}

/**
 * The destination picker for a forwarded task, or null when the vault holds no
 * other note to forward to.
 *
 * Split out from the prompt call so the keyboard behaviour is testable. The
 * picker preselects the first match as you type (#600), matching the folder
 * pickers (#467). It matters more here than there: this prompt only accepts an
 * existing note, so without a preselection, typing a filter and pressing Enter
 * submitted the raw text and failed validation instead of forwarding.
 */
export function buildForwardTaskPrompt(
  task: VaultTask,
  notes: ForwardCandidate[]
): ForwardTaskPrompt | null {
  const candidates = notes.filter(
    (n) => n.folder !== 'trash' && n.path !== task.sourcePath && n.path.endsWith('.md')
  )
  if (candidates.length === 0) return null

  // A path always wins over a title, so same-titled notes in different folders
  // stay reachable by typing their full path.
  const byKey = new Map<string, string>()
  const suggestions = candidates.map((n) => {
    byKey.set(n.path, n.path)
    if (!byKey.has(n.title)) byKey.set(n.title, n.path)
    return { value: n.path, label: n.title, detail: n.path }
  })

  return {
    options: {
      title: `Forward "${task.content || 'task'}" to…`,
      description: 'The original stays as a forwarded record; a copy is added to the note you pick.',
      placeholder: 'Note title or path',
      okLabel: 'Forward',
      suggestions,
      autoHighlightFirst: true,
      suggestionsHint: '↑↓ or ⌃J/⌃K pick a note · Enter to forward',
      validate: (input) => (byKey.has(input.trim()) ? null : 'Pick an existing note')
    },
    resolveTargetPath: (chosen) => byKey.get(chosen.trim())
  }
}

/**
 * Task forwarding (#316). `forwardTaskWithPicker` prompts for a destination note
 * and moves the task there: the original stays as a `- [>]` record linking to
 * the target, and a fresh `- [ ]` copy (backlinked to the source) is appended to
 * the target note.
 */
export async function forwardTaskWithPicker(task: VaultTask): Promise<void> {
  const prompt = buildForwardTaskPrompt(task, useStore.getState().notes)
  if (!prompt) {
    window.alert('There are no other notes to forward this task to.')
    return
  }

  const chosen = await promptApp(prompt.options)
  if (!chosen) return
  const targetPath = prompt.resolveTargetPath(chosen)
  if (targetPath) await useStore.getState().forwardTask(task, targetPath)
}

/** The task on the editor's current cursor line, or null. Parses the live buffer
 *  so the `taskIndex` matches what `forwardTask` rewrites. */
export function taskAtEditorCursor(view: EditorView): VaultTask | null {
  const active = useStore.getState().activeNote
  if (!active) return null
  const lineNumber = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const tasks = parseTasksFromBody(view.state.doc.toString(), {
    path: active.path,
    title: active.title,
    folder: active.folder
  })
  return tasks.find((t) => t.lineNumber === lineNumber) ?? null
}
