import { describe, expect, it } from 'vitest'
import { parseTasksFromBody } from '@shared/tasks'
import { emptyTasksShowLabel, isEmptyTask, withoutEmptyTasks } from './empty-tasks'

// A daily-note template's placeholders sit beside real work (#1026).
const body = [
  '# 2026-10-30',
  '- [ ]',
  '- [ ]   ',
  '- [ ] Call the bank',
  '- [ ] due:2026-10-31',
  '- [x] ',
  '- [ ] !high'
].join('\n')
const tasks = parseTasksFromBody(body, {
  path: 'Daily/2026-10-30.md',
  title: '2026-10-30',
  folder: 'inbox'
})

describe('empty tasks (#1026)', () => {
  it('counts a bare or whitespace-only checkbox as empty', () => {
    expect(tasks.map(isEmptyTask)).toEqual([true, true, false, false, true, false])
  })

  it('never hides a task with text, even text that is only a token', () => {
    const { shown, hidden } = withoutEmptyTasks(tasks)
    expect(shown.map((task) => task.content)).toEqual([
      'Call the bank',
      'due:2026-10-31',
      '!high'
    ])
    expect(hidden).toBe(3)
  })

  it('keeps the list itself when nothing is empty', () => {
    const real = tasks.filter((task) => !isEmptyTask(task))
    const result = withoutEmptyTasks(real)
    expect(result.shown).toBe(real)
    expect(result.hidden).toBe(0)
  })

  it('says what showing the hidden ones brings back', () => {
    expect(emptyTasksShowLabel(1)).toBe('Show 1 empty task')
    expect(emptyTasksShowLabel(3)).toBe('Show 3 empty tasks')
  })
})
