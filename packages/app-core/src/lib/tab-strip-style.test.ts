import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isTabStripOverflowing } from './tab-strip-overflow'

const editorPaneSource = readFileSync(
  new URL('../components/EditorPane.tsx', import.meta.url),
  'utf8'
)
const settingsSource = readFileSync(
  new URL('../components/SettingsModal.tsx', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(new URL('../store.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

describe('workspace tab strip overflow styles', () => {
  it('keeps horizontal tab overflow visible without lifting tabs', () => {
    expect(editorPaneSource).toContain('workspace-tab-strip')
    expect(editorPaneSource).toContain(
      "tabStripOverflowing ? 'h-14 overflow-x-auto' : 'h-10 overflow-x-hidden'"
    )
    expect(editorPaneSource).toContain('items-start')
    expect(stylesSource).toMatch(
      /\.workspace-tab-strip::-webkit-scrollbar\s*\{[^}]*height:\s*6px/s
    )
    expect(stylesSource).not.toMatch(
      /\.workspace-tab-strip::-webkit-scrollbar\s*\{[^}]*display:\s*none/s
    )
  })

  it('persists a setting for wrapping tabs onto additional rows', () => {
    expect(storeSource).toContain('wrapTabs: boolean')
    expect(storeSource).toContain('setWrapTabs')
    expect(settingsSource).toContain('Wrap note tabs')
    expect(editorPaneSource).toContain('wrapTabs')
    expect(editorPaneSource).toContain('flex-wrap')
  })

  it('detects horizontal overflow with a small rounding tolerance', () => {
    expect(isTabStripOverflowing({ scrollWidth: 100, clientWidth: 100 })).toBe(false)
    expect(isTabStripOverflowing({ scrollWidth: 100.5, clientWidth: 100 })).toBe(false)
    expect(isTabStripOverflowing({ scrollWidth: 102, clientWidth: 100 })).toBe(true)
  })
})
