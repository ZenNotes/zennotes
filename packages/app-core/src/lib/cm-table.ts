/**
 * WYSIWYG table editing for the Edit-mode editor — an Obsidian-style live
 * table. Each GFM pipe table is replaced by a block widget that renders a real
 * `<table>` with editable cells and GUI affordances (add/move/delete rows &
 * columns, alignment, sort, drag-to-reorder). The markdown source stays the
 * single source of truth: every edit re-serializes the table model
 * (`markdown-table.ts`) and writes it back as one CodeMirror change, so undo,
 * autosave, and multi-pane sync keep working.
 *
 * The replaced range is also marked atomic, so the CM caret never lands in the
 * raw `| pipe |` text — all editing happens through the widget. (Raw source
 * editing still lives in Split mode, which doesn't load this extension.)
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`; never loads in Split.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view'
import {
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  serializeTable,
  type MarkdownTable
} from './markdown-table'
import { openTableContextMenu } from './cm-table-menu'
import { renderMarkdown } from './markdown'

/** Render a cell's markdown source to inline HTML (sanitized by the markdown
 *  pipeline). Strips the wrapping `<p>` so the content sits inline in the cell.
 *  Empty cells render nothing. */
function renderInlineCell(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const html = renderMarkdown(trimmed).trim()
  const match = html.match(/^<p[^>]*>([\s\S]*?)<\/p>\s*$/)
  return match ? match[1] : html
}

/** Find the enclosing `Table` node range for a doc position, or null. */
function tableRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(view.state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'Table') return { from: node.from, to: node.to }
    if (!node.parent) break
    node = node.parent
  }
  return null
}

/**
 * Re-serialize `table` and write it over whichever Table node currently sits
 * under the widget's DOM. Resolving the range live (via posAtDOM) keeps the
 * write correct even when edits elsewhere have shifted the document.
 */
function commitTable(view: EditorView, dom: HTMLElement, table: MarkdownTable): void {
  let pos: number
  try {
    pos = view.posAtDOM(dom)
  } catch {
    return
  }
  const range = tableRangeAt(view, pos)
  if (!range) return
  const next = serializeTable(table)
  if (next === view.state.sliceDoc(range.from, range.to)) return
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next }
  })
}

type CellAddress = { row: number; col: number }

class TableWidget extends WidgetType {
  /** Working copy edited in place by the cells; committed on focus-out. */
  private model: MarkdownTable
  private dom: HTMLElement | null = null
  private dirty = false
  /** Set in toDOM — CodeMirror hands the live view there. Block widgets are
   *  provided by a StateField, which has no view at build time. */
  private view!: EditorView

  constructor(
    /** Raw markdown of the table block — drives `eq` so unchanged tables keep
     *  their DOM (and any in-progress cell focus) across rebuilds. */
    private readonly source: string,
    parsed: MarkdownTable
  ) {
    super()
    this.model = parsed
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  /** Commit a concrete next-model: re-serialize and write it over the source.
   *  The dispatch rebuilds the decorations (a fresh widget), so we refocus the
   *  requested cell on the next frame. Used by the context menu, which has
   *  already computed `next` from the current model. */
  private applyModel(next: MarkdownTable, focus?: CellAddress): void {
    // Capture the live range BEFORE the dispatch detaches our DOM.
    const dom = this.dom as HTMLElement
    this.model = next
    this.dirty = false
    commitTable(this.view, dom, next)
    if (focus) {
      requestAnimationFrame(() => this.focusCellAt(focus))
    }
  }

  /** Pull pending cell edits into the model, then apply a structural
   *  transform and commit — all without an intermediate dispatch, so our DOM
   *  stays attached for the single `commitTable` write. */
  private applyTransform(
    fn: (model: MarkdownTable) => MarkdownTable,
    focus?: CellAddress
  ): void {
    this.syncFromDom()
    this.applyModel(fn(this.model), focus)
  }

  private focusCellAt(addr: CellAddress): void {
    const view = this.view
    const dom = view.contentDOM.querySelector<HTMLElement>(
      `.cm-table-widget [data-row="${addr.row}"][data-col="${addr.col}"]`
    )
    if (dom) {
      dom.focus()
      placeCaretEnd(dom)
    }
  }

  /** Pull every cell's text out of the DOM into the model. `data-raw` holds the
   *  markdown source — `textContent` would lose it when a cell shows rendered
   *  inline markup (e.g. `code` chips). */
  private syncFromDom(): void {
    if (!this.dom) return
    const cells = this.dom.querySelectorAll<HTMLElement>('[data-row]')
    cells.forEach((cell) => {
      const row = Number(cell.dataset.row)
      const col = Number(cell.dataset.col)
      const value = cell.dataset.raw ?? cell.textContent ?? ''
      if (row === -1) this.model.headers[col] = value
      else if (this.model.rows[row]) this.model.rows[row][col] = value
    })
  }

  private commitIfDirty(): void {
    if (!this.dirty) return
    this.syncFromDom()
    this.dirty = false
    commitTable(this.view, this.dom as HTMLElement, this.model)
  }

  toDOM(view: EditorView): HTMLElement {
    this.view = view
    const root = document.createElement('div')
    root.className = 'cm-table-widget'
    root.setAttribute('contenteditable', 'false')
    this.dom = root

    const wrapper = document.createElement('div')
    wrapper.className = 'cm-table-wrapper'

    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.model.headers.forEach((text, col) => {
      headRow.append(this.buildCell('th', -1, col, text))
    })
    thead.append(headRow)
    table.append(thead)

    const tbody = document.createElement('tbody')
    this.model.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      row.forEach((text, col) => tr.append(this.buildCell('td', r, col, text)))
      tbody.append(tr)
    })
    table.append(tbody)
    wrapper.append(table)

    // Add-row / add-column buttons (appear on hover via CSS).
    const addCol = document.createElement('button')
    addCol.type = 'button'
    addCol.className = 'cm-table-add cm-table-add-col'
    addCol.textContent = '+'
    addCol.title = 'Add column'
    addCol.addEventListener('mousedown', (e) => e.preventDefault())
    addCol.addEventListener('click', (e) => {
      e.preventDefault()
      const col = this.model.headers.length
      this.applyTransform((m) => insertColumn(m, m.headers.length), { row: -1, col })
    })

    const addRow = document.createElement('button')
    addRow.type = 'button'
    addRow.className = 'cm-table-add cm-table-add-row'
    addRow.textContent = '+'
    addRow.title = 'Add row'
    addRow.addEventListener('mousedown', (e) => e.preventDefault())
    addRow.addEventListener('click', (e) => {
      e.preventDefault()
      const row = this.model.rows.length
      this.applyTransform((m) => insertRow(m, m.rows.length), { row, col: 0 })
    })

    wrapper.append(addCol, addRow)
    root.append(wrapper)

    // Commit when focus leaves the whole widget.
    root.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null
      if (next && root.contains(next)) return
      this.commitIfDirty()
    })

    return root
  }

  private buildCell(
    tag: 'th' | 'td',
    row: number,
    col: number,
    text: string
  ): HTMLTableCellElement {
    const cell = document.createElement(tag)
    const align = this.model.aligns[col] ?? 'none'
    if (align !== 'none') cell.setAttribute('align', align)

    const editable = document.createElement('div')
    editable.className = 'cm-table-cell'
    editable.dataset.row = String(row)
    editable.dataset.col = String(col)
    editable.dataset.raw = text
    editable.setAttribute('contenteditable', 'true')
    // Idle: show rendered inline markdown (code/bold/links). Editing: show the
    // raw source. `data-raw` stays authoritative for commits either way.
    editable.innerHTML = renderInlineCell(text)
    editable.dataset.rendered = 'true'

    editable.addEventListener('focus', () => {
      if (editable.dataset.rendered === 'true') {
        editable.textContent = editable.dataset.raw ?? ''
        editable.dataset.rendered = 'false'
        placeCaretEnd(editable)
      }
    })
    editable.addEventListener('input', () => {
      this.dirty = true
      editable.dataset.raw = editable.textContent ?? ''
    })
    editable.addEventListener('blur', () => {
      const raw = editable.textContent ?? ''
      editable.dataset.raw = raw
      editable.innerHTML = renderInlineCell(raw)
      editable.dataset.rendered = 'true'
    })
    editable.addEventListener('keydown', (event) => this.onCellKeydown(event, row, col))
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // Pull pending edits into the model (no dispatch) so the menu acts on
      // the current contents; the chosen action commits in one write.
      this.syncFromDom()
      openTableContextMenu({
        x: event.clientX,
        y: event.clientY,
        row,
        col,
        model: this.model,
        apply: (next, focus) => this.applyModel(next, focus)
      })
    })
    cell.append(editable)

    // Drag handles: row grip on the first cell of each body row, column grip
    // above each header cell. They appear on hover (CSS) and start a manual
    // pointer-drag to reorder.
    if (row >= 0 && col === 0) {
      cell.append(this.buildDragHandle('row', row))
    }
    if (row === -1) {
      cell.append(this.buildDragHandle('col', col))
    }
    return cell
  }

  private buildDragHandle(kind: 'row' | 'col', index: number): HTMLElement {
    const handle = document.createElement('div')
    handle.className = kind === 'row' ? 'cm-table-row-handle' : 'cm-table-col-handle'
    handle.setAttribute('contenteditable', 'false')
    handle.title = kind === 'row' ? 'Drag to move row' : 'Drag to move column'
    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      if (kind === 'row') this.startRowDrag(index)
      else this.startColDrag(index)
    })
    return handle
  }

  /** Drag a body row to a new position. Tracks the pointer, draws a drop
   *  indicator, and commits a `moveRow` on release. */
  private startRowDrag(fromRow: number): void {
    const dom = this.dom
    if (!dom) return
    this.syncFromDom()
    const wrapper = dom.querySelector<HTMLElement>('.cm-table-wrapper')
    const rows = Array.from(dom.querySelectorAll<HTMLElement>('tbody tr'))
    if (!wrapper || rows.length === 0) return
    dom.classList.add('is-dragging')
    const indicator = document.createElement('div')
    indicator.className = 'cm-table-drop-indicator cm-table-drop-row'
    wrapper.append(indicator)

    // Which row is the pointer over? Drop-onto-row semantics: the dragged row
    // moves into that row's slot (so dropping row 0 anywhere on row 1 swaps
    // them), which is far more intuitive than a midpoint insertion gap.
    const hoveredFor = (y: number): number => {
      for (let i = 0; i < rows.length; i++) {
        if (y <= rows[i].getBoundingClientRect().bottom) return i
      }
      return rows.length - 1
    }
    const place = (hovered: number): void => {
      if (hovered === fromRow) {
        indicator.style.display = 'none'
        return
      }
      indicator.style.display = 'block'
      const wrect = wrapper.getBoundingClientRect()
      const rect = rows[hovered].getBoundingClientRect()
      // Line on the far edge in the drag direction.
      const top = (hovered > fromRow ? rect.bottom : rect.top) - wrect.top
      indicator.style.top = `${top}px`
    }
    place(fromRow)

    const onMove = (e: MouseEvent): void => place(hoveredFor(e.clientY))
    const onUp = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      indicator.remove()
      dom.classList.remove('is-dragging')
      const hovered = hoveredFor(e.clientY)
      if (hovered !== fromRow) {
        this.applyModel(moveRow(this.model, fromRow, hovered))
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Drag a column to a new position. */
  private startColDrag(fromCol: number): void {
    const dom = this.dom
    if (!dom) return
    this.syncFromDom()
    const wrapper = dom.querySelector<HTMLElement>('.cm-table-wrapper')
    const headers = Array.from(dom.querySelectorAll<HTMLElement>('thead th'))
    if (!wrapper || headers.length === 0) return
    dom.classList.add('is-dragging')
    const indicator = document.createElement('div')
    indicator.className = 'cm-table-drop-indicator cm-table-drop-col'
    wrapper.append(indicator)

    // Drop-onto-column semantics, mirroring rows.
    const hoveredFor = (x: number): number => {
      for (let i = 0; i < headers.length; i++) {
        if (x <= headers[i].getBoundingClientRect().right) return i
      }
      return headers.length - 1
    }
    const place = (hovered: number): void => {
      if (hovered === fromCol) {
        indicator.style.display = 'none'
        return
      }
      indicator.style.display = 'block'
      const wrect = wrapper.getBoundingClientRect()
      const rect = headers[hovered].getBoundingClientRect()
      const left = (hovered > fromCol ? rect.right : rect.left) - wrect.left
      indicator.style.left = `${left}px`
    }
    place(fromCol)

    const onMove = (e: MouseEvent): void => place(hoveredFor(e.clientX))
    const onUp = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      indicator.remove()
      dom.classList.remove('is-dragging')
      const hovered = hoveredFor(e.clientX)
      if (hovered !== fromCol) {
        this.applyModel(moveColumn(this.model, fromCol, hovered))
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  private onCellKeydown(event: KeyboardEvent, row: number, col: number): void {
    const cols = this.model.headers.length
    const rowsCount = this.model.rows.length
    // Body rows are 0..rowsCount-1; header is -1. Flatten for navigation.
    const order: CellAddress[] = []
    for (let c = 0; c < cols; c++) order.push({ row: -1, col: c })
    for (let r = 0; r < rowsCount; r++)
      for (let c = 0; c < cols; c++) order.push({ row: r, col: c })
    const idx = order.findIndex((a) => a.row === row && a.col === col)

    if (event.key === 'Tab') {
      event.preventDefault()
      const nextIdx = event.shiftKey ? idx - 1 : idx + 1
      if (nextIdx >= 0 && nextIdx < order.length) {
        this.moveFocus(order[nextIdx])
      } else if (!event.shiftKey) {
        // Tab past the last cell → add a new row and land in it.
        const row = this.model.rows.length
        this.applyTransform((m) => insertRow(m, m.rows.length), { row, col: 0 })
      }
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const target = row === -1 ? { row: 0, col } : { row: row + 1, col }
      if (target.row >= rowsCount) {
        this.applyTransform((m) => insertRow(m, rowsCount), { row: rowsCount, col })
      } else {
        this.moveFocus(target)
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      this.commitIfDirty()
      this.view.focus()
    }
  }

  private moveFocus(addr: CellAddress): void {
    if (!this.dom) return
    const el = this.dom.querySelector<HTMLElement>(
      `[data-row="${addr.row}"][data-col="${addr.col}"]`
    )
    if (el) {
      el.focus()
      placeCaretEnd(el)
    }
  }

  ignoreEvent(): boolean {
    return true
  }

  destroy(): void {
    // Flush any uncommitted edits if the widget is torn down while focused.
    this.commitIfDirty()
    this.dom = null
  }
}

function placeCaretEnd(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function buildDecorations(state: EditorState): DecorationSet {
  const tree = syntaxTree(state)
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = []

  // Iterate the whole parsed tree (no viewport): block replace decorations
  // must come from a StateField, which has no viewport. Tables are sparse, so
  // this stays cheap for typical notes.
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const source = state.sliceDoc(node.from, node.to)
      const parsed = parseTable(source)
      if (!parsed) return false
      ranges.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({
          block: true,
          widget: new TableWidget(source, parsed)
        })
      })
      return false
    }
  })

  ranges.sort((a, b) => a.from - b.from)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

/**
 * Block widgets (and any decoration that replaces line breaks) must be
 * supplied through a StateField, not a ViewPlugin — CodeMirror needs to know
 * the block structure before the viewport is computed. The field also feeds
 * `atomicRanges` so the caret never lands inside the raw pipe source.
 */
export const tablePlugin = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    // Rebuild on edits and whenever the parser advances (the syntax tree is a
    // fresh object); otherwise positions are unchanged, so reuse as-is.
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field, false) ?? Decoration.none)
  ]
})
