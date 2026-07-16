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
  /** Ranking nudge for the unfiltered list — higher floats to the top. */
  boost?: number
  /** Extra space-separated terms that should also match this command (e.g.
   *  `/todo` finding "Task"). Folded into the match label, hidden from display. */
  keywords?: string
}

type DecoratedCompletion = Completion & {
  _kind?: 'slash' | 'wikilink' | 'date' | 'callout'
  _icon?: string
  _subtitle?: string
  _group?: string
}

const COMMANDS: SlashCmd[] = [
  { label: 'Heading 1', detail: '#', icon: 'H1', insert: '# ' },
  { label: 'Heading 2', detail: '##', icon: 'H2', insert: '## ' },
  { label: 'Heading 3', detail: '###', icon: 'H3', insert: '### ' },
  { label: 'Heading 4', detail: '####', icon: 'H4', insert: '#### ' },
  {
    label: 'Task',
    detail: '[ ]',
    icon: '☐',
    insert: '- [ ] ',
    boost: 99,
    keywords: 'todo to-do checkbox check task list'
  },
  { label: 'Bulleted list', detail: '-', icon: '•', insert: '- ' },
  { label: 'Numbered list', detail: '1.', icon: '1.', insert: '1. ' },
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
  if (decorated._kind === 'callout') {
    const el = document.createElement('div')
    el.className = 'callout-cmd-item'

    const icon = document.createElement('span')
    icon.className = `callout-cmd-icon callout-cmd-${decorated._group ?? 'note'}`
    icon.textContent = decorated._icon ?? ''

    const main = document.createElement('div')
    main.className = 'callout-cmd-main'

    const label = document.createElement('span')
    label.className = 'callout-cmd-label'
    label.textContent = completion.displayLabel ?? completion.label

    const desc = document.createElement('span')
    desc.className = 'callout-cmd-desc'
    desc.textContent = decorated._subtitle ?? ''

    main.appendChild(label)
    main.appendChild(desc)
    el.appendChild(icon)
    el.appendChild(main)
    return el
  }
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
  label.textContent = completion.displayLabel ?? completion.label

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
/**
 * Blank-line padding to drop a block element (a GFM table) into its own
 * paragraph at an insertion point, given the text immediately before and after.
 * Without a blank line on each side the table is absorbed into adjacent prose,
 * so strict parsers (PDF export, `:format`) render it scrambled. (#294)
 */
export function blockInsertPadding(
  before: string,
  after: string
): { lead: string; trail: string } {
  let lead = ''
  if (before.length > 0 && !before.endsWith('\n\n')) {
    lead = before.endsWith('\n') ? '\n' : '\n\n'
  }
  const trail =
    after.length === 0 || after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n'
  return { lead, trail }
}

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
        // Fold alias keywords into the matched label so `/todo`, `/checkbox`,
        // etc. surface the command; `displayLabel` keeps the menu text clean.
        label: cmd.keywords ? `${cmd.label} ${cmd.keywords}` : cmd.label,
        displayLabel: cmd.label,
        detail: cmd.detail,
        boost: cmd.boost,
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
          let insert = cmd.insert
          let leadPad = ''
          let tableCaretAfter = false
          if (cmd.label === 'Table') {
            // A GFM table must be separated from surrounding text by blank lines,
            // or strict parsers (PDF export, `:format`) read it as paragraph
            // text and it renders scrambled. Pad it into its own block. (#294)
            const after = view.state.doc.sliceString(to)
            const pad = blockInsertPadding(view.state.doc.sliceString(0, slashStart), after)
            leadPad = pad.lead
            // The table renders as a block widget; a caret left inside its
            // replaced range smears into a tall bar at the pane's edge. Land the
            // caret on the line AFTER the table instead, adding one at the end of
            // the document where blockInsertPadding leaves no trailing line. (#340)
            const trail = after.length === 0 ? pad.trail || '\n' : pad.trail
            insert = pad.lead + cmd.insert + trail
            tableCaretAfter = true
          }
          const cursorPos =
            cmd.cursorOffset != null
              ? slashStart + insert.length + cmd.cursorOffset
              : tableCaretAfter
                ? slashStart + leadPad.length + cmd.insert.length + 1
                : slashStart + leadPad.length + cmd.insert.length
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

/**
 * Slash commands that don't make sense outside a real note. "Page" creates and
 * opens a new note via the store, which would navigate away from (and is
 * meaningless inside) the template editor.
 */
const NON_TEMPLATE_COMMANDS = new Set(['Page'])

/**
 * Slash-command source for the template editor: the same block inserters as the
 * main editor (headings, lists, code block, divider, callout, …) minus the
 * app-stateful ones like "Page".
 */
export function templateSlashCommandSource(
  context: CompletionContext
): CompletionResult | null {
  const result = slashCommandSource(context)
  if (!result) return null
  const options = result.options.filter((option) => !NON_TEMPLATE_COMMANDS.has(option.label))
  if (options.length === 0) return null
  return { ...result, options }
}

/** Custom rendering for the slash command completion items. */
export const slashCommandRender = {
  render: renderCompletion
}
