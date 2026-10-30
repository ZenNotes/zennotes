import { describe, expect, it } from 'vitest'
import { tasksKeySheet, type TasksKeySheet } from './tasks-keys'

const keysOf = (sheet: TasksKeySheet): string[] =>
  sheet.groups.flatMap((group) => group.rows.map((row) => row.keys))

// The keys Vim mode off leaves live on every Tasks surface: the arrows,
// Enter, Space, Tab and the menu key, plus the Shift+J/K reorder chord.
const VIM_OFF_KEYS = /^(← \/ →|↑ \/ ↓|Enter|Space|Tab|Shift\+F10|Shift\+J \/ K)$/

describe('the Tasks keys cheat sheet', () => {
  for (const view of ['kanban', 'list', 'calendar'] as const) {
    it(`names no Vim key on the ${view} with Vim mode off`, () => {
      const sheet = tasksKeySheet(view, { vimMode: false, dndEnabled: true, listOrder: 'note' })
      expect(keysOf(sheet).length).toBeGreaterThan(0)
      for (const key of keysOf(sheet)) expect(key).toMatch(VIM_OFF_KEYS)
      expect(sheet.mouse).not.toBe('')
    })

    it(`keeps each ${view} row to a chip and a few words`, () => {
      const sheet = tasksKeySheet(view, { vimMode: true, dndEnabled: true, listOrder: 'note' })
      for (const group of sheet.groups) {
        for (const row of group.rows) {
          expect(row.label.split(' ').length, `${row.keys} ${row.label}`).toBeLessThanOrEqual(3)
        }
      }
    })
  }

  it('lists the board keys with Vim mode on', () => {
    const keys = keysOf(tasksKeySheet('kanban', { vimMode: true, dndEnabled: true, listOrder: 'note' }))
    for (const key of ['h / l', 'j / k', 'x', 'Enter', 'Shift+H / L', '< / >', 'g', 's', 'v', 'E', '?']) {
      expect(keys).toContain(key)
    }
  })

  it('keeps a Subtasks group for the subtasks keys, off until they exist', () => {
    const titles = (subtasks: boolean, vimMode: boolean): string[] =>
      tasksKeySheet('kanban', { vimMode, dndEnabled: true, listOrder: 'note', subtasks }).groups.map((g) => g.title)
    expect(titles(false, true)).not.toContain('Subtasks')
    expect(titles(true, true)).toEqual(['Move', 'Cards', 'Subtasks', 'Columns', 'Board'])
    // Tab and Esc are not letters: the group shows with Vim mode off too.
    const off = tasksKeySheet('kanban', { vimMode: false, dndEnabled: true, listOrder: 'note', subtasks: true })
    expect(off.groups.map((g) => g.title)).toContain('Subtasks')
    for (const key of keysOf(off)) expect(key).toMatch(/^(← \/ →|↑ \/ ↓|Enter|Space|Shift\+F10|Tab \/ Shift\+Tab|Esc)$/)
  })

  it('leaves card moves off a board that cannot move cards', () => {
    const sheet = tasksKeySheet('kanban', { vimMode: true, dndEnabled: false, listOrder: 'note' })
    expect(keysOf(sheet)).not.toContain('Shift+H / L')
    expect(sheet.mouse).not.toMatch(/cards/)
  })

  it('offers the list reorder only in note order', () => {
    expect(keysOf(tasksKeySheet('list', { vimMode: true, dndEnabled: true, listOrder: 'note' }))).toContain('J / K')
    expect(keysOf(tasksKeySheet('list', { vimMode: true, dndEnabled: true, listOrder: 'priority' }))).not.toContain('J / K')
    expect(keysOf(tasksKeySheet('list', { vimMode: false, dndEnabled: true, listOrder: 'priority' }))).not.toContain('Shift+J / K')
  })
})
