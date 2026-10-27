// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { peekMermaidSvg, renderMermaidSvg } from './mermaid-render'

// jsdom has no canvas, so Pele measures labels with its built-in width table,
// which keeps these layouts deterministic. The stub answers getContext the way
// jsdom does (null) without its "not implemented" warning on every render.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

async function drawn(source: string): Promise<string> {
  const result = await renderMermaidSvg(source)
  if (!result.ok) throw new Error(`expected a drawing, got: ${result.error}`)
  return result.svg
}

function parse(svg: string): SVGSVGElement {
  const host = document.createElement('div')
  host.innerHTML = svg
  const root = host.querySelector('svg')
  if (!root) throw new Error('no <svg> in the result')
  return root
}

describe('renderMermaidSvg', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--z-text-font')
  })

  it('draws a flowchart as an SVG whose labels are SVG text, not HTML in a foreignObject', async () => {
    // The #911 repro: long labels that mermaid clipped at 200px when its HTML
    // labels were measured at a fractional device scale.
    const root = parse(
      await drawn(
        'flowchart TB\n' +
          '  admin["aurora: forwarding disabled PLUS SOME MORE EXTRA TEXT"]\n' +
          '  rbnic["USB NIC enp0s20f0u9 at 10.255.255.2/30"]\n' +
          '  admin --- rbnic'
      )
    )
    expect(root.classList.contains('pele')).toBe(true)
    expect(root.querySelector('foreignObject')).toBeNull()
    // The long label wraps onto lines of its own box instead of being cut off.
    const lines = [...root.querySelectorAll('[data-id="admin"] .pele-label tspan')].map(
      (line) => line.textContent
    )
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe('aurora: forwarding disabled PLUS SOME MORE EXTRA TEXT')
  })

  it('measures and paints labels in the note text font', async () => {
    document.documentElement.style.setProperty('--z-text-font', '"Test Serif", serif')
    const root = parse(await drawn('flowchart LR\n  A[font probe] --> B'))
    expect(root.getAttribute('style')).toContain('font-family:var(--pele-font,"Test Serif", serif)')
  })

  it('paints through the theme variables rather than baking in a palette', async () => {
    const svg = await drawn('flowchart LR\n  A[palette probe] --> B')
    expect(svg).toContain('var(--pele-surface')
    expect(svg).toContain('var(--pele-line')
  })

  it('returns a syntax error as a result instead of throwing', async () => {
    const result = await renderMermaidSvg('flowchart TD\n  A --> B\n  B --> ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^Parse error on line \d+:/)
  })

  it('returns an unknown diagram type as an error result', async () => {
    const result = await renderMermaidSvg('zenuml\n  Alice->Bob: hi')
    expect(result.ok).toBe(false)
  })

  it('keeps markup in diagram text inert and draws no images or links', async () => {
    const root = parse(
      await drawn(
        'flowchart LR\n' +
          '  A["<img src=https://example.invalid/p.png onerror=alert(1)>"] --> B["<a href=https://example.invalid>x</a>"]\n' +
          '  click B "https://example.invalid/out"'
      )
    )
    expect(root.querySelector('img, image, a, script, foreignObject')).toBeNull()
    expect(root.outerHTML).not.toMatch(/onerror|https:\/\/example\.invalid/)
  })

  it('hands back an earlier drawing from the cache, and once loaded draws new diagrams synchronously', async () => {
    const source = 'flowchart LR\n  cached --> probe'
    const first = await renderMermaidSvg(source)
    expect(peekMermaidSvg(source)).toBe(first)

    // The renderer and the flowchart type are loaded now, so a diagram it has
    // never seen is drawn on the spot instead of reporting "not yet".
    const fresh = peekMermaidSvg('flowchart LR\n  never --> seen')
    expect(fresh?.ok).toBe(true)
  })

  it('typesets $$ label math as MathML in a box Pele sizes from the measurement', async () => {
    const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 48, height: 22, x: 0, y: 0, top: 0, left: 0, right: 48, bottom: 22, toJSON: () => ({})
    } as DOMRect)
    try {
      const root = parse(await drawn('flowchart LR\n  A["$$\\frac{a}{b}$$"] --> B'))
      const math = root.querySelector('foreignObject.pele-math')
      expect(math?.getAttribute('width')).toBe('48')
      expect(math?.getAttribute('height')).toBe('22')
      expect(math?.querySelector('math')).not.toBeNull()
    } finally {
      measure.mockRestore()
    }
  })

  it('shows label math as written when it cannot be typeset', async () => {
    const root = parse(await drawn('flowchart LR\n  A["$$\\frac{c}{$$"] --> B'))
    expect(root.querySelector('foreignObject')).toBeNull()
    expect(root.textContent).toContain('$$\\frac{c}{$$')
  })

  it('shares one drawing between Preview (trailing newline kept) and the editor (body trimmed)', async () => {
    const fromPreview = await renderMermaidSvg('flowchart LR\n  split --> view\n')
    expect(peekMermaidSvg('flowchart LR\n  split --> view')).toBe(fromPreview)
  })
})
