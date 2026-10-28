import { describe, it, expect } from 'vitest'
import { parseTaskFile, type VaultTask, type VaultTaskGroups } from '@shared/tasks'
import {
  applyFileOrder,
  applyPriorityOrder,
  computeTasksRender,
  filterTasks,
  noteTagsByPath
} from './tasks-filter'

function task(sourcePath: string, taskIndex: number, overrides?: Partial<VaultTask>): VaultTask {
  return {
    id: `${sourcePath}#${taskIndex}`,
    sourcePath,
    noteTitle: sourcePath.replace(/\.md$/, ''),
    noteFolder: 'inbox',
    lineNumber: taskIndex,
    taskIndex,
    rawText: '- [ ] x',
    content: `${sourcePath}:${taskIndex}`,
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: [],
    ...overrides
  }
}

function groups(today: VaultTask[]): VaultTaskGroups {
  return { today, upcoming: [], undated: [], waiting: [], done: [], forwarded: [], cancelled: [], overdueCount: 0 }
}

describe('filterTasks', () => {
  it('returns the same array untouched for a blank query', () => {
    const input = [task('a.md', 0)]
    expect(filterTasks(input, '')).toBe(input)
    expect(filterTasks(input, '   ')).toBe(input)
  })

  it('matches content and note title case-insensitively', () => {
    const a = task('plans.md', 0, { content: 'Draft the Launch email' })
    const b = task('journal.md', 0, { content: 'water the plants' })
    expect(filterTasks([a, b], 'launch')).toEqual([a])
    expect(filterTasks([a, b], 'JOURNAL')).toEqual([b])
  })

  it('matches tags with and without the leading #', () => {
    const a = task('a.md', 0, { tags: ['project-alpha'] })
    const b = task('a.md', 1, { tags: ['infra'] })
    expect(filterTasks([a, b], '#project-alpha')).toEqual([a])
    expect(filterTasks([a, b], 'infra')).toEqual([b])
  })

  it('matches @key:value fields by token, pair, key, or value', () => {
    const a = task('a.md', 0, { fields: { project: 'alpha' } })
    const b = task('a.md', 1, { fields: { project: 'beta', sprint: '24' } })
    const c = task('a.md', 2)
    const all = [a, b, c]
    expect(filterTasks(all, '@project:alpha')).toEqual([a])
    expect(filterTasks(all, 'project:beta')).toEqual([b])
    expect(filterTasks(all, '@project')).toEqual([a, b])
    expect(filterTasks(all, 'alpha')).toEqual([a])
    expect(filterTasks(all, '@sprint:24')).toEqual([b])
  })

  it('matches priority through the ! prefix', () => {
    const a = task('a.md', 0, { priority: 'high' })
    const b = task('a.md', 1)
    expect(filterTasks([a, b], '!high')).toEqual([a])
  })

  it('drops tasks nothing matches', () => {
    const a = task('a.md', 0, { fields: { project: 'alpha' } })
    expect(filterTasks([a], '@project:zeta')).toEqual([])
  })
})

describe('filterTasks: tags in a file task\'s body (#1008)', () => {
  // A task made with New task: the title is frontmatter, the body is the note.
  const body = [
    '---',
    'title: Renew the passport',
    'status: open',
    'tags: [task]',
    '---',
    '',
    'Book the appointment first. #errands #Admin/Paperwork',
    ''
  ].join('\n')
  const fileTask = parseTaskFile(body, {
    path: 'inbox/Renew the passport.md',
    title: 'Renew the passport',
    folder: 'inbox'
  })!
  // What the note list carries for that note (the Tags view's source): the
  // frontmatter tags and the body's inline tags.
  const notes = [
    { path: 'inbox/Renew the passport.md', tags: ['task', 'errands', 'Admin/Paperwork'] },
    { path: 'inbox/Week.md', tags: ['errands'] }
  ]
  // A checkbox in another note that mentions #errands on a different line.
  const checkbox = task('inbox/Week.md', 0, { content: 'water the plants' })

  it('leaves the parsed task\'s own tags to the frontmatter', () => {
    expect(fileTask.kind).toBe('file')
    expect(fileTask.tags).toEqual([])
  })

  it('finds a file task by a tag written in its body', () => {
    const tags = noteTagsByPath(notes)
    expect(filterTasks([fileTask, checkbox], '#errands', tags)).toEqual([fileTask])
    expect(filterTasks([fileTask, checkbox], 'errands', tags)).toEqual([fileTask])
    expect(filterTasks([fileTask, checkbox], '#admin', tags)).toEqual([fileTask])
    expect(filterTasks([fileTask, checkbox], '#admin/paperwork', tags)).toEqual([fileTask])
  })

  it('keeps a checkbox task to its own line', () => {
    const tags = noteTagsByPath(notes)
    expect(filterTasks([checkbox], '#errands', tags)).toEqual([])
  })

  it('does not treat the task marker as a body tag', () => {
    const tags = noteTagsByPath(notes)
    expect(filterTasks([fileTask], '#task', tags)).toEqual([])
  })

  it('reads only the task line without the note tags, as before', () => {
    expect(filterTasks([fileTask], '#errands')).toEqual([])
  })

  it('carries the body tags through the list render', () => {
    const tags = noteTagsByPath(notes)
    const collapsed = {
      today: false,
      upcoming: false,
      undated: false,
      waiting: false,
      forwarded: false,
      done: false,
      cancelled: false
    }
    const render = computeTasksRender([fileTask, checkbox], '#errands', new Date(), collapsed, 'note', tags)
    expect(render.filtered).toEqual([fileTask])
  })
})

describe('applyFileOrder', () => {
  it('orders a group by task index within a note', () => {
    const out = applyFileOrder(groups([task('a.md', 2), task('a.md', 0), task('a.md', 1)]))
    expect(out.today.map((t) => t.taskIndex)).toEqual([0, 1, 2])
  })

  it('groups tasks by note (path) then line order', () => {
    const out = applyFileOrder(
      groups([task('b.md', 0), task('a.md', 1), task('a.md', 0), task('b.md', 1)])
    )
    expect(out.today.map((t) => t.id)).toEqual(['a.md#0', 'a.md#1', 'b.md#0', 'b.md#1'])
  })

  it('does not mutate the input array', () => {
    const input = [task('a.md', 1), task('a.md', 0)]
    applyFileOrder(groups(input))
    expect(input.map((t) => t.taskIndex)).toEqual([1, 0])
  })
})

describe('the list by priority (#989)', () => {
  const today = new Date(2026, 9, 23)
  const open = { today: false, upcoming: false, undated: false, waiting: false, forwarded: false, done: false, cancelled: false }

  it('puts high before medium before low before none inside each group, ties by due date then note order', () => {
    const tasks = [
      task('a.md', 0, { content: 'bank', priority: 'med', due: '2026-10-23' }),
      task('a.md', 1, { content: 'passport', priority: 'high', due: '2026-10-20' }),
      task('b.md', 0, { content: 'plants', due: '2026-10-23' }),
      task('b.md', 1, { content: 'invoice', priority: 'low', due: '2026-10-23' }),
      task('c.md', 0, { content: 'contract', priority: 'high', due: '2026-10-23' }),
      task('c.md', 1, { content: 'rent', priority: 'high', due: '2026-11-01' }),
      task('c.md', 2, { content: 'tickets', priority: 'low', due: '2026-11-04' })
    ]
    const byPriority = computeTasksRender(tasks, '', today, open, 'priority').groups
    expect(byPriority.today.map((t) => t.content)).toEqual(['passport', 'contract', 'bank', 'invoice', 'plants'])
    expect(byPriority.upcoming.map((t) => t.content)).toEqual(['rent', 'tickets'])
    const byNote = computeTasksRender(tasks, '', today, open).groups
    expect(byNote.today.map((t) => t.content)).toEqual(['bank', 'passport', 'plants', 'invoice', 'contract'])
  })

  it('keeps note order for the closed groups', () => {
    const done = [task('b.md', 0, { checked: true, priority: 'low' }), task('a.md', 0, { checked: true, priority: 'high' })]
    const g = applyPriorityOrder({ ...groups([]), done })
    expect(g.done.map((t) => t.sourcePath)).toEqual(['a.md', 'b.md'])
  })
})
