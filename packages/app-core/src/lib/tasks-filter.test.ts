import { describe, it, expect } from 'vitest'
import type { VaultTask, VaultTaskGroups } from '@shared/tasks'
import { applyFileOrder } from './tasks-filter'

function task(sourcePath: string, taskIndex: number): VaultTask {
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
    waiting: false,
    tags: []
  }
}

function groups(today: VaultTask[]): VaultTaskGroups {
  return { today, upcoming: [], waiting: [], done: [], overdueCount: 0 }
}

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
