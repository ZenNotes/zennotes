/**
 * Where the keyboard goes after a command-palette command, on a host that
 * opens notes to read (a phone; the editor host's `openNotesToRead`).
 *
 * - `read`: the command only put a note that already existed on screen
 *   (`Command.opensToRead`): it is left to read, keyboard down.
 * - `edit`: typing, or the editor's own focus, is the point of the command:
 *   the editor takes the focus and the keyboard comes up, as on desktop.
 * - `stay`: everything else (a toggle, a view, a sort, a theme, a panel, a
 *   fold, task state, copy and export): the focus goes back where it was
 *   before the palette opened, so a keyboard that was down stays down.
 *
 * The rule defaults to `stay` and names the `edit` commands, so a new toggle
 * cannot raise a phone's keyboard by being forgotten. Desktop ignores all of
 * it: every command that lands on the editor focuses it, as it always has
 * (the three hand-offs in lib/editor-focus.ts all focus the editor there).
 */
export type CommandLanding = 'read' | 'edit' | 'stay'

/** The commands whose point is typing or the editor's focus. */
export const EDITOR_FOCUS_COMMAND_IDS: ReadonlySet<string> = new Set([
  // A new note, task, database or drawing is made to be written in.
  'note.new.quick',
  'note.new.inbox',
  'note.new.here',
  'task.new',
  'task.new.folder',
  'database.new',
  'drawing.new',
  'embed.drawing.new',
  // Daily, weekly and monthly notes the command creates (one that already
  // exists answers `opensToRead` first and is read).
  'note.daily.today',
  'note.daily.rollover',
  'note.weekly.thisWeek',
  'note.monthly.thisMonth',
  // Writing into the open note: templates, formatting, a comment.
  'template.create',
  'template.insert',
  'note.format',
  'editor.reflow-paragraph',
  'editor.add-comment',
  // Commands whose point is where the keyboard focus goes.
  'nav.focus.editor',
  'ref.focus',
  'split.right',
  'split.down',
  'pane.focus.left',
  'pane.focus.down',
  'pane.focus.up',
  'pane.focus.right'
])

/** Asked just before the command runs (afterwards a daily note exists either way). */
export function commandLanding(command: {
  id: string
  opensToRead?: () => boolean
}): CommandLanding {
  if (command.opensToRead?.() === true) return 'read'
  return EDITOR_FOCUS_COMMAND_IDS.has(command.id) ? 'edit' : 'stay'
}
