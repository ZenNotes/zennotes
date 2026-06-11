// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { TASKS_TAB_PATH } from '@shared/tasks'
import { databaseTabPath } from '@shared/databases'
import { hintTargetOpensNote } from './vim-nav'

function el(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html.trim()
  return container.firstElementChild as HTMLElement
}

describe('hintTargetOpensNote (#100 — hint into a note lands in the editor)', () => {
  it('is true for a sidebar note row', () => {
    expect(hintTargetOpensNote(el('<button data-sidebar-path="inbox/Note.md">Note</button>'))).toBe(
      true
    )
  })

  it('is true for a note tab (path carried on an ancestor)', () => {
    const tab = el('<div data-tab-path="inbox/Note.md"><button>close</button></div>')
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(true)
  })

  it('is false for the Tasks tab (a virtual tab focuses itself)', () => {
    const tab = el(`<div data-tab-path="${TASKS_TAB_PATH}"><button>x</button></div>`)
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(false)
  })

  it('is false for a database tab', () => {
    const tab = el(`<div data-tab-path="${databaseTabPath('Projects.csv')}"><button>x</button></div>`)
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(false)
  })

  it('is false for a folder row (no data-sidebar-path)', () => {
    expect(
      hintTargetOpensNote(
        el('<button data-sidebar-type="folder" data-sidebar-key="Projects">Projects</button>')
      )
    ).toBe(false)
  })

  it('is false for a plain button and for null', () => {
    expect(hintTargetOpensNote(el('<button>Settings</button>'))).toBe(false)
    expect(hintTargetOpensNote(null)).toBe(false)
  })
})
