/**
 * Tools for the jobs an assistant is asked to do most and could only do badly
 * before: changing a task without hand-editing its line, finding the daily note
 * without guessing a path, and working on part of a long note without reading or
 * rewriting all of it. Each is composed from the backend's own reads and writes,
 * so a scope and a server apply to them as to any other tool. The Go `zn mcp`
 * has the same tools in internal/mcp/worktools.go.
 */

import {
  setTaskFileCancelled,
  setTaskFileInProgress,
  setTaskFileStatus,
  updateFrontmatterFields
} from '@shared/frontmatter'
import type { NoteMeta as AppNoteMeta, VaultSettings } from '@shared/ipc'
import { goQuote } from '@shared/mcp-scope'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { findTemplate, mergeTemplates, parseCustomTemplate } from '@shared/template-files'
import { completeRecurringTaskAtLine } from '@shared/task-recurrence'
import { toIsoDateLocal } from '@shared/tasks'
import {
  setTaskCancelledAtIndex,
  setTaskCheckedAtIndex,
  setTaskDueAtIndex,
  setTaskFieldAtIndex,
  setTaskInProgressAtIndex,
  setTaskPriorityAtIndex,
  setTaskTextAtIndex,
  setTaskWaitingAtIndex
} from '@shared/tasklists'
import {
  dailyNoteLocationForDate,
  findDailyNoteForDate,
  findMonthlyNoteForDate,
  findWeeklyNoteForDate,
  monthlyNoteLocationForDate,
  noteTitleForDate,
  normalizeVaultSettings,
  vaultRelativeFolderPath,
  weeklyNoteLocationForDate
} from '@renderer/lib/vault-layout'
import { renderTemplate } from '@renderer/lib/template-render'
import type { VaultBackend } from '../cli/backend.js'
import { ScopedBackend } from './scoped-backend.js'
import { editSectionInBody, findSection, noteSections, sectionBody, usesCrlf } from './note-sections.js'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type ToolDef
} from './tool-support.js'
import { splitTaskId, type NoteMeta, type VaultTask } from './vault-ops.js'

/* ---------- update_task ------------------------------------------------ */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` that names a real day. */
function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

interface UpdateTaskInput {
  id: string
  due?: string
  priority?: string
  waiting?: boolean
  state?: string
  status?: string
  text?: string
  expectedText?: string
}

/** What the task parser reads as an `@key:value` value. */
const TASK_FIELD_VALUE_RE = /^[\p{L}\d][\p{L}\d/_-]*$/u

function validateUpdateTask(input: UpdateTaskInput): void {
  const { due, priority, waiting, state, status, text } = input
  if (
    due === undefined &&
    priority === undefined &&
    waiting === undefined &&
    state === undefined &&
    status === undefined &&
    text === undefined
  ) {
    throw new Error('update_task needs at least one of due, priority, waiting, state, status, text')
  }
  if (due && !isValidIsoDate(due)) throw new Error('due must be YYYY-MM-DD, or empty to clear it')
  if (priority !== undefined && !['', 'high', 'med', 'low'].includes(priority)) {
    throw new Error('priority must be high, med or low, or empty to clear it')
  }
  if (state !== undefined && !['open', 'done', 'in-progress', 'cancelled'].includes(state)) {
    throw new Error('state must be open, done, in-progress or cancelled')
  }
  if (status && !TASK_FIELD_VALUE_RE.test(status)) {
    throw new Error('status must be one word (letters, digits, /, _ or -), or empty to clear it')
  }
  if (text !== undefined && (!text.trim() || /[\r\n]/.test(text))) {
    throw new Error('text must be one line, and not empty')
  }
}

async function findTask(
  backend: VaultBackend,
  rel: string,
  index: string
): Promise<VaultTask | null> {
  const tasks = await backend.scanTasksForPath(rel, { includeExcluded: true })
  return tasks.find((task) => task.id.endsWith(`#${index}`)) ?? null
}

/**
 * The edit is applied to the task's line on its own: list_tasks numbers tasks by
 * the scan that produced the id (a server's own parser, or this engine's), and
 * the line setters count fenced code their own way. An id is a position in the
 * note, so an edit since the scan can put another task there; `expectedText`
 * catches that first. Every other line keeps its bytes, line ending included.
 *
 * `insertedTasks` is how far the task moved: finishing a recurring one writes its
 * next occurrence above it, as toggle_task does.
 */
function updateTaskLine(
  body: string,
  task: VaultTask,
  input: UpdateTaskInput
): { body: string; insertedTasks: number } | null {
  if (task.forwarded && input.state !== undefined) {
    throw new Error('That task was forwarded to another note; change it there.')
  }
  const lines = body.split('\n')
  const at = task.lineNumber
  const tidy = (line: string): string => line.replace(/\s+$/, '')
  if (at < 0 || at >= lines.length || tidy(lines[at]) !== tidy(task.rawText)) return null
  const ending = lines[at].endsWith('\r') ? '\r' : ''
  let line = ending ? lines[at].slice(0, -1) : lines[at]
  if (input.text !== undefined) line = setTaskTextAtIndex(line, 0, input.text)
  if (input.due !== undefined) line = setTaskDueAtIndex(line, 0, input.due || null)
  if (input.priority !== undefined) {
    line = setTaskPriorityAtIndex(line, 0, (input.priority || null) as 'high' | 'med' | 'low' | null)
  }
  if (input.waiting !== undefined) line = setTaskWaitingAtIndex(line, 0, input.waiting)
  if (input.status !== undefined) line = setTaskFieldAtIndex(line, 0, 'status', input.status || null)
  if (input.state === 'done') {
    lines[at] = line + ending
    const recurring = completeRecurringTaskAtLine(lines.join('\n'), at, {
      today: toIsoDateLocal(new Date())
    })
    if (recurring) return { body: recurring.body, insertedTasks: recurring.insertedTasks }
  }
  switch (input.state) {
    case 'open':
      line = setTaskInProgressAtIndex(setTaskCheckedAtIndex(line, 0, false), 0, false)
      break
    case 'done':
      line = setTaskCheckedAtIndex(line, 0, true)
      break
    case 'in-progress':
      line = setTaskInProgressAtIndex(line, 0, true)
      break
    case 'cancelled':
      line = setTaskCancelledAtIndex(line, 0, true)
      break
  }
  lines[at] = line + ending
  return { body: lines.join('\n'), insertedTasks: 0 }
}

/** TaskNotes' priority vocabulary, which a task note's frontmatter speaks. */
const TASK_FILE_PRIORITY: Record<string, string | null> = {
  high: 'high',
  med: 'normal',
  low: 'low',
  '': null
}

/** A whole-note task, whose fields are its frontmatter. */
function updateFileTask(start: string, task: VaultTask, input: UpdateTaskInput): string {
  if (input.text !== undefined) {
    throw new Error('A task note has no line of text to change; use rename_note for its title.')
  }
  // State, status and waiting are all its one `status:` field.
  const claims = [input.state, input.status, input.waiting].filter((value) => value !== undefined)
  if (claims.length > 1) {
    throw new Error('A task note keeps state, status and waiting in its one frontmatter status: pass only one of them.')
  }
  const crlf = usesCrlf(start)
  let body = crlf ? start.replace(/\r\n/g, '\n') : start
  const today = toIsoDateLocal(new Date())
  switch (input.state) {
    case 'open':
      body = setTaskFileStatus(body, false, today)
      break
    case 'done':
      body = setTaskFileStatus(body, true, today)
      break
    case 'in-progress':
      body = setTaskFileInProgress(body, true)
      break
    case 'cancelled':
      body = setTaskFileCancelled(body, true)
      break
  }
  const field = (key: string, value: string | null): void => {
    body = updateFrontmatterFields(body, { [key]: value })
  }
  if (input.due !== undefined) field('due', input.due || null)
  if (input.priority !== undefined) field('priority', TASK_FILE_PRIORITY[input.priority])
  if (input.waiting === true) {
    body = updateFrontmatterFields(body, { status: 'waiting', completedDate: null })
  } else if (input.waiting === false && task.waiting) {
    field('status', 'open')
  }
  if (input.status !== undefined) {
    if (input.status.toLowerCase() === 'done') {
      body = setTaskFileStatus(body, true, today)
    } else {
      body = updateFrontmatterFields(body, { status: input.status || null, completedDate: null })
    }
  }
  return crlf ? body.replace(/\n/g, '\r\n') : body
}

/** Edits one task through the backend's own read and write, so it takes a scope
 *  and a server the way any other edit does. The task as it now reads, or null
 *  when the id no longer matches one. */
async function updateTask(backend: VaultBackend, input: UpdateTaskInput): Promise<VaultTask | null> {
  validateUpdateTask(input)
  const { rel, indexStr } = splitTaskId(input.id)
  const task = await findTask(backend, rel, indexStr)
  if (!task) return null
  if (input.expectedText !== undefined && task.content.trim() !== input.expectedText.trim()) {
    throw new Error(
      `Task ${input.id} now reads ${goQuote(task.content)}, not ${goQuote(input.expectedText)}: the note changed. Run list_tasks again for its id.`
    )
  }
  const note = await backend.readNote(task.sourcePath)
  let next: string
  let index = indexStr
  if (indexStr === 'task') {
    next = updateFileTask(note.body, task, input)
  } else {
    const edited = updateTaskLine(note.body, task, input)
    if (edited === null) return null
    next = edited.body
    index = String(Number(indexStr) + edited.insertedTasks)
  }
  if (next !== note.body) await backend.writeNote(task.sourcePath, next)
  return await findTask(backend, task.sourcePath, index)
}

/* ---------- daily_note ------------------------------------------------- */

type PeriodicKind = 'daily' | 'weekly' | 'monthly'

/** Reads `today`, `yesterday`, `tomorrow` or YYYY-MM-DD, in the time zone of the
 *  machine running the server, as the app does. */
function resolveDate(raw: string, now: Date): Date {
  const shifted = (days: number): Date => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    return date
  }
  switch (raw.trim().toLowerCase()) {
    case '':
    case 'today':
      return now
    case 'yesterday':
      return shifted(-1)
    case 'tomorrow':
      return shifted(1)
  }
  if (!isValidIsoDate(raw)) throw new Error('date must be today, yesterday, tomorrow or YYYY-MM-DD')
  const [year, month, day] = raw.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** What the app starts the note with: the vault's template for this kind when
 *  the client may read it, else a heading. The app's rollover of unfinished
 *  tasks is left out: moving a user's tasks is not what finding a note should
 *  do. A scope that hides part of the vault gets the heading, because a template
 *  can hold anything. */
async function periodicBody(
  backend: VaultBackend,
  templateId: string | undefined,
  title: string,
  date: Date
): Promise<string> {
  if (templateId) {
    try {
      const custom = (await backend.listTemplates()).map((file) =>
        parseCustomTemplate(file.raw, file.sourcePath)
      )
      const template = findTemplate(mergeTemplates(BUILTIN_TEMPLATES, custom), templateId)
      if (template) return renderTemplate(template.body, { title, now: date }).body
    } catch {
      // A template that cannot be read leaves the heading.
    }
  }
  return `# ${title}\n\n`
}

async function dailyNote(
  backend: VaultBackend,
  kind: PeriodicKind,
  date: Date
): Promise<Record<string, unknown>> {
  const [raw, description, notes] = await Promise.all([
    backend.vaultSettings(),
    backend.describe(),
    backend.listNotes()
  ])
  const settings = normalizeVaultSettings({
    ...raw,
    primaryNotesLocation: description.primaryNotesLocation
  } as unknown as VaultSettings)
  const plan = {
    daily: { periodic: settings.dailyNotes, locate: dailyNoteLocationForDate },
    weekly: { periodic: settings.weeklyNotes, locate: weeklyNoteLocationForDate },
    monthly: { periodic: settings.monthlyNotes, locate: monthlyNoteLocationForDate }
  }[kind]
  const location = plan.locate(date, settings)
  const dir = vaultRelativeFolderPath('inbox', location.subpath, settings)
  const rel = dir ? `${dir}/${location.title}.md` : `${location.title}.md`
  const result = {
    kind,
    date: noteTitleForDate(date),
    enabled: !!plan.periodic.enabled
  }
  let found: NoteMeta | null = notes.find((note) => note.path === rel) ?? null
  // A note made under an older naming pattern still counts, whether or not the
  // user has this kind of note turned on.
  if (!found) {
    const lookup: Pick<VaultSettings, 'dailyNotes' | 'weeklyNotes' | 'monthlyNotes'> = {
      dailyNotes: { ...settings.dailyNotes, enabled: kind === 'daily' },
      weeklyNotes: { ...settings.weeklyNotes, enabled: kind === 'weekly' },
      monthlyNotes: { ...settings.monthlyNotes, enabled: kind === 'monthly' }
    }
    const find = {
      daily: findDailyNoteForDate,
      weekly: findWeeklyNoteForDate,
      monthly: findMonthlyNoteForDate
    }[kind]
    found = find(
      notes as unknown as AppNoteMeta[],
      { ...settings, ...lookup },
      date
    ) as unknown as NoteMeta | null
  }
  if (found) return { ...result, exists: true, path: found.path, note: found }
  // A folder this client cannot see stays unnamed, here as anywhere.
  const named = !(backend instanceof ScopedBackend) || (await backend.sharesPath(rel))
  return {
    ...result,
    exists: false,
    createWith: {
      folder: 'inbox',
      ...(named ? { subpath: location.subpath } : {}),
      title: location.title,
      body: await periodicBody(backend, plan.periodic.templateId, location.title, date)
    }
  }
}

/* ---------- Tools ------------------------------------------------------ */

export const WORK_TOOLS: ToolDef[] = [
  {
    schema: {
      name: 'update_task',
      description:
        'Change a task by its id from list_tasks: due date, priority, @waiting, state, status (Kanban column) or text. Only what you pass changes; pass "" to clear due, priority or status. The task stays where it is, and the rest of the note keeps its bytes, except that state done on a task with `@repeat:` writes its next occurrence above it, as toggle_task does, and returns the finished one. An id counts the task\'s position in its note, so pass expectedText to be told when an edit moved it. On a task note, state, status and waiting are one field: pass only one. Returns the updated task, or null if the id no longer matches one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from list_tasks: sourcePath#taskIndex.' },
          due: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' },
          priority: {
            type: 'string',
            enum: ['high', 'med', 'low', ''],
            description: '"" clears it.'
          },
          waiting: { type: 'boolean' },
          state: { type: 'string', enum: ['open', 'done', 'in-progress', 'cancelled'] },
          status: {
            type: 'string',
            description: 'The column a Kanban board groups it under, one word, or "" to clear.'
          },
          text: {
            type: 'string',
            description:
              'Replaces everything after the checkbox, one line, due and priority tokens included. Not for a task note: use rename_note.'
          },
          expectedText: {
            type: 'string',
            description:
              "The task's content from list_tasks. If it no longer reads this, nothing changes and the call fails."
          }
        },
        required: ['id']
      }
    },
    handler: async (args, backend) =>
      await updateTask(backend, {
        id: requireString(args, 'id'),
        expectedText: optionalString(args, 'expectedText'),
        due: optionalString(args, 'due'),
        priority: optionalString(args, 'priority'),
        waiting: optionalBoolean(args, 'waiting'),
        state: optionalString(args, 'state'),
        status: optionalString(args, 'status'),
        text: optionalString(args, 'text')
      })
  },
  {
    schema: {
      name: 'daily_note',
      description:
        "Find the daily note for a date (or the weekly or monthly note holding it) under this vault's own folder and naming settings, which you cannot guess. Changes nothing. If `exists`, use its `path`. If not, pass `createWith` to create_note as it is, which starts the note from the vault's template, and use the `path` create_note returns. `enabled: false` means the user has this kind of note turned off, so ask before creating one.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Default: daily.'
          },
          date: {
            type: 'string',
            description: 'today, yesterday, tomorrow or YYYY-MM-DD. Default: today.'
          }
        }
      }
    },
    handler: async (args, backend) => {
      const kindName = optionalString(args, 'kind') ?? ''
      if (!['', 'daily', 'weekly', 'monthly'].includes(kindName)) {
        throw new Error('kind must be daily, weekly or monthly')
      }
      const date = resolveDate(optionalString(args, 'date') ?? '', new Date())
      return await dailyNote(backend, (kindName || 'daily') as PeriodicKind, date)
    }
  },
  {
    schema: {
      name: 'note_sections',
      description:
        'Read a note by its headings. Without `heading`: its outline, every heading with its level and lines, for long notes and for finding where to edit. With `heading`: the text under that heading, subheadings included, so you need not read the whole note. Lines are zero-based, as in insert_at_line; endLineNumber is exclusive.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          heading: { type: 'string', description: 'Heading text, any case, without the #s.' },
          lineNumber: {
            type: 'number',
            description: "The heading's line, from the outline, when its text appears more than once."
          }
        },
        required: ['path']
      }
    },
    handler: async (args, backend) => {
      const rel = requireString(args, 'path')
      const heading = optionalString(args, 'heading') ?? ''
      const line = optionalNumber(args, 'lineNumber')
      const note = await backend.readNote(rel)
      if (!heading.trim()) return { path: note.path, headings: noteSections(note.body) }
      const section = findSection(note.body, heading, line === undefined ? undefined : Math.trunc(line))
      return {
        path: note.path,
        heading: section.text,
        level: section.level,
        lineNumber: section.lineNumber,
        endLineNumber: section.endLineNumber,
        body: sectionBody(note.body, section)
      }
    }
  },
  {
    schema: {
      name: 'edit_section',
      description:
        'Edit the part of a note under one heading: `append` (the usual choice, such as a new item under Action Items; it goes above any subheading), `prepend`, or `replace`, which rewrites everything under the heading, subheadings included. The heading and the rest of the note keep their bytes. Fails with the note\'s headings if there is no such heading.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          heading: { type: 'string', description: 'Heading text, any case, without the #s.' },
          mode: { type: 'string', enum: ['append', 'prepend', 'replace'] },
          text: {
            type: 'string',
            description: 'Markdown. Empty only with replace, to clear the section.'
          },
          lineNumber: {
            type: 'number',
            description:
              "The heading's line, from note_sections, when its text appears more than once."
          }
        },
        required: ['path', 'heading', 'mode', 'text']
      }
    },
    handler: async (args, backend) => {
      const rel = requireString(args, 'path')
      const heading = requireString(args, 'heading')
      const mode = requireString(args, 'mode')
      const text = args['text']
      if (typeof text !== 'string') throw new Error('text must be a string')
      if (mode === 'append' || mode === 'prepend') {
        if (!text.trim()) throw new Error('text is empty; only replace can clear a section')
      } else if (mode !== 'replace') {
        throw new Error('mode must be append, prepend or replace')
      }
      const line = optionalNumber(args, 'lineNumber')
      const note = await backend.readNote(rel)
      const section = findSection(note.body, heading, line === undefined ? undefined : Math.trunc(line))
      return await backend.writeNote(
        note.path,
        editSectionInBody(note.body, section, mode as 'append' | 'prepend' | 'replace', text)
      )
    }
  }
]
