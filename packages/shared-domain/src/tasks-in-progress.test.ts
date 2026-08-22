import { describe, expect, it } from 'vitest'
import { extractOpenTaskBlocks, setTaskInProgressAtIndex, TASK_LINE_RE } from './tasklists'
import {
  bucketTasksByDueDate,
  groupTasks,
  isTaskOpen,
  parseTaskFile,
  parseTasksFromBody,
  tasksDueOn,
  type ParseTasksContext
} from './tasks'
import { setTaskFileInProgress } from './frontmatter'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }

describe('task in-progress primitives (#512)', () => {
  it('recognizes [/] as a task state', () => {
    expect(TASK_LINE_RE.test('- [/] started')).toBe(true)
    expect(TASK_LINE_RE.exec('- [/] x')?.[2]).toBe('/')
    expect(TASK_LINE_RE.exec('1. [/] x')?.[2]).toBe('/')
    expect(TASK_LINE_RE.exec('> - [/] x')?.[2]).toBe('/')
    // Neighbouring state chars keep their meaning.
    expect(TASK_LINE_RE.exec('- [-] x')?.[2]).toBe('-')
    expect(TASK_LINE_RE.exec('- [ ] x')?.[2]).toBe(' ')
  })

  it('setTaskInProgressAtIndex flips the state to [/] and back to [ ]', () => {
    expect(setTaskInProgressAtIndex('- [ ] Task 1', 0, true)).toBe('- [/] Task 1')
    expect(setTaskInProgressAtIndex('- [x] Task 1', 0, true)).toBe('- [/] Task 1')
    expect(setTaskInProgressAtIndex('- [/] Task 1', 0, false)).toBe('- [ ] Task 1')
  })

  it('leaves the tail (metadata tokens, wikilinks) untouched when flipping', () => {
    const line = '- [ ] Ship it due:2026-08-04 !high #work [[Spec]]'
    const started = setTaskInProgressAtIndex(line, 0, true)
    expect(started).toBe('- [/] Ship it due:2026-08-04 !high #work [[Spec]]')
    expect(setTaskInProgressAtIndex(started, 0, false)).toBe(line)
  })

  it('parses [/] as in progress, and as none of the closed states', () => {
    const t = parseTasksFromBody('- [/] Task 1', ctx)[0]
    expect(t.inProgress).toBe(true)
    expect(t.checked).toBe(false)
    expect(t.forwarded).toBe(false)
    expect(t.cancelled).toBe(false)
  })

  it('keeps in-progress tasks in the active buckets, not a bucket of their own', () => {
    const tasks = parseTasksFromBody(
      '- [ ] open\n- [/] started\n- [x] done\n- [>] gone [[X]]\n- [-] scrapped',
      ctx
    )
    const g = groupTasks(tasks, new Date(2026, 0, 1))
    // In progress is still today's work: it sits beside the open task rather
    // than collecting under a group of its own like forwarded/cancelled do.
    expect(g.today.map((t) => t.content)).toEqual(['open', 'started'])
    expect(g.done.map((t) => t.content)).toEqual(['done'])
    expect(g.forwarded.map((t) => t.content)).toEqual(['gone [[X]]'])
    expect(g.cancelled.map((t) => t.content)).toEqual(['scrapped'])
  })

  it('respects due dates the same as an open task', () => {
    const tasks = parseTasksFromBody(
      '- [/] later due:2026-02-01\n- [/] overdue due:2025-12-01',
      ctx
    )
    const g = groupTasks(tasks, new Date(2026, 0, 1))
    expect(g.upcoming.map((t) => t.content)).toEqual(['later'])
    expect(g.today.map((t) => t.content)).toEqual(['overdue'])
    expect(g.overdueCount).toBe(1)
  })

  it('keeps in-progress tasks on the calendar surfaces', () => {
    const tasks = parseTasksFromBody(
      ['- [ ] open due:2026-07-27', '- [/] started due:2026-07-27', '- [/] started undated'].join(
        '\n'
      ),
      ctx
    )
    expect(tasksDueOn(tasks, '2026-07-27').map((t) => t.content)).toEqual(['open', 'started'])
    const buckets = bucketTasksByDueDate(tasks)
    expect(buckets.get('2026-07-27')?.map((t) => t.content)).toEqual(['open', 'started'])
    expect(buckets.get('unscheduled')?.map((t) => t.content)).toEqual(['started undated'])
  })

  it('isTaskOpen counts in progress as open', () => {
    const [open, started, done, cancelled] = parseTasksFromBody(
      '- [ ] a\n- [/] b\n- [x] c\n- [-] d',
      ctx
    )
    expect([open, started, done, cancelled].map(isTaskOpen)).toEqual([true, true, false, false])
  })

  it('rolls in-progress tasks forward with the open ones, children included', () => {
    const md = [
      '- [ ] open',
      '- [/] started',
      '    - [x] a finished step',
      '- [x] done',
      '- [-] scrapped',
      '- [>] gone [[X]]'
    ].join('\n')
    const { moved, rest } = extractOpenTaskBlocks(md)
    // A half-done task is exactly what should land in tomorrow's note, and its
    // indented children travel with it.
    expect(moved).toEqual(['- [ ] open', '- [/] started', '    - [x] a finished step'])
    expect(rest).toBe('- [x] done\n- [-] scrapped\n- [>] gone [[X]]')
  })

  it('rolls a loose list forward whole, blank lines included (#611 review)', () => {
    const md = ['- [ ] task', '    - [ ] a', '', '    - [ ] b', '', 'A paragraph.'].join('\n')
    const { moved, rest } = extractOpenTaskBlocks(md)
    expect(moved).toEqual(['- [ ] task', '    - [ ] a', '', '    - [ ] b'])
    expect(rest).toBe('\nA paragraph.')
  })

  it('reads a file-task `status: in-progress` as in progress, and writes it', () => {
    const body = '---\ntags: [task]\ntitle: Rewrite\nstatus: in-progress\n---\n\nHalf done.'
    const t = parseTaskFile(body, ctx)
    expect(t?.inProgress).toBe(true)
    expect(t?.checked).toBe(false)
    expect(t?.cancelled).toBe(false)
    expect(isTaskOpen(t!)).toBe(true)

    const started = setTaskFileInProgress('---\ntags: [task]\nstatus: open\n---\n', true)
    expect(started).toContain('status: in-progress')
    const reopened = setTaskFileInProgress(started, false)
    expect(reopened).toContain('status: open')
  })

  it('accepts the hand-written spellings of in progress in frontmatter', () => {
    for (const status of ['doing', 'started', 'wip', 'in progress']) {
      const t = parseTaskFile(`---\ntags: [task]\nstatus: ${status}\n---\n`, ctx)
      expect(t?.inProgress, status).toBe(true)
    }
  })
})
