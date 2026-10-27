// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEMES, rankThemes, resolveAuto } from './themes'

const css = readFileSync(
  fileURLToPath(new URL('../styles/index.css', import.meta.url)),
  'utf8'
)

// The canonical --z-* token set every standalone theme block defines (mirrors
// the Catppuccin Mocha block). Layered families (e.g. Gruvbox) inherit most of
// these from a shared block, so this full check is only asserted where a theme
// ships a self-contained block — like Rosé Pine.
const REQUIRED_TOKENS = [
  '--z-bg', '--z-bg-softer', '--z-bg-1', '--z-bg-2', '--z-bg-3', '--z-bg-4',
  '--z-fg', '--z-fg-1', '--z-fg-2', '--z-grey-2', '--z-grey-1', '--z-grey-0',
  '--z-grey-dim', '--z-accent', '--z-accent-soft', '--z-accent-muted',
  '--z-red', '--z-green', '--z-yellow', '--z-blue', '--z-purple', '--z-aqua',
  '--z-shadow'
]

function standaloneBlock(id: string): string | null {
  const start = css.indexOf(`:root[data-theme="${id}"] {`)
  if (start === -1) return null
  const end = css.indexOf('\n}', start)
  return end === -1 ? null : css.slice(start, end)
}

describe('built-in theme registry ↔ CSS', () => {
  const builtins = THEMES.filter((t) => t.family !== 'custom')

  it('every built-in theme id is styled in index.css', () => {
    for (const t of builtins) {
      expect(css, `no CSS for data-theme="${t.id}"`).toContain(`data-theme="${t.id}"`)
    }
  })

  it('the Rosé Pine variants each define the full --z-* token set (#294-adjacent)', () => {
    for (const id of ['rose-pine-main', 'rose-pine-moon', 'rose-pine-dawn']) {
      const block = standaloneBlock(id)
      expect(block, `missing standalone block for ${id}`).not.toBeNull()
      expect(block).toContain('color-scheme:')
      for (const token of REQUIRED_TOKENS) {
        expect(block, `${id} is missing ${token}`).toContain(`${token}:`)
      }
    }
  })

  it('Rosé Pine variants are registered with the right modes', () => {
    expect(THEMES.find((t) => t.id === 'rose-pine-main')?.mode).toBe('dark')
    expect(THEMES.find((t) => t.id === 'rose-pine-moon')?.mode).toBe('dark')
    expect(THEMES.find((t) => t.id === 'rose-pine-dawn')?.mode).toBe('light')
  })

  it('resolveAuto maps the rose-pine family to its dark/light defaults', () => {
    expect(resolveAuto('rose-pine', true)).toBe('rose-pine-main')
    expect(resolveAuto('rose-pine', false)).toBe('rose-pine-dawn')
  })

  // The Settings family picker resolves a clicked family via resolveAuto. A
  // family with no explicit case falls through to GitHub's default (a real id
  // but the WRONG family), so clicking it would silently apply the wrong theme.
  // Assert resolveAuto returns a variant OF THE REQUESTED family for each one.
  it('resolveAuto returns a variant of the requested family (both modes)', () => {
    const families = [...new Set(builtins.map((t) => t.family))]
    for (const family of families) {
      for (const dark of [true, false]) {
        const id = resolveAuto(family, dark)
        const resolved = THEMES.find((t) => t.id === id)
        expect(
          resolved?.family,
          `resolveAuto('${family}', ${dark}) → "${id}" (family ${resolved?.family})`
        ).toBe(family)
      }
    }
  })
})

describe('rankThemes', () => {
  it('finds a family named together with its mode or flavor', () => {
    expect(rankThemes('apple light')[0]?.id).toBe('apple-light')
    expect(rankThemes('apple dark')[0]?.id).toBe('apple-dark')
    expect(rankThemes('gruvbox dark hard')[0]?.id).toBe('dark-hard')
    expect(rankThemes('tokyo night')[0]?.family).toBe('tokyo-night')
  })

  it('still ranks a whole label first, and lists every theme for an empty query', () => {
    expect(rankThemes('light')[0]?.id).toBe('apple-light')
    expect(rankThemes('')).toHaveLength(THEMES.length)
  })
})
