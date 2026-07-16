import { describe, expect, it } from 'vitest'
import { arrangeColumns, NO_VALUE_COLUMN_ID, type Column } from './TasksKanban'

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
