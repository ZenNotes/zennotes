/**
 * Hide a note's leading YAML frontmatter (`---` … `---`) in WYSIWYG edit mode.
 *
 * The frontmatter is surfaced — and edited — in the right-hand Properties panel
 * (PropertiesPanel.tsx), so the raw YAML must not also show inline at the top of
 * the note. This collapses the whole frontmatter region with a zero-height block
 * widget and makes it atomic so the caret skips over it.
 *
 * This is the slimmed successor to the old in-editor properties widget: it keeps
 * only the "own the frontmatter region" responsibility (so other WYSIWYG plugins
 * still defer to it) and drops all the interaction, which now lives in React.
 */
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { StateField, type EditorState } from '@codemirror/state'
import { frontmatterEndLine } from './cm-properties'

/** A 0×0 placeholder so the replaced lines render as nothing. */
class HiddenFrontmatterWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-frontmatter-hidden'
    el.setAttribute('aria-hidden', 'true')
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const endLine = frontmatterEndLine(state)
  if (endLine === -1) return Decoration.none
  const from = state.doc.line(1).from
  const to = state.doc.line(endLine).to
  return Decoration.set([
    Decoration.replace({ widget: new HiddenFrontmatterWidget(), block: true }).range(from, to)
  ])
}

// Block decorations must come from a StateField (CodeMirror decides block layout
// before the viewport is known, so view plugins can't provide them).
export const frontmatterHidePlugin = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => (tr.docChanged ? buildDecorations(tr.state) : value),
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field, false) ?? Decoration.none)
  ]
})
