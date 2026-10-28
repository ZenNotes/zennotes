import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sidebarSelectedRowClass } from './Sidebar'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const match = stylesSource.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`, 's'))
  expect(match, `missing rule for .${selector}`).not.toBeNull()
  return match?.[0] ?? ''
}

// A sidebar row that is in the multi-selection and under the cursor at once
// used to draw only the selection, so the cursor vanished on it.
describe('the sidebar cursor on a selected row', () => {
  it('keeps the selection tint and adds the cursor ring when the cursor is on the row', () => {
    const classes = sidebarSelectedRowClass(true).split(/\s+/)
    expect(classes).toContain('vim-cursor-on-selected')
    expect(classes).toContain('bg-accent/[0.09]')
  })

  it('draws the selection alone when the cursor is elsewhere', () => {
    const classes = sidebarSelectedRowClass(false)
    expect(classes).not.toMatch(/vim-cursor/)
    expect(classes.split(/\s+/)).toContain('bg-accent/[0.09]')
  })

  it('draws the ring as an inset accent outline that stacks with the tint', () => {
    const ring = rule('vim-cursor-on-selected')
    expect(ring).toMatch(/box-shadow:\s*inset 0 0 0 2px rgb\(var\(--z-accent\)/)
    // A background of its own would replace the selection's tint again.
    expect(ring).not.toMatch(/background/)
  })
})
