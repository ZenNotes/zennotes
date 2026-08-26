import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { autoPairExtension, isInMarkdownCode } from './cm-auto-pairs'
import { markdownSnippetExtension } from './cm-markdown-snippets'
import { textReplacementExtension } from './cm-text-replacements'
import { formatMarkerBackspaceTransaction } from './cm-format'
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
  const isTyping = (view: EditorView): boolean => {
    const s = useStore.getState()
    return !s.vimMode || isEditorInsertMode(view, s.vimMode)
  }

  return [
    textReplacementExtension({
      replacements: () => useStore.getState().textReplacements,
      shouldHandle: (view) => {
        const s = useStore.getState()
        return s.textReplacementsEnabled && isTyping(view)
      }
    }),
    // Backspace inside a just-inserted empty formatting snippet (`**|**`, `` `|` ``)
    // deletes the whole pair, not one marker char (#468). Always on while typing —
    // it's a formatting-shortcut fix, independent of the auto-pairs pref. It sits
    // ahead of the auto-pair keymap on purpose: inside an empty `[](|)` link the
    // pair rule would fire first and delete only the `()` (#678).
    keymap.of([
      {
        key: 'Backspace',
        run: (view: EditorView): boolean => {
          if (!isTyping(view)) return false
          const tr = formatMarkerBackspaceTransaction(view.state)
          if (!tr) return false
          view.dispatch(tr)
          return true
        }
      }
    ]),
    autoPairExtension({
      shouldHandle: (view) => useStore.getState().autoPairs && isTyping(view),
      shouldPairQuotes: (view, from) => {
        const s = useStore.getState()
        return s.autoPairQuotesInProse || isInMarkdownCode(view.state, from)
      }
    }),
    markdownSnippetExtension({
      shouldHandle: (view) => {
        const s = useStore.getState()
        return s.markdownSnippets && isTyping(view)
      }
    })
  ]
}
