import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sidebarRestoreSlot } from './sidebar-restore'

const editorPaneSource = readFileSync(
  new URL('../components/EditorPane.tsx', import.meta.url),
  'utf8'
)

const pane = {
  sidebarOpen: false,
  zenMode: false,
  hasTabs: false,
  hasNote: false,
  hasVirtualTab: false
}

describe('sidebarRestoreSlot', () => {
  it('asks for nothing while the sidebar is open', () => {
    expect(sidebarRestoreSlot({ ...pane, sidebarOpen: true, hasTabs: true })).toBeNull()
  })

  it('uses the tab strip whenever there is one', () => {
    expect(sidebarRestoreSlot({ ...pane, hasTabs: true, hasNote: true })).toBe('tab-strip')
  })

  it('keeps a way back on a note with note tabs off', () => {
    expect(sidebarRestoreSlot({ ...pane, hasNote: true })).toBe('note-header')
  })

  it('keeps a way back on Tasks and other views with note tabs off', () => {
    expect(sidebarRestoreSlot({ ...pane, hasVirtualTab: true })).toBe('pane-strip')
  })

  it('leaves an empty pane to Home, which has its own button', () => {
    expect(sidebarRestoreSlot(pane)).toBe('home')
  })

  it('stays out of Zen mode', () => {
    expect(sidebarRestoreSlot({ ...pane, zenMode: true, hasNote: true })).toBeNull()
  })
})

describe('EditorPane', () => {
  it('draws a control for both slots the tab strip does not cover', () => {
    expect(editorPaneSource).toMatch(/sidebarSlot === 'pane-strip' && \(/)
    expect(editorPaneSource).toMatch(/sidebarSlot === 'note-header' && \(/)
    expect(editorPaneSource.match(/'Show sidebar',\r?\n\s+getKeymapDisplay/g)).toHaveLength(3)
  })

  it('marks them so a phone layout, which has no sidebar, can leave them out', () => {
    expect(editorPaneSource.match(/data-sidebar-restore/g)).toHaveLength(2)
  })
})
