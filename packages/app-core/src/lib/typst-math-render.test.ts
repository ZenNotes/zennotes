import { describe, expect, it } from 'vitest'
import { styleSvg } from './typst-math-render'

// Typst hands back an SVG measured in points at the 11pt text size every
// formula is compiled at, with its paint spelled out as black. The wrapper
// sizes it in em at KaTeX's 1.21 factor, so the two engines agree on how big a
// formula is next to prose (a plain 1em made Typst a fifth smaller), and turns
// every black fill and stroke into currentColor so it follows the theme (#746).
describe('styleSvg', () => {
  const svg = (w: number, h: number, body = '<path fill="#000000" d="M0 0"/>'): string =>
    `<svg class="typst-doc" viewBox="0 0 ${w} ${h}" width="${w}pt" height="${h}pt" xmlns="http://www.w3.org/2000/svg">${body}</svg>`

  it('sizes the formula the way KaTeX sizes Computer Modern', () => {
    // 11pt of Typst text is one em of the compiled document, drawn at 1.21em.
    const inline = styleSvg(svg(11, 11), false)
    expect(inline).toContain('width: 1.2100em; height: 1.2100em;')
    expect(inline).toContain('display: inline-block; vertical-align: middle;')
    const block = styleSvg(svg(22, 8), true)
    expect(block).toContain('width: 2.4200em; height: 0.8800em;')
    expect(block).toContain('display: block; margin: 0 auto;')
  })

  it('drops the intrinsic pt size', () => {
    const out = styleSvg(svg(11, 11), false)
    expect(out).not.toMatch(/width="11pt"|height="11pt"/)
  })

  it('recolors black glyph fills and black shape strokes to currentColor', () => {
    const out = styleSvg(
      svg(
        11,
        11,
        '<g fill="#000000"><path d="M0 0"/></g>' +
          '<path class="typst-shape" fill="none" stroke="#000" d="M0 1H9"/>' +
          '<path fill="#000" stroke="rgb(0, 0, 0)" d="M1 1"/>' +
          '<path fill="#ff0000" d="M2 2"/>'
      ),
      true
    )
    expect(out).toContain('<g fill="currentColor">')
    expect(out).toContain('fill="none" stroke="currentColor"')
    expect(out).toContain('fill="currentColor" stroke="currentColor"')
    expect(out).toContain('fill="#ff0000"')
    expect(out).not.toMatch(/(fill|stroke)="(#000000|#000|rgb\(0, 0, 0\))"/)
  })
})
