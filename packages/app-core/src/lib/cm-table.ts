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
import {
  Prec,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Text
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view'
import {
  escapeCell,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseColWidthsComment,
  parseTable,
  serializeTable,
  type MarkdownTable
} from './markdown-table'

/** Minimum draggable column width (px) for the resize handles (#294). */
const MIN_COL_WIDTH = 48
import { openTableContextMenu } from './cm-table-menu'
import { renderMarkdown } from './markdown'
import { getCM } from '@replit/codemirror-vim'
import { undo, redo } from '@codemirror/commands'
import { useStore } from '../store'
import { matchesSequenceToken, matchesShortcutBinding } from './keymaps'
import { followLinkTarget } from './follow-link'
import { extractLinkAtCursor } from './internal-links'

/** The follow target for a rendered link anchor inside a table cell: a
 *  wikilink's name (`data-wikilink`) or a plain link's href. Returns null for
 *  anchors that carry neither. */
function linkTargetFromAnchor(anchor: HTMLAnchorElement): string | null {
  if (anchor.classList.contains('wikilink')) return anchor.dataset.wikilink?.trim() || null
  return anchor.getAttribute('href')?.trim() || null
}

/** True when the editor is in Vim mode — gates the table's modal (normal /
 *  insert) keyboard navigation. With Vim off, cells stay plain contenteditable
 *  fields driven by Tab/Enter (unchanged). */
function vimEnabled(): boolean {
  return useStore.getState().vimMode
}

/** How long (ms) the pieces of a custom insert-escape sequence (e.g. jk) may be
 *  spread apart and still count as the escape rather than typed text. Mirrors
 *  Vim's default `timeoutlen`. (#341) */
const INSERT_ESCAPE_TIMEOUT_MS = 1000

/**
 * Render a cell's markdown source to inline HTML (sanitized by the markdown
 * pipeline). Empty cells render nothing.
 *
 * The text goes through the parser AS A TABLE CELL, because that is the only
 * thing it is: GFM gives cells inline content, never blocks. Handing the bare
 * text to the block pipeline meant a cell holding just `-` or `+` parsed as a
 * bullet-list marker and rendered an empty `<li>`, so the character vanished
 * from the widget while Preview, which parses the real table, showed it fine.
 * `#`, `1.`, `---` and `> q` were lost or mangled the same way. (#559)
 *
 * Round-tripping through a one-cell table keeps the widget on the exact same
 * parser as the reading view rather than adding an inline-only copy to keep in
 * sync, and `escapeCell` is the serializer's own escaping, so what the cell
 * shows is what its row will contain on disk.
 */
export function renderInlineCell(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // A newline would close the synthetic row; cells are single-line by
  // construction, but contenteditable can hand one back after a paste.
  const source = escapeCell(trimmed.replace(/\s*\n\s*/g, ' '))
  const parsed = document.createElement('template')
  parsed.innerHTML = renderMarkdown(`| ${source} |\n| --- |`)
  const cell = parsed.content.querySelector('th, td')
  // Never swallow the text: if the pipeline returns something unexpected (its
  // error fallback, say), show the source rather than an empty cell.
  if (cell) return cell.innerHTML
  const plain = document.createElement('span')
  plain.textContent = trimmed
  return plain.innerHTML
}

/** If a `<!-- zen:cols=… -->` width marker sits on the line right after the
 *  table ending at `tableTo`, return its parsed per-column widths and the end
 *  offset of that line. The widget swallows the marker (so it never shows as
 *  raw text) and writes replace the table + marker atomically. (#294) */
function colWidthsAfter(
  doc: Text,
  tableTo: number
): { widths: Array<number | null>; to: number } | null {
  const last = doc.lineAt(tableTo)
  if (last.number >= doc.lines) return null
  const next = doc.line(last.number + 1)
  const widths = parseColWidthsComment(next.text)
  return widths ? { widths, to: next.to } : null
}

/**
 * The table block containing `pos`, found by reading the document rather than
 * the syntax tree: the run of `|` rows around that line, plus a trailing
 * `zen:cols` marker.
 *
 * Backs up `tableRangeAt`. Markdown parsing is incremental, so a table that was
 * just created or restructured can still be outside the parsed tree when the
 * next action commits — and a commit that can't find its range throws the
 * user's edit away without a word. Reported as an alignment that only takes
 * effect the second time you choose it. (#485)
 */
export function tableBlockAt(doc: Text, pos: number): { from: number; to: number } | null {
  const isRow = (text: string): boolean => text.trimStart().startsWith('|')
  const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)))
  if (!isRow(line.text)) return null
  let first = line.number
  while (first > 1 && isRow(doc.line(first - 1).text)) first--
  let last = line.number
  while (last < doc.lines && isRow(doc.line(last + 1).text)) last++
  // A table is at least a header and its delimiter row; one `|` line on its own
  // is prose, and rewriting it as a table would be a worse failure than none.
  if (last - first < 1) return null
  const ext = colWidthsAfter(doc, doc.line(last).to)
  return { from: doc.line(first).from, to: ext ? ext.to : doc.line(last).to }
}

/** Find the enclosing `Table` node range for a doc position, or null. The range
 *  is extended over a trailing `zen:cols` width marker so re-serialization
 *  replaces both (no duplicate markers, no leaked raw comment). */
function tableRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(view.state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'Table') {
      const ext = colWidthsAfter(view.state.doc, node.to)
      return { from: node.from, to: ext ? ext.to : node.to }
    }
    if (!node.parent) break
    node = node.parent
  }
  return tableBlockAt(view.state.doc, pos)
}

/**
 * Re-serialize `table` and write it over whichever Table node currently sits
 * under the widget's DOM. Resolving the range live (via posAtDOM) keeps the
 * write correct even when edits elsewhere have shifted the document.
 *
 * `anchor` is the table's document position captured when the caller still
 * had a live widget (the context menu records it at open). Any doc change
 * while the menu is up (most commonly the dirty-cell commit that opening
 * the menu itself triggers via focusout) rebuilds the decorations and
 * detaches this widget's DOM, so posAtDOM can no longer answer. The anchor
 * re-resolves the table from the CURRENT document instead (its start does
 * not move: those mid-menu edits land inside or after the block), so the
 * user's action still lands. Third and hopefully final act of #485.
 */
function commitTable(
  view: EditorView,
  dom: HTMLElement | null,
  table: MarkdownTable,
  anchor?: number
): void {
  let range: { from: number; to: number } | null = null
  if (dom && dom.isConnected) {
    try {
      range = tableRangeAt(view, view.posAtDOM(dom))
    } catch {
      range = null
    }
  }
  if (!range && anchor != null) {
    range = tableBlockAt(view.state.doc, anchor)
  }
  if (!range) {
    // Never silently discard a user's edit again: every earlier act of #485
    // hid behind a bare return on this path.
    console.warn('[zen:table] commit dropped: could not locate the table block')
    return
  }
  const next = serializeTable(table)
  if (next === view.state.sliceDoc(range.from, range.to)) return
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next }
  })
}

type CellAddress = { row: number; col: number }
type VisualPosition = CellAddress & { offset: number }
type VisualCellRange = CellAddress & {
  cell: HTMLElement
  from: number
  to: number
  fullCell: boolean
}

class TableWidget extends WidgetType {
  /** Working copy edited in place by the cells; committed on focus-out. */
  private model: MarkdownTable
  private dom: HTMLElement | null = null
  private dirty = false
  /** Live `<col>` elements (one per column) the resize handles drive. (#294) */
  private cols: HTMLTableColElement[] = []
  /** Vim cell mode: 'normal' is a block-cursor that moves over characters
   *  (h/l) and rows (j/k); 'insert' edits the focused cell. Vim mode only. */
  private cellMode: 'normal' | 'insert' = 'normal'
  /** Character index of the Vim block cursor within the focused cell's source. */
  private cursorOffset = 0
  /** Where to land the block cursor on the next cell focus: a char index, or
   *  'end' (last char). Lets h/l carry the cursor across cell boundaries. */
  private pendingOffset: number | 'end' | null = null
  /** A pending operator (`d`/`c`) waiting for its motion key (dw, cc, d$, …). */
  private pendingOp: 'd' | 'c' | null = null
  /** Table-aware visual mode. Anchor and head retain cell coordinates so the
   *  selection survives focus moving across cell and row boundaries. */
  private visualMode: 'char' | 'line' | null = null
  private visualAnchor: VisualPosition | null = null
  private visualHead: VisualPosition | null = null
  /** A programmatic focus move made by a visual motion must not reset the
   *  visual state in the target cell's focus handler. */
  private preserveVisualOnFocus = false
  /** Pending text-object scope after `i`/`a` — in visual mode (`viw`) and in
   *  operator-pending (`diw`, `ca"`). */
  private visualScope: 'i' | 'a' | null = null
  /** Recent printable keys typed in INSERT mode, used to detect the configurable
   *  insert-escape sequence (e.g. jk). The Vim plugin's `Vim.map` mapping doesn't
   *  reach this contenteditable widget, so it is honored here directly. (#341) */
  private insertEscapeKeys: { ch: string; at: number }[] = []
  private pendingScope: 'i' | 'a' | null = null
  /** Armed after `f`/`F`/`t`/`T`, waiting for the target character (#435). */
  private pendingFind: 'f' | 'F' | 't' | 'T' | null = null
  /** Armed after `r`, waiting for the replacement character (#435). */
  private pendingReplace = false
  /** Armed after `g`, waiting for the second key (`gd` follows a link) (#445). */
  private pendingG = false
  /** Last `f`/`t` find, so `;`/`,` can repeat it. */
  private lastFind: { cmd: 'f' | 'F' | 't' | 'T'; ch: string } | null = null
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
  private applyModel(next: MarkdownTable, focus?: CellAddress, anchor?: number): void {
    // Capture the live range BEFORE the dispatch detaches our DOM.
    const dom = this.dom
    this.model = next
    this.dirty = false
    commitTable(this.view, dom, next, anchor)
    if (focus) {
      requestAnimationFrame(() => this.focusCellAt(focus))
    }
  }

  /** Apply a context-menu action, then keep keyboard focus usable. Actions with
   *  a target cell (insert/move/duplicate/align) focus it via `applyModel`;
   *  actions without one (delete row/column, sort) would otherwise drop focus to
   *  the body, so return it to the editor once the widget has re-rendered. (#437)
   *  `anchor` (captured at menu open) lets the commit land even when this
   *  widget instance was rebuilt while the menu was up (#485). */
  private applyMenuAction(next: MarkdownTable, focus?: CellAddress, anchor?: number): void {
    this.applyModel(next, focus, anchor)
    if (!focus) {
      requestAnimationFrame(() => this.view.focus())
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

  /** The table's current document position, captured while this widget is
   *  still live. A context menu outlives the widget instance that opened it:
   *  the focus moving into the menu commits any dirty cell, that dispatch
   *  rebuilds the decorations and detaches this DOM, and a later menu action
   *  would then have nothing to resolve its commit against. The anchor lets
   *  commitTable re-find the table in the current document instead (#485). */
  private captureTableAnchor(): number | undefined {
    try {
      return this.dom && this.dom.isConnected ? this.view.posAtDOM(this.dom) : undefined
    } catch {
      return undefined
    }
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

    // Colgroup carries persisted column widths and is what the resize handles
    // drive. Built for every table so a drag can populate it. (#294)
    const colgroup = document.createElement('colgroup')
    const colWidths = this.model.colWidths ?? []
    this.cols = []
    let anyWidth = false
    for (let c = 0; c < this.model.headers.length; c++) {
      const colEl = document.createElement('col')
      const w = colWidths[c]
      if (typeof w === 'number' && w > 0) {
        colEl.style.width = `${w}px`
        anyWidth = true
      }
      colgroup.append(colEl)
      this.cols.push(colEl)
    }
    table.append(colgroup)
    if (anyWidth) table.classList.add('cm-table-fixed')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.model.headers.forEach((text, col) => {
      const th = this.buildCell('th', -1, col, text)
      this.attachColResizeHandle(th, col)
      headRow.append(th)
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
      if (this.visualMode) this.exitVisual()
      this.commitIfDirty()
    })

    return root
  }

  /** Add a drag-to-resize grip on a header cell's right border. (#294) */
  private attachColResizeHandle(th: HTMLElement, col: number): void {
    const handle = document.createElement('div')
    handle.className = 'cm-table-col-resize'
    handle.setAttribute('contenteditable', 'false')
    handle.addEventListener('pointerdown', (e) => this.beginColResize(e, col))
    // Don't let press/click on the grip bubble into cell focus or drag-reorder
    // (pointerdown's stopPropagation doesn't stop the compat mouse events).
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    handle.addEventListener('click', (e) => e.stopPropagation())
    th.appendChild(handle)
  }

  /** Pointer-drag a column border to set its width. Locks every column to its
   *  current rendered width first (so the drag is stable under fixed layout),
   *  then persists all widths through the model's zen:cols marker on release. */
  private beginColResize(e: PointerEvent, col: number): void {
    if (!this.dom || !this.cols.length) return
    e.preventDefault()
    e.stopPropagation()
    const table = this.dom.querySelector('table')
    const ths = this.dom.querySelectorAll<HTMLElement>('thead th')
    const widths = this.cols.map((c, i) => {
      const fromStyle = c.style.width ? Number.parseFloat(c.style.width) : NaN
      const measured = ths[i]?.getBoundingClientRect().width ?? MIN_COL_WIDTH
      return Math.max(MIN_COL_WIDTH, Math.round(Number.isFinite(fromStyle) ? fromStyle : measured))
    })
    // Pin all columns + switch to fixed layout so dragging one is predictable.
    this.cols.forEach((c, i) => {
      c.style.width = `${widths[i]}px`
    })
    table?.classList.add('cm-table-fixed')
    this.dom.classList.add('is-col-resizing')

    const handle = e.target as HTMLElement
    const startX = e.clientX
    const startW = widths[col]
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* capture is best-effort */
    }
    const onMove = (ev: PointerEvent): void => {
      const next = Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX)))
      widths[col] = next
      const target = this.cols[col]
      if (target) target.style.width = `${next}px`
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* released already */
      }
      this.dom?.classList.remove('is-col-resizing')
      // Fold any pending cell edits in, then persist widths → zen:cols marker.
      this.syncFromDom()
      this.model = { ...this.model, colWidths: widths.slice() }
      commitTable(this.view, this.dom as HTMLElement, this.model)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
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
    // Vim: cells are non-editable in NORMAL mode, so there's no native text
    // caret (a block cursor is drawn in CSS); i/a turns editing on. tabindex
    // keeps the cell focusable for navigation while non-editable. Non-Vim:
    // always editable (click-to-edit), unchanged.
    editable.setAttribute('tabindex', '-1')
    editable.setAttribute('contenteditable', vimEnabled() ? 'false' : 'true')
    // Idle: show rendered inline markdown (code/bold/links). Editing: show the
    // raw source. `data-raw` stays authoritative for commits either way.
    editable.innerHTML = renderInlineCell(text)
    editable.dataset.rendered = 'true'

    editable.addEventListener('focus', () => {
      if (vimEnabled()) {
        // Vim: land in NORMAL mode at the pending offset (carried across cells
        // by h/l), or 0. The cell becomes a block cursor over its source.
        this.cellMode = 'normal'
        this.pendingOp = null
        this.pendingScope = null
        this.pendingG = false
        if (!this.preserveVisualOnFocus) {
          this.clearVisualCells()
          this.visualMode = null
          this.visualAnchor = null
          this.visualHead = null
          this.visualScope = null
        }
        const len = (editable.dataset.raw ?? '').length
        this.cursorOffset =
          this.pendingOffset === 'end'
            ? Math.max(0, len - 1)
            : Math.max(0, this.pendingOffset ?? 0)
        this.pendingOffset = null
        this.enterNormalCell(editable)
        return
      }
      if (editable.dataset.rendered === 'true') {
        editable.textContent = editable.dataset.raw ?? ''
        editable.dataset.rendered = 'false'
        placeCaretEnd(editable)
      }
    })
    // Follow a rendered link (wikilink or Markdown link) inside the cell instead
    // of dropping the caret into the raw source. Mirrors the main editor, where a
    // rendered link follows on plain click and Cmd/Ctrl-click always follows —
    // caught on mousedown (before focus reveals the source), so it works in both
    // Vim and non-Vim mode. Only fires while the cell shows its anchors. (#445)
    editable.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      if (editable.dataset.rendered !== 'true') return
      const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a')
      if (!anchor || !editable.contains(anchor)) return
      const target = linkTargetFromAnchor(anchor)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      followLinkTarget(target)
    })
    editable.addEventListener('input', () => {
      this.dirty = true
      editable.dataset.raw = editable.textContent ?? ''
    })
    editable.addEventListener('blur', () => {
      this.clearCellCursor(editable)
      editable.classList.remove('is-vim-normal')
      // Leaving the cell: pull the (possibly edited) source back out of the DOM
      // and re-render it. `data-raw` is authoritative, so read that.
      if (editable.dataset.rendered === 'false') {
        const raw = editable.dataset.raw ?? editable.textContent ?? ''
        editable.dataset.raw = raw
        editable.innerHTML = renderInlineCell(raw)
        editable.dataset.rendered = 'true'
      }
    })
    editable.addEventListener('keydown', (event) => this.onCellKeydown(event, row, col, editable))
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // Pull pending edits into the model (no dispatch) so the menu acts on
      // the current contents; the chosen action commits in one write.
      this.syncFromDom()
      const anchor = this.captureTableAnchor()
      openTableContextMenu({
        x: event.clientX,
        y: event.clientY,
        row,
        col,
        model: this.model,
        apply: (next, focus) => this.applyMenuAction(next, focus, anchor)
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

  private onCellKeydown(
    event: KeyboardEvent,
    row: number,
    col: number,
    editable: HTMLElement
  ): void {
    const cols = this.model.headers.length
    const rowsCount = this.model.rows.length

    if (editable.getAttribute('contenteditable') === 'true') {
      const marker = matchesShortcutBinding(event, 'Mod+B')
        ? '**'
        : matchesShortcutBinding(event, 'Mod+I')
          ? '*'
          : null
      if (marker && this.toggleCellFormatting(editable, marker)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (vimEnabled()) {
      if (this.cellMode === 'insert') {
        // INSERT: Escape (or the configurable insert-escape sequence, e.g. jk)
        // commits the cell text and drops back to NORMAL, staying put (classic
        // Vim). Everything else types normally / falls through to the shared
        // Tab / Enter handling below.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          this.exitInsertToNormal(editable, 0)
          return
        }
        // #341: the Vim plugin's `jk`-style insert-escape mapping never reaches
        // this contenteditable widget, so honor the configured sequence here.
        const escSeq = useStore.getState().vimInsertEscape.trim()
        if (escSeq && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const now = Date.now()
          const recent = this.insertEscapeKeys.filter((k) => now - k.at < INSERT_ESCAPE_TIMEOUT_MS)
          if ((recent.map((k) => k.ch).join('') + event.key).endsWith(escSeq)) {
            // Sequence complete: strip the already-typed prefix chars and exit
            // insert. This final key is swallowed rather than inserted.
            event.preventDefault()
            event.stopPropagation()
            this.insertEscapeKeys = []
            this.exitInsertToNormal(editable, escSeq.length - 1)
            return
          }
          this.insertEscapeKeys = [...recent, { ch: event.key, at: now }].slice(-escSeq.length)
        }
      } else {
        // NORMAL: h/j/k/l move between cells, i/a start editing, Esc leaves the
        // table. Stray printable keys are swallowed so they never reach the cell.
        // Stop unmodified keys from leaking to global shortcuts (the cell is not
        // contenteditable in NORMAL mode, so app-level handlers — e.g. the `m`
        // sidebar menu — would otherwise also fire). Modified combos (⌘S etc.)
        // still pass through.
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          event.stopPropagation()
        }
        const cellText = editable.dataset.raw ?? ''
        if (this.visualMode) {
          event.preventDefault()
          this.handleVisualKey(editable, row, col, event.key, cellText)
          return
        }
        if (this.pendingOp) {
          event.preventDefault()
          const op = this.pendingOp
          if (this.pendingScope) {
            // Third key: the text-object char (diw, ca", di(, …).
            const scope = this.pendingScope
            this.pendingOp = null
            this.pendingScope = null
            const r = textObjectRange(cellText, this.cursorOffset, scope, event.key)
            if (r) {
              this.deleteRange(editable, r.from, r.to)
              if (op === 'c') this.enterInsertMode(editable, r.from)
            }
            return
          }
          if (event.key === 'i' || event.key === 'a') {
            // Operator + text-object scope (di…, ca…): wait for the object key.
            this.pendingScope = event.key
            return
          }
          // Plain motion: dd / cc, dw / cw, d$ / c$, etc.
          this.pendingOp = null
          this.applyOperator(editable, op, event.key, cellText)
          return
        }
        if (this.pendingReplace) {
          // `r<char>`: replace the char under the cursor. Esc / non-printable
          // cancels without changing anything.
          event.preventDefault()
          this.pendingReplace = false
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            this.replaceChar(editable, event.key)
          }
          return
        }
        if (this.pendingFind) {
          // Second key of `f`/`F`/`t`/`T`: the target char. Esc / non-printable
          // cancels.
          event.preventDefault()
          const cmd = this.pendingFind
          this.pendingFind = null
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            this.lastFind = { cmd, ch: event.key }
            this.applyFind(editable, cmd, event.key, cellText, false)
          }
          return
        }
        if (this.pendingG) {
          // Second key of `g`: `gd` follows the link under the cursor, matching
          // the editor's go-to-definition motion. Anything else cancels (there's
          // no `gg` in a single-line cell). (#445)
          event.preventDefault()
          this.pendingG = false
          if (event.key === 'd') {
            const target = extractLinkAtCursor(cellText, this.cursorOffset)
            if (target) followLinkTarget(target)
          }
          return
        }
        // Directional cell navigation. Honors the configurable nav keymaps
        // (defaults h/l/j/k) so non-QWERTY layouts can remap them (#213), and
        // arrow keys always work (#232). Only plain navigation is remappable —
        // the Vim motions/operators in the switch below stay standard Vim.
        const navOverrides = useStore.getState().keymapOverrides
        if (event.key === 'ArrowLeft' || matchesSequenceToken(event, navOverrides, 'nav.moveLeft')) {
          event.preventDefault()
          this.moveCharLeft(editable, row, col)
          return
        }
        if (
          event.key === 'ArrowRight' ||
          matchesSequenceToken(event, navOverrides, 'nav.moveRight')
        ) {
          event.preventDefault()
          this.moveCharRight(editable, row, col)
          return
        }
        if (event.key === 'ArrowDown' || matchesSequenceToken(event, navOverrides, 'nav.moveDown')) {
          event.preventDefault()
          this.moveRowDown(row, col)
          return
        }
        if (event.key === 'ArrowUp' || matchesSequenceToken(event, navOverrides, 'nav.moveUp')) {
          event.preventDefault()
          this.moveRowUp(row, col)
          return
        }
        switch (event.key) {
          case 'i':
            event.preventDefault()
            this.enterInsertMode(editable, this.cursorOffset)
            return
          case 'a':
            event.preventDefault()
            this.enterInsertMode(editable, this.cursorOffset + 1)
            return
          case 'I':
            event.preventDefault()
            this.enterInsertMode(editable, 0)
            return
          case 'A':
            event.preventDefault()
            this.enterInsertMode(editable, cellText.length)
            return
          case 'w':
            event.preventDefault()
            this.cursorOffset = nextWordStart(cellText, this.cursorOffset)
            this.renderCellCursor(editable)
            return
          case 'e':
            event.preventDefault()
            this.cursorOffset = nextWordEnd(cellText, this.cursorOffset)
            this.renderCellCursor(editable)
            return
          case 'b':
            event.preventDefault()
            this.cursorOffset = prevWordStart(cellText, this.cursorOffset)
            this.renderCellCursor(editable)
            return
          case 'f':
          case 'F':
          case 't':
          case 'T':
            // Arm find-char; the next key is the target (#435).
            event.preventDefault()
            this.pendingFind = event.key as 'f' | 'F' | 't' | 'T'
            return
          case ';':
            event.preventDefault()
            if (this.lastFind) {
              this.applyFind(editable, this.lastFind.cmd, this.lastFind.ch, cellText, true)
            }
            return
          case ',': {
            event.preventDefault()
            if (this.lastFind) {
              // Repeat the last find in the opposite direction.
              const rev = { f: 'F', F: 'f', t: 'T', T: 't' } as const
              this.applyFind(editable, rev[this.lastFind.cmd], this.lastFind.ch, cellText, true)
            }
            return
          }
          case '0':
            event.preventDefault()
            this.cursorOffset = 0
            this.renderCellCursor(editable)
            return
          case '$':
            event.preventDefault()
            this.cursorOffset = Math.max(0, cellText.length - 1)
            this.renderCellCursor(editable)
            return
          case 'x':
            event.preventDefault()
            this.deleteRange(editable, this.cursorOffset, this.cursorOffset + 1)
            return
          case 'D':
            event.preventDefault()
            this.deleteRange(editable, this.cursorOffset, cellText.length)
            return
          case 'C': {
            event.preventDefault()
            const at = this.cursorOffset
            this.deleteRange(editable, at, cellText.length)
            this.enterInsertMode(editable, at)
            return
          }
          case 'g':
            // Arm `g`; the next key completes it (`gd` follows a link) (#445).
            event.preventDefault()
            this.pendingG = true
            return
          case 'd':
            event.preventDefault()
            this.pendingOp = 'd'
            return
          case 'c':
            event.preventDefault()
            this.pendingOp = 'c'
            return
          case 'v':
            event.preventDefault()
            this.visualMode = 'char'
            this.visualAnchor = { row, col, offset: this.cursorOffset }
            this.visualHead = { ...this.visualAnchor }
            this.renderVisualSelection()
            return
          case 'V':
            event.preventDefault()
            this.visualMode = 'line'
            this.visualAnchor = { row, col, offset: this.cursorOffset }
            this.visualHead = { ...this.visualAnchor }
            this.renderVisualSelection()
            return
          case 'u':
            // Undo: flush pending cell edits as one history step, then undo it
            // (or the previous change). Hands focus back to the editor.
            event.preventDefault()
            this.commitIfDirty()
            undo(this.view)
            this.view.focus()
            return
          case 'r':
            event.preventDefault()
            if (event.ctrlKey) {
              // Ctrl-r → redo.
              event.stopPropagation()
              this.commitIfDirty()
              redo(this.view)
              this.view.focus()
              return
            }
            // Plain `r`: arm replace-next-char (#435).
            this.pendingReplace = true
            return
          case 'Escape':
            // Vim: Esc in normal mode is a no-op — don't jump out of the table.
            // Leave a cell with j/k at the top/bottom edges (or click away).
            event.preventDefault()
            return
          case 'm':
            // Open the full table action menu (add/move/duplicate/delete/align/
            // sort) for this cell — keyboard-navigable with j/k/Enter/Esc.
            event.preventDefault()
            this.openCellMenu(editable, row, col)
            return
          case 'Tab':
          case 'Enter':
            break // fall through to shared Tab / Enter navigation
          default:
            if (
              event.key.length === 1 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey
            ) {
              event.preventDefault()
            }
            return
        }
      }
    }

    // Body rows are 0..rowsCount-1; header is -1. Flatten for navigation.
    const order: CellAddress[] = []
    for (let c = 0; c < cols; c++) order.push({ row: -1, col: c })
    for (let r = 0; r < rowsCount; r++)
      for (let c = 0; c < cols; c++) order.push({ row: r, col: c })
    const idx = order.findIndex((a) => a.row === row && a.col === col)

    // Keep arrow keys inside the table. Without this they fall through to
    // CodeMirror, whose caret can't enter the atomic table widget, so the main
    // selection jumps to a line outside the table and the page scrolls (#232).
    // Up/Down move between rows; Left/Right move the caret within the cell text
    // (the browser handles that natively in an editable cell) without scrolling.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const targetRow = event.key === 'ArrowDown' ? (row === -1 ? 0 : row + 1) : row - 1
      if (targetRow >= -1 && targetRow < rowsCount) this.moveFocus({ row: targetRow, col })
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.stopPropagation()
      return
    }

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

  /** Resolve a cell element by address within this widget. */
  private cellEl(row: number, col: number): HTMLElement | null {
    return this.dom?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`) ?? null
  }

  /** Focus a cell, landing the block cursor at a source offset (or its last
   *  char). Used when h/l cross a cell boundary and by j/k. */
  private focusCellAtOffset(row: number, col: number, offset: number | 'end'): void {
    const cell = this.cellEl(row, col)
    if (!cell) return
    this.pendingOffset = offset
    cell.focus()
  }

  /** Put a focused cell into NORMAL mode: non-editable, raw source shown, with
   *  the block cursor drawn over the current character. */
  private enterNormalCell(cell: HTMLElement): void {
    cell.setAttribute('contenteditable', 'false')
    cell.classList.add('is-vim-normal')
    // Show the raw source so motions map to real characters (and are
    // measurable for the block cursor).
    cell.textContent = cell.dataset.raw ?? ''
    cell.dataset.rendered = 'false'
    this.renderCellCursor(cell)
  }

  private clearCellCursor(cell: HTMLElement): void {
    cell.querySelector('.cm-table-cell-cursor')?.remove()
    cell.querySelector('.cm-table-cell-sel')?.remove()
  }

  /** Draw the block cursor over the character at `cursorOffset`, measuring its
   *  rect from the cell's text node (so it tracks real glyph positions). */
  private renderCellCursor(cell: HTMLElement): void {
    this.clearCellCursor(cell)
    const text = cell.dataset.raw ?? ''
    const offset = Math.max(0, Math.min(this.cursorOffset, Math.max(0, text.length - 1)))
    this.cursorOffset = offset
    const cursor = document.createElement('span')
    cursor.className = 'cm-table-cell-cursor'
    cursor.setAttribute('contenteditable', 'false')
    const node = cell.firstChild
    const cellRect = cell.getBoundingClientRect()
    const range = document.createRange()
    if (
      node &&
      node.nodeType === Node.TEXT_NODE &&
      text.length > 0 &&
      typeof range.getBoundingClientRect === 'function'
    ) {
      range.setStart(node, offset)
      range.setEnd(node, Math.min(text.length, offset + 1))
      const rect = range.getBoundingClientRect()
      cursor.style.left = `${rect.left - cellRect.left}px`
      cursor.style.top = `${rect.top - cellRect.top}px`
      cursor.style.width = `${Math.max(rect.width, 3)}px`
      cursor.style.height = `${rect.height || 18}px`
    } else {
      // Empty cell, or no measurement available (e.g. jsdom): a thin block at
      // the cell's start.
      cursor.style.left = '10px'
      cursor.style.top = '5px'
      cursor.style.bottom = '5px'
      cursor.style.width = '0.5em'
    }
    cell.appendChild(cursor)
  }

  /** Vim NORMAL `l`: next character; at the cell's end, jump to the next
   *  column. */
  private moveCharRight(cell: HTMLElement, row: number, col: number): void {
    const len = (cell.dataset.raw ?? '').length
    if (this.cursorOffset < len - 1) {
      this.cursorOffset += 1
      this.renderCellCursor(cell)
    } else if (col + 1 < this.model.headers.length) {
      this.focusCellAtOffset(row, col + 1, 0)
    }
  }

  /** Vim NORMAL `h`: previous character; at the cell's start, jump to the
   *  previous column (landing on its last char). */
  private moveCharLeft(cell: HTMLElement, row: number, col: number): void {
    if (this.cursorOffset > 0) {
      this.cursorOffset -= 1
      this.renderCellCursor(cell)
    } else if (col - 1 >= 0) {
      this.focusCellAtOffset(row, col - 1, 'end')
    }
  }

  /** Vim NORMAL `j`: header → first body row → … → past the last row leaves the
   *  table downward, keeping the column offset (clamped). */
  private moveRowDown(row: number, col: number): void {
    const target = row === -1 ? 0 : row + 1
    if (target >= this.model.rows.length) {
      this.exitToEditor('after')
      return
    }
    this.focusCellAtOffset(target, col, this.cursorOffset)
  }

  /** Vim NORMAL `k`: body row → … → header → past the header leaves upward. */
  private moveRowUp(row: number, col: number): void {
    if (row === -1) {
      this.exitToEditor('before')
      return
    }
    this.focusCellAtOffset(row === 0 ? -1 : row - 1, col, this.cursorOffset)
  }

  /** Switch the focused cell into INSERT mode at a source offset: editable,
   *  native caret, block cursor removed. Don't re-focus — that re-fires the
   *  focus handler, snapping back to NORMAL. */
  private enterInsertMode(cell: HTMLElement, caretOffset: number): void {
    this.cellMode = 'insert'
    this.insertEscapeKeys = []
    this.pendingOp = null
    this.pendingScope = null
    this.pendingFind = null
    this.pendingReplace = false
    this.visualMode = null
    this.visualAnchor = null
    this.visualHead = null
    this.visualScope = null
    this.clearCellCursor(cell)
    cell.classList.remove('is-vim-normal')
    cell.setAttribute('contenteditable', 'true')
    if (cell.dataset.rendered !== 'false') {
      cell.textContent = cell.dataset.raw ?? ''
      cell.dataset.rendered = 'false'
    }
    placeCaretAt(cell, caretOffset)
  }

  /** Apply or remove a Markdown marker around the native selection in an
   *  editable cell. Cell edits do not pass through CodeMirror's keymap, so the
   *  widget mirrors the editor's bold and italic toggle locally. */
  private toggleCellFormatting(cell: HTMLElement, marker: string): boolean {
    const selection = cellSelectionOffsets(cell)
    if (!selection) return false
    const change = toggleCellTextWrap(
      cell.textContent ?? '',
      selection.from,
      selection.to,
      marker
    )
    cell.textContent = change.text
    cell.dataset.raw = change.text
    cell.dataset.rendered = 'false'
    this.dirty = true
    placeCellSelection(cell, change.from, change.to)
    return true
  }

  /** Commit the focused cell and drop from INSERT back to NORMAL. Optionally
   *  removes `removeBefore` chars just before the caret first, used to strip a
   *  typed insert-escape prefix (the `j` of `jk`) before exiting. (#341) */
  private exitInsertToNormal(editable: HTMLElement, removeBefore: number): void {
    const sel = window.getSelection()
    let caret = sel && sel.anchorNode && editable.contains(sel.anchorNode) ? sel.anchorOffset : 0
    let text = editable.textContent ?? ''
    if (removeBefore > 0 && caret >= removeBefore) {
      text = text.slice(0, caret - removeBefore) + text.slice(caret)
      caret -= removeBefore
      editable.textContent = text
    }
    editable.dataset.raw = text
    editable.setAttribute('contenteditable', 'false')
    this.cellMode = 'normal'
    // Vim leaves the cursor on the char left of the caret.
    this.cursorOffset = Math.max(0, caret - 1)
    this.enterNormalCell(editable)
  }

  /** Delete `[from, to)` from the focused cell's source in place (no dispatch —
   *  committed on blur, like typing). Re-renders the NORMAL block cursor. */
  private deleteRange(cell: HTMLElement, from: number, to: number): void {
    const text = cell.dataset.raw ?? ''
    const a = Math.max(0, Math.min(from, text.length))
    const b = Math.max(a, Math.min(to, text.length))
    if (b === a) return
    const next = text.slice(0, a) + text.slice(b)
    cell.dataset.raw = next
    this.dirty = true
    this.cursorOffset = Math.max(0, Math.min(a, next.length - 1))
    cell.textContent = next
    cell.dataset.rendered = 'false'
    this.renderCellCursor(cell)
  }

  /** Move the block cursor to `ch` per an `f`/`F`/`t`/`T` motion. `isRepeat`
   *  (from `;`/`,`) nudges a till-motion past the char it's parked before so it
   *  advances instead of getting stuck. No-op when the char isn't found. (#435) */
  private applyFind(
    cell: HTMLElement,
    cmd: 'f' | 'F' | 't' | 'T',
    ch: string,
    text: string,
    isRepeat: boolean
  ): void {
    const dir = cmd === 'f' || cmd === 't' ? 1 : -1
    const till = cmd === 't' || cmd === 'T'
    const from = isRepeat && till ? this.cursorOffset + dir : this.cursorOffset
    const target = findChar(text, from, ch, dir, till)
    if (target === null) return
    this.cursorOffset = target
    this.renderCellCursor(cell)
  }

  /** `r<char>`: replace the character under the block cursor. (#435) */
  private replaceChar(cell: HTMLElement, ch: string): void {
    const text = cell.dataset.raw ?? ''
    if (this.cursorOffset >= text.length) return
    const next = text.slice(0, this.cursorOffset) + ch + text.slice(this.cursorOffset + 1)
    cell.dataset.raw = next
    this.dirty = true
    cell.textContent = next
    cell.dataset.rendered = 'false'
    this.renderCellCursor(cell)
  }

  /** Apply a pending operator (`d`/`c`) over the motion in `key`: dd/cc clear
   *  the cell; dw/cw, d$/c$, d0/c0, dl, db act over that range. `c` then edits. */
  private applyOperator(
    cell: HTMLElement,
    op: 'd' | 'c',
    key: string,
    text: string
  ): void {
    const off = this.cursorOffset
    let from = off
    let to = off
    if (key === op) {
      // dd / cc → the whole cell
      from = 0
      to = text.length
    } else {
      switch (key) {
        case 'w':
          to = op === 'c' ? Math.min(text.length, nextWordEnd(text, off) + 1) : nextWordStart(text, off)
          break
        case 'e':
          to = Math.min(text.length, nextWordEnd(text, off) + 1)
          break
        case '$':
          to = text.length
          break
        case '0':
          from = 0
          to = off
          break
        case 'l':
          to = Math.min(text.length, off + 1)
          break
        case 'h':
          from = Math.max(0, off - 1)
          break
        case 'b':
          from = prevWordStart(text, off)
          break
        default:
          return // unknown motion — cancel the operator
      }
    }
    const wholeCell = from === 0 && to === text.length
    if (to > from || wholeCell) {
      this.deleteRange(cell, from, to)
      if (op === 'c') this.enterInsertMode(cell, from)
    }
  }

  private cellOrder(): CellAddress[] {
    const order: CellAddress[] = []
    for (let col = 0; col < this.model.headers.length; col++) {
      order.push({ row: -1, col })
    }
    for (let row = 0; row < this.model.rows.length; row++) {
      for (let col = 0; col < this.model.headers.length; col++) {
        order.push({ row, col })
      }
    }
    return order
  }

  private adjacentCell(row: number, col: number, delta: -1 | 1): CellAddress | null {
    const order = this.cellOrder()
    const index = order.findIndex((addr) => addr.row === row && addr.col === col)
    return order[index + delta] ?? null
  }

  /** Move the visual head to another cell without letting its focus handler
   *  reset the selection. */
  private moveVisualTo(row: number, col: number, offset: number | 'end'): void {
    const cell = this.cellEl(row, col)
    if (!cell) return
    const length = (cell.dataset.raw ?? '').length
    const nextOffset =
      offset === 'end'
        ? Math.max(0, length - 1)
        : Math.max(0, Math.min(offset, Math.max(0, length - 1)))
    if (document.activeElement !== cell) {
      this.pendingOffset = nextOffset
      this.preserveVisualOnFocus = true
      try {
        cell.focus()
      } finally {
        this.preserveVisualOnFocus = false
        this.pendingOffset = null
      }
    }
    this.cursorOffset = nextOffset
    this.visualHead = { row, col, offset: nextOffset }
    this.renderVisualSelection()
  }

  private visualSelectionRanges(): VisualCellRange[] {
    if (!this.visualMode || !this.visualAnchor || !this.visualHead) return []
    const order = this.cellOrder()
    if (this.visualMode === 'line') {
      const firstRow = Math.min(this.visualAnchor.row, this.visualHead.row)
      const lastRow = Math.max(this.visualAnchor.row, this.visualHead.row)
      return order.flatMap(({ row, col }) => {
        if (row < firstRow || row > lastRow) return []
        const cell = this.cellEl(row, col)
        if (!cell) return []
        return [
          { cell, row, col, from: 0, to: (cell.dataset.raw ?? '').length, fullCell: true }
        ]
      })
    }

    const anchorIndex = order.findIndex(
      (addr) => addr.row === this.visualAnchor?.row && addr.col === this.visualAnchor?.col
    )
    const headIndex = order.findIndex(
      (addr) => addr.row === this.visualHead?.row && addr.col === this.visualHead?.col
    )
    if (anchorIndex < 0 || headIndex < 0) return []
    const anchorFirst =
      anchorIndex < headIndex ||
      (anchorIndex === headIndex && this.visualAnchor.offset <= this.visualHead.offset)
    const firstIndex = anchorFirst ? anchorIndex : headIndex
    const lastIndex = anchorFirst ? headIndex : anchorIndex
    const firstOffset = anchorFirst ? this.visualAnchor.offset : this.visualHead.offset
    const lastOffset = anchorFirst ? this.visualHead.offset : this.visualAnchor.offset
    const ranges: VisualCellRange[] = []
    for (let index = firstIndex; index <= lastIndex; index++) {
      const addr = order[index]
      const cell = this.cellEl(addr.row, addr.col)
      if (!cell) continue
      const length = (cell.dataset.raw ?? '').length
      const from = index === firstIndex ? Math.min(firstOffset, length) : 0
      const to = index === lastIndex ? Math.min(lastOffset + 1, length) : length
      ranges.push({ cell, ...addr, from, to, fullCell: false })
    }
    return ranges
  }

  /** Render every selected table fragment with themed overlays. Selected cells
   *  expose their raw source while visual mode is active so character offsets
   *  stay exact even when Markdown would normally render as nested elements. */
  private renderVisualSelection(): void {
    const ranges = this.visualSelectionRanges()
    const selected = new Set(ranges.map((range) => range.cell))
    const active = this.dom?.ownerDocument.activeElement
    this.dom?.querySelectorAll<HTMLElement>('.cm-table-cell.is-vim-visual').forEach((cell) => {
      cell.querySelectorAll('.cm-table-cell-sel').forEach((overlay) => overlay.remove())
      cell.classList.remove('is-vim-visual')
      if (!selected.has(cell) && cell !== active && cell.dataset.rendered === 'false') {
        cell.innerHTML = renderInlineCell(cell.dataset.raw ?? '')
        cell.dataset.rendered = 'true'
      }
    })

    for (const { cell, from, to, fullCell } of ranges) {
      this.clearCellCursor(cell)
      cell.classList.add('is-vim-visual')
      if (cell.dataset.rendered === 'true') {
        cell.textContent = cell.dataset.raw ?? ''
        cell.dataset.rendered = 'false'
      }
      const overlay = cell.ownerDocument.createElement('span')
      overlay.className = 'cm-table-cell-sel'
      const text = cell.dataset.raw ?? ''
      if (fullCell || text.length === 0) {
        overlay.classList.add('is-full')
        cell.appendChild(overlay)
        continue
      }
      const node = cell.firstChild
      const range = cell.ownerDocument.createRange()
      if (
        !node ||
        node.nodeType !== Node.TEXT_NODE ||
        typeof range.getBoundingClientRect !== 'function'
      ) {
        continue
      }
      range.setStart(node, Math.max(0, Math.min(from, text.length)))
      range.setEnd(node, Math.max(from, Math.min(to, text.length)))
      const rect = range.getBoundingClientRect()
      const cellRect = cell.getBoundingClientRect()
      overlay.style.left = `${rect.left - cellRect.left}px`
      overlay.style.top = `${rect.top - cellRect.top}px`
      overlay.style.width = `${Math.max(rect.width, 2)}px`
      overlay.style.height = `${rect.height || 18}px`
      cell.appendChild(overlay)
    }
  }

  private clearVisualCells(): void {
    const active = this.dom?.ownerDocument.activeElement
    this.dom?.querySelectorAll<HTMLElement>('.cm-table-cell.is-vim-visual').forEach((cell) => {
      cell.querySelectorAll('.cm-table-cell-sel').forEach((overlay) => overlay.remove())
      cell.classList.remove('is-vim-visual')
      if (cell !== active && cell.dataset.rendered === 'false') {
        cell.innerHTML = renderInlineCell(cell.dataset.raw ?? '')
        cell.dataset.rendered = 'true'
      }
    })
  }

  private exitVisual(): void {
    this.visualMode = null
    this.visualAnchor = null
    this.visualHead = null
    this.visualScope = null
    this.clearVisualCells()
    window.getSelection()?.removeAllRanges()
  }

  private finishVisualAtStart(first: VisualCellRange, insert: boolean): void {
    const target = first.cell
    const nextLength = (target.dataset.raw ?? '').length
    const offset = Math.max(0, Math.min(first.from, Math.max(0, nextLength - 1)))
    this.exitVisual()
    if (document.activeElement === target) {
      this.cursorOffset = offset
      this.enterNormalCell(target)
    } else {
      this.focusCellAtOffset(first.row, first.col, offset)
    }
    if (insert) this.enterInsertMode(target, first.from)
  }

  private deleteVisualSelection(insert: boolean): void {
    const ranges = this.visualSelectionRanges()
    const first = ranges[0]
    if (!first) return
    let changed = false
    for (const { cell, from, to } of ranges) {
      const text = cell.dataset.raw ?? ''
      if (to > from) changed = true
      const next = text.slice(0, from) + text.slice(to)
      cell.dataset.raw = next
      cell.textContent = next
      cell.dataset.rendered = 'false'
    }
    if (changed) this.dirty = true
    this.finishVisualAtStart(first, insert)
  }

  private yankVisualSelection(): void {
    const ranges = this.visualSelectionRanges()
    const first = ranges[0]
    if (!first) return
    let previousRow: number | null = null
    let selected = ''
    for (const { cell, row, from, to } of ranges) {
      if (previousRow !== null) selected += row === previousRow ? '\t' : '\n'
      selected += (cell.dataset.raw ?? '').slice(from, to)
      previousRow = row
    }
    void navigator.clipboard?.writeText(selected)
    this.finishVisualAtStart(first, false)
  }

  /** Keys while in table visual mode. Motions update a coordinate-aware head;
   *  edit and yank commands consume the same multi-cell range. */
  private handleVisualKey(
    cell: HTMLElement,
    row: number,
    col: number,
    key: string,
    text: string
  ): void {
    if (!this.visualHead) this.visualHead = { row, col, offset: this.cursorOffset }
    if (this.visualScope) {
      const scope = this.visualScope
      this.visualScope = null
      const range = textObjectRange(text, this.cursorOffset, scope, key)
      if (range) {
        this.visualMode = 'char'
        this.visualAnchor = { row, col, offset: range.from }
        this.cursorOffset = Math.max(range.from, range.to - 1)
        this.visualHead = { row, col, offset: this.cursorOffset }
        this.renderVisualSelection()
      }
      return
    }
    if (this.visualMode === 'char' && (key === 'i' || key === 'a')) {
      this.visualScope = key
      return
    }

    if (key === 'Escape') {
      this.exitVisual()
      this.renderCellCursor(cell)
      return
    }
    if (key === 'd' || key === 'x') {
      this.deleteVisualSelection(false)
      return
    }
    if (key === 'c' || key === 's') {
      this.deleteVisualSelection(true)
      return
    }
    if (key === 'y') {
      this.yankVisualSelection()
      return
    }
    if (key === 'v') {
      if (this.visualMode === 'char') {
        this.exitVisual()
        this.renderCellCursor(cell)
      } else {
        this.visualMode = 'char'
        this.renderVisualSelection()
      }
      return
    }
    if (key === 'V') {
      if (this.visualMode === 'line') {
        this.exitVisual()
        this.renderCellCursor(cell)
      } else {
        this.visualMode = 'line'
        this.renderVisualSelection()
      }
      return
    }

    const moveVertical = (delta: -1 | 1): void => {
      const targetRow = row + delta
      if (targetRow < -1 || targetRow >= this.model.rows.length) return
      this.moveVisualTo(targetRow, col, this.cursorOffset)
    }
    if (this.visualMode === 'line') {
      if (key === 'j') moveVertical(1)
      if (key === 'k') moveVertical(-1)
      return
    }

    const updateOffset = (offset: number): void => this.moveVisualTo(row, col, offset)
    switch (key) {
      case 'h': {
        if (this.cursorOffset > 0) updateOffset(this.cursorOffset - 1)
        else {
          const previous = this.adjacentCell(row, col, -1)
          if (previous) this.moveVisualTo(previous.row, previous.col, 'end')
        }
        return
      }
      case 'l': {
        if (this.cursorOffset < text.length - 1) updateOffset(this.cursorOffset + 1)
        else {
          const next = this.adjacentCell(row, col, 1)
          if (next) this.moveVisualTo(next.row, next.col, 0)
        }
        return
      }
      case 'j':
        moveVertical(1)
        return
      case 'k':
        moveVertical(-1)
        return
      case 'w': {
        const nextOffset = nextWordStartWithinCell(text, this.cursorOffset)
        if (nextOffset !== null) updateOffset(nextOffset)
        else {
          const next = this.adjacentCell(row, col, 1)
          if (next) this.moveVisualTo(next.row, next.col, 0)
        }
        return
      }
      case 'e': {
        const nextOffset = nextWordEnd(text, this.cursorOffset)
        if (nextOffset > this.cursorOffset) updateOffset(nextOffset)
        else {
          const next = this.adjacentCell(row, col, 1)
          if (next) {
            const nextText = this.cellEl(next.row, next.col)?.dataset.raw ?? ''
            this.moveVisualTo(next.row, next.col, nextWordEnd(nextText, -1))
          }
        }
        return
      }
      case 'b': {
        const previousOffset = prevWordStart(text, this.cursorOffset)
        if (previousOffset < this.cursorOffset) updateOffset(previousOffset)
        else {
          const previous = this.adjacentCell(row, col, -1)
          if (previous) this.moveVisualTo(previous.row, previous.col, 'end')
        }
        return
      }
      case '0':
        updateOffset(0)
        return
      case '$':
        updateOffset(Math.max(0, text.length - 1))
        return
      default:
        return
    }
  }

  /** Leave the table, returning the caret to the document just before/after the
   *  table block. The atomic range keeps it from sliding back in. */
  private exitToEditor(side: 'before' | 'after'): void {
    if (this.visualMode) this.exitVisual()
    this.commitIfDirty()
    this.cellMode = 'normal'
    this.pendingOp = null
    this.pendingScope = null
    const dom = this.dom
    if (!dom) {
      this.view.focus()
      return
    }
    let pos: number
    try {
      pos = this.view.posAtDOM(dom)
    } catch {
      this.view.focus()
      return
    }
    const range = tableRangeAt(this.view, pos)
    this.view.focus()
    if (!range) return
    const doc = this.view.state.doc
    const anchor =
      side === 'before' ? Math.max(0, range.from - 1) : Math.min(doc.length, range.to + 1)
    this.view.dispatch({ selection: { anchor } })
  }

  /** Open the table action menu for the focused cell (Vim NORMAL `m`),
   *  anchored at the cell. The menu itself is keyboard-navigable. */
  private openCellMenu(editable: HTMLElement, row: number, col: number): void {
    this.syncFromDom()
    const anchor = this.captureTableAnchor()
    const rect = editable.getBoundingClientRect()
    openTableContextMenu({
      x: rect.left,
      y: rect.bottom,
      row,
      col,
      model: this.model,
      apply: (next, focus) => this.applyMenuAction(next, focus, anchor)
    })
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

/** Vim character class: 0 = whitespace, 1 = word char, 2 = punctuation. A
 *  "word" is a maximal run of one non-whitespace class. */
function charClass(ch: string): 0 | 1 | 2 {
  if (/\s/.test(ch)) return 0
  if (/[A-Za-z0-9_]/.test(ch)) return 1
  return 2
}

/** Vim `w`: index of the start of the next word (clamped to the last char). */
export function nextWordStart(text: string, off: number): number {
  const n = text.length
  if (n === 0) return 0
  return nextWordStartWithinCell(text, off) ?? n - 1
}

/** Next word start inside this cell, or null when the motion must continue in
 *  the next cell. */
function nextWordStartWithinCell(text: string, off: number): number | null {
  const n = text.length
  if (n === 0) return null
  let i = off
  const cls = charClass(text[i] ?? ' ')
  if (cls !== 0) while (i < n && charClass(text[i]) === cls) i++
  while (i < n && charClass(text[i]) === 0) i++
  return i < n ? i : null
}

/** Vim `b`: index of the start of the current/previous word. */
export function prevWordStart(text: string, off: number): number {
  let i = off - 1
  while (i > 0 && charClass(text[i]) === 0) i--
  if (i <= 0) return 0
  const cls = charClass(text[i])
  while (i > 0 && charClass(text[i - 1]) === cls) i--
  return Math.max(0, i)
}

/** Vim `f`/`t`/`F`/`T`: index of `ch` searching from `off` in `dir` (+1 forward,
 *  -1 back), or null if not found. `till` (t/T) stops one char short of the
 *  target. The search always starts one char past `off`. (#435) */
export function findChar(
  text: string,
  off: number,
  ch: string,
  dir: 1 | -1,
  till: boolean
): number | null {
  const n = text.length
  if (dir === 1) {
    for (let i = off + 1; i < n; i++) {
      if (text[i] === ch) return till ? i - 1 : i
    }
  } else {
    for (let i = off - 1; i >= 0; i--) {
      if (text[i] === ch) return till ? i + 1 : i
    }
  }
  return null
}

/** Vim `e`: index of the end of the current/next word. */
export function nextWordEnd(text: string, off: number): number {
  const n = text.length
  if (n === 0) return 0
  let i = off + 1
  while (i < n && charClass(text[i]) === 0) i++
  if (i >= n) return n - 1
  const cls = charClass(text[i])
  while (i + 1 < n && charClass(text[i + 1]) === cls) i++
  return Math.min(i, n - 1)
}

/** Vim text object: the range covering `iw`/`aw` (word), `i"`/`a"` (and `'`/`` ` ``),
 *  and `i(`/`a(` etc. (brackets) around `offset`. `to` is exclusive. Returns
 *  null if the object isn't found (e.g. unbalanced brackets). */
export function textObjectRange(
  text: string,
  offset: number,
  scope: 'i' | 'a',
  obj: string
): { from: number; to: number } | null {
  const n = text.length
  if (n === 0) return null
  const off = Math.max(0, Math.min(offset, n - 1))

  if (obj === 'w') {
    const cls = charClass(text[off])
    let from = off
    let to = off + 1
    while (from > 0 && charClass(text[from - 1]) === cls) from--
    while (to < n && charClass(text[to]) === cls) to++
    if (scope === 'a') {
      const afterEnd = to
      while (to < n && charClass(text[to]) === 0) to++
      if (to === afterEnd) while (from > 0 && charClass(text[from - 1]) === 0) from--
    }
    return { from, to }
  }

  if (obj === '"' || obj === "'" || obj === '`') {
    let open = -1
    for (let i = off; i >= 0; i--) {
      if (text[i] === obj) {
        open = i
        break
      }
    }
    if (open === -1) {
      for (let i = off; i < n; i++) {
        if (text[i] === obj) {
          open = i
          break
        }
      }
    }
    if (open === -1) return null
    let close = -1
    for (let i = open + 1; i < n; i++) {
      if (text[i] === obj) {
        close = i
        break
      }
    }
    if (close === -1) return null
    return scope === 'i' ? { from: open + 1, to: close } : { from: open, to: close + 1 }
  }

  const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  let openCh: string
  let closeCh: string
  if (OPENERS[obj]) {
    openCh = obj
    closeCh = OPENERS[obj]
  } else if (CLOSERS[obj]) {
    openCh = CLOSERS[obj]
    closeCh = obj
  } else {
    return null
  }
  let depth = 0
  let openPos = -1
  for (let i = off; i >= 0; i--) {
    if (text[i] === closeCh && i !== off) depth++
    else if (text[i] === openCh) {
      if (depth === 0) {
        openPos = i
        break
      }
      depth--
    }
  }
  if (openPos === -1) return null
  depth = 0
  let closePos = -1
  for (let i = openPos + 1; i < n; i++) {
    if (text[i] === openCh) depth++
    else if (text[i] === closeCh) {
      if (depth === 0) {
        closePos = i
        break
      }
      depth--
    }
  }
  if (closePos === -1) return null
  return scope === 'i' ? { from: openPos + 1, to: closePos } : { from: openPos, to: closePos + 1 }
}

/** Collapse the caret at a character offset within the element's text node. */
function placeCaretAt(el: HTMLElement, offset: number): void {
  const node = el.firstChild
  const range = document.createRange()
  if (node && node.nodeType === Node.TEXT_NODE) {
    const max = node.textContent?.length ?? 0
    range.setStart(node, Math.max(0, Math.min(offset, max)))
  } else {
    range.selectNodeContents(el)
  }
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** Native selection offsets measured against an editable cell's plain text. */
function cellSelectionOffsets(el: HTMLElement): { from: number; to: number } | null {
  const selection = el.ownerDocument.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !el.contains(selection.anchorNode) ||
    !el.contains(selection.focusNode)
  ) {
    return null
  }
  const offsetOf = (node: Node, offset: number): number => {
    const range = el.ownerDocument.createRange()
    range.setStart(el, 0)
    range.setEnd(node, offset)
    return range.toString().length
  }
  const anchor = offsetOf(selection.anchorNode, selection.anchorOffset)
  const head = offsetOf(selection.focusNode, selection.focusOffset)
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) }
}

type CellTextWrap = { text: string; from: number; to: number }

/** Toggle a symmetric Markdown marker around one cell selection. */
function toggleCellTextWrap(
  text: string,
  from: number,
  to: number,
  marker: string
): CellTextWrap {
  const markerLength = marker.length
  if (from === to) {
    const before = text.slice(Math.max(0, from - markerLength), from)
    const after = text.slice(from, from + markerLength)
    const insideLongerPair =
      marker === '*' && text.slice(from - 2, from) === '**' && text.slice(from, from + 2) === '**'
    if (before === marker && after === marker && !insideLongerPair) {
      return {
        text: text.slice(0, from - markerLength) + text.slice(from + markerLength),
        from: from - markerLength,
        to: from - markerLength
      }
    }
    return {
      text: text.slice(0, from) + marker + marker + text.slice(from),
      from: from + markerLength,
      to: from + markerLength
    }
  }

  const before = text.slice(Math.max(0, from - markerLength), from)
  const after = text.slice(to, to + markerLength)
  if (before === marker && after === marker) {
    return {
      text: text.slice(0, from - markerLength) + text.slice(from, to) + text.slice(to + markerLength),
      from: from - markerLength,
      to: to - markerLength
    }
  }

  const selected = text.slice(from, to)
  if (
    selected.length >= markerLength * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    return {
      text:
        text.slice(0, from) +
        selected.slice(markerLength, selected.length - markerLength) +
        text.slice(to),
      from,
      to: to - markerLength * 2
    }
  }

  return {
    text: text.slice(0, from) + marker + selected + marker + text.slice(to),
    from: from + markerLength,
    to: to + markerLength
  }
}

/** Restore a native selection after replacing a cell's textContent. */
function placeCellSelection(el: HTMLElement, from: number, to: number): void {
  const text = el.textContent ?? ''
  const start = Math.max(0, Math.min(from, text.length))
  const end = Math.max(start, Math.min(to, text.length))
  const node = el.firstChild
  const range = el.ownerDocument.createRange()
  if (node?.nodeType === Node.TEXT_NODE) {
    range.setStart(node, start)
    range.setEnd(node, end)
  } else {
    range.setStart(el, 0)
    range.setEnd(el, 0)
  }
  const selection = el.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
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
      const parsed = parseTable(state.sliceDoc(node.from, node.to))
      if (!parsed) return false
      // Pull persisted column widths from a trailing zen:cols marker and extend
      // the replaced range over it. The widget's `eq` key (blockSource) includes
      // the marker, so a width change rebuilds the DOM. (#294)
      const ext = colWidthsAfter(state.doc, node.to)
      if (ext) parsed.colWidths = ext.widths
      const to = ext ? ext.to : node.to
      const blockSource = state.sliceDoc(node.from, to)
      ranges.push({
        from: node.from,
        to,
        deco: Decoration.replace({
          block: true,
          widget: new TableWidget(blockSource, parsed)
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

/** Find a `Table` node directly adjacent to `line`: `down` → a table on the
 *  next line, `up` → a table on the previous line. Returns its range or null. */
function adjacentTableRange(
  state: EditorState,
  line: number,
  dir: 'down' | 'up'
): { from: number; to: number } | null {
  const targetLine = dir === 'down' ? line + 1 : line - 1
  if (targetLine < 1 || targetLine > state.doc.lines) return null
  const probe =
    dir === 'down' ? state.doc.line(targetLine).from : state.doc.line(targetLine).to
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(
    probe,
    dir === 'down' ? 1 : -1
  )
  while (node) {
    if (node.name === 'Table') return { from: node.from, to: node.to }
    node = node.parent
  }
  return null
}

/** Focus the entry cell of the table widget at `tableFrom`: the first header
 *  cell when entering from above, the first cell of the last row from below. */
function focusTableEntryCell(
  view: EditorView,
  tableFrom: number,
  edge: 'first' | 'last'
): boolean {
  const widgets = view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-widget')
  for (const widget of widgets) {
    let pos: number
    try {
      pos = view.posAtDOM(widget)
    } catch {
      continue
    }
    if (pos !== tableFrom) continue
    let cell: HTMLElement | null
    if (edge === 'first') {
      cell = widget.querySelector<HTMLElement>('[data-row="-1"][data-col="0"]')
    } else {
      const bodyCol0 = Array.from(
        widget.querySelectorAll<HTMLElement>('[data-col="0"]')
      ).filter((c) => Number(c.dataset.row) >= 0)
      cell = bodyCol0.length ? bodyCol0[bodyCol0.length - 1] : null
    }
    if (cell) {
      cell.focus()
      return true
    }
  }
  return false
}

/**
 * Vim integration: in NORMAL mode, `j` / `k` on a line directly adjacent to a
 * rendered table steps the caret into the table (first header cell from above,
 * last row from below) instead of jumping over the atomic block. Inside, the
 * widget's own key handler takes over. Highest precedence so it runs before Vim
 * consumes the key; a no-op (returns false) whenever there's no adjacent table.
 */
export const tableVimEntry = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (!vimEnabled()) return false
      const navOverrides = useStore.getState().keymapOverrides
      const down =
        event.key === 'ArrowDown' || matchesSequenceToken(event, navOverrides, 'nav.moveDown')
      const up = event.key === 'ArrowUp' || matchesSequenceToken(event, navOverrides, 'nav.moveUp')
      if (!down && !up) return false
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
      // Keys from inside a table widget are the widget's own cell navigation —
      // this handler only enters a table from the surrounding document.
      if ((event.target as HTMLElement | null)?.closest?.('.cm-table-widget')) return false
      const vimState = getCM(view)?.state?.vim as { insertMode?: boolean } | undefined
      if (vimState?.insertMode) return false
      const sel = view.state.selection.main
      if (!sel.empty) return false
      const line = view.state.doc.lineAt(sel.head).number
      const dir = down ? 'down' : 'up'
      const table = adjacentTableRange(view.state, line, dir)
      if (!table) return false
      if (focusTableEntryCell(view, table.from, dir === 'down' ? 'first' : 'last')) {
        event.preventDefault()
        return true
      }
      return false
    }
  })
)
