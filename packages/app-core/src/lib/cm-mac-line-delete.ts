import { deleteToLineStart } from '@codemirror/commands'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { isMacPlatform } from './keymaps'

export function macLineStartDeleteExtension(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (
          !isMacPlatform() ||
          !event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          (event.key !== 'Backspace' && event.code !== 'Backspace')
        ) {
          return false
        }

        const handled = deleteToLineStart(view)
        if (!handled) return false
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }
    })
  )
}
