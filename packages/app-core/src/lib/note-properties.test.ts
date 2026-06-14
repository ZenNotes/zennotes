import { describe, it, expect } from 'vitest'
import {
  inferPropKind,
  isChecked,
  splitList,
  stripQuotes,
  formatDateDisplay,
  coerceToKind,
  parseFrontmatterRaw,
  buildPropertiesPanelHTML,
  buildRecordPanelHTML,
  setFrontmatterValue,
  renameFrontmatterKey,
  addFrontmatterProperty,
  removeFrontmatterProperty
} from './note-properties'

describe('frontmatter editing (note body ⇄ properties)', () => {
  const body = ['---', '状态: done', '评分: 4', '---', '', '# Title', '', 'Body.'].join('\n')

  it('sets a value in place, leaving the body untouched', () => {
    const next = setFrontmatterValue(body, '评分', '5')
    expect(next).toContain('评分: 5')
    expect(next).not.toContain('评分: 4')
    expect(next).toContain('# Title')
    expect(next).toContain('Body.')
  })

  it('writes an empty value as a bare `key:`', () => {
    expect(setFrontmatterValue(body, '状态', '')).toContain('\n状态:\n')
  })

  it('renames a key, preserving its value', () => {
    const next = renameFrontmatterKey(body, '状态', '阅读状态')
    expect(next).toContain('阅读状态: done')
    expect(next).not.toMatch(/\n状态:/)
  })

  it('appends a new property inside the block', () => {
    const next = addFrontmatterProperty(body, '标签', '技术')
    expect(next).toContain('标签: 技术')
    expect(next.indexOf('标签')).toBeLessThan(next.lastIndexOf('---'))
  })

  it('creates a frontmatter block when the note has none', () => {
    const next = addFrontmatterProperty('# Just a title\n', '状态', 'done')
    expect(next.startsWith('---\n状态: done\n---\n')).toBe(true)
    expect(next).toContain('# Just a title')
  })

  it('removes a property, and drops the block when it empties', () => {
    expect(removeFrontmatterProperty(body, '状态')).not.toContain('状态')
    const single = ['---', '状态: done', '---', '', '# Title'].join('\n')
    const emptied = removeFrontmatterProperty(single, '状态')
    expect(emptied).not.toContain('---')
    expect(emptied).toContain('# Title')
  })
})

describe('inferPropKind (type encoded in YAML)', () => {
  it('treats a quoted value as text even when it looks numeric', () => {
    expect(inferPropKind('"5"')).toBe('text')
    expect(inferPropKind("'2026-01-15'")).toBe('text')
  })
  it('classifies bare values by shape', () => {
    expect(inferPropKind('5')).toBe('number')
    expect(inferPropKind('true')).toBe('checkbox')
    expect(inferPropKind('2026-01-15')).toBe('date')
    expect(inferPropKind('2026-01-15T10:30')).toBe('datetime')
    expect(inferPropKind('思维, 商业')).toBe('list')
    expect(inferPropKind('[a, b]')).toBe('list')
    expect(inferPropKind('已读')).toBe('text')
  })
})

describe('value helpers', () => {
  it('reads checkbox state', () => {
    expect(isChecked('true')).toBe(true)
    expect(isChecked('false')).toBe(false)
  })
  it('strips one layer of quotes', () => {
    expect(stripQuotes('"5"')).toBe('5')
    expect(stripQuotes('已读')).toBe('已读')
  })
  it('splits list values', () => {
    expect(splitList('思维, 商业')).toEqual(['思维', '商业'])
    expect(splitList('[a, "b", c]')).toEqual(['a', 'b', 'c'])
  })
  it('formats date display with slashes', () => {
    expect(formatDateDisplay('2026-01-15')).toBe('2026/01/15')
  })
})

describe('coerceToKind (change type = rewrite YAML)', () => {
  it('quotes a number when switching to text (lossless)', () => {
    expect(coerceToKind('5', 'text')).toEqual({ yaml: '"5"', lossy: false })
  })
  it('flags incompatible data when text → number', () => {
    expect(coerceToKind('已读', 'number')).toEqual({ yaml: '0', lossy: true })
  })
  it('keeps a valid boolean for checkbox, defaults otherwise', () => {
    expect(coerceToKind('true', 'checkbox')).toEqual({ yaml: 'true', lossy: false })
    expect(coerceToKind('已读', 'checkbox')).toEqual({ yaml: 'false', lossy: true })
  })
  it('wraps a scalar into a list', () => {
    expect(coerceToKind('a', 'list')).toEqual({ yaml: '[a]', lossy: false })
  })
  it('adds a time component for datetime', () => {
    expect(coerceToKind('2026-01-15', 'datetime')).toEqual({
      yaml: '2026-01-15T00:00',
      lossy: false
    })
  })
})

describe('parseFrontmatterRaw', () => {
  it('returns ordered key/raw pairs with quotes kept', () => {
    const text = '---\n状态: 已读\n评分: "5"\n---\n# Body'
    expect(parseFrontmatterRaw(text)).toEqual([
      { key: '状态', raw: '已读' },
      { key: '评分', raw: '"5"' }
    ])
  })
  it('returns [] when there is no frontmatter', () => {
    expect(parseFrontmatterRaw('# Just a body')).toEqual([])
  })
})

describe('buildPropertiesPanelHTML', () => {
  it('returns empty string when there are no properties', () => {
    expect(buildPropertiesPanelHTML([], 'Properties')).toBe('')
  })
  it('renders a row per key with the panel title', () => {
    const html = buildPropertiesPanelHTML(
      [
        { key: '状态', raw: '已读' },
        { key: '推荐', raw: 'true' }
      ],
      '笔记属性'
    )
    expect(html).toContain('笔记属性')
    expect(html).toContain('状态')
    expect(html).toContain('已读')
    expect(html).toContain('np-checkbox is-checked')
    expect(html).toContain('data-kind="checkbox"')
  })
  it('renders a quoted value as plain text (no quotes shown)', () => {
    const html = buildPropertiesPanelHTML([{ key: '评分', raw: '"5"' }], 'P')
    expect(html).toContain('data-kind="text"')
    expect(html).toContain('>5<')
    expect(html).not.toContain('"5"')
  })
  it('escapes HTML in keys and values', () => {
    const html = buildPropertiesPanelHTML([{ key: '<k>', raw: '<script>x</script>' }], 'P')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;k&gt;')
  })
})

describe('buildRecordPanelHTML (linked = database columns)', () => {
  it('renders linked fields by their database type', () => {
    const html = buildRecordPanelHTML(
      '笔记属性',
      [
        { name: '状态', type: 'select', value: 'done', options: [{ id: '1', value: 'done', label: '已读' }] },
        { name: '推荐', type: 'checkbox', value: 'true' },
        {
          name: '标签',
          type: 'multiSelect',
          value: 'a,b',
          options: [
            { id: '1', value: 'a', label: '思维' },
            { id: '2', value: 'b', label: '商业' }
          ]
        }
      ],
      []
    )
    expect(html).toContain('np-row-linked')
    expect(html).toContain('已读') // select option label, not raw value
    expect(html).not.toContain('>done<')
    expect(html).toContain('思维')
    expect(html).toContain('商业')
    expect(html).toContain('np-checkbox is-checked')
  })
  it('dedupes an independent frontmatter key that matches a linked field', () => {
    const html = buildRecordPanelHTML(
      'P',
      [{ name: '状态', type: 'text', value: '已读' }],
      [
        { key: '状态', raw: '其它' },
        { key: '备注', raw: '自由文本' }
      ]
    )
    // The linked 状态 wins; the frontmatter 状态 ("其它") is dropped.
    expect(html).not.toContain('其它')
    expect(html).toContain('备注')
    expect(html).toContain('自由文本')
  })
})
