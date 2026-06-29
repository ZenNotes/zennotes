import { describe, expect, it } from 'vitest'
import {
  extractUncheckedTaskBlocks,
  moveTaskLine,
  removeTaskAtIndex,
  takeTaskLineAtIndex,
  setTaskCheckedAtIndex,
  setTaskDueAtIndex,
  setTaskPriorityAtIndex,
  setTaskTextAtIndex,
  setTaskWaitingAtIndex,
  toggleTaskAtIndex
} from '@shared/tasklists'

describe('toggleTaskAtIndex', () => {
  it('checks the right task by index', () => {
    const md = ['- [ ] a', '- [ ] b', '- [ ] c'].join('\n')
    expect(toggleTaskAtIndex(md, 1, true)).toBe(['- [ ] a', '- [x] b', '- [ ] c'].join('\n'))
  })

  it('skips fenced code blocks', () => {
    const md = ['- [ ] a', '```', '- [ ] inside', '```', '- [ ] b'].join('\n')
    // index 1 is the second OUTSIDE task ("b"), not the one inside the fence
    const next = toggleTaskAtIndex(md, 1, true)
    expect(next).toBe(['- [ ] a', '```', '- [ ] inside', '```', '- [x] b'].join('\n'))
  })

  it('returns markdown unchanged when index is out of range', () => {
    const md = '- [ ] only one'
    expect(toggleTaskAtIndex(md, 5, true)).toBe(md)
  })
})

describe('setTaskCheckedAtIndex', () => {
  it('is an alias for toggleTaskAtIndex', () => {
    const md = '- [ ] a'
    expect(setTaskCheckedAtIndex(md, 0, true)).toBe('- [x] a')
    expect(setTaskCheckedAtIndex('- [x] a', 0, false)).toBe('- [ ] a')
  })
})

describe('setTaskWaitingAtIndex', () => {
  it('appends @waiting when not present', () => {
    expect(setTaskWaitingAtIndex('- [ ] a', 0, true)).toBe('- [ ] a @waiting')
  })

  it('does nothing when @waiting is already there', () => {
    const md = '- [ ] a @waiting'
    expect(setTaskWaitingAtIndex(md, 0, true)).toBe(md)
  })

  it('removes @waiting and tidies whitespace', () => {
    expect(setTaskWaitingAtIndex('- [ ] a @waiting', 0, false)).toBe('- [ ] a')
    expect(setTaskWaitingAtIndex('- [ ] a @waiting due:2026-04-30', 0, false)).toBe(
      '- [ ] a due:2026-04-30'
    )
  })

  it('does nothing when @waiting is absent and waiting=false', () => {
    const md = '- [ ] a'
    expect(setTaskWaitingAtIndex(md, 0, false)).toBe(md)
  })

  it('only touches the indexed task', () => {
    const md = ['- [ ] a', '- [ ] b'].join('\n')
    expect(setTaskWaitingAtIndex(md, 1, true)).toBe(['- [ ] a', '- [ ] b @waiting'].join('\n'))
  })
})

describe('setTaskPriorityAtIndex', () => {
  it('appends a priority token when none is set', () => {
    expect(setTaskPriorityAtIndex('- [ ] a', 0, 'high')).toBe('- [ ] a !high')
  })

  it('replaces an existing priority token', () => {
    expect(setTaskPriorityAtIndex('- [ ] a !med', 0, 'high')).toBe('- [ ] a !high')
    expect(setTaskPriorityAtIndex('- [ ] !low a', 0, 'high')).toBe('- [ ] a !high')
  })

  it('removes the priority token when priority=null', () => {
    expect(setTaskPriorityAtIndex('- [ ] a !high', 0, null)).toBe('- [ ] a')
    expect(setTaskPriorityAtIndex('- [ ] a !high due:2026-04-30', 0, null)).toBe(
      '- [ ] a due:2026-04-30'
    )
  })

  it('handles short alias forms (h/m/l)', () => {
    expect(setTaskPriorityAtIndex('- [ ] a !h', 0, 'low')).toBe('- [ ] a !low')
  })

  it('does not match priority-like substrings inside content', () => {
    // `!medical` should NOT be treated as a `!med` token (word boundary).
    expect(setTaskPriorityAtIndex('- [ ] !medical record', 0, 'high')).toBe(
      '- [ ] !medical record !high'
    )
  })

  it('only touches the indexed task', () => {
    const md = ['- [ ] a !high', '- [ ] b'].join('\n')
    expect(setTaskPriorityAtIndex(md, 1, 'med')).toBe(['- [ ] a !high', '- [ ] b !med'].join('\n'))
  })
})

describe('setTaskDueAtIndex', () => {
  it('adds due dates', () => {
    expect(setTaskDueAtIndex('- [ ] a', 0, '2026-04-30')).toBe('- [ ] a due:2026-04-30')
  })

  it('replaces existing due dates', () => {
    expect(setTaskDueAtIndex('- [ ] a due:2026-04-29', 0, '2026-04-30')).toBe(
      '- [ ] a due:2026-04-30'
    )
  })

  it('replaces malformed due tokens too', () => {
    expect(setTaskDueAtIndex('- [ ] a due:tomorrow', 0, '2026-04-30')).toBe(
      '- [ ] a due:2026-04-30'
    )
  })

  it('removes existing due dates without disturbing other metadata', () => {
    expect(setTaskDueAtIndex('- [ ] a due:2026-04-30 !high', 0, null)).toBe(
      '- [ ] a !high'
    )
  })
})

describe('extractUncheckedTaskBlocks', () => {
  it('pulls out only unchecked tasks, leaving checked + prose behind', () => {
    const md = ['# 2026-06-16', '', '- [x] shipped', '- [ ] follow up', 'a note line'].join('\n')
    const { moved, rest } = extractUncheckedTaskBlocks(md)
    expect(moved).toEqual(['- [ ] follow up'])
    expect(rest).toBe(['# 2026-06-16', '', '- [x] shipped', 'a note line'].join('\n'))
  })

  it('moves tokens verbatim (future due dates are preserved)', () => {
    const md = ['- [ ] plan Q3 due:2026-09-01 !high', '- [x] done'].join('\n')
    const { moved } = extractUncheckedTaskBlocks(md)
    expect(moved).toEqual(['- [ ] plan Q3 due:2026-09-01 !high'])
  })

  it('carries indented child lines along with their task', () => {
    const md = ['- [ ] parent', '  - [ ] child', '  notes', '- [ ] sibling'].join('\n')
    const { moved, rest } = extractUncheckedTaskBlocks(md)
    expect(moved).toEqual(['- [ ] parent', '  - [ ] child', '  notes', '- [ ] sibling'])
    expect(rest).toBe('')
  })

  it('ignores checkboxes inside fenced code blocks', () => {
    const md = ['- [ ] real', '```', '- [ ] fenced', '```'].join('\n')
    const { moved, rest } = extractUncheckedTaskBlocks(md)
    expect(moved).toEqual(['- [ ] real'])
    expect(rest).toBe(['```', '- [ ] fenced', '```'].join('\n'))
  })

  it('returns nothing to move when all tasks are checked', () => {
    const md = ['- [x] a', '- [x] b'].join('\n')
    const { moved, rest } = extractUncheckedTaskBlocks(md)
    expect(moved).toEqual([])
    expect(rest).toBe(md)
  })
})

describe('setTaskTextAtIndex', () => {
  it('replaces the text after the checkbox, preserving the marker + check state', () => {
    expect(setTaskTextAtIndex('- [x] old text', 0, 'new text')).toBe('- [x] new text')
    expect(setTaskTextAtIndex('  - [ ] a\n  - [ ] b', 1, 'edited')).toBe('  - [ ] a\n  - [ ] edited')
  })

  it('writes tokens verbatim when included in the new text', () => {
    expect(setTaskTextAtIndex('- [ ] a', 0, 'do thing due:2026-07-01 !high')).toBe(
      '- [ ] do thing due:2026-07-01 !high'
    )
  })

  it('leaves an empty checkbox when text is blank', () => {
    expect(setTaskTextAtIndex('- [ ] something', 0, '   ')).toBe('- [ ]')
  })
})

describe('removeTaskAtIndex', () => {
  it('deletes the task line at the given index', () => {
    expect(removeTaskAtIndex('- [ ] a\n- [ ] b\n- [ ] c', 1)).toBe('- [ ] a\n- [ ] c')
  })

  it('keeps surrounding prose intact', () => {
    const md = ['# Day', '', '- [ ] keep', '- [ ] drop', 'a line'].join('\n')
    expect(removeTaskAtIndex(md, 1)).toBe(['# Day', '', '- [ ] keep', 'a line'].join('\n'))
  })

  it('does not count checkboxes inside fenced code', () => {
    const md = ['```', '- [ ] fenced', '```', '- [ ] real'].join('\n')
    expect(removeTaskAtIndex(md, 0)).toBe(['```', '- [ ] fenced', '```'].join('\n'))
  })

  it('returns markdown unchanged for an out-of-range index', () => {
    expect(removeTaskAtIndex('- [ ] only', 5)).toBe('- [ ] only')
  })
})

describe('takeTaskLineAtIndex', () => {
  it('returns the removed line plus the remaining body (for moving a task)', () => {
    const md = ['- [ ] a', '- [ ] b due:2026-07-01 !high', '- [ ] c'].join('\n')
    const { line, body } = takeTaskLineAtIndex(md, 1)
    expect(line).toBe('- [ ] b due:2026-07-01 !high')
    expect(body).toBe('- [ ] a\n- [ ] c')
  })

  it('returns a null line and the unchanged body when out of range', () => {
    const { line, body } = takeTaskLineAtIndex('- [ ] only', 9)
    expect(line).toBeNull()
    expect(body).toBe('- [ ] only')
  })
})

describe('moveTaskLine', () => {
  it('moves a task down past the next task (after)', () => {
    const md = ['- [ ] a', '- [ ] b', '- [ ] c'].join('\n')
    // move task 0 (a) to after task 1 (b)
    expect(moveTaskLine(md, 0, 1, 'after')).toBe(['- [ ] b', '- [ ] a', '- [ ] c'].join('\n'))
  })

  it('moves a task up before the previous task (before)', () => {
    const md = ['- [ ] a', '- [ ] b', '- [ ] c'].join('\n')
    // move task 2 (c) to before task 1 (b)
    expect(moveTaskLine(md, 2, 1, 'before')).toBe(['- [ ] a', '- [ ] c', '- [ ] b'].join('\n'))
  })

  it('keeps non-task lines in place when swapping across them', () => {
    // a (task0), checked b (task1), c (task2); move a to after c
    const md = ['- [ ] a', '- [x] b', '- [ ] c'].join('\n')
    expect(moveTaskLine(md, 0, 2, 'after')).toBe(['- [x] b', '- [ ] c', '- [ ] a'].join('\n'))
  })

  it('preserves the full line (indent + metadata)', () => {
    const md = ['  - [ ] a !high #x', '- [ ] b'].join('\n')
    expect(moveTaskLine(md, 0, 1, 'after')).toBe(['- [ ] b', '  - [ ] a !high #x'].join('\n'))
  })

  it('ignores tasks inside fenced code when counting', () => {
    const md = ['- [ ] a', '```', '- [ ] inside', '```', '- [ ] b'].join('\n')
    // task 0 = a, task 1 = b (inside fence skipped); move a after b
    expect(moveTaskLine(md, 0, 1, 'after')).toBe(
      ['```', '- [ ] inside', '```', '- [ ] b', '- [ ] a'].join('\n')
    )
  })

  it('is a no-op for out-of-range or same index', () => {
    const md = ['- [ ] a', '- [ ] b'].join('\n')
    expect(moveTaskLine(md, 0, 0, 'after')).toBe(md)
    expect(moveTaskLine(md, 9, 0, 'after')).toBe(md)
  })
})
