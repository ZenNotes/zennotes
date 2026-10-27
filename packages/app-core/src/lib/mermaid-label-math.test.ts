// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { typesetLabelMath } from './mermaid-label-math'

/** jsdom lays nothing out, so every box is 0x0 unless a test says otherwise. */
function measureAs(width: number, height: number) {
  const seen: { tag: string; parentFontSize: string; parentIsProbe: boolean }[] = []
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const parent = this.parentElement
    seen.push({
      tag: this.localName,
      parentFontSize: parent?.style.fontSize ?? '',
      parentIsProbe: parent?.getAttribute('aria-hidden') === 'true'
    })
    return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect
  })
  return seen
}

describe('typesetLabelMath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the bare MathML element, sized up to whole pixels from its measured box', () => {
    measureAs(30.2, 18.4)
    const result = typesetLabelMath('x^2', 14)
    expect(result).not.toBeNull()
    if (!result || !('html' in result)) throw new Error('expected MathML markup')
    expect(result.width).toBe(31)
    expect(result.height).toBe(19)
    expect(result.html.startsWith('<math')).toBe(true)
    expect(result.html).not.toContain('katex')
  })

  it('measures the element Pele receives at the font size Pele asks for', () => {
    const seen = measureAs(20, 16)
    typesetLabelMath('\\alpha + \\beta', 17)
    expect(seen).toEqual([{ tag: 'math', parentFontSize: '17px', parentIsProbe: true }])
  })

  it('leaves TeX that KaTeX rejects to Pele, which shows it as written', () => {
    measureAs(20, 16)
    expect(typesetLabelMath('\\frac{a}{', 14)).toBeNull()
  })

  it('gives up on a formula it cannot measure and tries again on the next drawing', () => {
    expect(typesetLabelMath('y_1', 14)).toBeNull()
    measureAs(12, 15)
    expect(typesetLabelMath('y_1', 14)).not.toBeNull()
  })

  it('never turns label math into a link', () => {
    measureAs(40, 16)
    const result = typesetLabelMath('\\href{javascript:alert(1)}{x} + \\url{https://example.invalid}', 14)
    const host = document.createElement('div')
    host.innerHTML = result && 'html' in result ? result.html : ''
    expect(host.querySelector('math')).not.toBeNull()
    // KaTeX's default refuses both commands and paints them as error text; the
    // source survives only as the hidden x-tex annotation, which is inert text.
    expect(host.querySelector('a, [href], [xlink\\:href]')).toBeNull()
  })

  it('leaves no markup behind in the page', () => {
    measureAs(10, 10)
    typesetLabelMath('z', 14)
    expect(document.body.querySelector('math, .katex')).toBeNull()
  })
})
