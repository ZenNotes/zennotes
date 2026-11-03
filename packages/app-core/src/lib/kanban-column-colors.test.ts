import { describe, expect, it } from 'vitest'
import {
  KANBAN_COLUMN_COLORS,
  kanbanColumnColorCss,
  kanbanColumnColorLabel,
  kanbanColumnColorVar,
  parseKanbanColumnColor,
  selectOptionChipStyle,
  selectOptionColor
} from './kanban-column-colors'

describe('kanban column colours (#1037)', () => {
  it('reads the palette names however they are typed', () => {
    expect(parseKanbanColumnColor('blue')).toBe('blue')
    expect(parseKanbanColumnColor(' Blue ')).toBe('blue')
    expect(parseKanbanColumnColor('PURPLE')).toBe('purple')
    // The other spelling, and the theme token's own name for teal.
    expect(parseKanbanColumnColor('grey')).toBe('gray')
    expect(parseKanbanColumnColor('aqua')).toBe('teal')
  })

  it('refuses what the palette does not have, a hex included', () => {
    for (const raw of ['', 'orange', '#ff0000', 'rgb(0 0 0)', 'accent', 3, null, undefined, {}]) {
      expect(parseKanbanColumnColor(raw)).toBeNull()
    }
  })

  it('draws every colour from a theme token, never a fixed hex', () => {
    for (const color of KANBAN_COLUMN_COLORS) {
      expect(color.token).toMatch(/^--z-[a-z0-9-]+$/)
      expect(kanbanColumnColorVar(color.id)).toBe(`var(${color.token})`)
      expect(kanbanColumnColorCss(color.id)).toBe(`rgb(var(${color.token}))`)
    }
    expect(kanbanColumnColorCss('teal')).toBe('rgb(var(--z-aqua))')
    expect(kanbanColumnColorLabel('gray')).toBe('Gray')
  })

  it('keeps to the hue tokens every bundled theme defines', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
    // Each theme block that sets one hue sets them all, so no column colour
    // falls back to another theme's shade.
    const blocks = css.split(/\n(?=:root)/).filter((block) => block.includes('--z-red:'))
    expect(blocks.length).toBeGreaterThan(30)
    for (const block of blocks) {
      for (const color of KANBAN_COLUMN_COLORS) expect(block).toContain(`${color.token}:`)
    }
  })
})

describe('select option colors', () => {
  const field = { options: [{ value: 'Done', color: 'Green' }, { value: 'Old', color: '#ff0000' }, { value: 'Plain' }] }

  it('reads a color the palette has, in any case', () => {
    expect(selectOptionColor(field, 'Done')).toBe('green')
  })

  it('drops one it does not, and an option with none', () => {
    expect(selectOptionColor(field, 'Old')).toBeNull()
    expect(selectOptionColor(field, 'Plain')).toBeNull()
    expect(selectOptionColor(field, 'Missing')).toBeNull()
    expect(selectOptionColor(undefined, 'Done')).toBeNull()
  })

  it('tints a chip from the theme, never a fixed hex', () => {
    const style = selectOptionChipStyle('blue')
    expect(style.backgroundColor).toBe('rgb(var(--z-blue) / 0.15)')
    expect(style.color).toBe('rgb(var(--z-blue))')
    expect(style['--tw-ring-color']).toBe('rgb(var(--z-blue) / 0.3)')
  })
})
