import { describe, expect, it } from 'vitest'
import {
  fenceLanguageEdit,
  fenceLanguageToken,
  isPlainTextFenceTag,
  type FenceLanguageEdit
} from './code-fence-language'

/** Offset just past the fence characters, the way the editor's CodeMark
 *  node reports it, for lines that are a fence after optional indentation
 *  or quote markers. */
function markEnd(line: string): number {
  const match = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/.exec(line)
  if (!match) throw new Error(`not a fence: ${line}`)
  return match[0].length
}

function apply(line: string, edit: FenceLanguageEdit | null): string {
  if (!edit) return line
  return line.slice(0, edit.from) + edit.insert + line.slice(edit.to)
}

function setLanguage(line: string, tag: string | null): string {
  return apply(line, fenceLanguageEdit(line, markEnd(line), tag))
}

describe('fenceLanguageToken', () => {
  it('reads the first word of the info string', () => {
    expect(fenceLanguageToken('```ts', 3)).toBe('ts')
    expect(fenceLanguageToken('``` python title="a.py"', 3)).toBe('python')
    expect(fenceLanguageToken('~~~~ rust', 4)).toBe('rust')
    expect(fenceLanguageToken('```python{1,3}', 3)).toBe('python')
  })

  it('finds none on a bare fence or before an attribute block', () => {
    expect(fenceLanguageToken('```', 3)).toBeNull()
    expect(fenceLanguageToken('```   ', 3)).toBeNull()
    expect(fenceLanguageToken('```{.wide}', 3)).toBeNull()
  })
})

describe('fenceLanguageEdit', () => {
  it('adds a language to a bare backtick or tilde fence', () => {
    expect(setLanguage('```', 'typescript')).toBe('```typescript')
    expect(setLanguage('~~~', 'python')).toBe('~~~python')
  })

  it('keeps a long fence at its length', () => {
    expect(setLanguage('`````', 'go')).toBe('`````go')
    expect(setLanguage('~~~~~~ js', 'rust')).toBe('~~~~~~ rust')
  })

  it('replaces only the language, keeping attributes and a title after it', () => {
    expect(setLanguage('```py title="a.py"', 'python')).toBe('```python title="a.py"')
    expect(setLanguage('```js {1,3}', 'typescript')).toBe('```typescript {1,3}')
    expect(setLanguage('~~~ ruby linenos', 'python')).toBe('~~~ python linenos')
  })

  it('keeps the space between the fence and the language', () => {
    expect(setLanguage('```  js', 'ts')).toBe('```  ts')
  })

  it('writes before an attribute block, with a space', () => {
    expect(setLanguage('```{.wide}', 'python')).toBe('```python {.wide}')
    expect(setLanguage('``` {.wide}', 'python')).toBe('```python {.wide}')
  })

  it('leaves a CR at the end of a CRLF line alone', () => {
    expect(setLanguage('```\r', 'python')).toBe('```python\r')
    expect(setLanguage('```js\r', 'ts')).toBe('```ts\r')
    expect(setLanguage('```js\r', null)).toBe('```\r')
  })

  it('works inside a quote or a list item', () => {
    expect(setLanguage('> ```', 'sql')).toBe('> ```sql')
    expect(setLanguage('>   ```js', 'ts')).toBe('>   ```ts')
    expect(setLanguage('    ```', 'bash')).toBe('    ```bash')
  })

  it('is nothing to do when the language is already the pick', () => {
    expect(fenceLanguageEdit('```python', 3, 'python')).toBeNull()
    expect(fenceLanguageEdit('```', 3, null)).toBeNull()
  })

  it('takes the language away, with the gap before it', () => {
    expect(setLanguage('```python', null)).toBe('```')
    expect(setLanguage('``` python  ', null)).toBe('```  ')
    expect(setLanguage('~~~~ go', null)).toBe('~~~~')
  })

  it('writes text instead when attributes follow, so none is promoted', () => {
    expect(setLanguage('```python title="a.py"', null)).toBe('```text title="a.py"')
    expect(fenceLanguageEdit('```text title="a.py"', 3, null)).toBeNull()
  })

  it('reports offsets in the line, for the caller to place in the document', () => {
    expect(fenceLanguageEdit('> ```js', 5, 'ts')).toEqual({ from: 5, to: 7, insert: 'ts' })
  })
})

describe('isPlainTextFenceTag', () => {
  it('knows the spellings of plain text', () => {
    for (const tag of ['text', 'TXT', 'plaintext', 'plain', 'nohighlight']) {
      expect(isPlainTextFenceTag(tag)).toBe(true)
    }
    expect(isPlainTextFenceTag('tex')).toBe(false)
    expect(isPlainTextFenceTag('python')).toBe(false)
  })
})
