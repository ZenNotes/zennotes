import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { markdownSnippetExtension } from './cm-markdown-snippets'
import { isEditorInsertMode } from './vim-nav'
import { useStore } from '../store'

/**
 * Markdown snippet auto-close, wired to app state. Single source of truth for
 * *when* snippets fire, shared by every editor surface:
 *  - respects the `markdownSnippets` pref (Settings → Writing), and
 *  - only fires while actually typing — Vim off, or Vim *insert* mode — never
 *    in Vim normal/visual mode, where Space/Enter belong to Vim. (songgenqing)
 */
export function appMarkdownSnippetExtension(): Extension {
  return markdownSnippetExtension({
    shouldHandle: (view: EditorView) => {
      const s = useStore.getState()
      if (!s.markdownSnippets) return false
      return !s.vimMode || isEditorInsertMode(view, s.vimMode)
    }
  })
}
