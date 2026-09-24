/**
 * The wrapper Preview puts around a task item's own text, so done and
 * cancelled styling (strike, gray) lands on that text and never on a nested
 * sub-task (#512). The CSS styles `> .task-item-body` in tight items and
 * `> p` in loose ones, whose text already sits in paragraphs.
 *
 * Only inline content is wrapped, one span per run, and every block child
 * stays where it is. The wrapper used to take every child but the checkbox,
 * paragraphs and sub-lists, and went in where the first of those sat: in a
 * loose item that was the whitespace ahead of a code block, so the code block
 * moved above the task's text (#849), and in a tight item a done task's code
 * block was struck through with it, which a loose item never does.
 */

const BLOCK_TAGS = new Set([
  'P',
  'UL',
  'OL',
  'DIV',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'HR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'DETAILS',
  'FIGURE',
  'DL'
])

export function wrapTaskItemOwnText(li: HTMLLIElement, checkbox: Element | null): void {
  if (li.querySelector(':scope > .task-item-body')) return
  let run: ChildNode[] = []
  const flush = (): void => {
    const hasText = run.some(
      (node) => node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() !== ''
    )
    if (hasText) {
      const body = li.ownerDocument.createElement('span')
      body.className = 'task-item-body'
      li.insertBefore(body, run[0])
      for (const node of run) body.appendChild(node)
    }
    run = []
  }
  for (const node of Array.from(li.childNodes)) {
    // The checkbox and the state marker bound a run rather than join it: the
    // marker sits in the gutter and must not be struck along with the text.
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null
    if (node === checkbox || el?.classList.contains('zen-task-state') || (el && BLOCK_TAGS.has(el.tagName))) {
      flush()
      continue
    }
    run.push(node)
  }
  flush()
}
