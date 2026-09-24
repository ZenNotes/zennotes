// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { wrapTaskItemOwnText } from './preview-task-body'

const fence = '```'
const stepOne = (box: string): string =>
  [
    `- [${box}] **1. Step one.** Open PowerShell and paste:`,
    `    ${fence}powershell`,
    '    Get-Date',
    `    ${fence}`,
    "    Expected: today's date."
  ].join('\n')

/** The first task item of `md`, rendered and wrapped the way Preview does. */
function wrappedTaskItem(md: string): HTMLLIElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(md)
  const li = host.querySelector<HTMLLIElement>('li.task-list-item')
  if (!li) throw new Error('no task item rendered')
  const checkbox = li.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'
  )
  wrapTaskItemOwnText(li, checkbox)
  return li
}

function inSourceOrder(li: HTMLLIElement, ...parts: string[]): boolean {
  const text = li.textContent ?? ''
  const at = parts.map((part) => text.indexOf(part))
  return at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1]))
}

describe('wrapTaskItemOwnText', () => {
  it('keeps a loose item in source order and leaves its paragraphs to the CSS (#849)', () => {
    const li = wrappedTaskItem(`${stepOne(' ')}\n\n- [ ] **2. Step two.** Text only\n`)
    expect(inSourceOrder(li, 'Step one', 'Get-Date', 'Expected')).toBe(true)
    expect(li.querySelector(':scope > .task-item-body')).toBeNull()
  })

  it("wraps a tight item's own text but never its code block", () => {
    const li = wrappedTaskItem(`${stepOne('x')}\n- [ ] **2. Step two.** Text only\n`)
    expect(inSourceOrder(li, 'Step one', 'Get-Date', 'Expected')).toBe(true)
    const bodies = [...li.querySelectorAll(':scope > .task-item-body')].map((b) => b.textContent)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('Step one')
    expect(bodies[1]).toContain('Expected')
    expect(li.querySelector('pre')?.closest('.task-item-body')).toBeNull()
  })

  it('leaves a sub-list outside the wrapper (#512)', () => {
    const li = wrappedTaskItem('- [x] Parent task\n  - [ ] Open sub-task\n')
    const body = li.querySelector(':scope > .task-item-body')
    expect(body?.textContent).toContain('Parent task')
    expect(body?.textContent).not.toContain('Open sub-task')
    expect(li.querySelector(':scope > ul')).not.toBeNull()
  })

  it('keeps the state marker out of the wrapper', () => {
    const li = wrappedTaskItem('- [/] Halfway there\n')
    const marker = li.querySelector('.zen-task-state')
    expect(marker).not.toBeNull()
    expect(marker?.closest('.task-item-body')).toBeNull()
    expect(li.querySelector(':scope > .task-item-body')?.textContent).toContain('Halfway there')
  })

  it('wraps once however often it runs', () => {
    const li = wrappedTaskItem(`${stepOne('x')}\n- [ ] Next\n`)
    wrapTaskItemOwnText(li, li.querySelector('input[type="checkbox"]'))
    expect(li.querySelectorAll('.task-item-body')).toHaveLength(2)
  })
})
