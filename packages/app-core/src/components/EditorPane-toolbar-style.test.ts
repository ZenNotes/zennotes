import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./EditorPane.tsx', import.meta.url), 'utf8')

describe('the pane toolbar buttons', () => {
  it('drop their highlight at once when a panel closes', () => {
    // With a color transition, closing Connections with ⌘2 took the panel away at
    // once and left its button lit for another 150 ms.
    const start = source.indexOf('function IconBtn(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain("'bg-paper-200 text-ink-900'")
    expect(body).not.toContain('transition-colors')
  })
})
