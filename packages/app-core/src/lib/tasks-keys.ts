/**
 * The Tasks views' keyboard cheat sheet: what the Keys button (`?` in Vim
 * mode) shows for the list, the calendar and the board. It replaced the
 * always-visible hint lines, which had grown into a paragraph nobody read.
 *
 * Every key a Tasks surface answers stays named here, so no binding lost its
 * discoverability when the lines went. Vim mode decides the set, the rule
 * every list follows: with it off only the arrows, Enter, Space, Tab and the
 * menu key are live, so only they appear (plus the mouse line), and a letter
 * is never named where it would do nothing.
 */
export type TasksKeysView = 'list' | 'calendar' | 'kanban'

export interface TasksKeyRow {
  /** The chip: one key, or a pair like `h / l`. */
  keys: string
  /** One to three words. */
  label: string
}

export interface TasksKeyGroup {
  title: string
  rows: TasksKeyRow[]
}

export interface TasksKeySheet {
  groups: TasksKeyGroup[]
  /** The mouse equivalents, one muted line. */
  mouse: string
}

export interface TasksKeySheetOptions {
  vimMode: boolean
  /** The board can move cards (every board but Folder). */
  dndEnabled: boolean
  /** The list reorders tasks only in its notes' order. */
  listOrder: 'note' | 'priority'
  /** The board's cards step into their subtasks (Tab / Shift+Tab, Esc back).
   *  Reserved for the subtasks branch, which binds those keys; off until
   *  then, so the sheet never names a key that does nothing. */
  subtasks?: boolean
  /** The board is split into swimlanes (#1027): the Lanes group shows. */
  lanes?: boolean
  /** A card can move to another lane (every lane field but Folder). */
  laneMoves?: boolean
}

/** The board's Subtasks group, shown once `subtasks` is on. Tab and Esc are
 *  not letters, so it belongs to both modes. */
const SUBTASK_GROUP: TasksKeyGroup = {
  title: 'Subtasks',
  rows: [
    { keys: 'Tab / Shift+Tab', label: 'step through' },
    { keys: 'Esc', label: 'back to card' }
  ]
}

/** The view-wide keys every sub-view answers in Vim mode, after the view's
 *  own `s` order where it has one. The view switch (1 2 3) and New task (a)
 *  name their keys in their buttons' tooltips, so the sheet leaves them out. */
function viewRows(order: string | null): TasksKeyRow[] {
  return [
    ...(order ? [{ keys: 's', label: order }] : []),
    { keys: 'v', label: 'view menu' },
    { keys: 'E', label: 'empty tasks' },
    { keys: '/', label: 'filter' },
    { keys: 'F', label: 'saved filters' },
    { keys: '?', label: 'these keys' }
  ]
}

/** The board's Lanes group (#1027), shown while the board has lanes. `{ }`
 *  hop lane to lane the way they hop note to note in the Tags view, and
 *  Shift+J/K move the card down or up a lane as Shift+H/L move it across.
 *  With Vim mode off the arrows walk the lane headers, and Enter or Space on
 *  one folds it. */
function laneGroup({ vimMode, laneMoves }: TasksKeySheetOptions): TasksKeyGroup {
  if (!vimMode) return { title: 'Lanes', rows: [{ keys: 'Enter / Space', label: 'toggle (header)' }] }
  return {
    title: 'Lanes',
    rows: [
      { keys: '{ / }', label: 'lanes' },
      ...(laneMoves ? [{ keys: 'Shift+J / K', label: 'move card' }] : []),
      { keys: 'za', label: 'toggle lane' },
      { keys: 'zM / zR', label: 'collapse, expand all' },
      { keys: 'Enter', label: 'toggle (header)' }
    ]
  }
}

function kanbanSheet(options: TasksKeySheetOptions): TasksKeySheet {
  const sheet = kanbanGroups(options)
  if (options.subtasks) sheet.groups.splice(2, 0, SUBTASK_GROUP)
  if (options.lanes) {
    const columns = sheet.groups.findIndex((group) => group.title === 'Columns')
    sheet.groups.splice(columns, 0, laneGroup(options))
  }
  return sheet
}

function kanbanGroups({ vimMode, dndEnabled, lanes, laneMoves }: TasksKeySheetOptions): TasksKeySheet {
  // A Folder board's cards still drag between priority, tag or field lanes.
  const mouse = dndEnabled || (lanes && laneMoves)
    ? 'Drag cards and headers · right-click for menus'
    : 'Drag headers · right-click for menus'
  if (!vimMode) {
    return {
      groups: [
        {
          title: 'Move',
          rows: [
            { keys: '← / →', label: 'columns' },
            { keys: '↑ / ↓', label: 'cards, header' }
          ]
        },
        {
          title: 'Cards',
          rows: [
            { keys: 'Space', label: 'toggle' },
            { keys: 'Enter', label: 'open' },
            { keys: 'Shift+F10', label: 'menu' }
          ]
        },
        {
          title: 'Columns',
          rows: [
            { keys: 'Enter', label: 'rename (header)' },
            { keys: 'Shift+F10', label: 'header menu' }
          ]
        }
      ],
      mouse
    }
  }
  return {
    groups: [
      {
        title: 'Move',
        rows: [
          { keys: 'h / l', label: 'columns' },
          { keys: 'j / k', label: 'cards, header' }
        ]
      },
      {
        title: 'Cards',
        // The card's states (i start, c cancel, @ due date) are in the menu
        // `m` opens, each with its key. Subtasks get a group of their own
        // (SUBTASK_GROUP), right after this one.
        rows: [
          { keys: 'x', label: 'toggle' },
          { keys: 'Enter', label: 'open' },
          ...(dndEnabled ? [{ keys: 'Shift+H / L', label: 'move' }] : []),
          { keys: 'm', label: 'menu' }
        ]
      },
      {
        title: 'Columns',
        rows: [
          { keys: '< / >', label: 'reorder' },
          { keys: 'W', label: 'WIP limit' },
          { keys: 'Enter', label: 'rename (header)' }
        ]
      },
      {
        title: 'Board',
        rows: [{ keys: 'g', label: 'group by' }, { keys: 'S', label: 'lanes' }, ...viewRows('order')]
      }
    ],
    mouse
  }
}

function listSheet({ vimMode, listOrder }: TasksKeySheetOptions): TasksKeySheet {
  const reorder = listOrder === 'note'
  const mouse = reorder ? 'Drag to reorder · right-click for actions' : 'Right-click for actions'
  if (!vimMode) {
    return {
      groups: [
        {
          title: 'Move',
          rows: [
            { keys: '↑ / ↓', label: 'tasks' },
            ...(reorder ? [{ keys: 'Shift+J / K', label: 'reorder' }] : [])
          ]
        },
        { title: 'Tasks', rows: [{ keys: 'Enter', label: 'open' }] }
      ],
      mouse
    }
  }
  return {
    groups: [
      {
        title: 'Move',
        rows: [
          { keys: 'j / k', label: 'tasks' },
          { keys: 'g g / G', label: 'top, bottom' },
          ...(reorder ? [{ keys: 'J / K', label: 'reorder' }] : [])
        ]
      },
      {
        title: 'Task',
        rows: [
          { keys: 'x', label: 'toggle' },
          { keys: 'Enter', label: 'open' },
          { keys: 'i', label: 'start' },
          { keys: 'c', label: 'cancel' },
          { keys: '@', label: 'due date' },
          { keys: '>', label: 'forward' }
        ]
      },
      { title: 'List', rows: viewRows('order') }
    ],
    mouse
  }
}

function calendarSheet({ vimMode }: TasksKeySheetOptions): TasksKeySheet {
  const mouse = 'Drag to another day · right-click for actions'
  if (!vimMode) {
    return {
      groups: [
        {
          title: 'Move',
          rows: [
            { keys: '← / →', label: 'days' },
            { keys: '↑ / ↓', label: 'weeks' }
          ]
        },
        {
          title: 'Tasks',
          rows: [
            { keys: 'Tab', label: 'next task' },
            { keys: 'Space', label: 'toggle' },
            { keys: 'Enter', label: 'open' }
          ]
        }
      ],
      mouse
    }
  }
  return {
    groups: [
      {
        title: 'Move',
        rows: [
          { keys: 'h / l', label: 'days' },
          { keys: 'j / k', label: 'weeks' },
          { keys: '[ / ]', label: 'months' },
          { keys: 'g t', label: 'today' }
        ]
      },
      {
        title: 'Task',
        rows: [
          { keys: 'Tab', label: 'next task' },
          { keys: 'x', label: 'toggle' },
          { keys: 'Enter', label: 'open' },
          { keys: 'e', label: 'edit' },
          { keys: 'm', label: 'move' },
          { keys: 'd d', label: 'delete' },
          { keys: 'i', label: 'start' },
          { keys: 'c', label: 'cancel' }
        ]
      },
      {
        title: 'Dates',
        rows: [
          { keys: '< / >', label: 'due ±1 day' },
          { keys: 'T', label: 'due today' },
          { keys: '@', label: 'due date' },
          { keys: 'a', label: 'add to day' }
        ]
      },
      { title: 'Calendar', rows: viewRows(null) }
    ],
    mouse
  }
}

export function tasksKeySheet(view: TasksKeysView, options: TasksKeySheetOptions): TasksKeySheet {
  if (view === 'kanban') return kanbanSheet(options)
  if (view === 'calendar') return calendarSheet(options)
  return listSheet(options)
}
