/**
 * Heading-fold enhancement for the rendered preview.
 *
 * Walks every `h1`–`h6` inside the root, injects a clickable ▾ arrow
 * at its left margin, and on click collapses every following sibling
 * until the next heading of equal-or-higher level — matching
 * Obsidian's preview folding and the live-preview folding we already
 * ship for edit mode.
 *
 * Folded state lives entirely in the DOM (`data-heading-folded`). If
 * the preview re-renders (edit mode flip, body change) the fold
 * resets, which is the same contract Obsidian uses.
 */

const ARROW_CLASS = 'prose-heading-fold-arrow'
const FOLDED_ATTR = 'data-heading-folded'
const LEVEL_ATTR = 'data-heading-level'

function levelOfHeading(el: HTMLElement): number | null {
  const match = el.tagName.match(/^H([1-6])$/)
  return match ? Number(match[1]) : null
}

function gatherFoldTargets(heading: HTMLElement, level: number): HTMLElement[] {
  const targets: HTMLElement[] = []
  let node: Element | null = heading.nextElementSibling
  while (node) {
    if (node instanceof HTMLElement) {
      const sibLevel = levelOfHeading(node)
      if (sibLevel !== null && sibLevel <= level) break
      targets.push(node)
    }
    node = node.nextElementSibling
  }
  return targets
}

function applyFoldState(heading: HTMLElement, folded: boolean): void {
  const level = Number(heading.getAttribute(LEVEL_ATTR))
  if (!level) return
  for (const el of gatherFoldTargets(heading, level)) {
    el.style.display = folded ? 'none' : ''
  }
  heading.setAttribute(FOLDED_ATTR, folded ? 'true' : 'false')
  const arrow = heading.querySelector<HTMLElement>(`.${ARROW_CLASS}`)
  if (arrow) {
    arrow.classList.toggle('is-folded', folded)
    arrow.textContent = folded ? '▸' : '▾'
    arrow.setAttribute('aria-expanded', String(!folded))
    arrow.setAttribute('aria-label', folded ? 'Expand heading' : 'Collapse heading')
  }
}

export function enhancePreviewHeadingFolds(root: HTMLElement): void {
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  headings.forEach((heading) => {
    if (heading.querySelector(`.${ARROW_CLASS}`)) return // idempotent
    const level = levelOfHeading(heading)
    if (level === null) return
    heading.setAttribute(LEVEL_ATTR, String(level))
    heading.setAttribute(FOLDED_ATTR, 'false')
    heading.classList.add('prose-heading-foldable')

    const arrow = document.createElement('span')
    arrow.className = `${ARROW_CLASS} is-open`
    arrow.setAttribute('role', 'button')
    arrow.setAttribute('aria-label', 'Collapse heading')
    arrow.setAttribute('aria-expanded', 'true')
    arrow.setAttribute('contenteditable', 'false')
    arrow.textContent = '▾'
    arrow.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const folded = heading.getAttribute(FOLDED_ATTR) !== 'true'
      applyFoldState(heading, folded)
    })
    heading.insertBefore(arrow, heading.firstChild)
  })
}
