import { describe, expect, it } from 'vitest'
import { setTaskCancelledAtIndex, TASK_LINE_RE } from './tasklists'
import {
  bucketTasksByDay,
  groupTasks,
  isTaskOpen,
  parseTaskFile,
  parseTasksFromBody,
  tasksOnDay,
  type ParseTasksContext
} from './tasks'
import { setTaskFileCancelled } from './frontmatter'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }
// These tasks have no planned day, so the day they sit on does not depend on
// today; any date serves.
const TODAY = '2026-01-01'

describe('task cancelling primitives (#450)', () => {
  it('recognizes [-] as a task state', () => {
    expect(TASK_LINE_RE.test('- [-] cancelled')).toBe(true)
    expect(TASK_LINE_RE.exec('- [-] x')?.[2]).toBe('-')
    // A list marker `-` with an ordinary open box is still just open.
    expect(TASK_LINE_RE.exec('- [ ] x')?.[2]).toBe(' ')
  })

  it('setTaskCancelledAtIndex flips the state to [-] and back to [ ]', () => {
    expect(setTaskCancelledAtIndex('- [ ] Task 1', 0, true)).toBe('- [-] Task 1')
    expect(setTaskCancelledAtIndex('- [x] Task 1', 0, true)).toBe('- [-] Task 1')
    expect(setTaskCancelledAtIndex('- [-] Task 1', 0, false)).toBe('- [ ] Task 1')
  })

  it('parses [-] as cancelled (not checked or forwarded)', () => {
    const t = parseTasksFromBody('- [-] Task 1', ctx)[0]
    expect(t.cancelled).toBe(true)
    expect(t.checked).toBe(false)
    expect(t.forwarded).toBe(false)
  })

  it('groups cancelled tasks into the cancelled bucket, out of today/done/forwarded', () => {
    const tasks = parseTasksFromBody('- [ ] open\n- [x] done\n- [>] gone [[X]]\n- [-] scrapped', ctx)
    const g = groupTasks(tasks, new Date(2026, 0, 1))
    expect(g.cancelled.map((t) => t.content)).toEqual(['scrapped'])
    expect(g.undated.map((t) => t.content)).toEqual(['open'])
    expect(g.done.map((t) => t.content)).toEqual(['done'])
    expect(g.forwarded.map((t) => t.content)).toEqual(['gone [[X]]'])
  })

  it('keeps cancelled tasks off the calendar surfaces (#476)', () => {
    const tasks = parseTasksFromBody(
      [
        '- [ ] open due:2026-07-27',
        '- [-] scrapped due:2026-07-27',
        '- [x] done due:2026-07-27',
        '- [>] gone due:2026-07-27 [[X]]',
        '- [-] scrapped undated'
      ].join('\n'),
      ctx
    )

    // The sidepanel calendar (tasksOnDay) and the Tasks calendar
    // (bucketTasksByDay) both drop cancelled tasks: they used to render
    // them with an empty checkbox, alongside the actionable ones. A forwarded
    // `[>]` origin stays: its copy in the target note has no due date.
    expect(tasksOnDay(tasks, '2026-07-27', TODAY).map((t) => t.content)).toEqual(['open', 'gone [[X]]'])

    const buckets = bucketTasksByDay(tasks, TODAY)
    expect(buckets.get('2026-07-27')?.map((t) => t.content)).toEqual(['open', 'gone [[X]]'])
    // Undated cancelled tasks stay out of the calendar's "No date" strip too.
    expect(buckets.get('unscheduled')).toBeUndefined()
  })

  it('isTaskOpen treats only done and cancelled as closed', () => {
    const [open, scrapped, done, forwarded] = parseTasksFromBody(
      '- [ ] a\n- [-] b\n- [x] c\n- [>] d [[X]]',
      ctx
    )
    expect([open, scrapped, done, forwarded].map(isTaskOpen)).toEqual([true, false, false, true])
  })

  it('reads a file-task `status: cancelled` as cancelled, and writes it', () => {
    const body = '---\ntags: [task]\ntitle: Rewrite\nstatus: cancelled\n---\n\nAbandoned.'
    const t = parseTaskFile(body, ctx)
    expect(t?.cancelled).toBe(true)
    expect(t?.checked).toBe(false)

    const cancelled = setTaskFileCancelled('---\ntags: [task]\nstatus: open\n---\n', true)
    expect(cancelled).toContain('status: cancelled')
    const reopened = setTaskFileCancelled(cancelled, false)
    expect(reopened).toContain('status: open')
  })
})
