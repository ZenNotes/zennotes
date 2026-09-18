import { describe, expect, it } from 'vitest'
import fixtures from '../../bridge-contract/fixtures/task-roundtrip.json'
import { setTaskDueAtIndex } from './tasklists'
import { groupTasks, parseTasksFromBody, toIsoDateLocal, type ParseTasksContext } from './tasks'

describe('shared task roundtrip fixtures', () => {
  it.each(fixtures.cases)('$id', (fixture) => {
    const note = fixture.note as ParseTasksContext
    const before = parseTasksFromBody(fixture.body, note)
    expect(before).toHaveLength(fixture.expectedTaskCount)
    expect(before[fixture.taskIndex]).toMatchObject(fixture.expectedBefore)

    const localNow = fixture.localNow
      ? new Date(
          fixture.localNow[0],
          fixture.localNow[1] - 1,
          fixture.localNow[2],
          fixture.localNow[3],
          fixture.localNow[4]
        )
      : undefined
    const due = localNow ? toIsoDateLocal(localNow) : fixture.due!
    const saved = setTaskDueAtIndex(fixture.body, fixture.taskIndex, due)
    expect(saved).toBe(fixture.expectedBody)

    const after = parseTasksFromBody(saved, note)
    expect(after).toHaveLength(fixture.expectedTaskCount)
    expect(after[fixture.taskIndex]).toMatchObject(fixture.expectedAfter)
    expect(after[fixture.taskIndex].id).toBe(before[fixture.taskIndex].id)
    if (localNow) {
      expect(groupTasks(after, localNow).today.map((task) => task.id)).toContain(
        after[fixture.taskIndex].id
      )
    }
  })
})
