import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

// The body of the block that applies wherever nothing can hover (a phone, a
// tablet, a touch-only laptop), with its nested rules keyed by selector.
function noHoverRules(): Map<string, string> {
  const opener = '@media not all and (hover: hover) and (pointer: fine) {'
  const start = stylesSource.indexOf(opener)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 1
  let end = start + opener.length
  while (depth > 0 && end < stylesSource.length) {
    if (stylesSource[end] === '{') depth += 1
    if (stylesSource[end] === '}') depth -= 1
    end += 1
  }
  const block = stylesSource.slice(start + opener.length, end - 1)
  return new Map([...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => [match[1].trim(), match[2]]))
}

describe('controls that appear on hover, where nothing can hover', () => {
  it('shows the ones people need', () => {
    expect(noHoverRules().get('.zn-hover-reveal')).toMatch(/opacity:\s*1\s*!important/)
  })

  it('takes away a hover shortcut for something already on screen', () => {
    // The Table row's Open sat over the end of a long name on every phone row,
    // while the row's page glyph already opens the page.
    expect(noHoverRules().get('.zn-hover-only')).toMatch(/display:\s*none\s*!important/)
  })
})
