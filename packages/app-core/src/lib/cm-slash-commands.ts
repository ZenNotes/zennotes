import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'

interface SlashCmd {
  label: string
  detail: string
  icon: string
  insert: string
  /** Cursor offset from end of inserted text. Negative = move back. */
  cursorOffset?: number
}

type DecoratedCompletion = Completion & {
  _kind?: 'slash' | 'wikilink' | 'date'
  _icon?: string
  _subtitle?: string
}

const COMMANDS: SlashCmd[] = [
  { label: 'Heading 1', detail: '#', icon: 'H1', insert: '# ' },
  { label: 'Heading 2', detail: '##', icon: 'H2', insert: '## ' },
  { label: 'Heading 3', detail: '###', icon: 'H3', insert: '### ' },
  { label: 'Heading 4', detail: '####', icon: 'H4', insert: '#### ' },
  { label: 'Bulleted list', detail: '-', icon: '•', insert: '- ' },
  { label: 'Numbered list', detail: '1.', icon: '1.', insert: '1. ' },
  { label: 'To-do list', detail: '[ ]', icon: '☐', insert: '- [ ] ' },
  { label: 'Quote', detail: '>', icon: '❝', insert: '> ' },
  { label: 'Code block', detail: '```', icon: '</>', insert: '```\n\n```', cursorOffset: -4 },
  { label: 'Divider', detail: '---', icon: '—', insert: '---\n' },
  { label: 'Table', detail: '|', icon: '⊞', insert: '| Column 1 | Column 2 |\n| --- | --- |\n| | |' },
  { label: 'Math block', detail: '$$', icon: '∑', insert: '$$\n\n$$', cursorOffset: -3 },
  { label: 'Callout', detail: '>', icon: '!', insert: '> [!note]\n> ' },
  { label: 'Link', detail: '[]', icon: '🔗', insert: '[]()', cursorOffset: -3 },
  { label: 'Image', detail: '![]', icon: '🖼', insert: '![]()', cursorOffset: -3 },
  { label: 'Page', detail: 'new note', icon: '📄', insert: '__PAGE__' },
]

/** Render a custom completion item matching the app theme. */
function renderCompletion(completion: Completion): HTMLElement {
  const decorated = completion as DecoratedCompletion
  if (decorated._kind === 'wikilink') {
    const el = document.createElement('div')
    el.className = 'wikilink-cmd-item'

    const main = document.createElement('div')
    main.className = 'wikilink-cmd-main'

    const label = document.createElement('span')
    label.className = 'wikilink-cmd-label'
    label.textContent = completion.label

    const subtitle = document.createElement('span')
    subtitle.className = 'wikilink-cmd-subtitle'
    subtitle.textContent = decorated._subtitle ?? completion.detail ?? ''

    main.appendChild(label)
    main.appendChild(subtitle)
    el.appendChild(main)
    return el
  }

  const el = document.createElement('div')
  el.className = 'slash-cmd-item'

  const icon = document.createElement('span')
  icon.className = 'slash-cmd-icon'
  icon.textContent = decorated._icon ?? ''

  const label = document.createElement('span')
  label.className = 'slash-cmd-label'
  label.textContent = completion.label

  const detail = document.createElement('span')
  detail.className = 'slash-cmd-detail'
  detail.textContent = completion.detail ?? ''

  el.appendChild(icon)
  el.appendChild(label)
  el.appendChild(detail)
  return el
}

/**
 * CodeMirror completion source for Notion-style slash commands.
 * Activates when `/` is typed at the start of a line or after whitespace.
 */
export function slashCommandSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const textBefore = state.doc.sliceString(line.from, pos)

  // Match / at start of line or after whitespace, plus optional filter text
  const match = textBefore.match(/(?:^|\s)(\/[^\s]*)$/)
  if (!match) return null

  const slashStart = pos - match[1].length // position of /
  const filterFrom = slashStart + 1 // position after / (for filtering)

  return {
    from: filterFrom,
    options: COMMANDS.map(
      (cmd): Completion => ({
        label: cmd.label,
        detail: cmd.detail,
        _kind: 'slash',
        // Store icon for the custom renderer
        _icon: cmd.icon,
        type: 'slash',
        apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
          // Special: "Page" creates a new note in the same directory
          if (cmd.insert === '__PAGE__') {
            view.dispatch({ changes: { from: slashStart, to, insert: '' } })
            const state = useStore.getState()
            const active = state.activeNote
            if (active) {
              const parts = active.path.split('/')
              const folder = parts[0] as 'inbox' | 'archive'
              const subpath = parts.slice(1, -1).join('/')
              void state.createAndOpen(folder, subpath, { focusTitle: true })
            } else {
              void state.createAndOpen('inbox', '', { focusTitle: true })
            }
            return
          }
          const insert = cmd.insert
          const cursorPos =
            cmd.cursorOffset != null
              ? slashStart + insert.length + cmd.cursorOffset
              : slashStart + insert.length
          view.dispatch({
            changes: { from: slashStart, to, insert },
            selection: { anchor: cursorPos }
          })
        }
      } as Completion & { _icon: string })
    ),
    filter: true
  }
}

/** Custom rendering for the slash command completion items. */
export const slashCommandRender = {
  render: renderCompletion
}
