import { describe, expect, it } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import {
  applyColumnOrder,
  arrangeColumns,
  compareCardsByDue,
  completeStatusOrder,
  cursorAfterCardMove,
  dropMutationsFor,
  fieldColumns,
  IN_PROGRESS_COLUMN_ID,
  kanbanGroupByKeyPlan,
  kanbanPendingGroupByPlan,
  NO_VALUE_COLUMN_ID,
  priorityColumns,
  statusColumns,
  taskIdentityKey,
  type Column,
  folderColumns,
  noteLocationOf,
  orderCards,
  FOLDER_OTHER_LABEL,
  columnWipLoads,
  hideEmptyCards,
  kanbanCardStep,
  parseWipLimitInput,
  wipState
} from './TasksKanban'

function col(id: string): Column {
  return { id, label: id, tasks: [] }
}

const ids = (columns: Column[]): string[] => columns.map((c) => c.id)

describe('arrangeColumns', () => {
  it('returns columns unchanged when no order is saved', () => {
    const built = [col('backlog'), col('review'), col('done')]
    expect(ids(arrangeColumns(built, []))).toEqual(['backlog', 'review', 'done'])
  })

  it('reorders columns to match a full saved order', () => {
    const built = [col('backlog'), col('review'), col('done')]
    expect(ids(arrangeColumns(built, ['done', 'backlog', 'review']))).toEqual([
      'done',
      'backlog',
      'review'
    ])
  })

  it('keeps unlisted (newly discovered) columns after the ordered ones, in built order', () => {
    const built = [col('backlog'), col('review'), col('done'), col('blocked')]
    // Only backlog + done are in the saved order; review + blocked are new.
    expect(ids(arrangeColumns(built, ['done', 'backlog']))).toEqual([
      'done',
      'backlog',
      'review',
      'blocked'
    ])
  })

  it('always pins the No-value bucket last, even if the order lists it first', () => {
    const built = [col('backlog'), col(NO_VALUE_COLUMN_ID), col('done')]
    expect(ids(arrangeColumns(built, [NO_VALUE_COLUMN_ID, 'done', 'backlog']))).toEqual([
      'done',
      'backlog',
      NO_VALUE_COLUMN_ID
    ])
  })

  it('ignores saved ids that no longer exist among the built columns', () => {
    const built = [col('backlog'), col('done')]
    // 'review' was deleted from the vault but lingers in the saved order.
    expect(ids(arrangeColumns(built, ['review', 'done', 'backlog']))).toEqual(['done', 'backlog'])
  })
})

function task(sourcePath: string, taskIndex: number, content = 'task'): VaultTask {
  return { content, checked: false, sourcePath, taskIndex } as unknown as VaultTask
}

function colWith(id: string, tasks: VaultTask[]): Column {
  return { id, label: id, tasks }
}

describe('cursorAfterCardMove (#492)', () => {
  const mover = task('inbox/board.md', 2, 'Mover')
  const anchor = task('inbox/board.md', 0, 'Anchor')

  it('lands on the moved card, not on the top of its new column', () => {
    // Columns sort by priority and due date, so a moved card usually arrives
    // below the cards already there.
    const columns = [colWith('backlog', []), colWith('doing', [anchor, mover])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 1
    })
  })

  it('finds the target column by id after an emptied column disappears', () => {
    // `backlog` held only the moved card, so the rebuilt board drops it and
    // every column to its right shifts down one index.
    const columns = [colWith('doing', [anchor, mover]), colWith('review', [])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 0,
      cardIdx: 1
    })
  })

  it('keeps the cursor in the target column when the card is not found there', () => {
    const columns = [colWith('backlog', []), colWith('doing', [anchor])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 0
    })
  })

  it('clamps to the last column when the target is gone entirely', () => {
    const columns = [colWith('backlog', []), colWith('doing', [anchor])]
    expect(cursorAfterCardMove(columns, 'vanished', taskIdentityKey(mover))).toEqual({
      colIdx: 1,
      cardIdx: 0
    })
  })

  it('distinguishes two tasks from the same note', () => {
    const columns = [colWith('doing', [anchor, mover])]
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(anchor)).cardIdx).toBe(0)
    expect(cursorAfterCardMove(columns, 'doing', taskIdentityKey(mover)).cardIdx).toBe(1)
  })
})

describe('applyColumnOrder (persisted card arrangement replay)', () => {
  const a = task('inbox/a.md', 0, 'A')
  const b = task('inbox/b.md', 0, 'B')
  const c = task('inbox/c.md', 0, 'C')

  const saved = (key: string, keys: string[]): Map<string, string[]> => new Map([[key, keys]])
  const texts = (columns: Column[], i: number): string[] =>
    columns[i].tasks.map((t) => t.content)

  it('replays a saved arrangement over the built sort', () => {
    const columns = [colWith('today', [a, b, c])]
    const order = saved('status:today', [
      taskIdentityKey(c),
      taskIdentityKey(a),
      taskIdentityKey(b)
    ])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['C', 'A', 'B'])
  })

  it('keeps unlisted (new) cards after the arranged ones, in built order', () => {
    const columns = [colWith('today', [a, b, c])]
    const order = saved('status:today', [taskIdentityKey(c)])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['C', 'A', 'B'])
  })

  it('ignores saved keys whose task is no longer in the column', () => {
    // C was completed or rescheduled since the arrangement was saved.
    const columns = [colWith('today', [a, b])]
    const order = saved('status:today', [
      taskIdentityKey(c),
      taskIdentityKey(b),
      taskIdentityKey(a)
    ])
    expect(texts(applyColumnOrder('status', columns, order), 0)).toEqual(['B', 'A'])
  })

  it('leaves columns without a saved arrangement untouched', () => {
    const columns = [colWith('today', [a, b]), colWith('upcoming', [c])]
    const order = saved('status:today', [taskIdentityKey(b), taskIdentityKey(a)])
    const out = applyColumnOrder('status', columns, order)
    expect(texts(out, 0)).toEqual(['B', 'A'])
    expect(out[1]).toBe(columns[1])
  })

  it('scopes the arrangement to its board, so group-bys do not bleed', () => {
    // A same-named column on a different board must not pick up this order.
    const columns = [colWith('today', [a, b])]
    const order = saved('status:today', [taskIdentityKey(b), taskIdentityKey(a)])
    expect(texts(applyColumnOrder('priority', columns, order), 0)).toEqual(['A', 'B'])
  })
})

describe('group-by vs gt/gT tab keymaps (#573)', () => {
  const gKey = { key: 'g', code: 'KeyG' }
  const event = (init: {
    key: string
    code: string
    shiftKey?: boolean
    metaKey?: boolean
  }): KeyboardEvent =>
    ({
      key: init.key,
      code: init.code,
      ctrlKey: false,
      metaKey: !!init.metaKey,
      altKey: false,
      shiftKey: !!init.shiftKey
    }) as KeyboardEvent

  it('defers the cycle in vim mode, where g opens the gt/gT sequences', () => {
    expect(kanbanGroupByKeyPlan(true, null, event(gKey))).toBe('defer')
  })

  it('cycles immediately with vim off (no tab sequences exist)', () => {
    expect(kanbanGroupByKeyPlan(false, null, event(gKey))).toBe('cycle-now')
  })

  it('cycles immediately when the tab keymaps were rebound off the g prefix', () => {
    const overrides = { 'vim.tabNext': '] t', 'vim.tabPrevious': '[ t' }
    expect(kanbanGroupByKeyPlan(true, overrides, event(gKey))).toBe('cycle-now')
  })

  it('yields to the tab switch on the completing t and T', () => {
    expect(kanbanPendingGroupByPlan(null, event({ key: 't', code: 'KeyT' }))).toBe(
      'yield-to-tabs'
    )
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'T', code: 'KeyT', shiftKey: true }))
    ).toBe('yield-to-tabs')
  })

  it('keeps the prefix alive across the bare Shift that precedes gT', () => {
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))
    ).toBe('keep-pending')
  })

  it('treats a second g as a repeated prefix', () => {
    expect(kanbanPendingGroupByPlan(null, event(gKey))).toBe('repeat-prefix')
  })

  it('drops the prefix on any other key, vim-style', () => {
    expect(kanbanPendingGroupByPlan(null, event({ key: 'j', code: 'KeyJ' }))).toBe('interrupt')
    expect(
      kanbanPendingGroupByPlan(null, event({ key: 'p', code: 'KeyP', metaKey: true }))
    ).toBe('interrupt')
  })

  it('follows a rebound completion token', () => {
    const overrides = { 'vim.tabNext': 'g n' }
    expect(kanbanPendingGroupByPlan(overrides, event({ key: 'n', code: 'KeyN' }))).toBe(
      'yield-to-tabs'
    )
    // The old completion no longer completes anything: plain t interrupts,
    // while the untouched gT still finishes through its Shifted T.
    expect(kanbanPendingGroupByPlan(overrides, event({ key: 't', code: 'KeyT' }))).toBe(
      'interrupt'
    )
    expect(
      kanbanPendingGroupByPlan(overrides, event({ key: 'T', code: 'KeyT', shiftKey: true }))
    ).toBe('yield-to-tabs')
  })
})

// #677: started work (`[/]`) gets its own column on the Status board.
function card(over: Partial<VaultTask> & { content: string }): VaultTask {
  return {
    kind: 'inline',
    sourcePath: 'inbox/board.md',
    taskIndex: 0,
    checked: false,
    waiting: false,
    inProgress: false,
    cancelled: false,
    forwarded: false,
    ...over
  } as VaultTask
}

const TODAY = new Date(2026, 7, 25)
const columnIds = (columns: Column[], id: string): string[] =>
  columns.find((c) => c.id === id)!.tasks.map((t) => t.content)

describe('statusColumns (#677)', () => {
  it('places [/] tasks in their own In progress column, in flow order', () => {
    const columns = statusColumns(
      [
        card({ content: 'todo', taskIndex: 0 }),
        card({ content: 'started', taskIndex: 1, inProgress: true }),
        card({ content: 'later', taskIndex: 2, due: '2026-09-01' }),
        card({ content: 'started later', taskIndex: 3, due: '2026-09-01', inProgress: true }),
        card({ content: 'blocked', taskIndex: 4, waiting: true, inProgress: true }),
        card({ content: 'shipped', taskIndex: 5, checked: true })
      ],
      TODAY
    )
    expect(columns.map((c) => c.id)).toEqual(['today', 'upcoming', 'undated', IN_PROGRESS_COLUMN_ID, 'waiting', 'done'])
    // An undated task has its own column (#990); started, it still goes to In progress.
    expect(columnIds(columns, 'today')).toEqual([])
    expect(columnIds(columns, 'undated')).toEqual(['todo'])
    expect(columnIds(columns, 'upcoming')).toEqual(['later'])
    // Started work follows the list's order: dated first, undated last.
    expect(columnIds(columns, IN_PROGRESS_COLUMN_ID)).toEqual(['started later', 'started'])
    // @waiting wins over [/]: the card reads as blocked until the wait clears.
    expect(columnIds(columns, 'waiting')).toEqual(['blocked'])
    expect(columnIds(columns, 'done')).toEqual(['shipped'])
  })

  it('counts overdue cards per column, not the ones that moved to In progress', () => {
    const columns = statusColumns(
      [
        card({ content: 'late', taskIndex: 0, due: '2026-08-01' }),
        card({ content: 'late but started', taskIndex: 1, due: '2026-08-01', inProgress: true })
      ],
      TODAY
    )
    expect(columns.find((c) => c.id === 'today')!.badge).toEqual({ kind: 'overdue', value: 1 })
    expect(columns.find((c) => c.id === IN_PROGRESS_COLUMN_ID)!.badge).toEqual({ kind: 'overdue', value: 1 })
  })
})

describe('dropMutationsFor on the Status board (#677)', () => {
  const kinds = (columnId: string, over: Partial<VaultTask> = {}): string[] =>
    dropMutationsFor('status', columnId, card({ content: 'x', ...over }), TODAY)!.map((m) =>
      m.kind === 'set-in-progress' ? `set-in-progress:${m.inProgress}` : m.kind
    )

  it('dropping into In progress marks the task [/] and clears done/waiting', () => {
    expect(kinds(IN_PROGRESS_COLUMN_ID)).toEqual(['set-checked', 'set-waiting', 'set-in-progress:true'])
  })

  it('dropping back into Today or Upcoming reopens a [/] task', () => {
    expect(kinds('today', { inProgress: true })).toContain('set-in-progress:false')
    expect(kinds('upcoming', { inProgress: true })).toContain('set-in-progress:false')
  })

  it('dropping into Waiting keeps the [/] underneath', () => {
    expect(kinds('waiting', { inProgress: true })).toEqual(['set-checked', 'set-waiting'])
  })

  it('dropping into No due date clears the due date and reopens the task (#990)', () => {
    const mutations = dropMutationsFor('status', 'undated', card({ content: 'x', due: '2026-09-01', inProgress: true }), TODAY)
    expect(mutations).toContainEqual({ kind: 'set-due', due: null })
    expect(mutations).toContainEqual({ kind: 'set-in-progress', inProgress: false })
  })

  it('refuses No due date for a daily-note task, whose date is its note\'s, not a due: to clear', () => {
    expect(dropMutationsFor('status', 'undated', card({ content: 'x', due: '2026-08-15', dueInferred: true }), TODAY)).toBeNull()
  })
})

describe('completeStatusOrder (#677)', () => {
  const built = ['today', 'upcoming', IN_PROGRESS_COLUMN_ID, 'waiting', 'done']

  it('slots No due date after Upcoming in an order saved before it existed (#990)', () => {
    const withUndated = ['today', 'upcoming', 'undated', IN_PROGRESS_COLUMN_ID, 'waiting', 'done']
    expect(completeStatusOrder(['done', 'upcoming', 'today', IN_PROGRESS_COLUMN_ID, 'waiting'], withUndated)).toEqual([
      'done',
      'upcoming',
      'undated',
      'today',
      IN_PROGRESS_COLUMN_ID,
      'waiting'
    ])
  })

  it('leaves an empty saved order alone (built order applies)', () => {
    expect(completeStatusOrder([], built)).toEqual([])
  })

  it('slots the new column after its built neighbour in a pre-2.38 saved order', () => {
    expect(completeStatusOrder(['done', 'today', 'upcoming', 'waiting'], built)).toEqual([
      'done',
      'today',
      'upcoming',
      IN_PROGRESS_COLUMN_ID,
      'waiting'
    ])
  })

  it('keeps a saved order that already knows the column', () => {
    const saved = [IN_PROGRESS_COLUMN_ID, 'today', 'upcoming', 'waiting', 'done']
    expect(completeStatusOrder(saved, built)).toEqual(saved)
  })

  it('drops ids the board no longer builds and prepends a column with no built predecessor', () => {
    expect(completeStatusOrder(['stale', 'upcoming', 'done'], built)).toEqual([
      'today',
      'upcoming',
      IN_PROGRESS_COLUMN_ID,
      'waiting',
      'done'
    ])
  })
})

describe('folder board (#730)', () => {
  const task = (sourcePath: string, noteFolder: VaultTask['noteFolder'], extra: Partial<VaultTask> = {}): VaultTask =>
    ({
      id: `${sourcePath}#0`,
      sourcePath,
      noteTitle: sourcePath.split('/').pop()!.replace(/\.md$/, ''),
      noteFolder,
      lineNumber: 0,
      taskIndex: 0,
      rawText: '- [ ] x',
      content: 'x',
      checked: false,
      forwarded: false,
      cancelled: false,
      inProgress: false,
      waiting: false,
      tags: [],
      ...extra
    }) as VaultTask
  const layout = (folderRoot = '', systemFolderPaths?: Record<string, string>) => ({
    folderRoot,
    systemFolderPaths: systemFolderPaths ?? null,
    systemFolderLabels: null
  })

  it('locates a note under its system folder in inbox mode, root mode, and with a remapped folder', () => {
    expect(noteLocationOf(task('inbox/Projects/alpha/plan.md', 'inbox'))).toEqual({ folder: 'inbox', dir: 'Projects/alpha', prefix: 'inbox' })
    expect(noteLocationOf(task('inbox/plan.md', 'inbox'))).toEqual({ folder: 'inbox', dir: '', prefix: 'inbox' })
    // Root mode: no prefix, so the first segment is a user folder.
    expect(noteLocationOf(task('Projects/alpha/plan.md', 'inbox'))).toEqual({ folder: 'inbox', dir: 'Projects/alpha', prefix: '' })
    expect(noteLocationOf(task('plan.md', 'inbox'))).toEqual({ folder: 'inbox', dir: '', prefix: '' })
    // A vault whose inbox lives in `01 - Entry`: that prefix is the inbox, and a
    // directory literally called inbox is a user folder.
    const remapped = { inbox: '01 - Entry' }
    expect(noteLocationOf(task('01 - Entry/Projects/plan.md', 'inbox'), remapped)).toEqual({ folder: 'inbox', dir: 'Projects', prefix: '01 - Entry' })
    expect(noteLocationOf(task('inbox/plan.md', 'inbox'), remapped)).toEqual({ folder: 'inbox', dir: 'inbox', prefix: '' })
    expect(noteLocationOf(task('quick/2026/plan.md', 'quick'))).toEqual({ folder: 'quick', dir: '2026', prefix: 'quick' })
  })

  it('gives every note folder its own column, system roots first, subfolders alphabetically', () => {
    const columns = folderColumns(
      [
        task('inbox/Projects/beta/b.md', 'inbox'),
        task('inbox/plan.md', 'inbox'),
        task('inbox/Projects/alpha/a.md', 'inbox'),
        task('inbox/Projects/alpha/deep/d.md', 'inbox'),
        task('quick/q.md', 'quick'),
        task('inbox/Areas/home.md', 'inbox'),
        task('inbox/Projects/alpha/done.md', 'inbox', { checked: true })
      ],
      false,
      layout()
    )
    expect(columns.map((c) => [c.id, c.label, c.tasks.length])).toEqual([
      ['inbox', 'Inbox', 1],
      ['inbox/Areas', 'Areas', 1],
      ['inbox/Projects/alpha', 'Projects/alpha', 1],
      ['inbox/Projects/alpha/deep', 'Projects/alpha/deep', 1],
      ['inbox/Projects/beta', 'Projects/beta', 1],
      ['quick', 'Quick Notes', 1]
    ])
  })

  it('labels root-mode notes by their folder and the vault root by the inbox label', () => {
    const columns = folderColumns([task('Projects/alpha/a.md', 'inbox'), task('plan.md', 'inbox')], false, layout())
    expect(columns.map((c) => [c.id, c.label])).toEqual([
      ['inbox', 'Inbox'],
      ['Projects/alpha', 'Projects/alpha']
    ])
  })

  it('with a root, groups by its children, rolls deeper notes up, and parks the rest in Other folders', () => {
    const columns = folderColumns(
      [
        task('inbox/Projects/beta/b.md', 'inbox'),
        task('inbox/Projects/alpha/a.md', 'inbox'),
        task('inbox/Projects/alpha/deep/d.md', 'inbox'),
        task('inbox/Projects/overview.md', 'inbox'),
        task('inbox/Areas/home.md', 'inbox'),
        task('inbox/plan.md', 'inbox'),
        task('quick/q.md', 'quick')
      ],
      false,
      layout('projects/')
    )
    expect(columns.map((c) => [c.id, c.label, c.tasks.length])).toEqual([
      ['inbox/Projects', 'Projects', 1],
      ['inbox/Projects/alpha', 'alpha', 2],
      ['inbox/Projects/beta', 'beta', 1],
      [NO_VALUE_COLUMN_ID, FOLDER_OTHER_LABEL, 3]
    ])
    // Root mode: same shape without the prefix.
    const rootMode = folderColumns([task('Projects/alpha/a.md', 'inbox'), task('Notes/n.md', 'inbox')], false, layout('Projects'))
    expect(rootMode.map((c) => c.id)).toEqual(['Projects/alpha', NO_VALUE_COLUMN_ID])
  })

  it('hides archived notes unless asked, and shows their column with the archive label when shown', () => {
    const tasks = [task('inbox/a.md', 'inbox'), task('archive/old/o.md', 'archive')]
    expect(folderColumns(tasks, false, layout()).map((c) => c.id)).toEqual(['inbox'])
    expect(folderColumns(tasks, true, layout()).map((c) => [c.id, c.label])).toEqual([
      ['inbox', 'Inbox'],
      ['archive/old', 'Archive / old']
    ])
  })
})

describe('forwarded and cancelled records stay off every board (#786)', () => {
  // One task forwarded Note 1 → Note 2 → Note 3: two `[>]` trail records and
  // one live copy. Plus a cancelled and a done task for the other closed states.
  const chain: VaultTask[] = [
    card({ content: 'Write the report', sourcePath: 'inbox/Note 1.md', forwarded: true, priority: 'high' }),
    card({ content: 'Write the report', sourcePath: 'inbox/Note 2.md', forwarded: true, priority: 'high' }),
    card({ content: 'Write the report', sourcePath: 'inbox/Note 3.md', priority: 'high' }),
    card({ content: 'Old idea', sourcePath: 'inbox/Note 3.md', taskIndex: 1, cancelled: true }),
    card({ content: 'Shipped', sourcePath: 'inbox/Note 3.md', taskIndex: 2, checked: true }),
    card({ content: 'Still open', sourcePath: 'inbox/Note 3.md', taskIndex: 3 })
  ].map((task) => ({ ...task, noteFolder: 'inbox' as const }))

  const cards = (columns: Column[]): string[] =>
    columns.flatMap((c) => c.tasks.map((t) => `${t.sourcePath} › ${t.content}`))

  it('shows the forwarded task once on the Priority board, from the note it lives in now', () => {
    const columns = priorityColumns(chain)
    expect(columnIds(columns, 'high')).toEqual(['Write the report'])
    expect(cards(columns)).toEqual(['inbox/Note 3.md › Write the report', 'inbox/Note 3.md › Still open'])
  })

  it('shows it once on the Folder board too', () => {
    const columns = folderColumns(chain, false, {
      folderRoot: '',
      systemFolderPaths: null,
      systemFolderLabels: null
    })
    expect(cards(columns)).toEqual(['inbox/Note 3.md › Write the report', 'inbox/Note 3.md › Still open'])
  })

  it('and the Status board keeps leaving the trail records out', () => {
    const columns = statusColumns(chain, TODAY)
    expect(cards(columns)).toEqual([
      'inbox/Note 3.md › Write the report',
      'inbox/Note 3.md › Still open',
      'inbox/Note 3.md › Shipped'
    ])
  })
})

// #949: a task note's `status: done` both closes it and names its column, so a
// Custom status board with a configured `done` column must keep it there.
describe('closed task notes on the Custom status board (#949)', () => {
  const taskNote = (content: string, status: string): VaultTask =>
    card({
      content,
      kind: 'file',
      sourcePath: `inbox/${content}.md`,
      taskIndex: -1,
      status,
      fields: { status },
      checked: status === 'done',
      cancelled: status === 'cancelled',
      inProgress: status === 'in-progress'
    })
  // A note with frontmatter `status: in-progress` lends that status to its
  // checkboxes, and a checked box keeps its own explicit `@status:done`.
  const checkbox = (content: string, status: string, checked: boolean, taskIndex: number): VaultTask =>
    card({ content, sourcePath: 'inbox/Checklist.md', taskIndex, status, fields: { status }, checked })
  const tasks = [
    taskNote('Completed demo task', 'done'),
    taskNote('Active demo task', 'in-progress'),
    taskNote('Dropped demo task', 'cancelled'),
    checkbox('Finished step', 'in-progress', true, 0),
    checkbox('Next step', 'in-progress', false, 1),
    checkbox('Shipped step', 'done', true, 2)
  ]
  const statuses = ['open', 'in-progress', 'waiting', 'done']

  it('keeps a done task note in the configured Done column, still checked', () => {
    const columns = fieldColumns(tasks, 'status', statuses)
    expect(ids(columns)).toEqual(['open', 'in-progress', 'waiting', 'done', NO_VALUE_COLUMN_ID])
    expect(columnIds(columns, 'done')).toEqual(['Completed demo task'])
    expect(columns.find((c) => c.id === 'done')!.tasks[0].checked).toBe(true)
    expect(columnIds(columns, 'in-progress')).toEqual(['Active demo task', 'Next step'])
  })

  it('leaves closed task notes off when their status has no configured column', () => {
    const columns = fieldColumns(tasks, 'status', ['open', 'in-progress'])
    expect(ids(columns)).toEqual(['open', 'in-progress', NO_VALUE_COLUMN_ID])
    expect(columns.flatMap((c) => c.tasks.map((t) => t.content))).toEqual(['Active demo task', 'Next step'])
  })

  it('shows a cancelled task note once a cancelled column is configured', () => {
    const columns = fieldColumns(tasks, 'status', [...statuses, 'cancelled'])
    expect(columnIds(columns, 'cancelled')).toEqual(['Dropped demo task'])
  })

  it('keeps checked checkbox tasks off, whatever status they carry or inherit', () => {
    const columns = fieldColumns(tasks, 'status', statuses)
    const shown = columns.flatMap((c) => c.tasks.map((t) => t.content))
    expect(shown).not.toContain('Finished step')
    expect(shown).not.toContain('Shipped step')
  })
})

// #889: a column can follow its cards' due dates instead of the order they
// were dragged into, on every board, custom status boards included.
describe('card order by due date (#889)', () => {
  const dated = (content: string, due: string | undefined, sourcePath: string, taskIndex = 0): VaultTask =>
    card({ content, due, sourcePath, taskIndex })
  const texts = (columns: Column[], i: number): string[] => columns[i].tasks.map((t) => t.content)

  const late = dated('Late', '2026-10-20', 'inbox/a.md')
  const soon = dated('Soon', '2026-10-06', 'inbox/b.md')
  const undated = dated('Someday', undefined, 'inbox/c.md')
  const sameDayFirst = dated('Same day, first line', '2026-10-06', 'inbox/d.md', 0)
  const sameDaySecond = dated('Same day, second line', '2026-10-06', 'inbox/d.md', 3)

  it('puts the earliest due date first and cards without one last', () => {
    const sorted = [undated, late, soon].sort(compareCardsByDue).map((t) => t.content)
    expect(sorted).toEqual(['Soon', 'Late', 'Someday'])
  })

  it('breaks a same-day tie by note, then by the task\'s place in it', () => {
    const sorted = [sameDaySecond, soon, sameDayFirst].sort(compareCardsByDue).map((t) => t.content)
    expect(sorted).toEqual(['Soon', 'Same day, first line', 'Same day, second line'])
  })

  // The reporter's case: a custom status board whose column was hand-arranged
  // once keeps that arrangement forever, however the due dates change.
  const arranged = new Map([
    ['field:status:review', [taskIdentityKey(undated), taskIdentityKey(late), taskIdentityKey(soon)]]
  ])
  const board = (): Column[] => [colWith('review', [soon, late, undated]), colWith('done', [late])]

  it('by due date, ignores the dragged arrangement of a custom status column', () => {
    expect(texts(orderCards('field:status', board(), 'due', arranged), 0)).toEqual(['Soon', 'Late', 'Someday'])
  })

  it('manually, replays the dragged arrangement, which ordering by date left in place', () => {
    expect(texts(orderCards('field:status', board(), 'manual', arranged), 0)).toEqual(['Someday', 'Late', 'Soon'])
  })

  it('sorts every column without touching the built ones', () => {
    const built = [colWith('review', [undated, late, soon])]
    const out = orderCards('field:status', built, 'due', new Map())
    expect(texts(out, 0)).toEqual(['Soon', 'Late', 'Someday'])
    expect(texts(built, 0)).toEqual(['Someday', 'Late', 'Soon'])
  })
})

describe('empty tasks stay off the board (#1026)', () => {
  // Yesterday's daily note left its template placeholders behind: overdue,
  // empty, and in the Today column beside the real work.
  const placeholder = (taskIndex: number): VaultTask =>
    card({ content: '', taskIndex, sourcePath: 'Daily/2026-08-24.md', due: '2026-08-24' })
  const real = card({
    content: 'Call the bank',
    taskIndex: 3,
    sourcePath: 'Daily/2026-08-24.md',
    due: '2026-08-24'
  })
  const built = (): Column[] =>
    statusColumns(
      [placeholder(0), placeholder(1), real, card({ content: '  ', taskIndex: 4 })],
      TODAY
    )

  it('leaves empty cards off every column and counts them', () => {
    const { columns: shown, hidden } = hideEmptyCards(built(), TODAY)
    expect(hidden).toBe(3)
    expect(columnIds(shown, 'today')).toEqual(['Call the bank'])
    expect(columnIds(shown, 'undated')).toEqual([])
  })

  it('keeps every column, even one the hiding emptied', () => {
    const board = built()
    expect(hideEmptyCards(board, TODAY).columns.map((c) => c.id)).toEqual(board.map((c) => c.id))
  })

  it('stops counting a hidden placeholder as overdue', () => {
    const board = built()
    expect(board.find((c) => c.id === 'today')!.badge).toEqual({ kind: 'overdue', value: 3 })
    const { columns: shown } = hideEmptyCards(board, TODAY)
    expect(shown.find((c) => c.id === 'today')!.badge).toEqual({ kind: 'overdue', value: 1 })
  })

  it('hands back the same columns when nothing is empty', () => {
    const board = statusColumns([real], TODAY)
    const result = hideEmptyCards(board, TODAY)
    expect(result.hidden).toBe(0)
    expect(result.columns[0]).toBe(board[0])
  })
})

describe('WIP limits (#1025)', () => {
  it('reads a limit as a whole number from 1 to 999, and empty as no limit', () => {
    expect(parseWipLimitInput('3')).toEqual({ ok: true, limit: 3 })
    expect(parseWipLimitInput(' 12 ')).toEqual({ ok: true, limit: 12 })
    expect(parseWipLimitInput('999')).toEqual({ ok: true, limit: 999 })
    expect(parseWipLimitInput('')).toEqual({ ok: true, limit: null })
    expect(parseWipLimitInput('   ')).toEqual({ ok: true, limit: null })
    for (const bad of ['0', '-1', '2.5', 'three', '1000', '3 cards']) {
      expect(parseWipLimitInput(bad).ok, bad).toBe(false)
    }
  })

  it('is over only past the limit, not at it', () => {
    expect(wipState(4, undefined)).toBeNull()
    expect(wipState(2, 3)).toEqual({ load: 2, limit: 3, over: false })
    expect(wipState(3, 3)).toEqual({ load: 3, limit: 3, over: false })
    expect(wipState(4, 3)).toEqual({ load: 4, limit: 3, over: true })
  })

  it('counts every card a column holds, whatever the filter narrows it to', () => {
    // The loads come from the board before the filter, so a column holding
    // four cards reads 4 / 3 even while the filter shows one of them.
    const full = [
      colWith('in-progress', [
        card({ content: 'a' }),
        card({ content: 'b', taskIndex: 1 }),
        card({ content: '', taskIndex: 2 })
      ])
    ]
    expect(columnWipLoads(full, false).get('in-progress')).toBe(3)
    // A placeholder the board hides is not work in progress either.
    expect(columnWipLoads(full, true).get('in-progress')).toBe(2)
  })
})

describe('the cursor climbs onto the column header (#1025)', () => {
  it('goes from the first card up to the header, and stays there', () => {
    expect(kanbanCardStep(0, -1, 3)).toBe(-1)
    expect(kanbanCardStep(-1, -1, 3)).toBe(-1)
    expect(kanbanCardStep(2, -1, 3)).toBe(1)
  })

  it('comes back down to the first card, and stops at the last', () => {
    expect(kanbanCardStep(-1, 1, 3)).toBe(0)
    expect(kanbanCardStep(2, 1, 3)).toBe(2)
  })

  it('keeps an empty column on its header', () => {
    expect(kanbanCardStep(-1, 1, 0)).toBe(-1)
    expect(kanbanCardStep(0, -1, 0)).toBe(-1)
  })
})
