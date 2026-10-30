import { describe, expect, it } from 'vitest'
import {
  composeTemplateFile,
  findTemplate,
  mergeTemplates,
  parseCustomTemplate,
  parseFolderTemplate,
  parseFrontmatter,
  slugifyTemplateName,
  templateSettingId,
  templateSource,
  templateSourceLabel
} from '@shared/template-files'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
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
    const t = parseCustomTemplate('# body', '.zennotes/templates/weekly-review.md')
    expect(t.name).toBe('weekly-review')
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
      description: 'Daily standup',
      category: 'Engineering',
      body: '# {{title}}\n\n{{cursor}}\n'
    })
    const t = parseCustomTemplate(raw, '.zennotes/templates/standup.md')
    expect(t.name).toBe('Standup')
    expect(t.description).toBe('Daily standup')
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

describe('findTemplate', () => {
  // The Daily Note built-in, edited in Settings: Focus renamed to Today.
  const edited = parseCustomTemplate(
    composeTemplateFile({
      name: 'Daily Note',
      category: 'Personal',
      titleTemplate: '{{date:YYYY-MM-DD}}',
      builtinId: 'builtin.daily',
      body: '# {{date:dddd, MMMM D, YYYY}}\n\n## Today\n\n- {{cursor}}\n'
    }),
    '.zennotes/templates/daily-note.md'
  )
  const merged = mergeTemplates(BUILTIN_TEMPLATES, [edited])

  it("reaches the edited copy through the built-in's id, which merging drops", () => {
    expect(merged.some((t) => t.id === 'builtin.daily')).toBe(false)
    const found = findTemplate(merged, 'builtin.daily')
    expect(found?.id).toBe(edited.id)
    expect(found?.body).toContain('## Today')
  })

  it('still finds templates by their own id, and a built-in nobody edited', () => {
    expect(findTemplate(merged, edited.id)).toBe(edited)
    expect(findTemplate(merged, 'builtin.weekly')?.builtin).toBe(true)
  })

  it('prefers a template that has the id itself over an edited copy pointing at it', () => {
    const both: NoteTemplate[] = [
      { ...edited, id: 'custom:other', builtinId: 'builtin.adr' },
      BUILTIN_TEMPLATES.find((t) => t.id === 'builtin.adr')!
    ]
    expect(findTemplate(both, 'builtin.adr')?.builtin).toBe(true)
  })

  it('finds nothing for no id or a template that is gone', () => {
    expect(findTemplate(merged, undefined)).toBeUndefined()
    expect(findTemplate(merged, 'custom:deleted')).toBeUndefined()
  })

  it("stores the built-in's id for an edited copy, so a reset falls back to the built-in", () => {
    expect(templateSettingId(edited)).toBe('builtin.daily')
    expect(templateSettingId(BUILTIN_TEMPLATES[0])).toBe(BUILTIN_TEMPLATES[0].id)
    const afterReset = mergeTemplates(BUILTIN_TEMPLATES, [])
    expect(findTemplate(afterReset, templateSettingId(edited))?.id).toBe('builtin.daily')
  })
})

// #1024: a note in the vault's template folder is a template. A plain note is
// the Obsidian shape (the whole file is the template, named after the file);
// a file headed the `.zennotes/templates` way is read the way that folder
// reads it, so moving a template between the two keeps it working.
describe('parseFolderTemplate (#1024)', () => {
  it('reads a plain note as a template named after its file', () => {
    const raw = '# {{title}}\n\n## Agenda\n\n- [ ] {{cursor}}\n'
    const t = parseFolderTemplate(raw, 'Templates/Meeting.md', 'Templates')
    expect(t).toMatchObject({
      id: 'folder:Meeting',
      name: 'Meeting',
      description: '',
      category: 'Custom',
      body: raw,
      builtin: false,
      source: 'folder',
      sourcePath: 'Templates/Meeting.md'
    })
    expect(t.builtinId).toBeUndefined()
    expect(t.titleTemplate).toBeUndefined()
  })

  it("keeps a note's own frontmatter in the body, for the new note to carry", () => {
    const raw = '---\ntags: meeting\ncreated: {{date}}\n---\n# {{title}}\n'
    const t = parseFolderTemplate(raw, 'Templates/Meeting.md', 'Templates')
    expect(t.body).toBe(raw)
    expect(t.name).toBe('Meeting')
    expect(t.category).toBe('Custom')
  })

  it('reads a .zennotes/templates header as template settings, not note content', () => {
    const raw =
      '---\nname: Standup\ndescription: Daily sync\ncategory: Engineering\ntitleTemplate: "{{date:YYYY-MM-DD}} Standup"\ntargetSubpath: Meetings\n---\n## Yesterday\n'
    const t = parseFolderTemplate(raw, 'Templates/Work/standup.md', 'Templates')
    expect(t).toMatchObject({
      id: 'folder:Work/standup',
      name: 'Standup',
      description: 'Daily sync',
      category: 'Engineering',
      titleTemplate: '{{date:YYYY-MM-DD}} Standup',
      targetSubpath: 'Meetings',
      body: '## Yesterday\n',
      source: 'folder'
    })
  })

  it('never lets a template-folder note shadow a built-in', () => {
    const raw = '---\nname: Daily Note\ncategory: Personal\nbuiltinId: builtin.daily\n---\nbody\n'
    const t = parseFolderTemplate(raw, 'Templates/Daily Note.md', 'Templates')
    expect(t.builtinId).toBeUndefined()
    expect(t.body).toBe('body\n')
    const merged = mergeTemplates(BUILTIN_TEMPLATES, [t])
    expect(merged.filter((m) => m.name === 'Daily Note').map((m) => m.id)).toEqual([
      'builtin.daily',
      'folder:Daily Note'
    ])
  })

  it('treats a frontmatter with any key of its own as note content', () => {
    const raw = '---\nname: Standup\naliases: sync\n---\nbody\n'
    expect(parseFolderTemplate(raw, 'Templates/standup.md', 'Templates').body).toBe(raw)
  })
})

describe('template sources (#1024)', () => {
  const stored = parseCustomTemplate(
    '---\nname: Meeting\n---\nstored\n',
    '.zennotes/templates/meeting.md'
  )
  const fromFolder = parseFolderTemplate('folder\n', 'Templates/Meeting.md', 'Templates')
  const nested = parseFolderTemplate('nested\n', 'Templates/Work/Retro.md', 'Templates')

  it('says where each template comes from', () => {
    expect(templateSource(BUILTIN_TEMPLATES[0])).toBe('builtin')
    expect(templateSource(stored)).toBe('custom')
    expect(templateSource(fromFolder)).toBe('folder')
  })

  it('labels a template-folder entry with the folder it sits in', () => {
    expect(templateSourceLabel(fromFolder)).toBe('Templates')
    expect(templateSourceLabel(nested)).toBe('Templates/Work')
    expect(templateSourceLabel(stored)).toBe('Custom')
    expect(templateSourceLabel(BUILTIN_TEMPLATES[0])).toBe(BUILTIN_TEMPLATES[0].category)
  })

  it('keeps both sides of a name clash, the .zennotes/templates file first', () => {
    // Either order in, same order out: the clash is settled by source, not by
    // whichever list happened to load first.
    for (const custom of [
      [stored, fromFolder],
      [fromFolder, stored]
    ]) {
      const merged = mergeTemplates([], custom)
      expect(merged.map((t) => t.id)).toEqual(['custom:meeting', 'folder:Meeting'])
    }
  })
})

