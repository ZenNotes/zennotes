import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

describe('the app shell', () => {
  it('stays below a status bar the page draws under, and is unmoved where there is none', () => {
    const rule = /\.zn-app-shell \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    expect(rule).toContain('padding-top: env(safe-area-inset-top, 0px)')
  })
})
