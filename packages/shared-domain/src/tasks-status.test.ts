import { describe, expect, it } from 'vitest'
import { parseTaskFile, parseTasksFromBody, type ParseTasksContext } from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/t.md', title: 't', folder: 'inbox' }
const parse = (body: string) => parseTasksFromBody(body, ctx)[0]

describe('parseTasksFromBody — inline @status token (#354)', () => {
  it('parses @status:<id> and lower-cases it', () => {
    const task = parse('- [ ] ship onboarding @status:Review')
    expect(task.status).toBe('review')
  })

  it('strips the token from display content', () => {
    const task = parse('- [ ] ship onboarding @status:review')
    expect(task.content).toBe('ship onboarding')
    expect(task.content).not.toContain('@status')
  })

  it('accepts slug ids with underscores/hyphens', () => {
    expect(parse('- [ ] a @status:in_progress').status).toBe('in_progress')
    expect(parse('- [ ] a @status:code-review').status).toBe('code-review')
  })

  it('coexists with due/priority/waiting tokens', () => {
    const task = parse('- [ ] a !high due:2026-04-30 @status:blocked @waiting')
    expect(task.status).toBe('blocked')
    expect(task.priority).toBe('high')
    expect(task.due).toBe('2026-04-30')
    expect(task.waiting).toBe(true)
    expect(task.content).toBe('a')
  })

  it('leaves status undefined when no token is present', () => {
    expect(parse('- [ ] plain task').status).toBeUndefined()
  })

  it('does not treat @waiting as a status', () => {
    expect(parse('- [ ] a @waiting').status).toBeUndefined()
  })

  it('falls back to the note frontmatter status: as a default', () => {
    const body = ['---', 'status: Backlog', '---', '- [ ] inherits', '- [ ] overrides @status:done'].join(
      '\n'
    )
    const tasks = parseTasksFromBody(body, ctx)
    expect(tasks[0].status).toBe('backlog')
    expect(tasks[1].status).toBe('done')
  })
})

describe('parseTasksFromBody — general @key:value fields (#354)', () => {
  it('parses several fields into the fields map, lower-cased', () => {
    const task = parse('- [ ] plan @status:Review @sprint:24 @area:Backend')
    expect(task.fields).toEqual({ status: 'review', sprint: '24', area: 'backend' })
  })

  it('exposes status as a convenience accessor over fields.status', () => {
    expect(parse('- [ ] a @status:review').status).toBe('review')
    expect(parse('- [ ] a @sprint:24').status).toBeUndefined()
  })

  it('strips every field token from the display content', () => {
    const task = parse('- [ ] ship it @status:review @sprint:24')
    expect(task.content).toBe('ship it')
  })

  it('keeps the first value when a key repeats', () => {
    expect(parse('- [ ] a @status:one @status:two').fields?.status).toBe('one')
  })

  it('does not treat @waiting (no colon) or a bare URL as a field', () => {
    const task = parse('- [ ] a @waiting see http://x/y')
    expect(task.fields).toEqual({})
    expect(task.waiting).toBe(true)
  })
})

describe('parseTaskFile — frontmatter status vs the custom-status field (#672)', () => {
  it('keeps a note that says nothing out of every custom-status column', () => {
    const body = '---\ntitle: Ship it\ntags: [ task ]\ndue: 2026-08-24\n---\n'
    const task = parseTaskFile(body, ctx)!
    expect(task.kind).toBe('file')
    // Effective state is still open: unchecked, not cancelled, not waiting.
    expect(task.status).toBe('open')
    expect(task.checked).toBe(false)
    expect(task.cancelled).toBe(false)
    // ...but it is not a custom status the author chose.
    expect(task.fields).toEqual({})
  })

  it('carries an explicit status: as the custom-status field, lower-cased', () => {
    const task = parseTaskFile('---\ntags: [task]\nstatus: Review\n---\n', ctx)!
    expect(task.status).toBe('review')
    expect(task.fields).toEqual({ status: 'review' })
  })

  it('treats an explicit status: open as a chosen status', () => {
    const task = parseTaskFile('---\ntags: [task]\nstatus: open\n---\n', ctx)!
    expect(task.fields).toEqual({ status: 'open' })
  })
})
