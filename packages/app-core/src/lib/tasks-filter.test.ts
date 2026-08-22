import { describe, it, expect } from 'vitest'
import type { VaultTask, VaultTaskGroups } from '@shared/tasks'
import { applyFileOrder, filterTasks } from './tasks-filter'

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
  return { today, upcoming: [], waiting: [], done: [], forwarded: [], cancelled: [], overdueCount: 0 }
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
