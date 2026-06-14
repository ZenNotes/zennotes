/**
 * In-editor counterpart to the preview properties panel: replace a note's
 * leading YAML frontmatter (`---` … `---`) with an Obsidian-style properties
 * panel widget while in WYSIWYG edit mode.
 *
 * Interaction logic mirrors Obsidian's properties panel:
 *  - click a value (the whole cell is the target) to edit it; toggle a checkbox
 *  - click a key to rename it
 *  - click the leading type icon for a menu: change type, cut / copy / paste,
 *    or remove the property
 *  - the trailing "Add property" row appends a new one
 *
 * A property's type is encoded in its YAML value (see note-properties.ts), so
 * changing a type rewrites the value into the target type's form and warns when
 * the existing value isn't compatible — exactly like Obsidian. Everything is
 * written straight back into the YAML, the single source of truth.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import {
  splitMultiSelect,
  joinMultiSelect,
  isCheckboxTrue
} from '@shared/database-transforms'
import type { FieldType, SelectOption } from '@shared/databases'
import { useStore } from '../store'
import { translate } from './i18n'
import { confirmApp } from './confirm-requests'
import {
  coerceToKind,
  fieldIconKind,
  formatDateDisplay,
  inferPropKind,
  isChecked,
  propIconSvg,
  splitList,
  stripQuotes,
  type PropKind
} from './note-properties'

/**
 * The form projection backing a record page. When present, the note's
 * frontmatter is *not* free-form YAML — it mirrors the columns of a database
 * row, so the properties panel becomes a locked projection: you can edit a
 * value (which writes back to the table) but you cannot add, remove, rename,
 * or retype a property here — that is the form's job. A note that is not a
 * record page has a null context and keeps the full Obsidian-style editing.
 */
export interface RecordFieldMeta {
  fieldId: string
  name: string
  type: FieldType
  /** Current raw cell value, read live from the database row. */
  value: string
  options?: SelectOption[]
}

export interface RecordContext {
  csvPath: string
  rowId: string
  fields: RecordFieldMeta[]
  /** Write a raw cell value back to the database row (table ↔ note sync). */
  setCell: (fieldId: string, value: string) => void
}

/** Effect that pushes the current note's record context into the editor state. */
export const setRecordContext = StateEffect.define<RecordContext | null>()

/**
 * Holds the active note's record context. Lives at the top level of the editor
 * state (outside the WYSIWYG compartment) so it survives mode/live-preview
 * reconfigures; EditorPane keeps it current as the note or database changes.
 */
export const recordContextField = StateField.define<RecordContext | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRecordContext)) return e.value
    return value
  }
})

/** Stable identity for a record context's *shape* (drives widget rebuilds). */
function recordContextSig(ctx: RecordContext | null): string {
  if (!ctx) return ''
  return (
    `${ctx.csvPath}|${ctx.rowId}|` +
    ctx.fields
      .map(
        (f) =>
          `${f.name}:${f.type}:${f.value}:${(f.options ?? []).map((o) => `${o.value}=${o.label ?? ''}`).join(',')}`
      )
      .join(';')
  )
}

interface PropRow {
  key: string
  /** Raw YAML value, quotes/brackets kept (drives type inference). */
  raw: string
  kind: PropKind
  keyFrom: number
  keyTo: number
  valueFrom: number
  valueTo: number
  lineFrom: number
  lineEndWithBreak: number
}

interface FrontmatterParse {
  rows: PropRow[]
  from: number
  to: number
  insertAt: number
}

const TYPE_ORDER: PropKind[] = ['checkbox', 'date', 'datetime', 'list', 'number', 'text']
const TYPE_LABEL_KEY: Record<PropKind, string> = {
  checkbox: 'Checkbox',
  date: 'Date',
  datetime: 'Date & time',
  list: 'List',
  number: 'Number',
  text: 'Text'
}

/**
 * Line number of the closing `---` fence of leading frontmatter, or -1.
 * Exported so other WYSIWYG plugins (e.g. the thematic-rule renderer) can skip
 * the frontmatter region instead of fighting this plugin's block widget over
 * the same `---` lines.
 */
export function frontmatterEndLine(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return -1
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') return i
  }
  return -1
}

function parseFrontmatterRows(state: EditorState): FrontmatterParse | null {
  const doc = state.doc
  const endLine = frontmatterEndLine(state)
  if (endLine === -1) return null
  const rows: PropRow[] = []
  for (let i = 2; i < endLine; i++) {
    const line = doc.line(i)
    const idx = line.text.indexOf(':')
    if (idx === -1) continue
    const key = line.text.slice(0, idx).trim()
    if (!key) continue
    const raw = line.text.slice(idx + 1).trim()
    rows.push({
      key,
      raw,
      kind: inferPropKind(raw),
      keyFrom: line.from,
      keyTo: line.from + idx,
      valueFrom: line.from + idx + 1,
      valueTo: line.to,
      lineFrom: line.from,
      lineEndWithBreak: Math.min(line.to + 1, doc.length)
    })
  }
  return {
    rows,
    from: doc.line(1).from,
    to: doc.line(endLine).to,
    insertAt: doc.line(endLine).from
  }
}

function signature(rows: PropRow[]): string {
  return rows.map((r) => `${r.key} ${r.raw} ${r.kind}`).join('')
}

// One transient popup menu at a time. `commit` controls whether a deferred
// edit (the multiSelect picker) is written on close: true for a normal UI close
// (offsets are still valid), false when the widget is torn down by a document
// change (offsets would be stale, so the pending edit is dropped).
let closeActiveMenu: ((commit: boolean) => void) | null = null

class PropertiesWidget extends WidgetType {
  constructor(
    readonly rows: PropRow[],
    readonly insertAt: number,
    readonly ctx: RecordContext | null,
    readonly ctxSig: string
  ) {
    super()
  }

  eq(other: PropertiesWidget): boolean {
    return (
      signature(this.rows) === signature(other.rows) && this.ctxSig === other.ctxSig
    )
  }

  ignoreEvent(): boolean {
    return true
  }

  private t(key: string): string {
    return translate(useStore.getState().language, key)
  }

  destroy(): void {
    closeActiveMenu?.(false)
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'note-properties cm-note-properties'

    const title = document.createElement('div')
    title.className = 'np-title'
    title.textContent = this.t('Properties')
    root.appendChild(title)

    const rowsEl = document.createElement('div')
    rowsEl.className = 'np-rows'
    if (this.ctx) {
      // Record page: the panel is a pure projection of the form's columns,
      // sourced live from the database row — not from any YAML in the file.
      for (const field of this.ctx.fields) rowsEl.appendChild(this.renderRecordRow(field))
    } else {
      for (const row of this.rows) rowsEl.appendChild(this.renderRow(view, row))
    }
    root.appendChild(rowsEl)

    // A record page's properties are a fixed projection of the form's columns,
    // so there is no "Add property" affordance — rows are added in the table.
    if (!this.ctx) root.appendChild(this.renderAddRow(view))
    return root
  }

  /** A locked, read-only-structure row projecting one database column. */
  private renderRecordRow(field: RecordFieldMeta): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.className = 'np-row np-row-linked'
    rowEl.dataset.kind = fieldIconKind(field.type)

    const keyEl = document.createElement('div')
    keyEl.className = 'np-key'
    // The type is the column's type and is fixed, so the leading icon is static
    // (no type-change menu) and the name is read-only — edit those in the table.
    const icon = document.createElement('span')
    icon.className = 'np-icon-static'
    icon.innerHTML = propIconSvg(fieldIconKind(field.type))
    keyEl.appendChild(icon)
    const keyLabel = document.createElement('span')
    keyLabel.className = 'np-key-label'
    keyLabel.textContent = field.name
    keyEl.appendChild(keyLabel)
    rowEl.appendChild(keyEl)

    const cell = document.createElement('div')
    cell.className = 'np-cell'
    this.renderRecordCell(field, cell)
    rowEl.appendChild(cell)
    return rowEl
  }

  private renderRow(view: EditorView, row: PropRow): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.className = 'np-row'
    rowEl.dataset.kind = row.kind

    const keyEl = document.createElement('div')
    keyEl.className = 'np-key'

    const iconBtn = document.createElement('button')
    iconBtn.type = 'button'
    iconBtn.className = 'np-icon-button'
    iconBtn.setAttribute('aria-label', this.t('Property type'))
    iconBtn.innerHTML = propIconSvg(row.kind)
    iconBtn.addEventListener('mousedown', (e) => e.preventDefault())
    iconBtn.addEventListener('click', () => this.openMenu(view, row, iconBtn))
    keyEl.appendChild(iconBtn)

    const keyBtn = document.createElement('button')
    keyBtn.type = 'button'
    keyBtn.className = 'np-key-button'
    const keyLabel = document.createElement('span')
    keyLabel.className = 'np-key-label'
    keyLabel.textContent = row.key
    keyBtn.appendChild(keyLabel)
    keyBtn.addEventListener('mousedown', (e) => e.preventDefault())
    keyBtn.addEventListener('click', () => this.editKey(view, row, keyBtn))
    keyEl.appendChild(keyBtn)
    rowEl.appendChild(keyEl)

    const cell = document.createElement('div')
    cell.className = 'np-cell'
    this.renderCell(view, row, cell)
    rowEl.appendChild(cell)
    return rowEl
  }

  /** Replace `[valueFrom, valueTo]` with a serialized value on its line. */
  private writeValue(view: EditorView, row: PropRow, yaml: string): void {
    view.dispatch({
      changes: { from: row.valueFrom, to: row.valueTo, insert: yaml ? ` ${yaml}` : '' }
    })
  }

  private deleteRow(view: EditorView, row: PropRow): void {
    view.dispatch({ changes: { from: row.lineFrom, to: row.lineEndWithBreak, insert: '' } })
  }

  // --- record (form projection) cells ----------------------------------
  // A record page has no YAML; its values live in the database row. Reads come
  // from `field.value` (kept current by the record context) and edits write
  // straight back to the table via `setCell` — the single source of truth.

  private optionLabel(field: RecordFieldMeta, value: string): string {
    return field.options?.find((o) => o.value === value)?.label ?? value
  }

  private setRecordValue(field: RecordFieldMeta, rawValue: string): void {
    this.ctx?.setCell(field.fieldId, rawValue)
  }

  private renderRecordCell(field: RecordFieldMeta, cell: HTMLElement): void {
    cell.replaceChildren()
    const raw = field.value.trim()

    if (field.type === 'checkbox') {
      const box = document.createElement('button')
      box.type = 'button'
      box.className = 'np-checkbox'
      if (isCheckboxTrue(raw)) box.classList.add('is-checked')
      box.setAttribute('aria-label', field.name)
      box.addEventListener('mousedown', (e) => e.preventDefault())
      box.addEventListener('click', () => {
        box.classList.toggle('is-checked') // optimistic; the rebuild confirms it
        this.setRecordValue(field, isCheckboxTrue(raw) ? 'false' : 'true')
      })
      cell.appendChild(box)
      return
    }

    if (field.type === 'select' || field.type === 'multiSelect') {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'np-value-button'
      const values =
        field.type === 'multiSelect' ? splitMultiSelect(field.value) : raw ? [raw] : []
      if (values.length === 0) {
        button.appendChild(this.emptyValue())
      } else {
        const chips = document.createElement('span')
        chips.className = 'np-chips'
        for (const v of values) {
          const chip = document.createElement('span')
          chip.className = 'np-chip'
          chip.textContent = this.optionLabel(field, v)
          chips.appendChild(chip)
        }
        button.appendChild(chips)
      }
      button.addEventListener('mousedown', (e) => e.preventDefault())
      button.addEventListener('click', () => this.openOptionMenu(field, button))
      cell.appendChild(button)
      return
    }

    // text / number / date — an inline input, like the independent value cell.
    const value = document.createElement('button')
    value.type = 'button'
    value.className = 'np-value-button'
    if (raw === '') {
      value.appendChild(this.emptyValue())
    } else if (field.type === 'date') {
      const span = document.createElement('span')
      span.className = 'np-value np-value-date'
      span.textContent = formatDateDisplay(raw)
      value.appendChild(span)
    } else {
      const span = document.createElement('span')
      span.className = 'np-value'
      span.textContent = raw
      value.appendChild(span)
    }
    value.addEventListener('mousedown', (e) => e.preventDefault())
    value.addEventListener('click', () => this.editRecordValue(field, cell))
    cell.appendChild(value)
  }

  private editRecordValue(field: RecordFieldMeta, cell: HTMLElement): void {
    cell.replaceChildren()
    const input = document.createElement('input')
    input.className = 'np-input'
    input.type = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'
    input.value = field.value.trim()
    cell.appendChild(input)
    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const next = input.value.trim()
      if (save && next !== field.value.trim()) this.setRecordValue(field, next)
      else this.renderRecordCell(field, cell)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    input.focus()
    if (input.type === 'text') input.select()
  }

  /**
   * Option picker for a select / multiSelect record field. Single-select writes
   * and closes; multiSelect accumulates toggles in the open menu and writes the
   * joined value once on close.
   */
  private openOptionMenu(field: RecordFieldMeta, anchor: HTMLElement): void {
    closeActiveMenu?.(true)
    const options = field.options ?? []
    const multi = field.type === 'multiSelect'
    const selected = new Set(
      multi ? splitMultiSelect(field.value) : [field.value.trim()].filter(Boolean)
    )
    let changed = false

    const menu = document.createElement('div')
    menu.className = 'np-menu'
    const cleanup = (commit: boolean): void => {
      menu.remove()
      document.removeEventListener('mousedown', onDown, true)
      closeActiveMenu = null
      if (commit && multi && changed) {
        const ordered = options.filter((o) => selected.has(o.value)).map((o) => o.value)
        this.setRecordValue(field, joinMultiSelect(ordered))
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (menu.contains(e.target as Node)) return
      cleanup(true)
    }

    const renderItems = (): void => {
      menu.replaceChildren()
      if (!multi) {
        menu.appendChild(
          this.optionItem(this.t('None'), selected.size === 0, () => {
            cleanup(true)
            this.setRecordValue(field, '')
          })
        )
      }
      for (const o of options) {
        const label = o.label ?? o.value
        const isOn = selected.has(o.value)
        menu.appendChild(
          this.optionItem(label, isOn, () => {
            if (multi) {
              changed = true
              if (isOn) selected.delete(o.value)
              else selected.add(o.value)
              renderItems()
            } else {
              cleanup(true)
              this.setRecordValue(field, o.value)
            }
          })
        )
      }
      if (options.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'np-menu-empty'
        empty.textContent = this.t('No options')
        menu.appendChild(empty)
      }
    }
    renderItems()

    document.body.appendChild(menu)
    positionAt(menu, anchor.getBoundingClientRect(), 'below')
    document.addEventListener('mousedown', onDown, true)
    closeActiveMenu = cleanup
  }

  private optionItem(label: string, checked: boolean, onClick: () => void): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'np-menu-item'
    el.innerHTML =
      `<span class="np-menu-icon"></span>` +
      `<span class="np-menu-label">${escapeText(label)}</span>` +
      (checked ? '<span class="np-menu-check">✓</span>' : '')
    el.addEventListener('mousedown', (e) => e.preventDefault())
    el.addEventListener('click', onClick)
    return el
  }

  private renderCell(view: EditorView, row: PropRow, cell: HTMLElement): void {
    cell.replaceChildren()
    if (row.kind === 'checkbox') {
      const box = document.createElement('button')
      box.type = 'button'
      box.className = 'np-checkbox'
      if (isChecked(row.raw)) box.classList.add('is-checked')
      box.setAttribute('aria-label', row.key)
      box.addEventListener('mousedown', (e) => e.preventDefault())
      box.addEventListener('click', () =>
        this.writeValue(view, row, isChecked(row.raw) ? 'false' : 'true')
      )
      cell.appendChild(box)
      return
    }

    const value = document.createElement('button')
    value.type = 'button'
    value.className = 'np-value-button'
    value.appendChild(this.renderValueDisplay(row))
    value.addEventListener('mousedown', (e) => e.preventDefault())
    value.addEventListener('click', () => this.editValue(view, row, cell))
    cell.appendChild(value)
  }

  private renderValueDisplay(row: PropRow): HTMLElement {
    if (row.kind === 'list') {
      const items = splitList(row.raw)
      if (items.length === 0) return this.emptyValue()
      const chips = document.createElement('span')
      chips.className = 'np-chips'
      for (const item of items) {
        const chip = document.createElement('span')
        chip.className = 'np-chip'
        chip.textContent = item
        chips.appendChild(chip)
      }
      return chips
    }
    const bare = stripQuotes(row.raw)
    if (bare === '') return this.emptyValue()
    const span = document.createElement('span')
    span.className = 'np-value'
    if (row.kind === 'date' || row.kind === 'datetime') {
      span.classList.add('np-value-date')
      span.textContent = formatDateDisplay(row.raw)
    } else {
      span.textContent = bare
    }
    return span
  }

  private emptyValue(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'np-value np-empty'
    return span
  }

  private editValue(view: EditorView, row: PropRow, cell: HTMLElement): void {
    cell.replaceChildren()
    const input = document.createElement('input')
    input.className = 'np-input'
    input.type = row.kind === 'date' ? 'date' : row.kind === 'datetime' ? 'datetime-local' : 'text'
    input.value = stripQuotes(row.raw)
    cell.appendChild(input)
    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const next = coerceToKind(input.value, row.kind).yaml
      if (save && next !== row.raw) this.writeValue(view, row, next)
      else this.renderCell(view, row, cell)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    input.focus()
    if (input.type === 'text') input.select()
  }

  private editKey(view: EditorView, row: PropRow, keyBtn: HTMLElement): void {
    const input = document.createElement('input')
    input.className = 'np-input np-key-input'
    input.value = row.key
    keyBtn.replaceWith(input)
    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const next = input.value.trim()
      if (save && next && next !== row.key) {
        view.dispatch({ changes: { from: row.keyFrom, to: row.keyTo, insert: next } })
      } else {
        input.replaceWith(keyBtn)
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    input.focus()
    input.select()
  }

  /** Coerce the value to a new type, warning first when data is incompatible. */
  private async changeType(view: EditorView, row: PropRow, toKind: PropKind): Promise<void> {
    if (toKind === row.kind) return
    const { yaml, lossy } = coerceToKind(row.raw, toKind)
    const hasValue = stripQuotes(row.raw) !== ''
    if (hasValue && (lossy || yaml !== row.raw)) {
      const ok = await confirmApp({
        title: this.t('Change property type?'),
        description: this.t(
          'The current value isn’t compatible and will be adjusted to fit the new type.'
        ),
        confirmLabel: this.t('Update')
      })
      if (!ok) return
    }
    this.writeValue(view, row, yaml)
  }

  private async copyRow(row: PropRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${row.key}: ${row.raw}`)
    } catch {
      /* clipboard unavailable */
    }
  }

  private async pasteRow(view: EditorView): Promise<void> {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    const line = text.split(/\r?\n/)[0] ?? ''
    const idx = line.indexOf(':')
    if (idx === -1) return
    const key = line.slice(0, idx).trim()
    if (!key) return
    const value = line.slice(idx + 1).trim()
    view.dispatch({
      changes: { from: this.insertAt, to: this.insertAt, insert: `${key}:${value ? ` ${value}` : ''}\n` }
    })
  }

  private openMenu(view: EditorView, row: PropRow, anchor: HTMLElement): void {
    closeActiveMenu?.(true)
    const menus: HTMLElement[] = []
    const cleanup = (): void => {
      for (const m of menus) m.remove()
      document.removeEventListener('mousedown', onDown, true)
      closeActiveMenu = null
    }
    const onDown = (e: MouseEvent): void => {
      if (menus.some((m) => m.contains(e.target as Node))) return
      cleanup()
    }

    const menu = this.makeMenu([
      {
        label: this.t('Property type'),
        icon: 'info',
        submenu: TYPE_ORDER.map((kind) => ({
          label: this.t(TYPE_LABEL_KEY[kind]),
          icon: kind,
          checked: kind === row.kind,
          onClick: () => {
            cleanup()
            void this.changeType(view, row, kind)
          }
        }))
      },
      { separator: true },
      { label: this.t('Cut'), icon: 'cut', onClick: () => { cleanup(); void this.copyRow(row).then(() => this.deleteRow(view, row)) } },
      { label: this.t('Copy'), icon: 'copy', onClick: () => { cleanup(); void this.copyRow(row) } },
      { label: this.t('Paste'), icon: 'paste', onClick: () => { cleanup(); void this.pasteRow(view) } },
      { separator: true },
      { label: this.t('Remove'), icon: 'trash', danger: true, onClick: () => { cleanup(); this.deleteRow(view, row) } }
    ])
    document.body.appendChild(menu)
    menus.push(menu)
    positionAt(menu, anchor.getBoundingClientRect(), 'below')

    // Wire the type submenu (the only item that opens one).
    const typeItem = menu.querySelector<HTMLElement>('[data-has-submenu]')
    if (typeItem) {
      const open = (): void => {
        if (menus.length > 1) return
        const sub = this.makeMenu(
          TYPE_ORDER.map((kind) => ({
            label: this.t(TYPE_LABEL_KEY[kind]),
            icon: kind,
            checked: kind === row.kind,
            onClick: () => {
              cleanup()
              void this.changeType(view, row, kind)
            }
          }))
        )
        document.body.appendChild(sub)
        menus.push(sub)
        positionAt(sub, typeItem.getBoundingClientRect(), 'right')
      }
      typeItem.addEventListener('mouseenter', open)
      typeItem.addEventListener('click', open)
    }

    document.addEventListener('mousedown', onDown, true)
    closeActiveMenu = cleanup
  }

  private makeMenu(
    items: Array<
      | { separator: true }
      | {
          label: string
          icon?: string
          danger?: boolean
          checked?: boolean
          submenu?: unknown[]
          onClick?: () => void
        }
    >
  ): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'np-menu'
    for (const item of items) {
      if ('separator' in item) {
        const sep = document.createElement('div')
        sep.className = 'np-menu-sep'
        menu.appendChild(sep)
        continue
      }
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'np-menu-item'
      if (item.danger) el.classList.add('is-danger')
      if (item.submenu) el.dataset.hasSubmenu = ''
      el.innerHTML =
        `<span class="np-menu-icon">${menuIconSvg(item.icon)}</span>` +
        `<span class="np-menu-label">${escapeText(item.label)}</span>` +
        (item.submenu ? '<span class="np-menu-arrow">›</span>' : '') +
        (item.checked ? '<span class="np-menu-check">✓</span>' : '')
      el.addEventListener('mousedown', (e) => e.preventDefault())
      if (item.onClick) el.addEventListener('click', item.onClick)
      menu.appendChild(el)
    }
    return menu
  }

  private renderAddRow(view: EditorView): HTMLElement {
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'np-add'
    add.innerHTML =
      '<svg class="np-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
    const label = document.createElement('span')
    label.textContent = this.t('Add property')
    add.appendChild(label)
    add.addEventListener('mousedown', (e) => e.preventDefault())
    add.addEventListener('click', () => this.beginAdd(view, add))
    return add
  }

  private beginAdd(view: EditorView, addBtn: HTMLElement): void {
    const editor = document.createElement('div')
    editor.className = 'np-add-editor'
    const keyInput = document.createElement('input')
    keyInput.className = 'np-input'
    keyInput.placeholder = this.t('Property name')
    const valueInput = document.createElement('input')
    valueInput.className = 'np-input'
    valueInput.placeholder = this.t('Value')
    editor.append(keyInput, valueInput)
    addBtn.replaceWith(editor)

    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const key = keyInput.value.trim()
      if (save && key) {
        const value = valueInput.value.trim()
        const line = `${key}:${value ? ` ${coerceToKind(value, inferPropKind(value)).yaml}` : ''}\n`
        view.dispatch({ changes: { from: this.insertAt, to: this.insertAt, insert: line } })
      } else {
        editor.replaceWith(addBtn)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    }
    keyInput.addEventListener('keydown', onKey)
    valueInput.addEventListener('keydown', onKey)
    editor.addEventListener('focusout', (e) => {
      if (!editor.contains(e.relatedTarget as Node | null)) finish(true)
    })
    keyInput.focus()
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Small menu icons (Tabler outline). */
function menuIconSvg(name?: string): string {
  const open =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  const paths: Record<string, string> = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    cut: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 8l12 12M20 4 9.5 14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 12h6M9 16h4"/>',
    trash: '<path d="M5 7h14M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    checkbox: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/>',
    date: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/>',
    datetime: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    number: '<path d="M10 4 8 20M16 4l-2 16M4 9h16M3 15h16"/>',
    text: '<path d="M4 6h16M4 12h16M4 18h10"/>'
  }
  return `${open}${name ? paths[name] ?? '' : ''}</svg>`
}

/** Position a floating menu near an anchor rect, clamped to the viewport. */
function positionAt(menu: HTMLElement, rect: DOMRect, side: 'below' | 'right'): void {
  menu.style.visibility = 'hidden'
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = side === 'right' ? rect.right + 2 : rect.left
  let top = side === 'right' ? rect.top : rect.bottom + 4
  const pad = 8
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, rect.left - mw - 2)
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - mh - pad)
  menu.style.left = `${Math.max(pad, left)}px`
  menu.style.top = `${Math.max(pad, top)}px`
  menu.style.visibility = 'visible'
}

function buildDecorations(state: EditorState): DecorationSet {
  const parsed = parseFrontmatterRows(state)
  const ctx = state.field(recordContextField, false) ?? null

  // Record page: a pure projection of the form's columns, rendered from the
  // database — no YAML needed. The panel sits at the very top of the note. If a
  // legacy mirror block is still present it is replaced (and hidden); otherwise
  // the panel is inserted above the first line.
  if (ctx) {
    if (ctx.fields.length === 0) return Decoration.none
    const widget = new PropertiesWidget([], 0, ctx, recordContextSig(ctx))
    if (parsed) {
      return Decoration.set([
        Decoration.replace({ widget, block: true }).range(parsed.from, parsed.to)
      ])
    }
    return Decoration.set([
      Decoration.widget({ widget, block: true, side: -1 }).range(0)
    ])
  }

  // Plain note: render the editable YAML frontmatter panel, or nothing.
  if (!parsed) return Decoration.none
  return Decoration.set([
    Decoration.replace({
      widget: new PropertiesWidget(parsed.rows, parsed.insertAt, null, ''),
      block: true
    }).range(parsed.from, parsed.to)
  ])
}

// Block decorations must come from a StateField (CodeMirror forbids them from
// view plugins, since block layout is decided before the viewport is known).
export const propertiesPanelPlugin = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (value, tr) =>
    tr.docChanged || tr.effects.some((e) => e.is(setRecordContext))
      ? buildDecorations(tr.state)
      : value,
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of(
      (view) => view.state.field(field, false) ?? Decoration.none
    )
  ]
})
