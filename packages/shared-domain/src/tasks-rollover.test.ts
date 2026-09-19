import { describe, expect, it } from 'vitest'
import { extractOpenTaskBlocks, insertTasksUnderTasksHeading } from './tasklists'

describe('daily task rollover placeholders', () => {
  it('leaves empty placeholders behind while moving unfinished work', () => {
    const body = '## Tasks\n\n- [ ]\n- [ ] Carry this task\n- [ ]  \n- [/] In progress\n'
    expect(extractOpenTaskBlocks(body)).toEqual({
      moved: ['- [ ] Carry this task', '- [/] In progress'],
      rest: '## Tasks\n\n- [ ]\n- [ ]  \n'
    })
  })

  it('rolls tasks out of a CRLF note and keeps its line endings (#817)', () => {
    const body = '## Tasks\r\n\r\n- [ ] Call the bank\r\n  - [ ] Ask about the fee\r\n- [x] Done\r\n- [ ]\r\n'
    expect(extractOpenTaskBlocks(body)).toEqual({
      moved: ['- [ ] Call the bank', '  - [ ] Ask about the fee'],
      rest: '## Tasks\r\n\r\n- [x] Done\r\n- [ ]\r\n'
    })
  })

  it('keeps an empty parent with meaningful indented children', () => {
    const body = '- [ ]\n  - [ ] Child task\n\n- [ ]\n  Details to carry\n'
    expect(extractOpenTaskBlocks(body).moved).toEqual([
      '- [ ]',
      '  - [ ] Child task',
      '- [ ]',
      '  Details to carry'
    ])
  })

  it('replaces template placeholders without removing existing tasks or other sections', () => {
    const body = '# Today\n\n## Tasks\n\n- [ ]\n- [ ] Existing\n- [ ]\n- [ ]\n\n## Notes\n\n- [ ]\n'
    expect(
      insertTasksUnderTasksHeading(body, ['- [ ] Carried'], {
        replaceEmptyPlaceholders: true
      })
    ).toBe('# Today\n\n## Tasks\n\n- [ ] Existing\n- [ ] Carried\n\n## Notes\n\n- [ ]\n')
  })

  it('preserves fenced examples, completed markers, and parents with children', () => {
    const body = '## Tasks\n\n- [ ]\n  Child detail\n- [x]\n```md\n- [ ]\n```\n- [ ]\n\n---\n'
    expect(
      insertTasksUnderTasksHeading(body, ['- [ ] Carried'], {
        replaceEmptyPlaceholders: true
      })
    ).toBe('## Tasks\n\n- [ ]\n  Child detail\n- [x]\n```md\n- [ ]\n```\n- [ ] Carried\n\n---\n')
  })

  it('handles templates without a Tasks heading', () => {
    expect(
      insertTasksUnderTasksHeading('- [ ]\n- [ ]\n', ['- [ ] Carried'], {
        replaceEmptyPlaceholders: true
      })
    ).toBe('- [ ] Carried\n')
  })

  it('keeps placeholders when there is no work to insert or replacement is not requested', () => {
    const body = '## Tasks\n\n- [ ]\n'
    expect(insertTasksUnderTasksHeading(body, [], { replaceEmptyPlaceholders: true })).toBe(body)
    expect(insertTasksUnderTasksHeading(body, ['- [ ] Added'])).toBe(
      '## Tasks\n\n- [ ]\n- [ ] Added\n'
    )
  })
})
