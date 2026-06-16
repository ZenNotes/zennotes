import { describe, expect, it } from 'vitest'
import {
  composeTemplateFile,
  mergeTemplates,
  parseCustomTemplate,
  parseFrontmatter,
  slugifyTemplateName
} from '@shared/template-files'
import type { NoteTemplate } from '@bridge-contract/templates'

describe('parseFrontmatter', () => {
  it('splits flat scalar frontmatter from the body', () => {
    const { data, body } = parseFrontmatter('---\nname: ADR\ncategory: Engineering\n---\n# Body\n')
    expect(data).toEqual({ name: 'ADR', category: 'Engineering' })
    expect(body).toBe('# Body\n')
  })

  it('strips surrounding quotes from values', () => {
    const { data } = parseFrontmatter('---\ntitleTemplate: "{{date:YYYY-MM-DD}} — "\n---\nx')
    expect(data.titleTemplate).toBe('{{date:YYYY-MM-DD}} — ')
  })

  it('treats input without frontmatter as all body', () => {
    const { data, body } = parseFrontmatter('# Just a body\n')
    expect(data).toEqual({})
    expect(body).toBe('# Just a body\n')
  })

  it('treats a malformed (unterminated) fence as all body', () => {
    const raw = '---\nname: Broken\n# no closing fence\n'
    expect(parseFrontmatter(raw).body).toBe(raw)
  })
})

describe('parseCustomTemplate', () => {
  it('parses metadata and assigns identity from the filename', () => {
    const raw = '---\nname: My ADR\ndescription: A record\ncategory: Engineering\n---\n# {{title}}\n'
    const t = parseCustomTemplate(raw, '.zennotes/templates/my-adr.md')
    expect(t).toMatchObject({
      id: 'custom:my-adr',
      name: 'My ADR',
      description: 'A record',
      category: 'Engineering',
      builtin: false,
      sourcePath: '.zennotes/templates/my-adr.md'
    })
    expect(t.body).toBe('# {{title}}\n')
  })

  it('falls back to the filename stem when name is absent', () => {
    const t = parseCustomTemplate('# body', '.zennotes/templates/project-review.md')
    expect(t.name).toBe('project-review')
  })

  it('normalizes an unknown category to Custom and rejects trash as target', () => {
    const raw = '---\nname: X\ncategory: Nonsense\ntargetFolder: trash\n---\nbody'
    const t = parseCustomTemplate(raw, '.zennotes/templates/x.md')
    expect(t.category).toBe('Custom')
    expect(t.targetFolder).toBeUndefined()
  })
})

describe('composeTemplateFile + round trip', () => {
  it('serializes fields and parses back to the same metadata', () => {
    const raw = composeTemplateFile({
      name: 'Standup',
      description: 'Team standup',
      category: 'Engineering',
      body: '# {{title}}\n\n{{cursor}}\n'
    })
    const t = parseCustomTemplate(raw, '.zennotes/templates/standup.md')
    expect(t.name).toBe('Standup')
    expect(t.description).toBe('Team standup')
    expect(t.category).toBe('Engineering')
    expect(t.body.trimEnd()).toBe('# {{title}}\n\n{{cursor}}')
  })
})

describe('slugifyTemplateName', () => {
  it('lowercases and dashes', () => {
    expect(slugifyTemplateName('My Cool ADR!')).toBe('my-cool-adr')
  })
  it('falls back to "template" for empty input', () => {
    expect(slugifyTemplateName('  ')).toBe('template')
  })
})

describe('mergeTemplates', () => {
  const builtin = (id: string, name: string, category: NoteTemplate['category']): NoteTemplate => ({
    id,
    name,
    description: '',
    category,
    body: '',
    builtin: true
  })
  const custom = (name: string, category: NoteTemplate['category']): NoteTemplate => ({
    id: `custom:${name}`,
    name,
    description: '',
    category,
    body: '',
    builtin: false,
    sourcePath: `.zennotes/templates/${name}.md`
  })

  it('groups by category, built-ins first, then alphabetical', () => {
    const merged = mergeTemplates(
      [builtin('builtin.rfc', 'RFC', 'Engineering'), builtin('builtin.adr', 'ADR', 'Engineering')],
      [custom('Zeta', 'Custom'), custom('Recipe', 'Personal')]
    )
    expect(merged.map((t) => t.name)).toEqual(['ADR', 'RFC', 'Recipe', 'Zeta'])
  })

  it('lets a custom template with builtinId shadow the matching built-in', () => {
    const override: NoteTemplate = {
      ...custom('ADR', 'Engineering'),
      builtinId: 'builtin.adr'
    }
    const merged = mergeTemplates(
      [builtin('builtin.adr', 'ADR', 'Engineering'), builtin('builtin.rfc', 'RFC', 'Engineering')],
      [override]
    )
    // Only one ADR (the override, builtin:false), plus the untouched RFC built-in.
    expect(merged.map((t) => t.name)).toEqual(['ADR', 'RFC'])
    const adr = merged.find((t) => t.name === 'ADR')
    expect(adr?.builtin).toBe(false)
    expect(adr?.builtinId).toBe('builtin.adr')
  })
})

describe('composeTemplateFile builtinId round trip', () => {
  it('preserves builtinId through compose + parse', () => {
    const raw = composeTemplateFile({
      name: 'ADR',
      category: 'Engineering',
      builtinId: 'builtin.adr',
      body: '# {{title}}\n'
    })
    expect(parseCustomTemplate(raw, '.zennotes/templates/adr.md').builtinId).toBe('builtin.adr')
  })
})
