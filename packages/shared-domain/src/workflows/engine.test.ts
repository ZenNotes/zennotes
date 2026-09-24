import { describe, expect, it } from 'vitest'
import { planWorkflow } from './engine'
import { bindParams, nodeDef } from './nodes'
import { folderTarget } from './paths'
import type {
  NoteSet,
  PlanContext,
  RunPlan,
  VaultReader,
  Workflow,
  WorkflowNote,
  WorkflowStatement,
  WorkflowStep
} from './types'

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                   */
/* -------------------------------------------------------------------------- */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Fixed clock: every `since`/`{{date}}` assertion below is written against it. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)

function note(
  path: string,
  title: string,
  folder: string,
  tags: string[],
  frontmatter: Record<string, string>,
  age: number
): WorkflowNote {
  return {
    path,
    title,
    folder,
    tags,
    frontmatter,
    createdAt: NOW - age - 30 * DAY,
    updatedAt: NOW - age
  }
}

const NOTES: WorkflowNote[] = [
  note('inbox/Dune.md', 'Dune', 'inbox', ['book', 'book/scifi'], {
    rating: '5',
    status: 'finished',
    finished: '2024-02-01'
  }, DAY),
  note('inbox/Neuromancer.md', 'Neuromancer', 'inbox', ['book/scifi'], {
    rating: '4',
    status: 'finished'
  }, 3 * DAY),
  note('inbox/Ulysses.md', 'Ulysses', 'inbox', ['book'], {
    rating: '2',
    status: 'abandoned'
  }, 40 * DAY),
  note('inbox/Draft.md', 'Draft', 'inbox', ['book'], { rating: '10', status: 'reading' }, 2 * HOUR),
  note('inbox/projects/Compiler.md', 'Compiler', 'inbox/projects', ['project'], {
    status: 'active'
  }, 2 * DAY),
  note('inbox/projects/Engine.md', 'Engine', 'inbox/projects', ['project/workflows'], {
    status: 'active'
  }, 10 * DAY),
  note('archive/Old Note.md', 'Old Note', 'archive', [], {}, 100 * DAY),
  note('inbox/Meeting.md', 'Meeting', 'inbox', ['meeting'], { attendees: 'ada, alan' }, 5 * HOUR),
  note('inbox/Recipe.md', 'Recipe', 'inbox', ['recipe'], {}, 6 * DAY),
  note('inbox/Pipes.md', 'Pipes | Tubes', 'inbox', ['note'], { rating: '3' }, 8 * DAY),
  // Deliberately last so the existing NOTES[n] references above keep pointing
  // where they always did.
  note('trash/Deleted.md', 'Deleted', 'trash', ['book'], {}, 50 * DAY)
]

const BODIES: Record<string, string> = {
  'inbox/Dune.md': 'Spice must flow across Arrakis.',
  'inbox/Neuromancer.md': 'The sky above the port.',
  'inbox/Ulysses.md': 'Stately, plump Buck Mulligan.',
  'inbox/Draft.md': 'todo: finish this',
  'inbox/projects/Compiler.md': 'parser, codegen, and a linker',
  'inbox/projects/Engine.md': 'the workflow ENGINE plans, it never writes',
  'archive/Old Note.md': 'archived long ago',
  'trash/Deleted.md': 'deleted, not gone',
  'inbox/Meeting.md': 'ada and alan met about arrakis',
  'inbox/Recipe.md': 'flour, water, salt',
  'inbox/Pipes.md': 'pipes and tubes'
}

interface FakeVault {
  reader: VaultReader
  /** Every `readBody` call, in order, so tests can assert on caching. */
  reads: string[]
}

interface ReaderOptions {
  notes?: WorkflowNote[]
  current?: WorkflowNote | null
  selection?: WorkflowNote[]
  listThrows?: boolean
  bodyThrows?: boolean
}

function makeVault(options: ReaderOptions = {}): FakeVault {
  const reads: string[] = []
  const notes = options.notes ?? NOTES
  const reader: VaultReader = {
    listNotes: async () => {
      if (options.listThrows) throw new Error('vault offline')
      return [...notes]
    },
    readBody: async (path: string) => {
      reads.push(path)
      if (options.bodyThrows) throw new Error('unreadable')
      return BODIES[path] ?? ''
    }
  }
  if (options.current !== undefined) reader.current = () => options.current ?? null
  if (options.selection !== undefined) reader.selection = () => options.selection ?? []
  return { reader, reads }
}

function makeCtx(reader: VaultReader, extra: Partial<PlanContext> = {}): PlanContext {
  return { reader, now: NOW, ...extra }
}

/* -------------------------------------------------------------------------- */
/*  Workflow builders (bound through the real registry, not by hand)          */
/* -------------------------------------------------------------------------- */

function step(kind: string, tokens: string[] = [], line = 1): WorkflowStep {
  const def = nodeDef(kind)
  if (!def) return { kind, args: {}, line }
  return { kind, args: bindParams(def, tokens, line).args, line }
}

function stmt(
  name: string | null,
  input: string | null,
  steps: WorkflowStep[],
  line = 1
): WorkflowStatement {
  return { name, input, steps, line }
}

function workflow(statements: WorkflowStatement[], id = 'test'): Workflow {
  return {
    id,
    name: 'Test',
    description: '',
    trigger: { type: 'manual' },
    // The engine plans what it is handed; the draft rule is enforced by the
    // caller (see `isRunnable`), so the fixture is a workflow that may run.
    status: 'active',
    statements,
    meta: {}
  }
}

/** Plan a single pipeline named `out`, the shape most cases below need. */
async function planPipeline(steps: WorkflowStep[], options: ReaderOptions = {}): Promise<RunPlan> {
  const { reader } = makeVault(options)
  return planWorkflow(workflow([stmt('out', null, steps)]), makeCtx(reader))
}

function titles(notes: NoteSet | undefined): string[] {
  return (notes ?? []).map((item) => item.title)
}

async function outTitles(steps: WorkflowStep[], options: ReaderOptions = {}): Promise<string[]> {
  const plan = await planPipeline(steps, options)
  return titles(plan.wires.out)
}

/* -------------------------------------------------------------------------- */
/*  Sources                                                                   */
/* -------------------------------------------------------------------------- */

describe('sources', () => {
  it('`all` puts every working note on the wire', async () => {
    expect(await outTitles([step('all')])).toHaveLength(9)
  })

  it('`all`, `tag` and `search` leave the Trash and the Archive out', async () => {
    const all = await outTitles([step('all')])
    expect(all).not.toContain('Old Note')
    expect(all).not.toContain('Deleted')
    // The trashed note carries #book; a bulk `tag #book | add-tag …` must not
    // write into files that vanish on the next empty-trash.
    expect(await outTitles([step('tag', ['#book'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft'
    ])
    expect(await outTitles([step('search', ['deleted'])])).toEqual([])
    // Both stay reachable, spelled out loud.
    expect(await outTitles([step('folder', ['trash'])])).toEqual(['Deleted'])
    expect(await outTitles([step('folder', ['archive'])])).toEqual(['Old Note'])
  })

  it('`folder` matches the folder and everything under it', async () => {
    expect(await outTitles([step('folder', ['inbox'])])).toHaveLength(9)
    expect(await outTitles([step('folder', ['inbox/projects'])])).toEqual(['Compiler', 'Engine'])
  })

  it('`folder` with no name selects nothing rather than the whole vault', async () => {
    // An empty folder used to match every note, Trash and Archive included,
    // which is wider than any source goes and one `| trash` away from a
    // disaster. Same for the filter that shares the matching.
    const source = await planPipeline([step('folder', ['""'])])
    expect(titles(source.wires.out)).toEqual([])
    expect(source.diagnostics[0].severity).toBe('error')
    expect(source.diagnostics[0].message).toBe('`folder` needs a name')

    const blank = await planPipeline([step('folder', ['"  "'])])
    expect(titles(blank.wires.out)).toEqual([])

    const filter = await planPipeline([step('all'), step('in', ['""']), step('trash')])
    expect(filter.ops).toEqual([])
    expect(filter.diagnostics[0].message).toBe('`in` needs a folder name')
  })

  it('`tag` sees nested tags, the way the tag tree does', async () => {
    // Neuromancer is only tagged `book/scifi`, and still belongs to `book`.
    expect(await outTitles([step('tag', ['#book'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft'
    ])
  })

  it('`search` matches titles and bodies, case-insensitively', async () => {
    expect(await outTitles([step('search', ['arrakis'])])).toEqual(['Dune', 'Meeting'])
  })

  it('`search` does not read a body when the title already matched', async () => {
    const vault = makeVault()
    await planWorkflow(
      workflow([stmt('out', null, [step('search', ['dune'])])]),
      makeCtx(vault.reader)
    )
    expect(vault.reads).not.toContain('inbox/Dune.md')
  })

  it('`current` uses the reader callback', async () => {
    expect(await outTitles([step('current')], { current: NOTES[3] })).toEqual(['Draft'])
    expect(await outTitles([step('current')], { current: null })).toEqual([])
  })

  it('`selection` uses the reader callback', async () => {
    const selection = [NOTES[0], NOTES[8]]
    expect(await outTitles([step('selection')], { selection })).toEqual(['Dune', 'Recipe'])
  })

  it('warns instead of failing when current/selection are unavailable', async () => {
    const plan = await planPipeline([step('current')])
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics).toHaveLength(1)
    expect(plan.diagnostics[0].severity).toBe('warning')

    const other = await planPipeline([step('selection')])
    expect(titles(other.wires.out)).toEqual([])
    expect(other.diagnostics[0].severity).toBe('warning')
  })

  it('reports a reader that cannot list notes', async () => {
    const plan = await planPipeline([step('all')], { listThrows: true })
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].message).toContain('could not list notes')
  })
})

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
/* -------------------------------------------------------------------------- */

describe('where', () => {
  it('compares numerically when both sides are numbers', async () => {
    // A string compare would drop `10`, which sorts before `4`.
    expect(await outTitles([step('all'), step('where', ['rating', '>=', '4'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Draft'
    ])
  })

  it('compares `created`/`updated` against a typed date as dates', async () => {
    // 2026-07-24 sits more than a day from every note's timestamp, so the
    // assertion holds in any timezone even though the boundary is local.
    expect(await outTitles([step('all'), step('where', ['updated', '<', '2026-07-24'])])).toEqual([
      'Ulysses',
      'Engine',
      'Recipe',
      'Pipes | Tubes'
    ])
    expect(
      await outTitles([step('all'), step('where', ['updated', '>', '2026-07-24'])])
    ).toEqual(['Dune', 'Neuromancer', 'Draft', 'Compiler', 'Meeting'])
    expect(await outTitles([step('all'), step('where', ['created', '>', '2020-01-01'])])).toHaveLength(
      9
    )
    // A time component narrows further and still parses.
    expect(
      await outTitles([step('all'), step('where', ['updated', '>', '2020-01-01 00:00'])])
    ).toHaveLength(9)
  })

  it('a numeric field never widens against an uncomparable value', async () => {
    // Text fallback would compare '17…' < 'banana' and match everything; the
    // rule is that an unevaluable step narrows to nothing.
    expect(await outTitles([step('all'), step('where', ['updated', '<', 'banana'])])).toEqual([])
    expect(await outTitles([step('all'), step('where', ['updated', '>', 'banana'])])).toEqual([])
    expect(await outTitles([step('all'), step('where', ['updated', '!=', 'banana'])])).toEqual([])
  })

  it('compares text case-insensitively when a side is not a number', async () => {
    expect(await outTitles([step('all'), step('where', ['status', '=', 'FINISHED'])])).toEqual([
      'Dune',
      'Neuromancer'
    ])
    expect(await outTitles([step('all'), step('where', ['status', '!=', 'finished'])])).toHaveLength(
      7
    )
  })

  it('treats a missing field as blank rather than zero', async () => {
    // Notes with no `rating` must not compare as 0 and slip through `> 0`.
    expect(await outTitles([step('all'), step('where', ['rating', '>', '0'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft',
      'Pipes | Tubes'
    ])
  })

  it('supports the pseudo-fields, and matches folder exactly', async () => {
    expect(await outTitles([step('all'), step('where', ['title', 'contains', 'pipes'])])).toEqual([
      'Pipes | Tubes'
    ])
    expect(
      await outTitles([step('all'), step('where', ['path', 'matches', '^inbox/projects'])])
    ).toEqual(['Compiler', 'Engine'])
    // `where folder` is exact, unlike the `folder` source and the `in` filter.
    expect(await outTitles([step('all'), step('where', ['folder', '=', 'inbox'])])).toHaveLength(7)
    expect(
      await outTitles([step('all'), step('where', ['updated', '>', String(NOW - 4 * HOUR)])])
    ).toEqual(['Draft'])
  })

  it('reports an invalid regex and matches nothing', async () => {
    const plan = await planPipeline([step('all'), step('where', ['title', 'matches', '[unclosed'])])
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].severity).toBe('error')
    expect(plan.diagnostics[0].message).toContain('not a valid pattern')
  })

  it('reports a pattern outside the subset the same way', async () => {
    // Lookaround and backreferences are what no automaton can run, so they read
    // as "not a valid pattern" here rather than being quietly mistranslated.
    const plan = await planPipeline([
      step('all'),
      step('where', ['title', 'matches', '(?=Dune)'])
    ])
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].message).toContain('lookahead is not supported')
  })

  it('answers a pattern written to hang a backtracker, in milliseconds', async () => {
    // `^(a+)+$` over a long run of `a` that cannot match is the case that took
    // RegExp the better part of a minute, on the thread that draws the canvas.
    const title = `${'a'.repeat(60)}!`
    const hostile = note(`inbox/${title}.md`, title, 'inbox', [], {}, DAY)
    const started = Date.now()
    const plan = await planPipeline([step('all'), step('where', ['title', 'matches', '^(a+)+$'])], {
      notes: [hostile]
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics).toEqual([])
  })
})

describe('filters', () => {
  it('`tagged` and `not-tagged` follow the tag hierarchy', async () => {
    expect(await outTitles([step('all'), step('tagged', ['#project'])])).toEqual([
      'Compiler',
      'Engine'
    ])
    expect(await outTitles([step('all'), step('not-tagged', ['#book'])])).toHaveLength(5)
  })

  it('`in` narrows to a folder subtree', async () => {
    expect(await outTitles([step('all'), step('in', ['inbox/projects'])])).toEqual([
      'Compiler',
      'Engine'
    ])
  })

  it('`matching` globs over the path, with * stopping at a separator', async () => {
    expect(await outTitles([step('all'), step('matching', ['inbox/*.md'])])).toHaveLength(7)
    expect(await outTitles([step('all'), step('matching', ['inbox/**/*.md'])])).toHaveLength(9)
    expect(await outTitles([step('folder', ['archive']), step('matching', ['**/Old*.md'])])).toEqual(
      ['Old Note']
    )
  })

  it('`matching` answers a stack of ** without hanging', async () => {
    // A dozen `**/` is a dozen nested `.*`, which a backtracker answers in
    // minutes on an ordinary path. Same automaton as `matches`, same bound.
    const deep = note(`inbox/${'a/'.repeat(40)}Nope.txt`, 'Nope', 'inbox', [], {}, DAY)
    const started = Date.now()
    const plan = await planPipeline(
      [step('all'), step('matching', [`${'**/'.repeat(12)}x.md`])],
      { notes: [deep] }
    )
    expect(Date.now() - started).toBeLessThan(500)
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics).toEqual([])
  })

  it('`contains` reads bodies and ignores case', async () => {
    expect(await outTitles([step('all'), step('contains', ['codegen'])])).toEqual(['Compiler'])
    expect(await outTitles([step('all'), step('contains', ['engine plans'])])).toEqual(['Engine'])
  })

  it('`since` is relative to ctx.now, with m meaning minutes', async () => {
    expect(await outTitles([step('all'), step('since', ['7d'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Draft',
      'Compiler',
      'Meeting',
      'Recipe'
    ])
    expect(await outTitles([step('all'), step('since', ['180m'])])).toEqual(['Draft'])
    // 2w reaches back past Engine (10d) and Pipes (8d), but not Ulysses (40d).
    expect(await outTitles([step('all'), step('since', ['2w'])])).toHaveLength(8)
  })
})

/* -------------------------------------------------------------------------- */
/*  Order and shape                                                           */
/* -------------------------------------------------------------------------- */

describe('order', () => {
  it('sorts numerically, descending on request', async () => {
    expect(
      await outTitles([step('tag', ['#book']), step('sort', ['rating', 'desc'])])
    ).toEqual(['Draft', 'Dune', 'Neuromancer', 'Ulysses'])
  })

  it('sorts ascending by default', async () => {
    expect(await outTitles([step('tag', ['#book']), step('sort', ['title'])])).toEqual([
      'Draft',
      'Dune',
      'Neuromancer',
      'Ulysses'
    ])
  })

  it('is stable, so ties keep their incoming order', async () => {
    expect(await outTitles([step('tag', ['#book']), step('sort', ['status'])])).toEqual([
      'Ulysses',
      'Dune',
      'Neuromancer',
      'Draft'
    ])
  })

  it('`limit` truncates and never goes negative', async () => {
    expect(await outTitles([step('tag', ['#book']), step('limit', ['2'])])).toEqual([
      'Dune',
      'Neuromancer'
    ])
    expect(await outTitles([step('tag', ['#book']), step('limit', ['0'])])).toEqual([])
  })

  it('`dedupe` collapses repeated paths, keeping the first', async () => {
    const duplicated = [NOTES[0], NOTES[8], NOTES[0]]
    expect(await outTitles([step('all'), step('dedupe')], { notes: duplicated })).toEqual([
      'Dune',
      'Recipe'
    ])
  })
})

describe('shape', () => {
  it('`union` appends the other wire without duplicating paths', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('projects', null, [step('folder', ['inbox/projects'], 2)], 2),
        stmt('both', 'books', [step('union', ['projects'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.both)).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft',
      'Compiler',
      'Engine'
    ])
  })

  it('`union` with itself is a no-op', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('same', 'books', [step('union', ['books'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.same)).toHaveLength(4)
  })

  it('`subtract` removes by path', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('scifi', null, [step('tag', ['#book/scifi'], 2)], 2),
        stmt('rest', 'books', [step('subtract', ['scifi'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.rest)).toEqual(['Ulysses', 'Draft'])
  })

  it('reports an unknown wire and leaves the set alone', async () => {
    const plan = await planPipeline([step('tag', ['#book']), step('union', ['ghosts'])])
    expect(titles(plan.wires.out)).toHaveLength(4)
    expect(plan.diagnostics[0].message).toContain('unknown wire `ghosts`')
  })
})

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

describe('mutations', () => {
  it('emits one op per note and passes the set through', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('add-tag', ['#starred']),
      step('archive')
    ])
    expect(plan.ops).toHaveLength(8)
    expect(plan.ops[0]).toEqual({ kind: 'add-tag', path: 'inbox/Dune.md', tag: 'starred' })
    expect(plan.ops[4]).toEqual({ kind: 'archive', path: 'inbox/Dune.md' })
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('shapes set / remove-tag / move / apply-template / trash', async () => {
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('set', ['status', 'cooked']),
      step('remove-tag', ['#recipe']),
      step('move', ['archive/kitchen/']),
      step('apply-template', ['review']),
      step('trash')
    ])
    // Everything after the `move` names the note's NEW address: the wire
    // follows the note, so a later op can never resurrect the abandoned path.
    expect(plan.ops).toEqual([
      { kind: 'set-frontmatter', path: 'inbox/Recipe.md', field: 'status', value: 'cooked' },
      { kind: 'remove-tag', path: 'inbox/Recipe.md', tag: 'recipe' },
      { kind: 'move', path: 'inbox/Recipe.md', to: 'archive/kitchen' },
      { kind: 'apply-template', path: 'archive/kitchen/Recipe.md', template: 'review' },
      { kind: 'trash', path: 'archive/kitchen/Recipe.md' }
    ])
  })

  it('text ops after a path op follow the note to its destination', async () => {
    const moved = await planPipeline([
      step('tag', ['#recipe']),
      step('move', ['archive/kitchen/']),
      step('add-tag', ['#filed'])
    ])
    expect(moved.ops).toEqual([
      { kind: 'move', path: 'inbox/Recipe.md', to: 'archive/kitchen' },
      { kind: 'add-tag', path: 'archive/kitchen/Recipe.md', tag: 'filed' }
    ])
    // The wire's metadata follows too, so a later filter sees the new address.
    expect(moved.wires.out.map((note) => note.folder)).toEqual(['archive/kitchen'])

    const renamed = await planPipeline([
      step('tag', ['#recipe']),
      step('rename', ['Cookbook']),
      step('append', ['reviewed'])
    ])
    expect(renamed.ops).toEqual([
      { kind: 'rename', path: 'inbox/Recipe.md', to: 'Cookbook' },
      { kind: 'append', path: 'inbox/Cookbook.md', text: 'reviewed' }
    ])
    expect(renamed.wires.out.map((note) => note.title)).toEqual(['Cookbook'])

    const archived = await planPipeline([
      step('tag', ['#recipe']),
      step('archive'),
      step('set', ['status', 'done'])
    ])
    expect(archived.ops).toEqual([
      { kind: 'archive', path: 'inbox/Recipe.md' },
      { kind: 'set-frontmatter', path: 'archive/Recipe.md', field: 'status', value: 'done' }
    ])
  })

  it('shapes append / prepend and expands note fields', async () => {
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('append', ['reviewed', '{{date}}']),
      step('prepend', ['#', '{{title}}'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'append', path: 'inbox/Recipe.md', text: 'reviewed 2026-07-28' },
      { kind: 'prepend', path: 'inbox/Recipe.md', text: '# Recipe' }
    ])
  })

  it('expands rename patterns per note and keeps unknown placeholders visible', async () => {
    const plan = await planPipeline([
      step('tag', ['#meeting']),
      step('rename', ['"{{title}} {{finished}} {{titel}}"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'rename', path: 'inbox/Meeting.md', to: 'Meeting {{finished}} {{titel}}' }
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*  Render                                                                    */
/* -------------------------------------------------------------------------- */

describe('render', () => {
  it('builds a markdown table from the columns arg', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('render', ['table', 'title,', 'rating']),
      step('clipboard')
    ])
    expect(plan.ops[0]).toEqual({
      kind: 'clipboard',
      text: [
        '| title | rating |',
        '| --- | --- |',
        '| Dune | 5 |',
        '| Neuromancer | 4 |',
        '| Ulysses | 2 |',
        '| Draft | 10 |'
      ].join('\n')
    })
  })

  it('escapes a pipe inside a table cell', async () => {
    const plan = await planPipeline([
      step('all'),
      step('where', ['title', 'contains', 'tubes']),
      step('render', ['table', 'title']),
      step('clipboard')
    ])
    expect(plan.ops[0]).toEqual({
      kind: 'clipboard',
      text: ['| title |', '| --- |', '| Pipes \\| Tubes |'].join('\n')
    })
  })

  it('renders list, links and count', async () => {
    const list = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['list']),
      step('clipboard')
    ])
    expect(list.ops[0]).toEqual({ kind: 'clipboard', text: '- Dune\n- Neuromancer' })

    const links = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['links']),
      step('clipboard')
    ])
    expect(links.ops[0]).toEqual({ kind: 'clipboard', text: '- [[Dune]]\n- [[Neuromancer]]' })

    const count = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('clipboard')
    ])
    expect(count.ops[0]).toEqual({ kind: 'clipboard', text: '4' })
  })

  it('does not change the notes flowing through it', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('archive')
    ])
    expect(plan.ops).toHaveLength(4)
    expect(titles(plan.wires.out)).toHaveLength(4)
  })
})

/* -------------------------------------------------------------------------- */
/*  Sinks                                                                     */
/* -------------------------------------------------------------------------- */

describe('sinks', () => {
  it('`write` uses the rendered text', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['list']),
      step('write', ['"Reading Log.md"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'write-note', path: 'Reading Log.md', text: '- Dune\n- Neuromancer' }
    ])
  })

  it('`write-section` carries the heading', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['count']),
      step('write-section', ['"Reading Log.md"', '"Finished"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'write-section', path: 'Reading Log.md', heading: 'Finished', text: '2' }
    ])
  })

  it('a consumesText sink falls back to a links rendering', async () => {
    const plan = await planPipeline([step('tag', ['#book/scifi']), step('clipboard')])
    expect(plan.ops).toEqual([{ kind: 'clipboard', text: '- [[Dune]]\n- [[Neuromancer]]' }])
  })

  it('`create-each` creates one empty note per item, defaulting to .md', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('create-each', ['"reviews/{{title}} {{date}}"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'create-note', path: 'reviews/Dune 2026-07-28.md', body: '' },
      { kind: 'create-note', path: 'reviews/Neuromancer 2026-07-28.md', body: '' }
    ])
  })

  it('`create-each` keeps a note type the pattern already names', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('create-each', ['"boards/{{title}}.excalidraw"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'create-note', path: 'boards/Dune.excalidraw', body: '' },
      { kind: 'create-note', path: 'boards/Neuromancer.excalidraw', body: '' }
    ])
  })

  it('`create-each` suffixes a path it already planned in this run', async () => {
    // Same title, two folders, one pattern: the applier refuses the second
    // create and fails the whole run, so the plan resolves it first.
    const twins = [
      note('inbox/Report.md', 'Report', 'inbox', ['weekly'], {}, DAY),
      note('inbox/2025/Report.md', 'Report', 'inbox/2025', ['weekly'], {}, DAY),
      note('inbox/2024/Report.md', 'Report', 'inbox/2024', ['weekly'], {}, DAY)
    ]
    const plan = await planPipeline(
      [step('tag', ['#weekly']), step('create-each', ['"reviews/{{title}}"'])],
      { notes: twins }
    )
    expect(plan.ops).toEqual([
      { kind: 'create-note', path: 'reviews/Report.md', body: '' },
      { kind: 'create-note', path: 'reviews/Report 2.md', body: '' },
      { kind: 'create-note', path: 'reviews/Report 3.md', body: '' }
    ])
    expect(plan.diagnostics).toHaveLength(2)
    expect(plan.diagnostics[0].severity).toBe('warning')
    expect(plan.diagnostics[0].message).toContain('reviews/Report 2.md')
  })

  it('`notify` expands {{count}}, and falls back to the rendered text', async () => {
    const withMessage = await planPipeline([
      step('tag', ['#book']),
      step('notify', ['Found', '{{count}}', 'books', 'on', '{{date}}'])
    ])
    expect(withMessage.ops).toEqual([
      { kind: 'notify', message: 'Found 4 books on 2026-07-28' }
    ])

    const fromRender = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('notify')
    ])
    expect(fromRender.ops).toEqual([{ kind: 'notify', message: '4' }])
  })
})

/* -------------------------------------------------------------------------- */
/*  Rule 3: a statement that failed writes nothing                            */
/* -------------------------------------------------------------------------- */

describe('a statement that raised an error', () => {
  it('plans no sink op over the wire the error emptied', async () => {
    // The filter could not run, so the wire is empty for a reason that has
    // nothing to do with the vault, and writing that emptiness over the report
    // is a zero-byte overwrite of a real note.
    const plan = await planPipeline([
      step('all'),
      step('where', ['title', 'matches', '[unclosed']),
      step('write', ['"inbox/Report.md"'])
    ])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('not a valid pattern')
  })

  it('still writes an empty report when the wire is honestly empty', async () => {
    const plan = await planPipeline([
      step('all'),
      step('where', ['title', '=', 'no such note']),
      step('render', ['list']),
      step('write', ['"inbox/Report.md"'])
    ])
    expect(plan.ops).toEqual([{ kind: 'write-note', path: 'inbox/Report.md', text: '' }])
    expect(plan.diagnostics).toEqual([])
  })

  it('withdraws the ops planned before the error, not only after it', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('add-tag', ['#starred']),
      step('where', ['title', 'matches', '[unclosed']),
      step('archive')
    ])
    expect(plan.ops).toEqual([])
  })

  it('leaves every other statement`s ops standing', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [step('tag', ['#recipe'], 1), step('add-tag', ['#filed'], 1)], 1),
        stmt(null, null, [
          step('all', [], 2),
          step('where', ['title', 'matches', '[unclosed'], 2),
          step('write', ['"inbox/Report.md"'], 2)
        ], 2)
      ]),
      makeCtx(reader)
    )
    expect(plan.ops).toEqual([{ kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'filed' }])
    expect(plan.diagnostics).toHaveLength(1)
  })

  it('does not answer for a failure that happened inside a call', async () => {
    // `call` hands the wire straight through, so nothing that went wrong in the
    // child can have made the caller's own ops wrong.
    const broken = workflow(
      [stmt('out', null, [step('tag', ['#meeting'], 1), step('union', ['ghosts'], 1)], 1)],
      'child'
    )
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [
          step('tag', ['#recipe'], 1),
          step('call', ['child'], 1),
          step('add-tag', ['#filed'], 1)
        ], 1)
      ]),
      makeCtx(reader, { resolve: () => broken })
    )
    expect(plan.ops).toEqual([{ kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'filed' }])
    expect(plan.diagnostics[0].message).toBe('child: unknown wire `ghosts`')
  })
})

/* -------------------------------------------------------------------------- */
/*  Destinations                                                              */
/* -------------------------------------------------------------------------- */

// The desktop applier refuses these shapes too, and keeps doing so. These pin
// the refusal that a DRY RUN can see, and the one a Go runtime mirroring this
// layer would inherit.
describe('destinations', () => {
  async function refusal(steps: WorkflowStep[], options: ReaderOptions = {}): Promise<string> {
    const plan = await planPipeline(steps, options)
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0]?.severity).toBe('error')
    return plan.diagnostics[0]?.message ?? ''
  }

  it('refuses a move that climbs out of the vault', async () => {
    const plan = await planPipeline([step('tag', ['#recipe']), step('move', ['../../escape'])])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`move` cannot write `../../escape`: a path may not climb out of the vault'
    )
    // Refused, so the note is still where it was for anything downstream.
    expect(plan.wires.out.map((item) => item.path)).toEqual(['inbox/Recipe.md'])
  })

  it('refuses an absolute destination rather than reading it as relative', async () => {
    expect(await refusal([step('tag', ['#recipe']), step('move', ['/tmp'])])).toContain(
      'may not be absolute'
    )
    expect(await refusal([step('tag', ['#recipe']), step('move', ['C:/tmp'])])).toContain(
      'may not be absolute'
    )
    expect(await refusal([step('tag', ['#book']), step('write', ['"/tmp/out.md"'])])).toContain(
      'may not be absolute'
    )
  })

  it('refuses the app`s own directory', async () => {
    expect(await refusal([step('tag', ['#recipe']), step('move', ['.zennotes/workflows'])])).toContain(
      'may not be inside .zennotes'
    )
  })

  it('refuses a sink path that is not a note', async () => {
    expect(await refusal([step('tag', ['#book']), step('write', ['reports/weekly'])])).toContain(
      'must end in .md or .excalidraw'
    )
    expect(
      await refusal([
        step('tag', ['#book']),
        step('render', ['count']),
        step('write-section', ['reports/weekly', '"Books"'])
      ])
    ).toContain('must end in')
  })

  it('refuses a destination an interpolated field smuggled a climb into', async () => {
    const escaping = note('inbox/Recipe.md', 'Recipe', 'inbox', ['recipe'], { dest: '../secrets' }, DAY)
    expect(
      await refusal([step('tag', ['#recipe']), step('move', ['{{dest}}'])], { notes: [escaping] })
    ).toBe('`move` cannot write `../secrets`: a path may not climb out of the vault')
  })

  it('refuses a create-each pattern that escapes', async () => {
    expect(
      await refusal([step('tag', ['#book/scifi']), step('create-each', ['"../{{title}}"'])])
    ).toContain('may not climb out of the vault')
  })

  it('refuses a rename with no name', async () => {
    expect(await refusal([step('tag', ['#recipe']), step('rename', ['""'])])).toBe(
      '`rename` needs a name'
    )
  })

  it('refuses a rename that would move the note to another folder', async () => {
    // `renameTarget` keeps interior slashes, so this used to relocate the note
    // through the step that promises to keep it where it is.
    const plan = await planPipeline([step('tag', ['#recipe']), step('rename', ['sub/deep'])])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`rename` cannot take a path (`sub/deep`): `move` is the step that changes folders'
    )
    expect(plan.wires.out.map((item) => item.path)).toEqual(['inbox/Recipe.md'])

    // The rename that stays in its folder is untouched.
    const fine = await planPipeline([step('tag', ['#recipe']), step('rename', ['Cookbook'])])
    expect(fine.ops).toEqual([{ kind: 'rename', path: 'inbox/Recipe.md', to: 'Cookbook' }])
  })
})

/* -------------------------------------------------------------------------- */
/*  Wires, ordering and fan-out                                               */
/* -------------------------------------------------------------------------- */

describe('wires', () => {
  it('keys named statements by name and terminal ones by #line', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [step('limit', ['1'], 5), step('archive', [], 5)], 5)
      ]),
      makeCtx(reader)
    )
    expect(Object.keys(plan.wires).sort()).toEqual(['#5', 'books'])
    expect(titles(plan.wires['#5'])).toEqual(['Dune'])
  })

  it('fans one wire out to two statements without disturbing it', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [
          step('sort', ['rating', 'desc'], 2),
          step('limit', ['1'], 2),
          step('add-tag', ['#top'], 2)
        ], 2),
        stmt(null, 'books', [step('where', ['rating', '<', '4'], 3), step('add-tag', ['#meh'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.books)).toEqual(['Dune', 'Neuromancer', 'Ulysses', 'Draft'])
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Draft.md', tag: 'top' },
      { kind: 'add-tag', path: 'inbox/Ulysses.md', tag: 'meh' }
    ])
  })

  it('runs statements in dependency order, not file order', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('good', 'books', [step('where', ['rating', '>=', '4'], 1)], 1),
        stmt('books', null, [step('tag', ['#book'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.good)).toEqual(['Dune', 'Neuromancer', 'Draft'])
  })

  it('reports a cycle instead of looping forever', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('a', 'b', [step('limit', ['1'], 1)], 1),
        stmt('b', 'a', [step('limit', ['1'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(plan.diagnostics).toHaveLength(2)
    expect(plan.diagnostics[0].message).toContain('cycle')
    expect(plan.wires.a).toEqual([])
    expect(plan.wires.b).toEqual([])
    expect(plan.ops).toEqual([])
  })

  it('skips a statement whose input wire does not exist', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', 'ghosts', [step('archive', [], 1)], 1)]),
      makeCtx(reader)
    )
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('unknown wire `ghosts`')
  })
})

/* -------------------------------------------------------------------------- */
/*  Compose                                                                   */
/* -------------------------------------------------------------------------- */

const CHILD = workflow(
  [stmt('seen', null, [step('tag', ['#meeting'], 1), step('add-tag', ['#seen'], 1)], 1)],
  'child'
)

describe('call', () => {
  it('merges child ops in order and namespaces child wires', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [
          step('tag', ['#recipe'], 1),
          step('add-tag', ['#before'], 1),
          step('call', ['child'], 1),
          step('add-tag', ['#after'], 1)
        ], 1)
      ]),
      makeCtx(reader, { resolve: (id) => (id === 'child' ? CHILD : null) })
    )
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'before' },
      { kind: 'add-tag', path: 'inbox/Meeting.md', tag: 'seen' },
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'after' }
    ])
    expect(Object.keys(plan.wires).sort()).toEqual(['#1', 'child.seen'])
    expect(titles(plan.wires['child.seen'])).toEqual(['Meeting'])
  })

  it('skips a draft child instead of running it', async () => {
    // The top-level draft rule is the caller's (`isRunnable`); a called child
    // never passes through the caller, so the engine has to ask again. The
    // parent's own steps still run on either side of the skipped call.
    const draft: Workflow = { ...CHILD, status: 'draft' }
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [
          step('tag', ['#recipe'], 1),
          step('add-tag', ['#before'], 1),
          step('call', ['child'], 1),
          step('add-tag', ['#after'], 1)
        ], 1)
      ]),
      makeCtx(reader, { resolve: (id) => (id === 'child' ? draft : null) })
    )
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'before' },
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'after' }
    ])
    expect(plan.diagnostics[0].message).toBe('`call child` was skipped: that workflow is a draft')
    expect(plan.wires['child.seen']).toBeUndefined()
  })

  it('reports a missing resolver rather than silently doing nothing', async () => {
    const plan = await planPipeline([step('tag', ['#recipe']), step('call', ['child'])])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('needs a workflow resolver')
  })

  it('reports an unknown workflow id', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('tag', ['#recipe'], 1), step('call', ['nope'], 1)], 1)]),
      makeCtx(reader, { resolve: () => null })
    )
    expect(plan.diagnostics[0].message).toContain('unknown workflow `nope`')
    expect(titles(plan.wires.out)).toEqual(['Recipe'])
  })

  it('attributes a child diagnostic to the child', async () => {
    const broken = workflow(
      [stmt('out', null, [step('tag', ['#meeting'], 1), step('union', ['ghosts'], 1)], 1)],
      'child'
    )
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt(null, null, [step('all', [], 1), step('call', ['child'], 1)], 1)]),
      makeCtx(reader, { resolve: () => broken })
    )
    expect(plan.diagnostics[0].message).toBe('child: unknown wire `ghosts`')
  })

  it('stops at maxDepth when a resolver builds a cycle at runtime', async () => {
    const loop: Workflow = workflow(
      [stmt(null, null, [
        step('tag', ['#recipe'], 1),
        step('add-tag', ['#round'], 1),
        step('call', ['loop'], 1)
      ], 1)],
      'loop'
    )
    const { reader } = makeVault()
    const plan = await planWorkflow(loop, makeCtx(reader, { resolve: () => loop, maxDepth: 2 }))
    // The limit cut every level of the recursion short, and a statement that was
    // cut short keeps none of its ops (rule 3), so a runaway workflow plans
    // nothing at all rather than an arbitrary three tags deep into a loop.
    expect(plan.ops).toEqual([])
    const last = plan.diagnostics[plan.diagnostics.length - 1]
    expect(last.severity).toBe('error')
    expect(last.message).toContain('maxDepth')
  })

  it('stops at maxOps, dropping the statement the budget cut in half', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('tag', ['#book'], 1), step('archive', [], 1)], 1)]),
      makeCtx(reader, { maxOps: 3 })
    )
    // Four books and room for three: applying three of them is a half-done
    // filing job, so the statement contributes nothing and says why.
    expect(plan.ops).toEqual([])
    expect(titles(plan.wires.out)).toHaveLength(4)
    const last = plan.diagnostics[plan.diagnostics.length - 1]
    expect(last.message).toContain('maxOps')
  })

  it('keeps the ops of the statements that fitted inside the budget', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [step('tag', ['#recipe'], 1), step('add-tag', ['#filed'], 1)], 1),
        stmt(null, null, [step('tag', ['#book'], 2), step('archive', [], 2)], 2)
      ]),
      makeCtx(reader, { maxOps: 3 })
    )
    expect(plan.ops).toEqual([{ kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'filed' }])
  })

  it('never plans some of a note`s mutations and not the rest', async () => {
    const twoTags = workflow([
      stmt(null, null, [
        step('all', [], 1),
        step('add-tag', ['#x'], 1),
        step('add-tag', ['#y'], 1)
      ], 1)
    ])
    // Nine notes, two tags each. A budget of three lands inside the first
    // `add-tag`, where the old truncation left three notes carrying `#x` and
    // not one of them `#y`. There is no budget at which half a note is planned:
    // the statement either fits whole or contributes nothing.
    const cut = await planWorkflow(twoTags, makeCtx(makeVault().reader, { maxOps: 3 }))
    expect(cut.ops).toEqual([])

    const whole = await planWorkflow(twoTags, makeCtx(makeVault().reader, { maxOps: 100 }))
    const tagsByPath = new Map<string, string[]>()
    for (const op of whole.ops) {
      if (op.kind !== 'add-tag') continue
      tagsByPath.set(op.path, [...(tagsByPath.get(op.path) ?? []), op.tag])
    }
    expect(tagsByPath.size).toBe(9)
    for (const [path, tags] of tagsByPath) {
      expect(tags, path).toEqual(['x', 'y'])
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Invariants                                                                */
/* -------------------------------------------------------------------------- */

describe('invariants', () => {
  it('plans no ops at all when no step mutates', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('sort', ['rating', 'desc']),
      step('limit', ['2']),
      step('render', ['list'])
    ])
    expect(plan.ops).toEqual([])
    expect(plan.irreversible).toEqual([])
  })

  it('lists only the ops that cannot be rolled back', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [step('tag', ['#recipe'], 1), step('archive', [], 1)], 1),
        stmt(null, null, [step('tag', ['#recipe'], 2), step('notify', ['done'], 2)], 2),
        stmt(null, null, [step('tag', ['#recipe'], 3), step('clipboard', [], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(plan.ops).toHaveLength(3)
    expect(plan.irreversible.map((op) => op.kind)).toEqual(['notify', 'clipboard'])
  })

  it('reads a body at most once per path across the whole run', async () => {
    const vault = makeVault()
    await planWorkflow(
      workflow([
        stmt('a', null, [step('folder', ['inbox/projects'], 1), step('contains', ['parser'], 1)], 1),
        stmt('b', null, [step('folder', ['inbox/projects'], 2), step('contains', ['codegen'], 2)], 2)
      ]),
      makeCtx(vault.reader)
    )
    expect(vault.reads).toEqual(['inbox/projects/Compiler.md', 'inbox/projects/Engine.md'])
  })

  it('warns and keeps going when a body cannot be read', async () => {
    const plan = await planPipeline([step('all'), step('contains', ['anything'])], {
      notes: [NOTES[0]],
      bodyThrows: true
    })
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].severity).toBe('warning')
    expect(plan.diagnostics[0].message).toContain('could not read')
  })

  it('reports an unknown step kind without throwing', async () => {
    const plan = await planPipeline([step('tag', ['#book']), step('frobnicate')])
    expect(plan.diagnostics[0].message).toContain('unknown step `frobnicate`')
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('rejects a pipeline that opens with something other than a source', async () => {
    const plan = await planPipeline([step('limit', ['2'])])
    expect(plan.diagnostics[0].message).toContain('must start with a source')
    expect(plan.wires.out).toEqual([])
  })

  it('aborts the rest of a pipeline when a step is missing an arg', async () => {
    // `where` never bound its params, so `trash` must not run over the whole tag.
    const plan = await planPipeline([step('tag', ['#book']), step('where'), step('trash')])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('`where` is missing field')
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('aborts a pipeline at a source that is not its head', async () => {
    // A source past the head would REPLACE the wire with a vault-wide query,
    // so the `trash` after it must never see that widened set.
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('folder', ['inbox']),
      step('trash')
    ])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`folder` is a source, so it can only start a pipeline'
    )
    expect(titles(plan.wires.out)).toEqual(['Recipe'])
  })

  it('aborts a statement whose input wire feeds a source', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [step('all', [], 2), step('trash', [], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`all` is a source, so it cannot read from wire `books`'
    )
    // The statement still publishes its wire, holding what it read upstream.
    expect(titles(plan.wires['#2'])).toHaveLength(4)
  })

  it('never mutates the notes the reader handed it', async () => {
    const snapshot = JSON.stringify(NOTES)
    await planPipeline([
      step('all'),
      step('contains', ['a']),
      step('sort', ['title', 'desc']),
      step('add-tag', ['#x'])
    ])
    expect(JSON.stringify(NOTES)).toBe(snapshot)
  })
})

/* -------------------------------------------------------------------------- */
/*  Remapped system folders (#398)                                            */
/* -------------------------------------------------------------------------- */

// With vault.json `systemFolderPaths` the on-disk directory stops naming the
// bucket, so the reader stamps `system` on each note and the plan context
// carries the resolved directory names. These pin the three places that must
// respect a remap: the working-set filter, `folder trash`, and where the
// `trash`/`archive` steps file notes.
describe('remapped system folders', () => {
  const dirs = { inbox: '01 - Entry', archive: 'Shelf', trash: '99 - Deleted' } as const
  const remapNotes: WorkflowNote[] = [
    { ...note('01 - Entry/Idea.md', 'Idea', '01 - Entry', ['book'], { rating: '5' }, DAY), system: 'inbox' },
    { ...note('99 - Deleted/Gone.md', 'Gone', '99 - Deleted', ['book'], {}, DAY), system: 'trash' },
    { ...note('Shelf/Old.md', 'Old', 'Shelf', [], {}, DAY), system: 'archive' }
  ]
  const remapReader: VaultReader = {
    listNotes: async () => remapNotes,
    readBody: async () => ''
  }

  it('keeps `all` off a remapped Trash and Archive', async () => {
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('all')])]),
      makeCtx(remapReader, { systemFolderDirs: dirs })
    )
    expect(plan.wires.out.map((n) => n.title)).toEqual(['Idea'])
  })

  it('`folder trash` still means THE trash after a remap', async () => {
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('folder', ['trash'])])]),
      makeCtx(remapReader, { systemFolderDirs: dirs })
    )
    expect(plan.wires.out.map((n) => n.title)).toEqual(['Gone'])
  })

  it('`folder inbox` and `in inbox` still mean THE inbox after a remap', async () => {
    const source = await planWorkflow(
      workflow([stmt('out', null, [step('folder', ['inbox'])])]),
      makeCtx(remapReader, { systemFolderDirs: dirs })
    )
    expect(source.wires.out.map((n) => n.title)).toEqual(['Idea'])
    const filter = await planWorkflow(
      workflow([stmt('out', null, [step('all'), step('in', ['inbox'])])]),
      makeCtx(remapReader, { systemFolderDirs: dirs })
    )
    expect(filter.wires.out.map((n) => n.title)).toEqual(['Idea'])
  })

  it('the `trash` step projects into the remapped directory', async () => {
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('all'), step('trash')])]),
      makeCtx(remapReader, { systemFolderDirs: dirs })
    )
    expect(plan.ops).toEqual([{ kind: 'trash', path: '01 - Entry/Idea.md' }])
    expect(plan.wires.out.map((n) => n.path)).toEqual(['99 - Deleted/Idea.md'])
  })

  it('folderTarget resolves destinations and strips remapped source roots', () => {
    expect(folderTarget('trash', 'inbox/demo/X.md', dirs)).toBe('99 - Deleted/demo/X.md')
    expect(folderTarget('archive', '01 - Entry/X.md', dirs)).toBe('Shelf/X.md')
    expect(folderTarget('trash', 'inbox/demo/X.md')).toBe('trash/demo/X.md')
  })
})

/* -------------------------------------------------------------------------- */
/*  Notes at the vault root (#840)                                            */
/* -------------------------------------------------------------------------- */

// With vault.json `primaryNotesLocation: root` the primary notes area is the
// root itself, so its directory is the empty string, which `folder` refuses on
// purpose, and no note has an `inbox` directory. The system name is the only
// way to spell it, and it must reach the subfolders too.
describe('notes at the vault root', () => {
  const rootNotes: WorkflowNote[] = [
    { ...note('Dune.md', 'Dune', '', ['book'], {}, DAY), system: 'inbox' },
    { ...note('Areas/Gym/Plan.md', 'Plan', 'Areas/Gym', [], {}, DAY), system: 'inbox' },
    { ...note('quick/Scratch.md', 'Scratch', 'quick', [], {}, DAY), system: 'quick' },
    { ...note('archive/Old.md', 'Old', 'archive', ['book'], {}, DAY), system: 'archive' }
  ]
  const rootReader: VaultReader = {
    listNotes: async () => rootNotes,
    readBody: async () => ''
  }
  const out = async (steps: WorkflowStep[]): Promise<string[]> => {
    const plan = await planWorkflow(workflow([stmt('out', null, steps)]), makeCtx(rootReader))
    return plan.wires.out.map((n) => n.title)
  }

  it('`folder inbox` is the root and everything under it', async () => {
    expect(await out([step('folder', ['inbox'])])).toEqual(['Dune', 'Plan'])
  })

  it('a directory name still narrows to that directory', async () => {
    expect(await out([step('folder', ['Areas'])])).toEqual(['Plan'])
    expect(await out([step('folder', ['Areas/Gym'])])).toEqual(['Plan'])
  })

  it('the other system names keep their meaning', async () => {
    expect(await out([step('folder', ['quick'])])).toEqual(['Scratch'])
    expect(await out([step('folder', ['archive'])])).toEqual(['Old'])
    expect(await out([step('tag', ['#book']), step('in', ['inbox'])])).toEqual(['Dune'])
  })
})
