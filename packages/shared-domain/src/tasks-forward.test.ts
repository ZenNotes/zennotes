import { describe, expect, it } from 'vitest'
import { forwardTaskSubtreeAtIndex, setTaskForwardedAtIndex, TASK_LINE_RE } from './tasklists'
import {
  bucketTasksByDueDate,
  groupTasks,
  inferDailyTaskDueDates,
  parseTasksFromBody,
  type ParseTasksContext
} from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }

describe('task forwarding primitives (#316)', () => {
  it('recognizes [>] as a task state', () => {
    expect(TASK_LINE_RE.test('- [>] forwarded')).toBe(true)
    expect(TASK_LINE_RE.exec('- [>] x')?.[2]).toBe('>')
  })

  it('setTaskForwardedAtIndex flips the state to [>] and appends the link once', () => {
    expect(setTaskForwardedAtIndex('- [ ] Task 1', 0, '[[Target]]')).toBe('- [>] Task 1 [[Target]]')
    expect(setTaskForwardedAtIndex('- [>] Task 1 [[Target]]', 0, '[[Target]]')).toBe(
      '- [>] Task 1 [[Target]]'
    )
    expect(setTaskForwardedAtIndex('- [x] Task 1', 0, '[[T]]')).toBe('- [>] Task 1 [[T]]')
    expect(setTaskForwardedAtIndex('- [ ] Task 1', 0, '')).toBe('- [>] Task 1')
  })

  it('parses [>] as forwarded (not checked)', () => {
    const t = parseTasksFromBody('- [>] Task 1 [[Target]]', ctx)[0]
    expect(t.forwarded).toBe(true)
    expect(t.checked).toBe(false)
  })

  it('groups forwarded tasks into the forwarded bucket, out of today/done', () => {
    const tasks = parseTasksFromBody('- [ ] open\n- [x] done\n- [>] gone [[X]]', ctx)
    const g = groupTasks(tasks, new Date(2026, 0, 1))
    expect(g.forwarded.map((t) => t.content)).toEqual(['gone [[X]]'])
    expect(g.today.map((t) => t.content)).toEqual(['open'])
    expect(g.done.map((t) => t.content)).toEqual(['done'])
  })
})

describe('forwardTaskSubtreeAtIndex (#611)', () => {
  it('flips the parent and its open subtasks, keeping done/cancelled history in place', () => {
    const src = [
      '- [ ] Main task',
      '    - [ ] sub a',
      '    - [x] sub done',
      '    - [-] sub dropped',
      '    - [/] sub started',
      '- [ ] Sibling'
    ].join('\n')
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[Target]]')
    expect(body).toBe(
      [
        '- [>] Main task [[Target]]',
        '    - [>] sub a',
        '    - [x] sub done',
        '    - [-] sub dropped',
        '    - [>] sub started',
        '- [ ] Sibling'
      ].join('\n')
    )
    // The copy is the subtree BEFORE the flip: a faithful snapshot, with the
    // in-progress and closed states intact.
    expect(childLines).toEqual([
      '    - [ ] sub a',
      '    - [x] sub done',
      '    - [-] sub dropped',
      '    - [/] sub started'
    ])
  })

  it('carries every nesting level and plain continuation lines, tokens verbatim', () => {
    const src = [
      '- [ ] Upload run due:2026-08-20 !high',
      '  - [ ] country list #ops',
      '    - [x] France',
      '  a plain note line',
      '',
      '- [ ] After the blank'
    ].join('\n')
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[T]]')
    expect(childLines).toEqual([
      '  - [ ] country list #ops',
      '    - [x] France',
      '  a plain note line'
    ])
    const lines = body.split('\n')
    expect(lines[0]).toBe('- [>] Upload run due:2026-08-20 !high [[T]]')
    expect(lines[1]).toBe('  - [>] country list #ops')
    expect(lines[2]).toBe('    - [x] France')
    expect(lines[3]).toBe('  a plain note line')
    expect(lines[5]).toBe('- [ ] After the blank')
  })

  it('re-bases the subtree when the forwarded task is itself indented', () => {
    const src = ['- [ ] Outer', '  - [ ] Inner parent', '    - [ ] deep sub'].join('\n')
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 1, '[[T]]')
    expect(childLines).toEqual(['  - [ ] deep sub'])
    expect(body.split('\n')).toEqual([
      '- [ ] Outer',
      '  - [>] Inner parent [[T]]',
      '    - [>] deep sub'
    ])
  })

  it('stops the subtree at a dedent, leaving siblings untouched', () => {
    const src = ['- [ ] First', '    - [ ] child', '- [ ] Second', '    - [ ] second child'].join(
      '\n'
    )
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[T]]')
    expect(childLines).toEqual(['    - [ ] child'])
    expect(body).toContain('- [ ] Second\n    - [ ] second child')
  })

  it('is a no-op for an out-of-range index or an already-recorded forward', () => {
    expect(forwardTaskSubtreeAtIndex('- [ ] a\n  - [ ] b', 5, '[[T]]')).toEqual({
      body: '- [ ] a\n  - [ ] b',
      childLines: []
    })
    const done = '- [>] a [[T]]\n  - [ ] b'
    expect(forwardTaskSubtreeAtIndex(done, 0, '[[T]]')).toEqual({ body: done, childLines: [] })
  })

  it('counts task indexes fence-aware, like every other mutator', () => {
    const src = ['```', '- [ ] fake', '```', '- [ ] real', '  - [ ] sub'].join('\n')
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[T]]')
    expect(childLines).toEqual(['  - [ ] sub'])
    expect(body.split('\n')[3]).toBe('- [>] real [[T]]')
  })

  it('carries loose children across blank lines, like the rollover walk (#611 review)', () => {
    const src = ['- [ ] Parent', '    - [ ] a', '', '    - [ ] b', '- [ ] Sibling'].join('\n')
    const { body, childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[T]]')
    expect(childLines).toEqual(['    - [ ] a', '', '    - [ ] b'])
    expect(body.split('\n')).toEqual([
      '- [>] Parent [[T]]',
      '    - [>] a',
      '',
      '    - [>] b',
      '- [ ] Sibling'
    ])
  })

  it('re-bases mixed tab/space children by whitespace count (#611 review)', () => {
    const src = ['  - [ ] Parent', '\t\t\t- [ ] child'].join('\n')
    const { childLines } = forwardTaskSubtreeAtIndex(src, 0, '[[T]]')
    expect(childLines).toEqual(['\t- [ ] child'])
  })
})

describe('forwarded records on dated surfaces (#610)', () => {
  const dayCtx = (day: string): ParseTasksContext => ({
    path: `inbox/Daily Notes/${day}.md`,
    title: day,
    folder: 'inbox'
  })

  it('does not infer a daily due for a forwarded record, so a carry chain stays one task', () => {
    const dueByPath = new Map([
      ['inbox/Daily Notes/2026-08-15.md', '2026-08-15'],
      ['inbox/Daily Notes/2026-08-16.md', '2026-08-16']
    ])
    const record = parseTasksFromBody('- [>] Pay rent [[2026-08-16]]', dayCtx('2026-08-15'))
    const live = parseTasksFromBody('- [ ] Pay rent [[2026-08-15]]', dayCtx('2026-08-16'))
    const out = inferDailyTaskDueDates([...record, ...live], dueByPath)
    expect(out[0].due).toBeUndefined()
    expect(out[1].due).toBe('2026-08-16')
    expect(out[1].dueInferred).toBe(true)
  })

  it('keeps an explicit due: on a forwarded record, and buckets it on that date', () => {
    const tasks = parseTasksFromBody('- [>] pay due:2026-08-20 [[X]]', dayCtx('2026-08-15'))
    const out = inferDailyTaskDueDates(tasks, new Map([[tasks[0].sourcePath, '2026-08-15']]))
    expect(out[0].due).toBe('2026-08-20')
    expect(bucketTasksByDueDate(out).get('2026-08-20')?.length).toBe(1)
  })

  it('keeps an undated forwarded record off the calendar entirely, including unscheduled', () => {
    const tasks = parseTasksFromBody('- [>] gone [[X]]\n- [ ] still here', dayCtx('2026-08-15'))
    const buckets = bucketTasksByDueDate(tasks)
    expect(buckets.get('unscheduled')?.map((t) => t.content)).toEqual(['still here'])
  })
})
