// @vitest-environment jsdom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import type { VaultTask } from '@shared/tasks'
import { parseTaskFile, parseTasksFromBody } from '@shared/tasks'
import fixtures from '../../../bridge-contract/fixtures/task-subtasks.json'
import { computeTaskRollups } from './cm-task-rollup'
import type { TaskRollup } from './task-rollup'
import {
  cardsMatchingFilter,
  foldSubtasks,
  nextSubtaskFocus,
  progressPercent,
  subtaskProgress
} from './kanban-subtasks'

const ctx = { path: 'inbox/Plan.md', title: 'Plan', folder: 'inbox' } as const

function parse(lines: string[]): VaultTask[] {
  return parseTasksFromBody(lines.join('\n'), ctx)
}

function contents(list: { task: VaultTask; depth: number }[] | undefined): string[] {
  return (list ?? []).map(({ task, depth }) => `${depth}:${task.content}`)
}

describe('foldSubtasks (#1028)', () => {
  it('folds a subtree into its top task, in note order, with depths', () => {
    const tasks = parse([
      '- [ ] Launch',
      '  - [x] Write copy',
      '  - [ ] Ship',
      '    - [ ] Build',
      '  - [-] Dropped',
      '- [ ] Next'
    ])
    const folded = foldSubtasks(tasks)
    expect(folded.cards.map((t) => t.content)).toEqual(['Launch', 'Next'])
    expect(contents(folded.subtasksByCard.get('inbox/Plan.md#0'))).toEqual([
      '1:Write copy',
      '1:Ship',
      '2:Build',
      '1:Dropped'
    ])
    expect(folded.subtasksByCard.get('inbox/Plan.md#5')).toBeUndefined()
  })

  it('keeps note order whatever order the tasks arrive in', () => {
    const tasks = parse(['- [ ] p', '  - [ ] a', '  - [ ] b']).reverse()
    expect(contents(foldSubtasks(tasks).subtasksByCard.get('inbox/Plan.md#0'))).toEqual([
      '1:a',
      '1:b'
    ])
  })

  it('lets a task whose parent is not in the list stand as a card', () => {
    const [, child] = parse(['- [ ] p', '  - [ ] orphaned'])
    expect(foldSubtasks([child]).cards).toEqual([child])
  })

  it('folds a task note’s checkboxes into the note’s card', () => {
    const body = '---\ntags: [task]\n---\n- [ ] step one\n  - [x] step one a\n- [x] step two'
    const note = { path: 'inbox/Ship.md', title: 'Ship', folder: 'inbox' } as const
    const tasks = [parseTaskFile(body, note)!, ...parseTasksFromBody(body, note)]
    const folded = foldSubtasks(tasks)
    expect(folded.cards.map((t) => t.id)).toEqual(['inbox/Ship.md#task'])
    expect(contents(folded.subtasksByCard.get('inbox/Ship.md#task'))).toEqual([
      '1:step one',
      '2:step one a',
      '1:step two'
    ])
  })

  it('survives parent links that loop, standing each looped task as a card', () => {
    const base = parse(['- [ ] a', '- [ ] b'])
    const looped = [
      { ...base[0], parentId: base[1].id },
      { ...base[1], parentId: base[0].id }
    ]
    expect(foldSubtasks(looped).cards.map((t) => t.content)).toEqual(['a', 'b'])
  })
})

describe('subtaskProgress (#1028)', () => {
  it('counts direct subtasks only, the way the note’s 2/5 chip does', () => {
    const tasks = parse([
      '- [ ] top',
      '  - [ ] middle',
      '    - [x] leaf a',
      '    - [x] leaf b',
      '  - [x] sibling'
    ])
    const folded = foldSubtasks(tasks)
    expect(subtaskProgress(tasks[0], folded.subtasksByCard.get(tasks[0].id) ?? [])).toEqual({
      done: 1,
      total: 2
    })
  })

  it('leaves cancelled and forwarded subtasks out and counts in-progress as open', () => {
    const tasks = parse([
      '- [ ] parent',
      '  - [-] dropped',
      '  - [>] moved',
      '  - [/] going',
      '  - [x] done'
    ])
    const subtasks = foldSubtasks(tasks).subtasksByCard.get(tasks[0].id) ?? []
    expect(subtaskProgress(tasks[0], subtasks)).toEqual({ done: 1, total: 2 })
  })

  it('has nothing to show when no subtask counts', () => {
    const tasks = parse(['- [ ] parent', '  - [-] dropped'])
    const subtasks = foldSubtasks(tasks).subtasksByCard.get(tasks[0].id) ?? []
    expect(subtaskProgress(tasks[0], subtasks)).toBeNull()
    expect(subtaskProgress(tasks[0], [])).toBeNull()
  })

  it('never claims 100% while a subtask is still open', () => {
    expect(progressPercent({ done: 2, total: 3 })).toBe(66)
    expect(progressPercent({ done: 199, total: 200 })).toBe(99)
    expect(progressPercent({ done: 5, total: 5 })).toBe(100)
    expect(progressPercent({ done: 0, total: 4 })).toBe(0)
  })
})

describe('nextSubtaskFocus: Tab steps through a card’s subtasks (#1028)', () => {
  it('walks from the card into each subtask and back to the card', () => {
    expect(nextSubtaskFocus(null, 2, 1)).toBe(0)
    expect(nextSubtaskFocus(0, 2, 1)).toBe(1)
    expect(nextSubtaskFocus(1, 2, 1)).toBeNull()
  })

  it('walks backwards with Shift+Tab', () => {
    expect(nextSubtaskFocus(null, 2, -1)).toBe(1)
    expect(nextSubtaskFocus(1, 2, -1)).toBe(0)
    expect(nextSubtaskFocus(0, 2, -1)).toBeNull()
  })

  it('stays on the card when it has no subtasks, and recovers a stale index', () => {
    expect(nextSubtaskFocus(null, 0, 1)).toBeNull()
    expect(nextSubtaskFocus(7, 2, 1)).toBeNull()
  })
})

describe('cardsMatchingFilter (#1028)', () => {
  it('keeps a card when the filter only matches one of its subtasks', () => {
    const tasks = parse(['- [ ] Launch', '  - [ ] email #urgent', '- [ ] Other'])
    const folded = foldSubtasks(tasks)
    expect(
      cardsMatchingFilter(folded.cards, folded.subtasksByCard, '#urgent', null).map((t) => t.content)
    ).toEqual(['Launch'])
    expect(
      cardsMatchingFilter(folded.cards, folded.subtasksByCard, 'other', null).map((t) => t.content)
    ).toEqual(['Other'])
    expect(cardsMatchingFilter(folded.cards, folded.subtasksByCard, '', null)).toBe(folded.cards)
  })
})

/** The editor's chip counts from CodeMirror's Markdown tree; the card counts
 *  from the parser's parent links. One body, one fraction, on both surfaces. */
function editorRollups(source: string): Map<number, TaskRollup> {
  const state = EditorState.create({ doc: source, extensions: [markdown()] })
  ensureSyntaxTree(state, source.length, 5_000)
  return computeTaskRollups(state.update({}).state, 1, state.doc.lines)
}

function cardRollups(source: string): Map<number, TaskRollup> {
  const tasks = parseTasksFromBody(source, ctx)
  const subtasks = new Map(tasks.map((t) => [t.id, [] as { task: VaultTask; depth: number }[]]))
  for (const task of tasks) if (task.parentId) subtasks.get(task.parentId)?.push({ task, depth: 1 })
  const out = new Map<number, TaskRollup>()
  for (const task of tasks) {
    const progress = subtaskProgress(task, subtasks.get(task.id) ?? [])
    if (progress) out.set(task.lineNumber + 1, progress)
  }
  return out
}

describe('the card counts what the note’s chip counts (#512, #1028)', () => {
  const corpus: string[] = [
    ...fixtures.cases
      .map((c) => c.body)
      .filter((body) => !body.startsWith('---'))
      .map((body) => body.replace(/\r\n/g, '\n')),
    '- [ ] parent\n  - [x] a\n  - [ ] b\n  - [ ] c',
    '- [ ] parent\n  - [/] started\n  - [x] finished',
    '- [ ] parent\n  - [-] dropped\n  - [>] moved\n  - [x] kept',
    '- [ ] top\n  - [ ] middle\n    - [x] leaf a\n    - [ ] leaf b\n  - [x] sibling',
    '- [ ] parent\n  - just a note\n    - [x] belongs to the note',
    '- [ ] parent\n  - [x]glued\n  - [ ] real',
    '- [ ]parent\n  - [x] a',
    '- [x] parent\n  - [ ] leftover',
    '- [ ] a\n    - [ ] four-space child\n        - [ ] eight-space grandchild',
    '* [ ] star\n  + [x] plus child\n- [ ] dash after star',
    '- [ ] parent\n<span>\n  - [x] a tag alone is text here',
    '- [ ] parent\n| a | b |\n  - [x] a table row is text here',
    '1. [ ] parent\n2.\n   - [x] belongs to the empty 2.',
    '- [ ] parent\n  -      code item\nnot text\n  - [x] top level'
  ]

  it.each(corpus.map((body, i) => [i, body] as const))('corpus %i', (_i, body) => {
    expect(cardRollups(body)).toEqual(editorRollups(body))
  })
})
