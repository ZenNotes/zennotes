// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from './markdown'
import { enhancePreviewListFolds } from './preview-list-fold'
import { wrapTaskItemOwnText } from './preview-task-body'

const md = [
  '- [ ] **Task title** #tag',
  '    - detail line',
  '    - another detail line',
  '- [ ] **Next task** #tag',
  '- plain bullet',
  '    1. numbered child',
  '1. First step',
  '    - step detail',
  '2. Second step',
  '',
  '- loose item',
  '',
  '    second paragraph',
  '',
  '- after'
].join('\n')

function mount(source = md): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(source)
  document.body.append(root)
  enhancePreviewListFolds(root)
  return root
}

/** An item's own first line: no arrow, nothing nested. */
const labelOf = (li: HTMLElement): string => {
  const copy = li.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.prose-list-fold-arrow, ul, ol').forEach((el) => el.remove())
  return (copy.textContent ?? '').trim().split('\n')[0].trim()
}

const itemStartingWith = (root: HTMLElement, text: string): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>('li')].find((li) => labelOf(li).startsWith(text))!

const arrowOf = (li: HTMLElement): HTMLElement | null => li.querySelector(':scope > .prose-list-fold-arrow')

describe('preview list folding (#848)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('puts an arrow on every item with content under its first line, and on no other', () => {
    const root = mount()
    const withArrow = [...root.querySelectorAll<HTMLElement>('li')].filter((li) => arrowOf(li)).map(labelOf)
    expect(withArrow).toEqual(['Task title #tag', 'plain bullet', 'First step', 'loose item'])
  })

  it('keeps the arrow out of a task body wrapped before it, as the preview renders', () => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown(md)
    document.body.append(root)
    root.querySelectorAll<HTMLLIElement>('li.task-list-item').forEach((li) =>
      wrapTaskItemOwnText(li, li.querySelector(':scope > input'))
    )
    enhancePreviewListFolds(root)
    const task = itemStartingWith(root, 'Task title')
    const arrow = arrowOf(task)!
    expect(arrow).not.toBeNull()
    expect(task.querySelector('.task-item-body')!.contains(arrow)).toBe(false)
    arrow.click()
    expect(task.querySelector<HTMLElement>(':scope > ul')!.style.display).toBe('none')
    expect(task.querySelector<HTMLElement>('.task-item-body')!.style.display).toBe('')
  })

  it('leaves a loose task paragraph first, where its checkbox styling expects it', () => {
    const root = mount(['- [ ] loose task', '', '    more about it', ''].join('\n'))
    const task = root.querySelector<HTMLElement>('li.task-list-item')!
    expect(arrowOf(task)).not.toBeNull()
    const [first, second] = [...task.querySelectorAll<HTMLElement>(':scope > p')]
    expect(task.querySelector(':scope > p:first-child')).toBe(first)
    arrowOf(task)!.click()
    expect(first.style.display).toBe('')
    expect(second.style.display).toBe('none')
  })

  it('tells the CSS how wide a numbered item marker is', () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. step ${i + 1}\n    - detail`).join('\n')
    const root = mount(items)
    const chars = [...root.querySelectorAll<HTMLElement>('ol > li')].map((li) =>
      li.style.getPropertyValue('--z-list-marker-chars')
    )
    expect(chars).toEqual(['3', '3', '3', '3', '3', '3', '3', '3', '3', '4'])
  })

  it('gives a bullet nested in a numbered item its own marker width', () => {
    const root = mount(['1. step', '    - bullet', '        - detail', ''].join('\n'))
    const bullet = itemStartingWith(root, 'bullet')
    expect(bullet.style.getPropertyValue('--z-list-marker-chars')).toBe('2')
  })

  it('folds the list nested under a task from the arrow and opens it again', () => {
    const root = mount()
    const task = itemStartingWith(root, 'Task title')
    const nested = task.querySelector<HTMLElement>(':scope > ul')!
    const arrow = arrowOf(task)!
    arrow.click()
    expect(nested.style.display).toBe('none')
    expect(task.getAttribute('data-list-folded')).toBe('true')
    expect(arrow.classList.contains('is-folded')).toBe(true)
    expect(arrow.getAttribute('aria-expanded')).toBe('false')
    arrow.click()
    expect(nested.style.display).toBe('')
    expect(task.getAttribute('data-list-folded')).toBe('false')
  })

  it('keeps the first paragraph of a loose item and folds the rest', () => {
    const root = mount()
    const loose = itemStartingWith(root, 'loose item')
    const [first, second] = [...loose.querySelectorAll<HTMLElement>(':scope > p')]
    arrowOf(loose)!.click()
    expect(first.style.display).toBe('')
    expect(second.style.display).toBe('none')
  })

  it('stays out of the preview click handling and adds no second arrow', () => {
    const root = mount()
    const onClick = vi.fn()
    root.addEventListener('click', onClick)
    arrowOf(itemStartingWith(root, 'plain bullet'))!.click()
    expect(onClick).not.toHaveBeenCalled()
    enhancePreviewListFolds(root)
    expect(root.querySelectorAll('.prose-list-fold-arrow')).toHaveLength(4)
  })
})
