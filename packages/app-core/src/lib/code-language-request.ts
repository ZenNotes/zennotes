/**
 * How the code block label, the "Set Code Block Language…" command and
 * `Space l l` ask the active EditorPane for the code block language picker
 * (#1014). Its own module, with nothing heavy behind it: the command list is
 * on the boot path, and the picker's language list (language-data) is not.
 */
import type { EditorView } from '@codemirror/view'

export const ZEN_OPEN_CODE_LANGUAGE_PICKER_EVENT = 'zen:open-code-language-picker'

export interface CodeLanguagePickerRequest {
  /** The editor whose block it is. Omitted: the active editor's caret. */
  view?: EditorView
  /** Where the block's opening fence starts. */
  fenceFrom?: number
  /** The label that was clicked, to open the picker under it. */
  anchor?: DOMRect
}

/** Open the code block language picker: for a block's label, or, with no
 *  detail, at the caret of the active editor. */
export function requestCodeLanguagePicker(detail?: CodeLanguagePickerRequest): void {
  window.dispatchEvent(new CustomEvent(ZEN_OPEN_CODE_LANGUAGE_PICKER_EVENT, { detail }))
}
