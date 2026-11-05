import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)
const sidebar = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8')

describe('the app shell', () => {
  it('stays below a status bar the page draws under, and is unmoved where there is none', () => {
    const rule = /\.zn-app-shell \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    expect(rule).toContain('padding-top: env(safe-area-inset-top, 0px)')
  })

  it('ends above a gesture pill or home indicator the page draws over', () => {
    // A Pixel Tablet's pill is 32 px; the footer row ended at 793 of 800.
    const rule = /\.zn-app-shell \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    expect(rule).toContain('padding-bottom: env(safe-area-inset-bottom, 0px)')
  })

  it('clears the pill once: the sidebar footer adds no inset of its own', () => {
    const footerInsets = styles.match(/[^{}]*\{[^}]*safe-area-inset-bottom[^}]*\}/g) ?? []
    expect(footerInsets.map((rule) => rule.split('{')[0].trim())).toEqual(['.zn-app-shell'])
    expect(sidebar).not.toContain('zn-sidebar-footer-safe')
  })
})
