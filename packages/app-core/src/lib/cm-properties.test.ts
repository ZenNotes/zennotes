// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  propertiesPanelPlugin,
  recordContextField,
  setRecordContext,
  type RecordContext
} from './cm-properties'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { frontmatterStyle } from './cm-frontmatter'

vi.mock('../store', () => {
  const state = { language: 'en' }
  const useStore = Object.assign(() => null, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useStore }
})

function mountEditor(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      // Caret in the body so the frontmatter region isn't the active line.
      selection: { anchor: doc.length },
      // Mount alongside the plugins it coexists with in edit mode — the
      // thematic-rule renderer (whose hr would otherwise overlap the `---`
      // fences) and the frontmatter line styler.
      extensions: [
        markdown({ base: markdownLanguage }),
        propertiesPanelPlugin,
        wysiwygBlocksPlugin,
        frontmatterStyle
      ]
    })
  })
}

const DOC = ['---', '状态: 已读', '评分: 4', '推荐: true', '---', '', '# Body'].join('\n')

describe('propertiesPanelPlugin', () => {
  it('renders frontmatter as a properties widget without a decoration error', () => {
    const view = mountEditor(DOC)
    const panel = view.dom.querySelector('.cm-note-properties')
    expect(panel).not.toBeNull()
    const text = view.dom.textContent ?? ''
    expect(text).toContain('Properties')
    expect(text).toContain('状态')
    expect(text).toContain('已读')
    expect(text).toContain('评分')
    // The raw `---` fences are replaced by the widget, not shown as source.
    expect(text).not.toContain('---')
    view.destroy()
  })

  it('toggles a checkbox value back into the YAML source', () => {
    const view = mountEditor(DOC)
    const box = view.dom.querySelector<HTMLButtonElement>('button.np-checkbox')
    expect(box).not.toBeNull()
    expect(box?.classList.contains('is-checked')).toBe(true)
    box?.click()
    expect(view.state.doc.toString()).toContain('推荐: false')
    expect(view.state.doc.toString()).not.toContain('推荐: true')
    view.destroy()
  })

  it('renders nothing when the note has no frontmatter', () => {
    const view = mountEditor('# Just a heading\n\nBody text.')
    expect(view.dom.querySelector('.cm-note-properties')).toBeNull()
    view.destroy()
  })

  it('removes a property via the icon menu', () => {
    const view = mountEditor(DOC)
    // Open the first row's (状态) type-icon menu, then click "Remove".
    view.dom.querySelector<HTMLButtonElement>('.np-icon-button')?.click()
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.np-menu .np-menu-item')
    )
    const remove = items.find((b) => b.textContent?.includes('Remove'))
    expect(remove).toBeTruthy()
    remove?.click()
    expect(view.state.doc.toString()).not.toContain('状态')
    expect(view.state.doc.toString()).toContain('评分: 4')
    view.destroy()
  })

  it('renames a property key in place', () => {
    const view = mountEditor(DOC)
    view.dom.querySelector<HTMLButtonElement>('.np-key-button')?.click()
    const input = view.dom.querySelector<HTMLInputElement>('.np-key-input')
    expect(input).not.toBeNull()
    input!.value = '阅读状态'
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view.state.doc.toString()).toContain('阅读状态: 已读')
    view.destroy()
  })

  it('adds a new property through the add row', () => {
    const view = mountEditor(DOC)
    view.dom.querySelector<HTMLButtonElement>('.np-add')?.click()
    const inputs = view.dom.querySelectorAll<HTMLInputElement>('.np-add-editor .np-input')
    expect(inputs).toHaveLength(2)
    inputs[0].value = '优先级'
    inputs[1].value = 'high'
    inputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view.state.doc.toString()).toContain('优先级: high')
    // Inserted inside the frontmatter, before the closing fence.
    const doc = view.state.doc.toString()
    expect(doc.indexOf('优先级')).toBeLessThan(doc.lastIndexOf('---'))
    view.destroy()
  })
})

// --- record pages: properties are a pure projection of the form ------------
// A record page carries NO YAML mirror. Values come from the database row (the
// record context) and edits write straight back via setCell — the file body is
// untouched.

// The page body — just a heading, no `--- … ---` frontmatter.
const RECORD_DOC = '# Body\n\nfree text.'
// A legacy page written by an older build still has the mirror block.
const LEGACY_RECORD_DOC = ['---', '状态: done', '推荐: true', '---', '', '# Body'].join('\n')

function recordCtx(setCell: ReturnType<typeof vi.fn>): RecordContext {
  return {
    csvPath: 'list/Books.csv',
    rowId: 'r1',
    setCell,
    fields: [
      {
        fieldId: 'f-status',
        name: '状态',
        type: 'select',
        value: 'done',
        options: [
          { id: 'o1', value: 'done', label: '已读' },
          { id: 'o2', value: 'reading', label: '在读' }
        ]
      },
      { fieldId: 'f-rec', name: '推荐', type: 'checkbox', value: 'true' },
      {
        fieldId: 'f-tags',
        name: '标签',
        type: 'multiSelect',
        value: 'a, b',
        options: [
          { id: 't1', value: 'a', label: '思维' },
          { id: 't2', value: 'b', label: '商业' }
        ]
      },
      { fieldId: 'f-score', name: '评分', type: 'number', value: '4' }
    ]
  }
}

function mountRecordEditor(doc: string): {
  view: EditorView
  ctx: RecordContext
  setCell: ReturnType<typeof vi.fn>
} {
  const setCell = vi.fn()
  const ctx = recordCtx(setCell)
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ base: markdownLanguage }),
        recordContextField,
        propertiesPanelPlugin,
        wysiwygBlocksPlugin,
        frontmatterStyle
      ]
    })
  })
  view.dispatch({ effects: setRecordContext.of(ctx) })
  return { view, ctx, setCell }
}

describe('propertiesPanelPlugin — record (form) pages', () => {
  it('renders a locked projection from the form, with no frontmatter in the file', () => {
    const { view } = mountRecordEditor(RECORD_DOC)
    expect(view.dom.querySelector('.cm-note-properties')).not.toBeNull()
    // Projected from the database even though the document has no YAML at all.
    expect(view.dom.querySelectorAll('.np-row-linked').length).toBe(4)
    // Locked structure: can't add, rename, or change type from the note.
    expect(view.dom.querySelector('.np-add')).toBeNull()
    expect(view.dom.querySelector('.np-key-button')).toBeNull()
    expect(view.dom.querySelector('.np-icon-button')).toBeNull()
    // The note body is left untouched (no mirror written).
    expect(view.state.doc.toString()).toBe(RECORD_DOC)
    view.destroy()
  })

  it('shows option labels (not raw values) for select / multiSelect', () => {
    const { view } = mountRecordEditor(RECORD_DOC)
    const text = view.dom.textContent ?? ''
    expect(text).toContain('已读') // select label for "done"
    expect(text).toContain('思维') // multiSelect label for "a"
    expect(text).toContain('商业') // multiSelect label for "b"
    expect(text).toContain('4') // number value
    expect(text).not.toContain('done')
    view.destroy()
  })

  it('toggles a checkbox by writing to the database only (file unchanged)', () => {
    const { view, setCell } = mountRecordEditor(RECORD_DOC)
    const box = view.dom.querySelector<HTMLButtonElement>('button.np-checkbox')
    expect(box?.classList.contains('is-checked')).toBe(true)
    box?.click()
    expect(setCell).toHaveBeenCalledWith('f-rec', 'false')
    expect(view.state.doc.toString()).toBe(RECORD_DOC) // no YAML mirror written
    view.destroy()
  })

  it('picks a select option, writing the value back to the database', () => {
    const { view, setCell } = mountRecordEditor(RECORD_DOC)
    const firstRow = view.dom.querySelector('.np-row-linked')
    firstRow?.querySelector<HTMLButtonElement>('.np-value-button')?.click()
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.np-menu .np-menu-item')
    )
    const pick = items.find((b) => b.textContent?.includes('在读'))
    expect(pick).toBeTruthy()
    pick?.click()
    expect(setCell).toHaveBeenCalledWith('f-status', 'reading')
    expect(view.state.doc.toString()).toBe(RECORD_DOC)
    view.destroy()
  })

  it('hides a legacy frontmatter mirror and projects from the database instead', () => {
    const { view } = mountRecordEditor(LEGACY_RECORD_DOC)
    const text = view.dom.textContent ?? ''
    // The stale `--- … ---` block is replaced by the projection, not shown raw.
    expect(text).not.toContain('---')
    // Values come from the database context, not the (stale) YAML.
    expect(view.dom.querySelectorAll('.np-row-linked').length).toBe(4)
    expect(text).toContain('已读')
    view.destroy()
  })
})
