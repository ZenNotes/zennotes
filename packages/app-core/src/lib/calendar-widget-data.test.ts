// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { parseTasksFromBody } from '@shared/tasks'
import { useStore } from '../store'
import { dailyNoteLocationForDate } from './vault-layout'
import { getCalendarWidgetData } from './calendar-widget-data'
import { isoDateStr } from './calendar-data'

const NOW = new Date(2026, 9, 27, 9, 30) // Tue 27 Oct 2026

function meta(path: string, body: string): NoteMeta {
  return {
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: '',
  }
}

describe('getCalendarWidgetData', () => {
  let original: ReturnType<typeof useStore.getState>
  const files = new Map<string, string>()
  const readNote = vi.fn(async (path: string) => ({ ...meta(path, files.get(path) ?? ''), body: files.get(path) ?? '' }))

  function dailyPath(date: Date): string {
    const { title, subpath } = dailyNoteLocationForDate(date, useStore.getState().vaultSettings)
    return `inbox/${subpath ? `${subpath}/` : ''}${title}.md`
  }

  function load(): void {
    const notes = [...files].map(([path, body]) => meta(path, body))
    const vaultTasks = notes.flatMap((n) =>
      parseTasksFromBody(files.get(n.path)!, { path: n.path, title: n.title, folder: n.folder })
    )
    useStore.setState({ notes, vaultTasks })
  }

  beforeEach(() => {
    original = useStore.getState()
    files.clear()
    readNote.mockClear()
    Object.defineProperty(window, 'zen', { configurable: true, value: { readNote } })
    const settings = original.vaultSettings
    useStore.setState({
      vaultSettings: {
        ...settings,
        dailyNotes: { ...settings.dailyNotes, enabled: true, tasksDueOnNoteDate: true },
      },
      calendarWeekStart: 'monday',
      calendarShowWeekNumbers: true,
      showArchivedTasks: false,
      noteContents: {},
    })
  })

  afterEach(() => {
    useStore.setState(original, true)
  })

  it('covers the previous, current and next month grids from the week start', async () => {
    const data = await getCalendarWidgetData(NOW)
    expect(data.todayIso).toBe('2026-10-27')
    expect(data.weekStart).toBe(1)
    // September 2026's grid starts Monday 31 August; November's ends Sunday 6 December.
    expect(data.from).toBe('2026-08-31')
    expect(data.to).toBe('2026-12-06')
    expect(data.showWeekNumbers).toBe(true)
    expect(data.dailyEnabled).toBe(true)
  })

  it("marks a day's note with the panel's dots and its open tasks", async () => {
    const today = dailyPath(NOW)
    files.set(today, `${'word '.repeat(170)}\n- [ ] Buy Cougar Gold\n- [x] Done already\n`)
    files.set(dailyPath(new Date(2026, 9, 26)), '')
    load()
    const data = await getCalendarWidgetData(NOW)
    expect(data.days['2026-10-27']).toEqual({ dots: 3, faint: false, openTasks: 1 })
    expect(data.days['2026-10-26']).toEqual({ dots: 1, faint: true, openTasks: 0 })
    expect(data.days['2026-10-25']).toBeUndefined()
  })

  it('lists open tasks by due day: explicit dates and the daily note they live in', async () => {
    const today = dailyPath(NOW)
    files.set(today, '- [ ] In the daily note\n- [/] Started\n- [x] Finished\n')
    files.set('inbox/Errands.md', '- [ ] Amazon return due:2026-10-27\n- [ ] Later due:2026-11-03\n- [ ] Too far due:2027-03-01\n')
    load()
    const data = await getCalendarWidgetData(NOW)
    const day = data.agenda['2026-10-27']
    expect(day.total).toBe(3)
    expect(day.tasks.map((t) => [t.content, t.inDailyNote])).toEqual([
      ['In the daily note', true],
      ['Started', true],
      ['Amazon return', false],
    ])
    expect(data.agenda['2026-11-03'].tasks[0].content).toBe('Later')
    expect(Object.keys(data.agenda)).not.toContain('2027-03-01')
  })

  it("gives each task its line and the line core's toggle would write", async () => {
    files.set('inbox/Errands.md', '# Errands\n\n> - [/] Quoted, started due:2026-10-28\n1. [ ] Numbered due:2026-10-28\n')
    load()
    const [quoted, numbered] = (await getCalendarWidgetData(NOW)).agenda['2026-10-28'].tasks
    expect(quoted).toMatchObject({
      line: 2,
      raw: '> - [/] Quoted, started due:2026-10-28',
      toggled: '> - [x] Quoted, started due:2026-10-28',
      inProgress: true,
    })
    expect(numbered).toMatchObject({ line: 3, toggled: '1. [x] Numbered due:2026-10-28' })
  })

  it('caps a busy day but keeps its total', async () => {
    files.set('inbox/Lots.md', Array.from({ length: 5 }, (_, i) => `- [ ] T${i} due:2026-10-29`).join('\n'))
    load()
    const day = (await getCalendarWidgetData(NOW, 2)).agenda['2026-10-29']
    expect(day.total).toBe(5)
    expect(day.tasks.map((t) => t.content)).toEqual(['T0', 'T1'])
  })

  it("leaves out a trashed note's tasks the index still holds", async () => {
    files.set('inbox/Gone.md', '- [ ] Ghost due:2026-10-27')
    load()
    useStore.setState({ notes: [] })
    const data = await getCalendarWidgetData(NOW)
    expect(data.agenda['2026-10-27']).toBeUndefined()
  })

  it('reads a note again only after it changes', async () => {
    const today = dailyPath(NOW)
    files.set(today, 'hello')
    load()
    await getCalendarWidgetData(NOW)
    await getCalendarWidgetData(NOW)
    expect(readNote.mock.calls.filter(([p]) => p === today)).toHaveLength(1)
    useStore.setState({ notes: useStore.getState().notes.map((n) => ({ ...n, updatedAt: 2 })) })
    await getCalendarWidgetData(NOW)
    expect(readNote.mock.calls.filter(([p]) => p === today)).toHaveLength(2)
    expect(isoDateStr(NOW)).toBe('2026-10-27')
  })
})
