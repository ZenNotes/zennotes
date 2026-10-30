import { describe, expect, it } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import {
  activeLaneBy,
  clampLaneCursor,
  laneCursorStep,
  laneFieldLabel,
  laneJump,
  laneOptions,
  nextLaneBy,
  parseLanesArg,
  type LaneShape
} from './kanban-lanes'
import { boardDropMutations, laneDropMutationsFor } from './task-column-mutations'

const TODAY = new Date('2026-10-30T12:00:00')

function task(over: Partial<VaultTask> = {}): VaultTask {
  return {
    id: 'inbox/a.md#0',
    sourcePath: 'inbox/a.md',
    noteTitle: 'a',
    noteFolder: 'inbox',
    lineNumber: 0,
    taskIndex: 0,
    rawText: '- [ ] a',
    content: 'a',
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: [],
    ...over
  }
}

describe('the lane fields a board offers (#1027)', () => {
  it('offers None, Priority, Folder, Tag, then the @fields, never the column field', () => {
    const values = laneOptions('status', ['sprint', 'area'], { customStatus: false, current: 'none' }).map(
      (o) => o.value
    )
    expect(values).toEqual(['none', 'priority', 'folder', 'tag', 'field:area', 'field:sprint'])
    const onPriority = laneOptions('priority', [], { customStatus: false, current: 'none' }).map((o) => o.value)
    expect(onPriority).not.toContain('priority')
    const onSprint = laneOptions('field:sprint', ['sprint', 'area'], { customStatus: false, current: 'none' })
    expect(onSprint.map((o) => o.value)).not.toContain('field:sprint')
  })

  it('offers Custom status once statuses exist, and keeps a chosen field nobody uses now', () => {
    const values = laneOptions('status', [], { customStatus: true, current: 'field:sprint' }).map((o) => o.value)
    expect(values).toEqual(['none', 'priority', 'folder', 'tag', 'field:status', 'field:sprint'])
  })

  it('labels each field in a few words', () => {
    expect(laneFieldLabel('none')).toBe('None')
    expect(laneFieldLabel('tag')).toBe('Tag')
    expect(laneFieldLabel('field:status')).toBe('Custom status')
    expect(laneFieldLabel('field:sprint')).toBe('@sprint')
  })

  it('shows no lanes while the columns use the lane field, and keeps the choice for later', () => {
    expect(activeLaneBy('priority', 'priority')).toBe('none')
    expect(activeLaneBy('status', 'priority')).toBe('priority')
    expect(activeLaneBy('field:sprint', 'field:sprint')).toBe('none')
  })

  it('cycles through the offered fields and back to None', () => {
    const options = laneOptions('status', [], { customStatus: false, current: 'none' })
    expect(nextLaneBy(options, 'none')).toBe('priority')
    expect(nextLaneBy(options, 'tag')).toBe('none')
    // A field the board no longer offers starts the cycle over.
    expect(nextLaneBy(options, 'field:gone')).toBe('none')
  })
})

describe(':lanes (#1027)', () => {
  it('reads a lane field the way people type it', () => {
    expect(parseLanesArg('')).toBe('none')
    expect(parseLanesArg('off')).toBe('none')
    expect(parseLanesArg('Priority')).toBe('priority')
    expect(parseLanesArg('tags')).toBe('tag')
    expect(parseLanesArg('status')).toBe('field:status')
    expect(parseLanesArg('@sprint')).toBe('field:sprint')
    expect(parseLanesArg('field:area')).toBe('field:area')
    expect(parseLanesArg('two words')).toBeNull()
  })
})

describe('the lane cursor (#1027)', () => {
  // The focused column's cell in three lanes: 2 cards, an empty cell, 1 card.
  const lanes: LaneShape[] = [
    { cards: 2, collapsed: false },
    { cards: 0, collapsed: false },
    { cards: 1, collapsed: false }
  ]
  const walk = (start: { laneIdx: number; cardIdx: number }, delta: -1 | 1, steps: number, shape = lanes) => {
    const seen = [start]
    let at = start
    for (let i = 0; i < steps; i += 1) {
      at = laneCursorStep(at, delta, shape)
      seen.push(at)
    }
    return seen.map((c) => `${c.laneIdx}:${c.cardIdx}`)
  }

  it('walks down from the column header through every lane header and cell', () => {
    // -1:-1 is the column header, L:-1 a lane header, L:0 an empty cell.
    expect(walk({ laneIdx: -1, cardIdx: -1 }, 1, 8)).toEqual([
      '-1:-1',
      '0:-1',
      '0:0',
      '0:1',
      '1:-1',
      '1:0',
      '2:-1',
      '2:0',
      '2:0'
    ])
  })

  it('walks back up the same stops to the column header, and stays there', () => {
    expect(walk({ laneIdx: 2, cardIdx: 0 }, -1, 8)).toEqual([
      '2:0',
      '2:-1',
      '1:0',
      '1:-1',
      '0:1',
      '0:0',
      '0:-1',
      '-1:-1',
      '-1:-1'
    ])
  })

  it('passes over a collapsed lane on its header', () => {
    const folded: LaneShape[] = [lanes[0], { cards: 4, collapsed: true }, lanes[2]]
    expect(walk({ laneIdx: 0, cardIdx: 1 }, 1, 3, folded)).toEqual(['0:1', '1:-1', '2:-1', '2:0'])
    expect(walk({ laneIdx: 2, cardIdx: -1 }, -1, 2, folded)).toEqual(['2:-1', '1:-1', '0:1'])
  })

  it('jumps lane header to lane header with { and }', () => {
    expect(laneJump({ laneIdx: -1, cardIdx: -1 }, 1, 3)).toEqual({ laneIdx: 0, cardIdx: -1 })
    expect(laneJump({ laneIdx: 0, cardIdx: 1 }, 1, 3)).toEqual({ laneIdx: 1, cardIdx: -1 })
    expect(laneJump({ laneIdx: 2, cardIdx: -1 }, 1, 3)).toEqual({ laneIdx: 2, cardIdx: -1 })
    // From a card, { goes to its own lane's header first, as in the Tags view.
    expect(laneJump({ laneIdx: 2, cardIdx: 0 }, -1, 3)).toEqual({ laneIdx: 2, cardIdx: -1 })
    expect(laneJump({ laneIdx: 2, cardIdx: -1 }, -1, 3)).toEqual({ laneIdx: 1, cardIdx: -1 })
    expect(laneJump({ laneIdx: 0, cardIdx: -1 }, -1, 3)).toEqual({ laneIdx: -1, cardIdx: -1 })
  })

  it('clamps a cursor the board shrank under: a folded lane holds it on the header', () => {
    expect(clampLaneCursor({ laneIdx: 5, cardIdx: 3 }, lanes)).toEqual({ laneIdx: 2, cardIdx: 0 })
    expect(clampLaneCursor({ laneIdx: 0, cardIdx: 1 }, [{ cards: 2, collapsed: true }])).toEqual({
      laneIdx: 0,
      cardIdx: -1
    })
    expect(clampLaneCursor({ laneIdx: 1, cardIdx: 0 }, [])).toEqual({ laneIdx: -1, cardIdx: -1 })
  })
})

describe('dropping a card on a lane (#1027)', () => {
  it('sets the priority of a priority lane, like the Priority board', () => {
    expect(laneDropMutationsFor('priority', 'high', task())).toEqual([{ kind: 'set-priority', priority: 'high' }])
    expect(laneDropMutationsFor('priority', 'none', task({ priority: 'low' }))).toEqual([
      { kind: 'set-priority', priority: null }
    ])
  })

  it('sets or clears the @field of a field lane', () => {
    expect(laneDropMutationsFor('field:sprint', '24', task())).toEqual([
      { kind: 'set-field', key: 'sprint', value: '24' }
    ])
    expect(laneDropMutationsFor('field:sprint', '__none__', task())).toEqual([
      { kind: 'set-field', key: 'sprint', value: null }
    ])
  })

  it('makes the lane tag the first tag, or strips them for No tag', () => {
    expect(laneDropMutationsFor('tag', 'home', task({ tags: ['work'] }))).toEqual([{ kind: 'set-tag', tag: 'home' }])
    expect(laneDropMutationsFor('tag', '__none__', task({ tags: ['work'] }))).toEqual([{ kind: 'set-tag', tag: null }])
  })

  it('refuses folder lanes, and a task note whose tags live in its frontmatter', () => {
    expect(laneDropMutationsFor('folder', 'Projects', task())).toBeNull()
    expect(laneDropMutationsFor('tag', 'home', task({ kind: 'file', tags: ['work'] }))).toBeNull()
  })

  it('changes only what the drop crossed: the column, the lane, or both', () => {
    const t = task({ due: '2026-10-30' })
    const from = { columnId: 'today', laneId: 'none' }
    // Same cell: a reorder, nothing to write.
    expect(boardDropMutations('status', 'priority', from, from, t, TODAY)).toEqual([])
    // Another lane, same column: only the priority.
    expect(boardDropMutations('status', 'priority', from, { columnId: 'today', laneId: 'high' }, t, TODAY)).toEqual([
      { kind: 'set-priority', priority: 'high' }
    ])
    // Another column, same lane: only the column's own tokens.
    const columnOnly = boardDropMutations('status', 'priority', from, { columnId: 'waiting', laneId: 'none' }, t, TODAY)
    expect(columnOnly).toEqual([
      { kind: 'set-checked', checked: false },
      { kind: 'set-waiting', waiting: true }
    ])
    // Both, in one write.
    expect(boardDropMutations('status', 'priority', from, { columnId: 'done', laneId: 'low' }, t, TODAY)).toEqual([
      { kind: 'set-checked', checked: true },
      { kind: 'set-priority', priority: 'low' }
    ])
  })

  it('refuses the whole drop when either half cannot land', () => {
    const from = { columnId: 'today', laneId: 'inbox' }
    // Folder lanes are read-only: another lane is refused, even with a column change.
    expect(boardDropMutations('status', 'folder', from, { columnId: 'done', laneId: 'Projects' }, task(), TODAY)).toBeNull()
    // Within the lane, the column still moves.
    expect(boardDropMutations('status', 'folder', from, { columnId: 'done', laneId: 'inbox' }, task(), TODAY)).toEqual([
      { kind: 'set-checked', checked: true }
    ])
    // A Folder board's columns stay read-only, but its lanes do not.
    expect(
      boardDropMutations('folder', 'priority', { columnId: 'a', laneId: 'none' }, { columnId: 'a', laneId: 'high' }, task(), TODAY)
    ).toEqual([{ kind: 'set-priority', priority: 'high' }])
    expect(
      boardDropMutations('folder', 'priority', { columnId: 'a', laneId: 'none' }, { columnId: 'b', laneId: 'none' }, task(), TODAY)
    ).toBeNull()
  })

  it('reads a lane header drop as the lane alone, and a column header drop as the column alone', () => {
    const from = { columnId: 'today', laneId: 'none' }
    expect(boardDropMutations('status', 'priority', from, { columnId: null, laneId: 'med' }, task(), TODAY)).toEqual([
      { kind: 'set-priority', priority: 'med' }
    ])
    expect(boardDropMutations('status', 'priority', from, { columnId: 'done', laneId: null }, task(), TODAY)).toEqual([
      { kind: 'set-checked', checked: true }
    ])
  })
})
