import { describe, expect, it } from 'vitest'
import { markdownListHangingIndentCh } from './cm-markdown-list-indent'

describe('markdownListHangingIndentCh', () => {
  it('aligns wrapped unordered and ordered list text after the marker', () => {
    expect(markdownListHangingIndentCh('- item')).toBe(2)
    expect(markdownListHangingIndentCh('  - nested item')).toBe(4)
    expect(markdownListHangingIndentCh('10. ordered item')).toBe(4)
  })

  it('includes task markers in the hanging indent', () => {
    expect(markdownListHangingIndentCh('- [ ] task item')).toBe(6)
    expect(markdownListHangingIndentCh('  - [x] nested task')).toBe(8)
  })

  it('can align list items after a parsed markdown prefix', () => {
    expect(markdownListHangingIndentCh('> - quoted item', 2)).toBe(4)
  })

  it('does not treat paragraphs or horizontal rules as list items', () => {
    expect(markdownListHangingIndentCh('plain paragraph')).toBeNull()
    expect(markdownListHangingIndentCh('---')).toBeNull()
  })
})
