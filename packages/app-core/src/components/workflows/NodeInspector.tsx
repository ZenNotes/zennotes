// The inspector: one typed control per declared parameter of the selected step.
//
// This is the half of "the canvas is the editor" that the picker cannot do. A
// step is only as useful as its arguments, and a raw text box asks the author to
// remember a vocabulary the app already knows: which tags exist, which fields
// anything has ever been written to, which wires this workflow defines, which
// comparisons `where` accepts. So every `ParamSpec` gets the narrowest control
// its type allows and a plain text box is the LAST resort, not the default.
//
// Two rules keep the file honest while a control is being typed into:
//
//   1. Only values that survive `serialize` -> `parse` are pushed. A half-typed
//      duration (`7`) or an empty number would be dropped by the binder, the
//      argument would vanish from the file, and the control would clear itself
//      under the user's hands. Those keep their local text and leave the stored
//      value alone until they are valid again.
//   2. Nothing is ever cleared to "absent". Positional arguments mean a missing
//      middle one shifts every argument after it, so emptying a required param
//      writes `""` (which round-trips) and emptying an optional one writes its
//      declared default (which the serializer omits). The inspector then MARKS
//      the empty required ones, which is the honest way to show a half-built
//      step.

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { COMPARE_OPS, RENDER_STYLES, nodeDef, sanitizeTagChars } from '@shared/workflows/nodes'
import type { NodeDef, ParamSpec } from '@shared/workflows/nodes'
import { RAW_ARG } from '@shared/workflows/parse'
import type { ArgValue, WorkflowStatement, WorkflowStep } from '@shared/workflows/types'
import { Button, IconButton } from '../ui/Button'
import { CloseIcon, PlusIcon, TrashIcon } from '../icons'
import { CATEGORY_CHIP } from './node-presentation'

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What this vault and this workflow can offer a combobox.
 *
 * Passed in rather than read from the store here, because two of the six are
 * not store facts at all: `wires` comes from the workflow being edited and
 * `fields` from the notes the plan actually touched. The inspector renders a
 * vocabulary; it does not decide what is in it.
 */
export interface InspectorVocabulary {
  tags: readonly string[]
  fields: readonly string[]
  paths: readonly string[]
  folders: readonly ComboboxOption[]
  wires: readonly string[]
  workflows: readonly string[]
}

/**
 * An entry a combobox can offer: the value the argument takes, and a hint
 * shown beside it when the value alone does not say what it means. `inbox`
 * reads as "Vault root" on a vault whose notes live there, which is the one
 * folder a list of directories could never carry (#840). Typing matches the
 * hint too, so "root" finds it.
 */
export interface ComboboxOption {
  value: string
  hint?: string
}

/**
 * Fields every note has, whether or not anyone wrote frontmatter.
 *
 * Mirrors the `case` list in the engine's field lookup. Offered ahead of the
 * frontmatter names because they are the ones that always work: a vault where
 * nobody has written a `rating:` yet still sorts by `updated`.
 */
const BUILTIN_FIELDS: readonly string[] = ['title', 'path', 'folder', 'created', 'updated']

/** Enough options to recognize what exists, not a whole vault in a dropdown. */
const OPTION_LIMIT = 60

function optionsFor(
  all: readonly (string | ComboboxOption)[],
  text: string
): ComboboxOption[] {
  const needle = text.trim().toLowerCase()
  const out: ComboboxOption[] = []
  for (const entry of all) {
    const option = typeof entry === 'string' ? { value: entry } : entry
    if (
      needle !== '' &&
      !option.value.toLowerCase().includes(needle) &&
      !(option.hint ?? '').toLowerCase().includes(needle)
    ) {
      continue
    }
    out.push(option)
    if (out.length >= OPTION_LIMIT) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Values                                                                    */
/* -------------------------------------------------------------------------- */

// `DURATION_RE` is a copy of a private one in `@shared/workflows/nodes`,
// duplicated rather than exported because what it expresses here is different:
// the binder uses it to REJECT a token, and the inspector uses it to stop an
// invalid value being written at all, so the argument never disappears mid-type.
//
// The tag alphabet used to be copied the same way and drifted, which is what
// #532 was: this file's copy was written with `\w` (ASCII), so it deleted every
// Cyrillic character as it was typed while the binder accepted the same tag
// happily. Sanitizing and rejecting are still different jobs, but they have to
// share one alphabet, so that one is imported now.
const DURATION_RE = /^\d+[dhwm]$/

/** Wire names the grammar accepts. Mirrors `NAME_RE` in the parser. */
const WIRE_NAME_RE = /^[A-Za-z_][\w-]*$/

function displayValue(value: ArgValue | undefined): string {
  return value === undefined ? '' : String(value)
}

const INPUT_CLASS =
  'w-full rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs text-ink-900 outline-none focus-visible:ring-1 focus-visible:ring-accent/50'

const MISSING_CLASS = 'border-danger/70 bg-danger/5'

/* -------------------------------------------------------------------------- */
/*  One parameter                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A text input with a suggestion list, themed with the app's own tokens.
 *
 * This used to be `<input list>` + `<datalist>`. A datalist popup is drawn by
 * the browser and the OS, not by the page, so no CSS reaches it: on a dark theme
 * it renders as a white box with black text sitting on top of the inspector.
 * The only fix is to stop asking the platform to draw it. Suggestions are a hint
 * rather than a constraint, so typing a value the list does not contain stays
 * allowed, exactly as the datalist behaved.
 */
function ThemedCombobox({
  value,
  options,
  disabled,
  label,
  placeholder,
  invalid,
  onChange
}: {
  value: string
  options: readonly ComboboxOption[]
  disabled: boolean
  label: string
  placeholder?: string
  invalid: boolean
  onChange: (next: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // Close when focus or a click leaves the whole control. Tracked on the
  // wrapper rather than the input so clicking an option does not close the list
  // before the click lands.
  useEffect(() => {
    if (!open) return
    const onDocPointerDown = (event: MouseEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [open])

  const visible = options.slice(0, 8)
  const active = Math.min(cursor, Math.max(0, visible.length - 1))

  const commit = (next: string): void => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open && visible.length > 0}
        role="combobox"
        aria-controls={`${label}-listbox`}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value)
          setCursor(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (!open || visible.length === 0) {
            if (event.key === 'ArrowDown') setOpen(true)
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setCursor((c) => (c + 1) % visible.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setCursor((c) => (c - 1 + visible.length) % visible.length)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            commit(visible[active].value)
          } else if (event.key === 'Escape') {
            // Swallowed so the inspector stays open: Escape here means "I am
            // done with this list", not "leave the workflow".
            event.stopPropagation()
            setOpen(false)
          }
        }}
        className={`${INPUT_CLASS} ${invalid ? MISSING_CLASS : ''}`}
      />
      {open && visible.length > 0 && (
        <ul
          id={`${label}-listbox`}
          role="listbox"
          className="absolute left-0 right-0 z-dropdown mt-1 max-h-48 overflow-auto rounded-md border border-paper-300 bg-paper-100 py-1 shadow-float"
        >
          {visible.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                // mousedown, not click: the input's blur would otherwise close
                // the list before a click could register.
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit(option.value)
                }}
                onMouseEnter={() => setCursor(index)}
                className={`block w-full px-2 py-1 text-left text-xs ${
                  index === active ? 'bg-paper-300/70 text-ink-900' : 'text-ink-700'
                }`}
              >
                {option.value}
                {option.hint !== undefined && (
                  <span className="ml-2 text-ink-500">{option.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ParamControl({
  spec,
  value,
  nodeKey,
  vocabulary,
  disabled,
  onChange
}: {
  spec: ParamSpec
  value: ArgValue | undefined
  /** Identity of the step being inspected, so the local text re-seeds on a move. */
  nodeKey: string
  vocabulary: InspectorVocabulary
  disabled: boolean
  onChange: (value: ArgValue) => void
}): JSX.Element {
  const stored = displayValue(value)
  const [text, setText] = useState(stored)

  // Re-seed from the file whenever the step changes or the stored value moves
  // underneath us (a text edit, an undo). A value we just pushed comes back
  // identical, so this is a no-op for our own echo and the caret stays put.
  useEffect(() => {
    setText(stored)
  }, [nodeKey, stored])

  const missing = spec.required && text.trim() === ''

  const push = (next: string): void => {
    switch (spec.type) {
      case 'tag': {
        // Sanitized rather than rejected: a space in a tag is a typo, not an
        // intention, and silently refusing the keystroke reads as a broken
        // field. `bindParams` strips the `#`, so the stored value never has one.
        const clean = sanitizeTagChars(next)
        setText(clean)
        onChange(clean)
        return
      }
      case 'number': {
        setText(next)
        // An empty box is a number being retyped, not a number being deleted.
        if (next.trim() === '') return
        const parsed = Number(next)
        if (Number.isFinite(parsed)) onChange(parsed)
        return
      }
      case 'duration': {
        setText(next)
        if (DURATION_RE.test(next)) onChange(next)
        return
      }
      default:
        setText(next)
        onChange(next)
    }
  }

  const select = (options: readonly string[]): JSX.Element => {
    // A value the vocabulary does not contain is still shown: a wire that was
    // renamed elsewhere must not silently become a different wire because the
    // select had nowhere to put it.
    const all = options.includes(text) || text === '' ? options : [text, ...options]
    return (
      <select
        value={text}
        disabled={disabled}
        aria-label={spec.name}
        onChange={(event) => push(event.target.value)}
        className={`${INPUT_CLASS} ${missing ? MISSING_CLASS : ''}`}
      >
        {/* An empty slot needs somewhere to sit, or the browser shows the first
            option and the file quietly disagrees with the screen. */}
        {text === '' && <option value="">(none)</option>}
        {all.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  const combobox = (
    all: readonly (string | ComboboxOption)[],
    placeholder?: string
  ): JSX.Element => (
    <ThemedCombobox
      value={text}
      options={optionsFor(all, text)}
      disabled={disabled}
      label={spec.name}
      placeholder={placeholder}
      invalid={missing}
      onChange={push}
    />
  )

  const plain = (placeholder?: string, type: 'text' | 'number' = 'text'): JSX.Element => (
    <input
      type={type}
      value={text}
      disabled={disabled}
      aria-label={spec.name}
      placeholder={placeholder}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      onChange={(event) => push(event.target.value)}
      className={`${INPUT_CLASS} ${missing ? MISSING_CLASS : ''}`}
    />
  )

  const control = ((): JSX.Element => {
    switch (spec.type) {
      case 'compare-op':
        return select(COMPARE_OPS)
      case 'direction':
        return select(['asc', 'desc'])
      case 'render-style':
        return select(RENDER_STYLES)
      case 'wire':
        return select(vocabulary.wires)
      case 'tag':
        return combobox(vocabulary.tags, 'book')
      case 'field':
        return combobox([...BUILTIN_FIELDS, ...vocabulary.fields], 'updated')
      case 'path':
        return combobox(vocabulary.paths, 'inbox/Reading Log.md')
      case 'folder':
        return combobox(vocabulary.folders, 'inbox')
      case 'workflow':
        return combobox(vocabulary.workflows, 'archive-done')
      case 'number':
        return plain('25', 'number')
      case 'duration':
        return plain('7d')
      case 'glob':
        return plain('inbox/**/*.md')
      case 'heading':
        return plain('Finished')
      case 'template':
        return plain('book-review')
      default:
        return plain()
    }
  })()

  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xs text-ink-700">{spec.name}</span>
        <span className="text-2xs text-ink-400">
          {spec.type}
          {spec.required ? '' : ' · optional'}
        </span>
        {missing && (
          <span className="ml-auto text-2xs font-semibold uppercase tracking-wide text-danger">
            required
          </span>
        )}
      </span>
      {control}
      {spec.type === 'duration' && (
        <span className="text-2xs text-ink-400">A count and a unit: 7d, 24h, 2w, 6m.</span>
      )}
      {spec.type === 'tag' && (
        <span className="text-2xs text-ink-400">
          Written to the file with a #. Nested tags match, so book keeps book/scifi.
        </span>
      )}
      {spec.type === 'rest' && (
        <span className="text-2xs text-ink-400">
          Free text. {'{{date}}'} and any field expand per note.
        </span>
      )}
    </label>
  )
}

/* -------------------------------------------------------------------------- */
/*  The panel                                                                 */
/* -------------------------------------------------------------------------- */

export interface NodeInspectorProps {
  /** Null for a verb this version does not know; the panel then only offers Delete. */
  def: NodeDef | null
  step: WorkflowStep
  statement: WorkflowStatement
  /** Canvas id of the step, used to key the controls and their datalists. */
  nodeId: string
  stepIndex: number
  /** Wires other statements define, for the "reads" select. */
  inputChoices: readonly string[]
  /** How many other statements read this statement's wire. */
  wireReaders: number
  vocabulary: InspectorVocabulary
  /** False in a read-only workspace: every control is shown, none can be used. */
  editable: boolean
  /** Bumped by the caller to put the keyboard on the wire name (an edge click). */
  focusWireToken: number
  onSetArg: (name: string, value: ArgValue) => void
  onSetWireName: (name: string) => void
  onSetInput: (wire: string | null) => void
  /** Null when this step ends the pipeline, so nothing may follow it. */
  onInsertAfter: (() => void) | null
  onMoveStep: (delta: number) => void
  onDelete: () => void
  onClose: () => void
}

export function NodeInspector({
  def,
  step,
  statement,
  nodeId,
  stepIndex,
  inputChoices,
  wireReaders,
  vocabulary,
  editable,
  focusWireToken,
  onSetArg,
  onSetWireName,
  onSetInput,
  onInsertAfter,
  onMoveStep,
  onDelete,
  onClose
}: NodeInspectorProps): JSX.Element {
  const nodeKey = `${nodeId}:${step.kind}`
  const isFirst = stepIndex === 0
  const isLast = stepIndex === statement.steps.length - 1
  // A statement whose first step is a source manufactures its own notes, so it
  // may not also read a wire; the engine and `validate` both say so. The control
  // is therefore not offered rather than offered and then marked red.
  const opensWithSource =
    statement.steps.length > 0 && nodeDef(statement.steps[0].kind)?.source === true

  const [wireName, setWireName] = useState(statement.name ?? '')
  const wireRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setWireName(statement.name ?? '')
  }, [statement.name, nodeKey])

  useEffect(() => {
    if (focusWireToken === 0) return
    wireRef.current?.focus()
    wireRef.current?.select()
  }, [focusWireToken])

  /**
   * Commit the wire name, or put back what it was.
   *
   * Reverting is the point: a name that does not parse, or an empty one that
   * other statements still read, would break lines the author is not looking at.
   * The rename itself goes through `renameWire` upstream, so every reader
   * follows the name rather than being orphaned by it.
   */
  const commitWire = (): void => {
    const next = wireName.trim()
    const current = statement.name ?? ''
    if (next === current) return
    if (next === '' && wireReaders > 0) {
      setWireName(current)
      return
    }
    if (next !== '' && !WIRE_NAME_RE.test(next)) {
      setWireName(current)
      return
    }
    onSetWireName(next)
  }

  const onWireKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitWire()
      return
    }
    if (event.key === 'Escape') {
      // Abandons the edit without closing the panel: Escape here means "not
      // this name", and losing the whole selection would be a bigger answer
      // than the question.
      event.preventDefault()
      event.stopPropagation()
      setWireName(statement.name ?? '')
    }
  }

  return (
    <aside
      aria-label="Step options"
      // Named so "Edit step" in the canvas menu can put the keyboard in here.
      // Focusable itself as the fallback for a step with no arguments, where
      // there is no field to land in.
      data-workflow-inspector
      tabIndex={-1}
      // Escape closes the panel and leaves the workflow alone, which is the
      // rule everywhere in this view. A control that owns Escape for itself
      // (the wire name abandons its edit) stops it before it gets here.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      className="flex w-80 shrink-0 flex-col border-l border-paper-300/50 bg-paper-50"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-paper-300/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide ${
                CATEGORY_CHIP[def?.category ?? 'unknown']
              }`}
            >
              {def?.category ?? 'unknown'}
            </span>
            {def?.mutating && (
              <span
                title="Running this plans changes to your notes. You confirm them first, and can undo them after."
                className="rounded bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning"
              >
                writes
              </span>
            )}
          </div>
          <h3 className="mt-1 text-sm font-semibold text-ink-900">
            {def?.title ?? `Unknown step \`${step.kind}\``}
          </h3>
        </div>
        <IconButton
          size="sm"
          title="Close the step options"
          aria-label="Close the step options"
          onClick={onClose}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {def === null ? (
          <p className="text-xs text-ink-600">
            This version does not know the verb <span className="font-mono">{step.kind}</span>, so
            there is nothing to configure. Its arguments are kept exactly as written:{' '}
            <span className="font-mono">{displayValue(step.args[RAW_ARG]) || '(none)'}</span>
          </p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-600">{def.description}</p>
            <p className="mt-2 whitespace-pre-wrap break-words rounded bg-paper-200/70 px-1.5 py-1 font-mono text-2xs text-ink-700">
              {def.example}
            </p>

            {def.params.length > 0 && (
              <div className="mt-4 flex flex-col gap-3">
                {def.params.map((spec) => (
                  <ParamControl
                    key={spec.name}
                    spec={spec}
                    value={step.args[spec.name]}
                    nodeKey={nodeKey}
                    vocabulary={vocabulary}
                    disabled={!editable}
                    onChange={(value) => onSetArg(spec.name, value)}
                  />
                ))}
              </div>
            )}
            {def.params.length === 0 && (
              <p className="mt-4 text-2xs text-ink-400">This step takes no arguments.</p>
            )}
          </>
        )}

        {/* Wiring. Which wire a pipeline READS is a property of its first step's
            position in the line, and the name it PRODUCES belongs to its last:
            showing both on every node would be four controls saying two things. */}
        {(isFirst || isLast) && (
          <div className="mt-5 flex flex-col gap-3 border-t border-paper-300/50 pt-3">
            <div className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
              Wiring
            </div>

            {isFirst &&
              (opensWithSource ? (
                <p className="text-2xs text-ink-400">
                  This line starts from its own source, so it reads no wire.
                </p>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-2xs text-ink-700">reads</span>
                  <select
                    value={statement.input ?? ''}
                    disabled={!editable}
                    aria-label="Wire this line reads"
                    onChange={(event) =>
                      onSetInput(event.target.value === '' ? null : event.target.value)
                    }
                    className={`${INPUT_CLASS} ${statement.input === null ? MISSING_CLASS : ''}`}
                  >
                    <option value="">(nothing)</option>
                    {(statement.input !== null && !inputChoices.includes(statement.input)
                      ? [statement.input, ...inputChoices]
                      : inputChoices
                    ).map((wire) => (
                      <option key={wire} value={wire}>
                        {wire}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

            {isLast && (
              <label className="flex flex-col gap-1">
                <span className="font-mono text-2xs text-ink-700">produces wire</span>
                <input
                  ref={wireRef}
                  value={wireName}
                  disabled={!editable}
                  aria-label="Name of the wire this line produces"
                  placeholder="unnamed"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  onChange={(event) => setWireName(event.target.value)}
                  onBlur={commitWire}
                  onKeyDown={onWireKeyDown}
                  className={INPUT_CLASS}
                />
                <span className="text-2xs text-ink-400">
                  {wireReaders === 0
                    ? 'Name it and other lines can read it. Renaming updates every reader.'
                    : `${wireReaders} ${wireReaders === 1 ? 'line reads' : 'lines read'} this wire, so it cannot be left unnamed.`}
                </span>
              </label>
            )}
          </div>
        )}
      </div>

      {editable && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-paper-300/50 px-3 py-2">
          {onInsertAfter && (
            <Button variant="secondary" title="Add a step after this one" onClick={onInsertAfter}>
              <PlusIcon className="h-3.5 w-3.5" />
              Add after
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={isFirst}
            title="Move this step one place earlier in the line"
            onClick={() => onMoveStep(-1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            disabled={isLast}
            title="Move this step one place later in the line"
            onClick={() => onMoveStep(1)}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-danger hover:bg-danger/10 hover:text-danger"
            title={
              statement.steps.length === 1
                ? 'Delete this step, and the line it is the whole of'
                : 'Delete this step'
            }
            onClick={onDelete}
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      )}
    </aside>
  )
}
