/**
 * List item folding for the rendered preview (#848), the counterpart of the
 * editor's list arrows: an item with block content under its first line (a
 * nested list, another paragraph, a code block) gets a ▾ in the gutter that
 * hides that content.
 *
 * Folded state lives in the DOM (`data-list-folded`), the contract the
 * preview heading folds keep: a re-render (an edit, a mode switch) opens
 * everything again.
 *
 * The arrow is the item's LAST child and absolutely placed: as the first it
 * would break `li.task-list-item > p:first-child`, which seats a loose
 * task's text beside its checkbox.
 */

const ARROW_CLASS = 'prose-list-fold-arrow'
const FOLDABLE_CLASS = 'prose-list-foldable'
const FOLDED_ATTR = 'data-list-folded'

const BLOCK_TAGS = new Set([
  'UL',
  'OL',
  'P',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'DIV',
  'FIGURE',
  'DETAILS',
  'HR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6'
])

function isBlock(node: Element): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName)
}

/**
 * What an item folds: every block after the one holding its first line. A
 * tight item keeps its text inline (after the checkbox, for a task), so all
 * of its blocks fold; a loose item wraps its text in a first `<p>`, which
 * stays.
 */
export function listItemFoldTargets(li: HTMLElement): HTMLElement[] {
  const blocks = Array.from(li.children).filter(isBlock)
  if (blocks.length === 0) return []
  let inlineFirst = false
  for (const node of Array.from(li.childNodes)) {
    if (node === blocks[0]) break
    if (node instanceof HTMLElement && node.classList.contains(ARROW_CLASS)) continue
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim()) continue
    inlineFirst = true
    break
  }
  return inlineFirst || blocks[0].tagName !== 'P' ? blocks : blocks.slice(1)
}

function setListItemFolded(li: HTMLElement, folded: boolean): void {
  for (const el of listItemFoldTargets(li)) el.style.display = folded ? 'none' : ''
  li.setAttribute(FOLDED_ATTR, folded ? 'true' : 'false')
  const arrow = li.querySelector<HTMLElement>(`:scope > .${ARROW_CLASS}`)
  if (!arrow) return
  arrow.classList.toggle('is-folded', folded)
  arrow.textContent = folded ? '▸' : '▾'
  arrow.setAttribute('aria-expanded', String(!folded))
  arrow.setAttribute('aria-label', folded ? 'Expand list item' : 'Collapse list item')
}

/** `• ` for a bullet, `N. ` for a number. */
function markerChars(li: HTMLElement): number {
  const list = li.parentElement
  if (!(list instanceof HTMLOListElement)) return 2
  const index = Array.from(list.children).filter((el) => el.tagName === 'LI').indexOf(li)
  const number = (list.start || 1) + Math.max(index, 0)
  return String(Math.abs(number)).length + 2
}

export function enhancePreviewListFolds(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('li').forEach((li) => {
    if (li.querySelector(`:scope > .${ARROW_CLASS}`)) return // idempotent
    if (listItemFoldTargets(li).length === 0) return
    li.classList.add(FOLDABLE_CLASS)
    li.setAttribute(FOLDED_ATTR, 'false')
    // The marker renders outside the item, right-aligned, so `10. ` reaches
    // further left than `9. `; the CSS seats the arrow by the marker's width
    // in characters. Set on every item: a custom property inherits, and a
    // bullet nested in a numbered item must not take its parent's width.
    li.style.setProperty('--z-list-marker-chars', String(markerChars(li)))

    const arrow = document.createElement('span')
    arrow.className = `${ARROW_CLASS} is-open`
    arrow.setAttribute('role', 'button')
    arrow.setAttribute('aria-label', 'Collapse list item')
    arrow.setAttribute('aria-expanded', 'true')
    arrow.setAttribute('contenteditable', 'false')
    arrow.textContent = '▾'
    arrow.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      setListItemFolded(li, li.getAttribute(FOLDED_ATTR) !== 'true')
    })
    li.append(arrow)
  })
}
