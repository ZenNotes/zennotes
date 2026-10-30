import { describe, expect, it } from 'vitest'
import fixtures from '../../bridge-contract/fixtures/task-subtasks.json'
import { parseTaskFile, parseTasksFromBody, type ParseTasksContext } from './tasks'

/** What every scanner hands the Tasks surfaces for one note: the file task
 *  first, then the checkboxes (desktop main, the phones, the Go server). */
function scanNote(body: string, note: ParseTasksContext) {
  const fileTask = parseTaskFile(body, note)
  const inline = parseTasksFromBody(body, note)
  return fileTask ? [fileTask, ...inline] : inline
}

describe('subtask parents, shared with the Go server (#1028)', () => {
  it.each(fixtures.cases)('$id', (fixture) => {
    const tasks = scanNote(fixture.body, fixture.note as ParseTasksContext)
    expect(tasks.map((task) => ({ id: task.id, parentId: task.parentId }))).toEqual(
      fixture.expectedTasks.map((task) => ({
        id: task.id,
        parentId: 'parentId' in task ? task.parentId : undefined
      }))
    )
  })

  it('leaves the key off a task without a parent, so its record is unchanged', () => {
    const [top, child] = parseTasksFromBody('- [ ] top\n  - [ ] child', {
      path: 'inbox/a.md',
      title: 'a',
      folder: 'inbox'
    })
    expect('parentId' in top).toBe(false)
    expect(child.parentId).toBe('inbox/a.md#0')
  })

  it('points at the file task even when it is scanned on its own', () => {
    const body = '---\ntags: [task]\n---\n- [ ] step'
    const [step] = parseTasksFromBody(body, { path: 'inbox/t.md', title: 't', folder: 'inbox' })
    expect(step.parentId).toBe('inbox/t.md#task')
  })

  it('keeps the file-task parent when an excluded note is scanned on purpose', () => {
    const body = '---\ntags: [task]\ntasks: false\n---\n- [ ] step'
    const ctx = { path: 'inbox/t.md', title: 't', folder: 'inbox' } as const
    expect(parseTasksFromBody(body, ctx)).toEqual([])
    const [step] = parseTasksFromBody(body, ctx, { includeExcluded: true })
    expect(step.parentId).toBe('inbox/t.md#task')
  })
})
