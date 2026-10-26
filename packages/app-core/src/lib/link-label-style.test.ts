import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

// Every top-level rule that sets `color`, in source order.
const colorRules = [...stylesSource.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((match, order) => ({
    order,
    selectors: match[1].split(',').map((selector) => selector.trim()),
    body: match[2]
  }))
  .filter((rule) => /(^|[\s;])color\s*:/.test(rule.body))

function rulesFor(selector: string) {
  const found = colorRules.filter((rule) => rule.selectors.includes(selector))
  expect(found, `no color rule for ${selector}`).not.toEqual([])
  return found
}

const LABEL = '.cm-editor :where(.tok-link) .tok-link-syntax'

describe('link label color in the editor', () => {
  it('gives the label inside a resolved link the accent', () => {
    const [label] = rulesFor(LABEL)
    expect(label.body).toMatch(/color:\s*rgb\(var\(--z-accent\)\)/)
  })

  it('beats the block tokens on the same span and yields to the link syntax tokens', () => {
    // Inside a list item the label span is `tok-list tok-link-syntax`; its
    // brackets add `tok-meta-code`. All three rules share one specificity, so
    // source order decides: a link in a list once rendered as plain list text.
    const label = rulesFor(LABEL)[0].order
    for (const block of [
      '.cm-editor .tok-list',
      '.cm-editor .tok-quote',
      '.cm-editor .tok-heading2',
      '.cm-editor .tok-heading6',
      '.cm-editor .tok-emphasis',
      '.cm-editor .tok-strong'
    ]) {
      for (const rule of rulesFor(block)) expect(rule.order, block).toBeLessThan(label)
    }
    for (const syntax of ['.cm-editor .tok-meta-code', '.cm-editor .tok-string', '.cm-editor .tok-label']) {
      for (const rule of rulesFor(syntax)) expect(rule.order, syntax).toBeGreaterThan(label)
    }
  })
})
