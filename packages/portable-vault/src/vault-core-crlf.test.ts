import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { extractTags, extractWikilinks, stripCodeContent } from './vault-core'

// A note saved with Windows line endings (CRLF) splits at "\n" into lines
// that still end in "\r", and JavaScript's `.` never matches "\r", so the
// fence pattern's `(.*)$` never matched: a CRLF fence never opened, and the
// code inside it leaked into the note's tags and links. The desktop fixed
// its copies of stripCodeContent in ZenNotes/zennotes 7afe7a3b (2.77.0);
// this is the phones' copy of the same logic.

describe('vault-core reads code fences in notes saved with CRLF line endings', () => {
  it('ignores #tags inside a fence', () => {
    assert.deepEqual(extractTags('```c\r\n#include <x>\r\n```\r\nreal #ok\r\n'), ['ok'])
    assert.deepEqual(extractTags('- item\r\n  ~~~\r\n  #nope\r\n  ~~~\r\n  #after\r\n'), ['after'])
  })

  it('ignores [[links]] inside a fence', () => {
    assert.deepEqual(extractWikilinks('```\r\n[[Not a link]]\r\n```\r\nSee [[Real note]]\r\n'), ['Real note'])
  })

  it('keeps every line, and reads an LF note exactly as before', () => {
    const crlf = '# Note\r\n```\r\n#code\r\n```\r\ntext\r\n'
    assert.equal(stripCodeContent(crlf).split('\n').length, crlf.split('\n').length)
    const lf = '# Note\n```js\nconst tag = "#x"\n```\nplain #kept\n'
    assert.equal(stripCodeContent(lf), '# Note\n \n \n \nplain #kept\n')
  })
})
