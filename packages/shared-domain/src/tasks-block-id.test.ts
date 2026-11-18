import { describe, expect, it } from 'vitest'
import { parseTasksFromBody, type ParseTasksContext } from './tasks'

const ctx: ParseTasksContext = { path: 'inbox/Chores.md', title: 'Chores', folder: 'inbox' }
const parse = (body: string) => parseTasksFromBody(body, ctx)

describe('parseTasksFromBody: a trailing ^id block marker', () => {
  it('stays out of the title every task surface shows, and stays on disk', () => {
    const [plants, ferns, cactus] = parse(
      '# Chores\n\n' +
        '- [ ] Water the plants @repeat:weekly due:2026-11-22 ^plants\n' +
        '  - [ ] Ferns ^ferns\n' +
        '  - [ ] Cactus\n'
    )
    expect(plants.content).toBe('Water the plants')
    expect(plants.due).toBe('2026-11-22')
    expect(plants.fields?.repeat).toBe('weekly')
    expect(plants.rawText).toBe('- [ ] Water the plants @repeat:weekly due:2026-11-22 ^plants')
    expect(ferns.content).toBe('Ferns')
    expect(ferns.rawText).toBe('  - [ ] Ferns ^ferns')
    expect(cactus.content).toBe('Cactus')
  })

  it('leaves a caret that is not a block id alone', () => {
    expect(parse('- [ ] Compute 2^3')[0].content).toBe('Compute 2^3')
    expect(parse('- [ ] Bump x ^ y')[0].content).toBe('Bump x ^ y')
  })

  it('leaves a task that is only a marker empty instead of showing the id', () => {
    expect(parse('- [ ] ^lonely')[0].content).toBe('')
  })
})
