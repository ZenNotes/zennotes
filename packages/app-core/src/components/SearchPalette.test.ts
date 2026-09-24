// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { useToastStore } from '../lib/toast'
import { SearchPalette } from './SearchPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confirmApp = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../lib/confirm-requests', () => ({ confirmApp }))
// Closing the palette hands focus back to the editor with a few timed retries;
// there is no editor here and the retries would outlive the jsdom window.
const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

describe('SearchPalette: Ctrl+D moves the highlighted note to Trash', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let moveToTrash: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    confirmApp.mockClear()
    confirmApp.mockResolvedValue(true)

    const notes = [note('Alpha'), note('Beta'), note('Gamma')]
    moveToTrash = vi.fn(async (path: string) => ({
      ...notes.find((n) => n.path === path)!,
      path: path.replace('inbox/', 'trash/'),
      folder: 'trash' as const
    }))
    ;(window as unknown as { zen: unknown }).zen = { moveToTrash }
    useStore.setState({
      notes,
      selectedPath: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      // The real refresh re-lists the vault through the bridge; here the
      // listing just forgets whatever was trashed.
      refreshNotes: async () => {
        const trashed = new Set(moveToTrash.mock.calls.map((call) => call[0] as string))
        useStore.setState({ notes: notes.filter((n) => !trashed.has(n.path)) })
      }
    })
    useToastStore.setState({ toasts: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    delete (window as unknown as { zen?: unknown }).zen
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const input = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const rows = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-search-idx]')].map(
      (row) => row.textContent?.replace(/inbox$/i, '').trim() ?? ''
    )
  const ctrlD = async (): Promise<void> => {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('trashes the highlighted note, keeps the palette open, and drops the row', async () => {
    act(() => root.render(createElement(SearchPalette)))
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    await ctrlD()

    expect(confirmApp).toHaveBeenCalledTimes(1)
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Beta.md')
    expect(useStore.getState().searchOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(rows()).toEqual(['Alpha', 'Gamma'])
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Moved "Beta" to Trash'
    )
    // The highlight stays on the row that took Beta's place.
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })

  it('does nothing when the confirmation is declined', async () => {
    confirmApp.mockResolvedValue(false)
    act(() => root.render(createElement(SearchPalette)))
    await ctrlD()
    expect(moveToTrash).not.toHaveBeenCalled()
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('clamps the highlight when the last row is trashed', async () => {
    act(() => root.render(createElement(SearchPalette)))
    for (let i = 0; i < 2; i++) {
      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        )
      })
    }
    await ctrlD()
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Gamma.md')
    expect(rows()).toEqual(['Alpha', 'Beta'])
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })
})

// #826: a search that finds no note with the typed name offers to create it:
// a create row after the results, and Shift+Enter from anywhere, both leading
// to a New note form where the name, folder and tags can change first.
describe('SearchPalette: the create row opens a New note form', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let createAndOpen: ReturnType<typeof vi.fn>
  let selectNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

    createAndOpen = vi.fn(async () => {})
    selectNote = vi.fn(async () => {})
    focusEditorNormalMode.mockClear()
    useStore.setState({
      notes: [
        { ...note('Alpha'), tags: ['ops', 'prod'] },
        { ...note('Beta'), tags: ['ops'] },
        { ...note('Roadmap'), path: 'inbox/projects/Roadmap.md' }
      ],
      folders: [
        { folder: 'inbox', subpath: 'projects', siblingOrder: 0 },
        { folder: 'inbox', subpath: 'projects/ideas', siblingOrder: 0 },
        { folder: 'archive', subpath: 'old', siblingOrder: 0 }
      ],
      systemFolderLabels: {},
      selectedPath: null,
      activeNote: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      createAndOpen: createAndOpen as unknown as ReturnType<typeof useStore.getState>['createAndOpen'],
      selectNote: selectNote as unknown as ReturnType<typeof useStore.getState>['selectNote']
    })
    act(() => root.render(createElement(SearchPalette)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const search = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const field = (id: 'name' | 'folder' | 'tags'): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>(`#search-create-${id}`)
    if (!el) throw new Error(`${id} field not rendered`)
    return el
  }
  const form = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-search-create-form]')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const type = (el: HTMLInputElement, text: string): void => {
    act(() => {
      setValue.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = async (el: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const focus = (el: HTMLElement): void => {
    act(() => el.focus())
  }
  const createRow = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-search-create]')
  const highlighted = (): string | null =>
    document.querySelector<HTMLElement>('[data-search-idx].bg-paper-200')?.dataset.searchIdx ?? null
  const formRows = (attr: 'folder' | 'tag'): string[] =>
    [...document.querySelectorAll<HTMLElement>(`[data-search-form-${attr}]`)].map(
      (row) => row.dataset[attr === 'folder' ? 'searchFormFolder' : 'searchFormTag'] ?? ''
    )
  const formHighlighted = (): string | null =>
    document.querySelector<HTMLElement>('[data-search-form-idx].bg-paper-200')?.dataset.searchFormIdx ??
    null
  const chipTags = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-search-create-tag]')].map(
      (chip) => chip.dataset.searchCreateTag ?? ''
    )
  const status = (): { kind: string | undefined; text: string } => {
    const el = document.querySelector<HTMLElement>('[data-search-create-status]')
    return { kind: el?.dataset.searchCreateStatus, text: el?.textContent ?? '' }
  }
  const createButton = (): HTMLButtonElement => {
    const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Create'
    )
    if (!el) throw new Error('Create button not rendered')
    return el
  }

  it('Shift+Enter opens the form with the name filled in and selected; Enter creates in Inbox', async () => {
    type(search(), 'Meeting notes')
    expect(createRow()?.textContent).toBe('Create "Meeting notes"…Inbox')
    expect(document.body.textContent).not.toContain('No matches.')

    await key(search(), 'Enter', { shiftKey: true })
    expect(form()).not.toBeNull()
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(field('name').value).toBe('Meeting notes')
    expect(document.activeElement).toBe(field('name'))
    expect(field('folder').value).toBe('')
    expect(status()).toEqual({ kind: 'ok', text: 'Creates "Meeting notes" in Inbox' })

    await key(field('name'), 'Enter')
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Meeting notes', tags: [] })
    expect(selectNote).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(false)
    // The name is settled, so the new note opens with the editor focused
    // (like `:e name`), not with the title field waiting for one.
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('the row follows the fuzzy matches; Enter on it opens the form instead of creating', async () => {
    type(search(), 'Alph')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-search-idx]')]
    expect(rows.map((r) => r.dataset.searchIdx)).toEqual(['0', '1'])
    expect(rows[0].textContent).toBe('Alphainbox')
    expect(rows[1].hasAttribute('data-search-create')).toBe(true)
    expect(highlighted()).toBe('0')

    await key(search(), 'ArrowDown')
    expect(highlighted()).toBe('1')
    await key(search(), 'ArrowDown')
    expect(highlighted()).toBe('1')

    await key(search(), 'Enter')
    expect(form()).not.toBeNull()
    expect(field('name').value).toBe('Alph')
    expect(createAndOpen).not.toHaveBeenCalled()
  })

  it('plain Enter on a match still opens it, never the form', async () => {
    type(search(), 'Alph')
    await key(search(), 'Enter')
    expect(selectNote).toHaveBeenCalledWith('inbox/Alpha.md')
    expect(form()).toBeNull()
  })

  it('a typed path fills the Folder field, and the Folder picker filters, picks and moves on to Tags', async () => {
    type(search(), 'projects/ideas/Q4 plan')
    expect(createRow()?.textContent).toBe('Create "Q4 plan"…Inbox › projects/ideas')
    await key(search(), 'Enter', { shiftKey: true })
    expect(field('folder').value).toBe('projects/ideas')

    // Focusing the field lists every folder (the three roots and their
    // subfolders), nothing highlighted, so Enter would still create. Typing
    // narrows the list and preselects the first hit.
    focus(field('folder'))
    expect(formRows('folder')).toEqual([
      '',
      'projects',
      'projects/ideas',
      'quick',
      'archive',
      'archive/old'
    ])
    expect(formHighlighted()).toBeNull()
    type(field('folder'), 'arch')
    expect(formRows('folder')).toEqual(['archive', 'archive/old'])
    expect(formHighlighted()).toBe('0')
    await key(field('folder'), 'ArrowDown')
    expect(formHighlighted()).toBe('1')

    await key(field('folder'), 'Enter')
    expect(field('folder').value).toBe('archive/old')
    expect(document.activeElement).toBe(field('tags'))
    expect(status().text).toBe('Creates "Q4 plan" in Archive › old')
    expect(createAndOpen).not.toHaveBeenCalled()

    await key(field('tags'), 'Enter')
    expect(createAndOpen).toHaveBeenCalledWith('archive', 'old', { title: 'Q4 plan', tags: [] })
  })

  it('a folder that does not exist yet is typed, not picked: ArrowUp keeps the typed value', async () => {
    type(search(), 'Q4 plan')
    await key(search(), 'Enter', { shiftKey: true })
    focus(field('folder'))
    type(field('folder'), 'proj')
    expect(formHighlighted()).toBe('0')
    await key(field('folder'), 'ArrowUp')
    expect(formHighlighted()).toBeNull()
    await key(field('folder'), 'Enter')
    expect(createAndOpen).toHaveBeenCalledWith('inbox', 'proj', { title: 'Q4 plan', tags: [] })
  })

  it('a name already used in that folder blocks Create until it changes, and Shift+Enter opens the note', async () => {
    type(search(), 'alpha')
    await key(search(), 'Enter', { shiftKey: true })
    expect(status().kind).toBe('collision')
    expect(status().text).toContain('"Alpha" already exists in Inbox. Change the name, or open it.')
    expect(createButton().disabled).toBe(true)

    await key(field('name'), 'Enter')
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(true)

    type(field('name'), 'Alpha 2')
    expect(status()).toEqual({ kind: 'ok', text: 'Creates "Alpha 2" in Inbox' })
    expect(createButton().disabled).toBe(false)

    type(field('name'), 'alpha')
    await key(field('name'), 'Enter', { shiftKey: true })
    expect(selectNote).toHaveBeenCalledWith('inbox/Alpha.md')
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(false)
  })

  it('a same-named note elsewhere only warns, and the chosen folder decides', async () => {
    type(search(), 'roadmap')
    await key(search(), 'Enter', { shiftKey: true })
    expect(status().kind).toBe('collision')
    expect(status().text).toContain('A note named "Roadmap" already exists in Inbox › projects.')
    expect(createButton().disabled).toBe(false)

    type(field('folder'), 'projects')
    expect(status().text).toContain('already exists in Inbox › projects. Change the name')
    expect(createButton().disabled).toBe(true)

    type(field('folder'), '')
    await key(field('name'), 'Enter')
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'roadmap', tags: [] })
  })

  it('tags: query #words become chips, the picker offers vault tags, typing adds new ones', async () => {
    type(search(), '#ops Runbook')
    expect(createRow()?.textContent).toBe('Create "Runbook"…Inbox')
    await key(search(), 'Enter', { shiftKey: true })
    expect(chipTags()).toEqual(['ops'])

    // No text: the vault's other tags, most used first, minus the chosen one.
    focus(field('tags'))
    expect(formRows('tag')).toEqual(['prod'])
    expect(formHighlighted()).toBeNull()

    // A prefix preselects the vault tag; Enter takes that spelling.
    type(field('tags'), 'pr')
    expect(formRows('tag')).toEqual(['prod', 'pr'])
    expect(formHighlighted()).toBe('0')
    await key(field('tags'), 'Enter')
    expect(chipTags()).toEqual(['ops', 'prod'])
    expect(field('tags').value).toBe('')

    // Text no tag starts with is offered as new; a comma commits it as typed.
    type(field('tags'), 'k8s')
    expect(formRows('tag')).toEqual(['k8s'])
    await key(field('tags'), ',')
    expect(chipTags()).toEqual(['ops', 'prod', 'k8s'])

    // Backspace on an empty field takes the last chip back.
    await key(field('tags'), 'Backspace')
    expect(chipTags()).toEqual(['ops', 'prod'])
    expect(status().text).toBe('Creates "Runbook" in Inbox with #ops #prod')

    await key(field('tags'), 'Enter')
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', {
      title: 'Runbook',
      tags: ['ops', 'prod']
    })
  })

  it('text left in the Tags field still counts when Create is clicked; text that is no tag blocks', async () => {
    type(search(), 'Runbook')
    await key(search(), 'Enter', { shiftKey: true })
    focus(field('tags'))
    type(field('tags'), '9lives')
    expect(status().kind).toBe('error')
    expect(status().text).toMatch(/Tags start with a letter/)
    expect(createButton().disabled).toBe(true)

    type(field('tags'), 'oncall')
    expect(createButton().disabled).toBe(false)
    await act(async () => {
      createButton().click()
      await Promise.resolve()
    })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Runbook', tags: ['oncall'] })
  })

  // A browser moves focus to a pressed button as mousedown's default action,
  // unless the event is cancelled; jsdom leaves that step to the test. The
  // blur used to unmount the list under the fields and move the footer
  // before mouseup, so the click never fired and the first Create was lost.
  const press = async (button: HTMLElement, focusedField: HTMLInputElement): Promise<void> => {
    await act(async () => {
      const uncancelled = button.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      )
      if (uncancelled) focusedField.blur()
      await Promise.resolve()
    })
  }

  it('pressing the mouse on Create keeps the Tags field focused, so the click lands and the typed tag counts', async () => {
    type(search(), 'Runbook')
    await key(search(), 'Enter', { shiftKey: true })
    focus(field('tags'))
    type(field('tags'), 'oncall')
    expect(formRows('tag')).toEqual(['oncall'])

    await press(createButton(), field('tags'))
    expect(document.activeElement).toBe(field('tags'))
    expect(formRows('tag')).toEqual(['oncall'])
    expect(chipTags()).toEqual([])

    await act(async () => {
      createButton().click()
      await Promise.resolve()
    })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Runbook', tags: ['oncall'] })
  })

  it('pressing the mouse on Back keeps the folder list until the click', async () => {
    type(search(), 'Runbook')
    await key(search(), 'Enter', { shiftKey: true })
    focus(field('folder'))
    expect(formRows('folder')).toEqual(['', 'projects', 'projects/ideas', 'quick', 'archive', 'archive/old'])

    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Back'
    )
    if (!back) throw new Error('Back button not rendered')
    await press(back, field('folder'))
    expect(document.activeElement).toBe(field('folder'))
    expect(formRows('folder')).toHaveLength(6)

    await act(async () => {
      back.click()
      await Promise.resolve()
    })
    expect(form()).toBeNull()
    expect(search().value).toBe('Runbook')
    expect(createAndOpen).not.toHaveBeenCalled()
  })

  it('Ctrl+Enter or Cmd+Enter creates from any field', async () => {
    type(search(), 'Runbook')
    await key(search(), 'Enter', { shiftKey: true })
    focus(field('folder'))
    await key(field('folder'), 'Enter', { ctrlKey: true })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Runbook', tags: [] })
  })

  it('a name that cannot be a file opens the form with the reason; Escape goes back with the query kept', async () => {
    type(search(), 'why?')
    expect(createRow()?.textContent).toBe('Create "why?"…Inbox')
    await key(search(), 'Enter', { shiftKey: true })
    expect(status().kind).toBe('error')
    expect(status().text).toMatch(/cannot contain/)
    expect(createButton().disabled).toBe(true)
    await key(field('name'), 'Enter')
    expect(createAndOpen).not.toHaveBeenCalled()

    await key(field('name'), 'Escape')
    expect(form()).toBeNull()
    expect(useStore.getState().searchOpen).toBe(true)
    expect(search().value).toBe('why?')
    expect(document.activeElement).toBe(search())
  })

  it('a path into the Trash is refused in the Folder field', async () => {
    type(search(), 'trash/Brand new')
    await key(search(), 'Enter', { shiftKey: true })
    expect(field('name').value).toBe('Brand new')
    expect(field('folder').value).toBe('trash')
    expect(status()).toEqual({ kind: 'error', text: 'Notes cannot be created in the Trash.' })
    expect(createButton().disabled).toBe(true)
  })

  it('offers nothing for an empty or tag-only query', async () => {
    expect(createRow()).toBeNull()
    await key(search(), 'Enter', { shiftKey: true })
    expect(form()).toBeNull()
    expect(useStore.getState().searchOpen).toBe(true)

    type(search(), '#ops')
    expect(createRow()).toBeNull()
    await key(search(), 'Enter', { shiftKey: true })
    expect(form()).toBeNull()
  })
})
