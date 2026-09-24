// The node registry: every step kind a workflow can use, declared as data.
//
// The parser is deliberately dumb: it splits statements into pipelines and
// pipelines into `verb token token` steps, then hands the tokens here to be
// bound to typed params. Adding a node therefore means adding an entry to
// `NODE_DEFS` and a case in the engine, and never touching the parser, the
// serializer, or the layout.
//
// The registry is also what the canvas reads to render a node's form, what the
// validator reads to check arity, and what the palette reads to offer
// completions. One source of truth for all four.

import type { ArgValue, Diagnostic } from './types'
import { RAW_ARG } from './types'

/* -------------------------------------------------------------------------- */
/*  Param and node shapes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `rest` swallows every remaining token as a space-joined string (used by
 * `render` for its column list and by `append` for free text). Every other type
 * consumes exactly one token.
 */
export type ParamType =
  | 'string'
  | 'number'
  | 'tag'
  | 'path'
  | 'folder'
  | 'field'
  | 'compare-op'
  | 'direction'
  | 'duration'
  | 'glob'
  | 'heading'
  | 'template'
  | 'wire'
  | 'workflow'
  | 'render-style'
  | 'rest'

export interface ParamSpec {
  name: string
  type: ParamType
  required: boolean
  /** Used when the token is absent and `required` is false. */
  default?: ArgValue
}

export type NodeCategory =
  | 'source'
  | 'filter'
  | 'order'
  | 'shape'
  | 'mutate'
  | 'render'
  | 'sink'
  | 'compose'

export interface NodeDef {
  /** Registry key and the verb written in the file. */
  kind: string
  category: NodeCategory
  title: string
  /**
   * What this step DOES, in one plain sentence, addressed to the person writing
   * the workflow. The completion popup and the syntax panel both show it, and it
   * is the only place the language is explained, so a parameter name repeated
   * back ("folder", "tag") is not an answer to "what does this do".
   *
   * REQUIRED, not optional: a node whose docs are a nice-to-have ships without
   * them, and the popup then has a blank pane where the explanation should be.
   * `nodes.test.ts` pins the same rule at runtime for anyone editing this file
   * with the types turned off.
   */
  description: string
  /**
   * A real line that would parse, shown under the description in monospace.
   *
   * Source verbs write the whole statement (`books = tag #book`) because that is
   * how a pipeline opens; every other verb writes the bare step as it would
   * appear after a `|`. `nodes.test.ts` parses every one of them, so an example
   * cannot drift away from the grammar it is meant to teach.
   */
  example: string
  params: ParamSpec[]
  /** Opens a pipeline; may not appear after a `|`. */
  source: boolean
  /** Emits WorkflowOps. Any workflow containing one requires confirmation. */
  mutating: boolean
  /** Ends a pipeline; nothing may follow it. */
  terminal: boolean
  /** Attaches rendered text to the pipeline for a following sink to consume. */
  producesText?: boolean
  /** Uses text from a preceding `render`, falling back to a default rendering. */
  consumesText?: boolean
  /** Reads note bodies, so the engine must load them before running this step. */
  needsBody?: boolean
  /** Cannot be reversed by replaying an inverse op. */
  irreversible?: boolean
}

/* -------------------------------------------------------------------------- */
/*  Comparison operators                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Surface syntax for `where`, mapped to the same semantics the databases
 * feature uses (`FilterOp` in `../databases`). The names are kept aligned on
 * purpose: when the Go engine lands, both features should agree on what
 * "contains" means, and the conformance fixtures cover one vocabulary rather
 * than two. `>=` and `<=` have no `FilterOp` equivalent today, which is a known
 * gap to close when databases grows them.
 */
export const COMPARE_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'matches'] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

export function isCompareOp(value: string): value is CompareOp {
  return (COMPARE_OPS as readonly string[]).includes(value)
}

export const RENDER_STYLES = ['table', 'list', 'count', 'links'] as const
export type RenderStyle = (typeof RENDER_STYLES)[number]

/* -------------------------------------------------------------------------- */
/*  The registry                                                              */
/* -------------------------------------------------------------------------- */

const p = (name: string, type: ParamType, required = true, def?: ArgValue): ParamSpec => ({
  name,
  type,
  required,
  ...(def === undefined ? {} : { default: def })
})

export const NODE_DEFS: readonly NodeDef[] = [
  /* ----- Sources: open a pipeline, produce a NoteSet ----- */
  {
    kind: 'all',
    category: 'source',
    title: 'All notes',
    description:
      'Starts a pipeline with every note in the vault, except the Trash and the Archive. Reach those explicitly with `folder trash` or `folder archive`.',
    example: 'notes = all',
    params: [],
    source: true,
    mutating: false,
    terminal: false
  },
  {
    kind: 'folder',
    category: 'source',
    title: 'Notes in folder',
    description:
      'Starts a pipeline with the notes in a folder, subfolders included. The four system names (inbox, quick, archive, trash) mean those folders wherever the vault keeps them: on a vault whose notes live at the root, `folder inbox` is the vault root.',
    example: 'inbox = folder inbox',
    params: [p('folder', 'folder')],
    source: true,
    mutating: false,
    terminal: false
  },
  {
    kind: 'tag',
    category: 'source',
    title: 'Notes with tag',
    description:
      'Starts a pipeline with the notes carrying a tag. Trashed and archived notes stay out, like `all`.',
    example: 'books = tag #book',
    params: [p('tag', 'tag')],
    source: true,
    mutating: false,
    terminal: false
  },
  {
    kind: 'search',
    category: 'source',
    title: 'Full-text search',
    description:
      'Starts a pipeline with the notes whose title or body contains the text. Reads the whole vault, so it is the slowest way to open one.',
    example: 'hits = search reading list',
    params: [p('query', 'rest')],
    source: true,
    mutating: false,
    terminal: false,
    needsBody: true
  },
  {
    kind: 'current',
    category: 'source',
    title: 'Current note',
    description:
      'Starts a pipeline with the note you have open, and with nothing at all when none is.',
    example: 'here = current',
    params: [],
    source: true,
    mutating: false,
    terminal: false
  },
  {
    kind: 'selection',
    category: 'source',
    title: 'Selected notes',
    description:
      'Starts a pipeline with the notes you have selected in the list, in the order they are shown.',
    example: 'picked = selection',
    params: [],
    source: true,
    mutating: false,
    terminal: false
  },

  /* ----- Filters: NoteSet -> NoteSet ----- */
  {
    kind: 'where',
    category: 'filter',
    title: 'Where field',
    description:
      'Keeps only the notes whose field compares true. Reads frontmatter, plus title, path, folder, created and updated.',
    example: 'where rating >= 4',
    params: [p('field', 'field'), p('op', 'compare-op'), p('value', 'rest')],
    source: false,
    mutating: false,
    terminal: false,
    // Frontmatter is PARSED OUT OF THE BODY, so a field comparison needs the
    // body loaded even though it never looks at prose. Without this the filter
    // silently sees `{}` for every note: `rating >= 4` matches nothing and
    // `rating < 4` matches everything, with no error to explain why. Costly on
    // a large vault, and correctness wins until note metadata carries
    // frontmatter of its own.
    needsBody: true
  },
  {
    kind: 'tagged',
    category: 'filter',
    title: 'Tagged',
    description:
      'Keeps only the notes carrying a tag. Tags nest, so #project also keeps #project/compiler.',
    example: 'tagged #book',
    params: [p('tag', 'tag')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'not-tagged',
    category: 'filter',
    title: 'Not tagged',
    description:
      'Drops the notes carrying a tag and keeps the rest. Nested tags count as carrying it.',
    example: 'not-tagged #someday',
    params: [p('tag', 'tag')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'in',
    category: 'filter',
    title: 'In folder',
    description:
      'Keeps only the notes that live inside a folder, subfolders included. The four system names mean the system folders wherever the vault keeps them, as with `folder`.',
    example: 'in inbox/projects',
    params: [p('folder', 'folder')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'matching',
    category: 'filter',
    title: 'Path matches',
    description:
      'Keeps only the notes whose path matches a pattern, where * stays inside one folder and ** crosses them.',
    example: 'matching inbox/**/*.md',
    params: [p('glob', 'glob')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'contains',
    category: 'filter',
    title: 'Body contains',
    description:
      'Keeps only the notes whose text contains what you wrote, ignoring case. Reads every note on the wire, so narrow the set first.',
    example: 'contains TODO',
    params: [p('text', 'rest')],
    source: false,
    mutating: false,
    terminal: false,
    needsBody: true
  },
  {
    kind: 'since',
    category: 'filter',
    title: 'Updated since',
    description:
      'Keeps only the notes updated within the last stretch of time.',
    example: 'since 7d',
    params: [p('duration', 'duration')],
    source: false,
    mutating: false,
    terminal: false
  },

  /* ----- Order ----- */
  {
    kind: 'sort',
    category: 'order',
    title: 'Sort',
    description:
      'Reorders the notes by a field. Ascending unless you say desc.',
    example: 'sort finished desc',
    params: [p('field', 'field'), p('direction', 'direction', false, 'asc')],
    source: false,
    mutating: false,
    terminal: false,
    // Same reason as `where`: sorting by a frontmatter field needs the body.
    needsBody: true
  },
  {
    kind: 'limit',
    category: 'order',
    title: 'Limit',
    description:
      'Keeps the first few notes and drops the rest, so sort before it or which few you get is arbitrary.',
    example: 'limit 25',
    params: [p('count', 'number')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'dedupe',
    category: 'order',
    title: 'Remove duplicates',
    description:
      'Drops any note that already appeared earlier on the wire, keeping the first of each.',
    example: 'dedupe',
    params: [],
    source: false,
    mutating: false,
    terminal: false
  },

  /* ----- Shape: combine wires ----- */
  {
    kind: 'union',
    category: 'shape',
    title: 'Union with wire',
    description:
      'Adds the notes another wire carries, skipping the ones already here. The wire has to be named on an earlier line.',
    example: 'union areas',
    params: [p('wire', 'wire')],
    source: false,
    mutating: false,
    terminal: false
  },
  {
    kind: 'subtract',
    category: 'shape',
    title: 'Subtract wire',
    description:
      'Drops every note another wire also carries, which is how you say "all of these except those".',
    example: 'subtract recent',
    params: [p('wire', 'wire')],
    source: false,
    mutating: false,
    terminal: false
  },

  /* ----- Mutate: emit ops, one per note on the wire ----- */
  {
    kind: 'set',
    category: 'mutate',
    title: 'Set frontmatter field',
    description:
      'Writes a frontmatter field on every note, replacing whatever it held. {{date}} and any other field expand per note.',
    example: 'set status done',
    params: [p('field', 'field'), p('value', 'rest')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'add-tag',
    category: 'mutate',
    title: 'Add tag',
    description:
      'Adds a tag to every note that does not already carry it, so running the workflow twice adds nothing the second time.',
    example: 'add-tag #triage',
    params: [p('tag', 'tag')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'remove-tag',
    category: 'mutate',
    title: 'Remove tag',
    description:
      'Deletes a tag from the text of every note that carries it. A tag listed in the frontmatter is left alone.',
    example: 'remove-tag #todo',
    params: [p('tag', 'tag')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'move',
    category: 'mutate',
    title: 'Move to folder',
    description:
      'Moves every note into a folder, keeping its filename. This moves the file on disk, and the folder is created if it is missing.',
    example: 'move archive/2026',
    params: [p('folder', 'folder')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'rename',
    category: 'mutate',
    title: 'Rename',
    description:
      'Gives every note a new filename in the folder it already sits in, keeping its extension. {{date}} and any field expand per note.',
    example: 'rename {{date}}-{{title}}',
    params: [p('pattern', 'rest')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'append',
    category: 'mutate',
    title: 'Append text',
    description:
      'Adds a line to the end of every note, one blank line clear of what is there. It appends again on every run, so it stacks up.',
    example: 'append Reviewed {{date}}',
    params: [p('text', 'rest')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'prepend',
    category: 'mutate',
    title: 'Prepend text',
    description:
      'Adds a line at the top of every note, below its frontmatter rather than above it. It prepends again on every run.',
    example: 'prepend > Reviewed {{date}}',
    params: [p('text', 'rest')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'apply-template',
    category: 'mutate',
    title: 'Apply template',
    description:
      'Puts a template at the top of every note, below its frontmatter, without removing anything already written there.',
    example: 'apply-template book-review',
    params: [p('template', 'template')],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'archive',
    category: 'mutate',
    title: 'Archive',
    description:
      'Moves every note into the archive folder. The file is kept, its path is not, and Undo puts it back.',
    example: 'archive',
    params: [],
    source: false,
    mutating: true,
    terminal: false
  },
  {
    kind: 'trash',
    category: 'mutate',
    title: 'Move to trash',
    description:
      'Moves every note into the trash folder. Nothing is erased, but the notes leave the vault you browse.',
    example: 'trash',
    params: [],
    source: false,
    mutating: true,
    terminal: false
  },

  /* ----- Render: NoteSet -> text, consumed by the following sink ----- */
  {
    kind: 'render',
    category: 'render',
    title: 'Render',
    description:
      'Turns the notes into text for the sink that follows it. Does not change the notes themselves.',
    example: 'render table title, rating',
    params: [p('style', 'render-style'), p('columns', 'rest', false, '')],
    source: false,
    mutating: false,
    terminal: false,
    producesText: true
  },

  /* ----- Sinks: terminate a pipeline ----- */
  {
    kind: 'write',
    category: 'sink',
    title: 'Write to note',
    description:
      'Replaces the whole of one note with the rendered text, so point it at a note this workflow owns rather than one you write in.',
    example: 'write "inbox/Reading Log.md"',
    params: [p('path', 'path')],
    source: false,
    mutating: true,
    terminal: true,
    consumesText: true
  },
  {
    kind: 'write-section',
    category: 'sink',
    title: 'Replace section in note',
    description:
      'Replaces what sits under one heading and leaves the rest of the note alone, adding the heading at the end when it is not there yet.',
    example: 'write-section "inbox/Reading Log.md" "Finished"',
    params: [p('path', 'path'), p('heading', 'heading')],
    source: false,
    mutating: true,
    terminal: true,
    consumesText: true
  },
  {
    kind: 'create-each',
    category: 'sink',
    title: 'Create a note per item',
    description:
      'Creates one empty note per note on the wire, at a path you spell out with {{title}} and the like. It does not copy any rendered text in.',
    example: 'create-each "inbox/{{title}} - notes.md"',
    params: [p('pattern', 'rest')],
    source: false,
    mutating: true,
    terminal: true
  },
  {
    kind: 'notify',
    category: 'sink',
    title: 'Show a notification',
    description:
      'Shows a notification, with {{count}} standing for how many notes reached it. Once it has been shown there is nothing to undo.',
    example: 'notify {{count}} notes are waiting in the inbox',
    params: [p('message', 'rest')],
    source: false,
    mutating: true,
    terminal: true,
    consumesText: true,
    irreversible: true
  },
  {
    kind: 'clipboard',
    category: 'sink',
    title: 'Copy to clipboard',
    description:
      'Puts the rendered text on the clipboard, over whatever was there. Undo cannot bring the old clipboard back.',
    example: 'clipboard',
    params: [],
    source: false,
    mutating: true,
    terminal: true,
    consumesText: true,
    irreversible: true
  },

  /* ----- Compose ----- */
  {
    kind: 'call',
    category: 'compose',
    title: 'Call another workflow',
    description:
      'Runs another workflow as part of this one and folds its changes into the same run. It starts from its own sources, not from this wire.',
    example: 'call archive-done',
    params: [p('workflow', 'workflow')],
    source: false,
    mutating: true,
    terminal: false
  }
] as const

const BY_KIND = new Map<string, NodeDef>(NODE_DEFS.map((def) => [def.kind, def]))

export function nodeDef(kind: string): NodeDef | null {
  return BY_KIND.get(kind) ?? null
}

export function nodeKinds(): string[] {
  return NODE_DEFS.map((def) => def.kind)
}

/** True when the workflow writes, i.e. running it needs a confirmation step. */
export function stepIsMutating(kind: string): boolean {
  return nodeDef(kind)?.mutating ?? false
}

/* -------------------------------------------------------------------------- */
/*  Token binding                                                             */
/* -------------------------------------------------------------------------- */

export interface BindResult {
  args: Record<string, ArgValue>
  diagnostics: Diagnostic[]
}

const DURATION_RE = /^\d+[dhwm]$/
// The same shape every vault extractor recognises (#205): a letter first, in
// any script. An ASCII-only `\w` here would refuse the `#café` the vault
// itself indexes, and accept the digit-leading `#2024` that `INLINE_TAG_RE`
// in apply-ops would then silently decline to write.
const TAG_RE = /^#?\p{L}[\p{L}\d_/-]*$/u
/** Everything `TAG_RE` would not accept inside a tag. Same alphabet, same flag. */
const TAG_CHARS_RE = /[^\p{L}\d_/-]/gu

/**
 * Drop the characters a tag cannot hold, keeping the ones `TAG_RE` accepts.
 *
 * Exported because the canvas inspector sanitizes a tag AS IT IS TYPED while
 * this module REJECTS a finished token, and those two jobs still have to agree
 * on one alphabet. They did not. The inspector kept its own copy written with
 * `\w`, which is ASCII, so it deleted every Cyrillic character the moment it
 * was typed while `bindParams` right here would have accepted the tag without
 * complaint (#532). That is precisely the failure the comment above `TAG_RE`
 * warns about, made by the copy rather than the original, so the alphabet now
 * lives in one place and is imported.
 *
 * Leading `#` goes because the stored argument never carries one. Note this
 * does NOT enforce the letter-first rule: a half-typed tag is allowed to be
 * briefly invalid, since refusing a keystroke reads as a broken field.
 */
export function sanitizeTagChars(input: string): string {
  return input.replace(/^#+/, '').replace(TAG_CHARS_RE, '')
}

/**
 * Bind raw tokens to a node's declared params, coercing and validating each.
 *
 * Always returns an `args` object (with whatever bound successfully) alongside
 * diagnostics, rather than throwing. A workflow with one bad step should still
 * render on the canvas with that step marked red, which is only possible if
 * partial results survive.
 */
export function bindParams(def: NodeDef, tokens: string[], line: number): BindResult {
  const args: Record<string, ArgValue> = {}
  const diagnostics: Diagnostic[] = []
  let index = 0

  for (const spec of def.params) {
    if (spec.type === 'rest') {
      const rest = tokens.slice(index).join(' ')
      index = tokens.length
      if (!rest) {
        if (spec.required) {
          diagnostics.push({
            severity: 'error',
            message: `\`${def.kind}\` needs ${spec.name}`,
            line
          })
        } else if (spec.default !== undefined) {
          args[spec.name] = spec.default
        }
        continue
      }
      args[spec.name] = unquote(rest)
      continue
    }

    const token = tokens[index]
    if (token === undefined) {
      if (spec.required) {
        diagnostics.push({
          severity: 'error',
          message: `\`${def.kind}\` needs ${spec.name}`,
          line
        })
      } else if (spec.default !== undefined) {
        args[spec.name] = spec.default
      }
      continue
    }
    index += 1

    const bound = coerce(spec, token, def.kind, line)
    if (bound.diagnostic) diagnostics.push(bound.diagnostic)
    if (bound.value !== undefined) {
      args[spec.name] = bound.value
    } else {
      // Park the failed token and everything after it, the same way an unknown
      // verb parks its arguments: the author's text must survive a save even
      // while the step is red. Binding also STOPS here, because a later token
      // sliding into this param's position is how `where rating == 4` used to
      // degrade into `where rating 4` over two saves.
      args[RAW_ARG] = tokens.slice(index - 1).join(' ')
      return { args, diagnostics }
    }
  }

  if (index < tokens.length) {
    diagnostics.push({
      severity: 'warning',
      message: `\`${def.kind}\` ignored extra input: ${tokens.slice(index).join(' ')}`,
      line
    })
  }

  return { args, diagnostics }
}

function coerce(
  spec: ParamSpec,
  token: string,
  kind: string,
  line: number
): { value?: ArgValue; diagnostic?: Diagnostic } {
  const bad = (message: string): { diagnostic: Diagnostic } => ({
    diagnostic: { severity: 'error', message, line }
  })

  switch (spec.type) {
    case 'number': {
      const n = Number(token)
      if (!Number.isFinite(n)) return bad(`\`${kind}\` expects a number, got \`${token}\``)
      return { value: n }
    }
    case 'tag': {
      if (!TAG_RE.test(token)) return bad(`\`${token}\` is not a valid tag`)
      return { value: token.replace(/^#/, '') }
    }
    case 'compare-op': {
      if (!isCompareOp(token)) {
        return bad(`\`${token}\` is not a comparison (${COMPARE_OPS.join(' ')})`)
      }
      return { value: token }
    }
    case 'direction': {
      const dir = token.toLowerCase()
      if (dir !== 'asc' && dir !== 'desc') return bad(`sort direction must be asc or desc`)
      return { value: dir }
    }
    case 'duration': {
      if (!DURATION_RE.test(token)) {
        return bad(`\`${token}\` is not a duration (e.g. 7d, 12h, 2w)`)
      }
      return { value: token }
    }
    case 'render-style': {
      if (!(RENDER_STYLES as readonly string[]).includes(token)) {
        return bad(`render style must be one of ${RENDER_STYLES.join(', ')}`)
      }
      return { value: token }
    }
    default:
      return { value: unquote(token) }
  }
}

/** Strip one layer of matching quotes, so `"Reading Log.md"` binds as a path. */
export function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
