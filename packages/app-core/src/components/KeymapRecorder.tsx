import { useEffect, useState, type ReactNode } from 'react'
import {
  findKeymapConflict,
  formatKeymapBinding,
  getDefaultKeymapBinding,
  getKeymapBinding,
  getKeymapDisplay,
  isChordEvent,
  isMacPlatform,
  isUnboundBinding,
  sequenceTokenFromEvent,
  shortcutBindingFromEvent,
  UNBOUND_LABEL,
  type KeymapDefinition,
  type KeymapOverrides
} from '../lib/keymaps'
import {
  commandBindingKind,
  commandRecorderStep,
  COMMAND_LEADER_TOKEN,
  findActionCommandConflicts,
  findCommandBindingConflicts,
  formatCommandBinding,
  leaderTokenOf,
  MAX_COMMAND_SEQUENCE_KEYS,
  parseCommandBinding,
  type CommandKeymapConflict,
  type CommandKeymaps
} from '../lib/command-keymaps'
import { keymapBindingTakenBy } from '../lib/list-view-keys'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

/** What a recorder is recording a key for: a built-in action, or a command. */
export type KeymapRecorderTarget =
  | { kind: 'action'; definition: KeymapDefinition }
  | {
      kind: 'command'
      id: string
      title: string
      category: string
      /** A key the command already has from elsewhere (a leader chord), shown
       *  so the new binding reads as an addition. */
      builtinShortcut?: string
    }

/**
 * The key recorder behind every Change… in Settings → Keymap, and behind
 * Alt+Enter in the command palette (#971). Keys are captured on the window
 * in the capture phase while it is open; everything else that listens there
 * stands down while Settings or the palette is open.
 *
 * An action's recorder takes any key, Enter and Escape included, so it is
 * saved and cancelled with the buttons. A command's binding is never a bare
 * Enter, Escape or Backspace, so those drive its recorder from the keyboard:
 * Enter saves, Escape cancels, Backspace clears.
 */
export function KeymapRecorderModal({
  target,
  overrides,
  commandKeymaps,
  vimMode,
  onClose,
  onSave,
  onUnbind
}: {
  target: KeymapRecorderTarget
  overrides: KeymapOverrides
  commandKeymaps: CommandKeymaps
  vimMode: boolean
  onClose: () => void
  /** For an action, the binding as recorded (the caller maps its default
   *  back to "no override"); for a command, the canonical binding. */
  onSave: (binding: string) => void
  onUnbind: () => void
}): JSX.Element {
  return target.kind === 'action' ? (
    <ActionRecorder
      definition={target.definition}
      overrides={overrides}
      commandKeymaps={commandKeymaps}
      vimMode={vimMode}
      onClose={onClose}
      onSave={onSave}
      onUnbind={onUnbind}
    />
  ) : (
    <CommandRecorder
      target={target}
      overrides={overrides}
      commandKeymaps={commandKeymaps}
      vimMode={vimMode}
      onClose={onClose}
      onSave={onSave}
      onUnbind={onUnbind}
    />
  )
}

function RecorderShell({
  title,
  description,
  display,
  hint,
  notices,
  current,
  secondary,
  canUnbind,
  canSave,
  onUnbind,
  onClose,
  onSave,
  recorderKind
}: {
  title: string
  description: string
  display: string
  hint: string
  notices: JSX.Element | null
  current: string
  secondary: string
  canUnbind: boolean
  canSave: boolean
  onUnbind: () => void
  onClose: () => void
  onSave: () => void
  recorderKind: 'action' | 'command'
}): JSX.Element {
  return (
    <Modal
      size="sm"
      layer="popover"
      align="center"
      onClose={onClose}
      closeOnEsc={false}
      initialFocus="panel"
      data={{ 'data-keymap-recorder': recorderKind }}
    >
      <div className="border-b border-paper-300/60 px-5 py-4">
        <div className="text-base font-semibold text-ink-900">{title}</div>
        <div className="mt-1 text-sm text-ink-500">{description}</div>
      </div>
      <div className="px-5 py-4">
        <div className="rounded-xl border border-paper-300/70 bg-paper-50/80 px-4 py-4">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
            Recording
          </div>
          <div
            className="mt-2 text-2xl font-semibold text-ink-900"
            data-keymap-recorder-binding=""
          >
            {display}
          </div>
          <div className="mt-2 text-xs leading-5 text-ink-500">{hint}</div>
        </div>
        {notices}
        <div className="mt-3 text-xs text-ink-500">Current: {current}</div>
        <div className="mt-1 text-xs text-ink-500">{secondary}</div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-paper-300/60 px-5 py-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={onUnbind}
          disabled={!canUnbind}
          title="Save this with no key at all."
        >
          Unbind
        </Button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canSave}
            onClick={onSave}
            data-keymap-recorder-save=""
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Notice({
  tone,
  children
}: {
  tone: 'danger' | 'warning' | 'info'
  children: ReactNode
}): JSX.Element {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/35 bg-danger/10 text-danger'
      : tone === 'warning'
        ? 'border-warning/35 bg-warning/10 text-ink-800'
        : 'border-paper-300/70 bg-paper-100/80 text-ink-700'
  return (
    <div
      className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 ${toneClass}`}
      data-keymap-recorder-notice={tone}
    >
      <span aria-hidden>{tone === 'info' ? 'ⓘ' : '⚠'}</span>
      <span>{children}</span>
    </div>
  )
}

function ActionRecorder({
  definition,
  overrides,
  commandKeymaps,
  vimMode,
  onClose,
  onSave,
  onUnbind
}: {
  definition: KeymapDefinition
  overrides: KeymapOverrides
  commandKeymaps: CommandKeymaps
  vimMode: boolean
  onClose: () => void
  onSave: (binding: string) => void
  onUnbind: () => void
}): JSX.Element {
  const currentBinding = getKeymapBinding(overrides, definition.id)
  const [binding, setBinding] = useState(currentBinding)
  const mac = isMacPlatform()
  // Block saving a global shortcut that another action already owns (#298).
  const conflict = binding ? findKeymapConflict(overrides, definition.id, binding) : null
  // And one a command's key holds (#971): both are keys the user chose. A
  // leader key that starts a command's sequence is allowed (built-in leader
  // keys always win) but said out loud, since the command loses its keys.
  const commandHits = binding
    ? findActionCommandConflicts(definition.id, binding, { overrides, commandKeymaps })
    : []
  const leaderKey = definition.scope === 'leader'
  const blockingCommand = leaderKey ? null : commandHits[0] ?? null
  // A list action's chord that an app-wide key takes first never fires
  // (#972). Said before Save, not refused: the user may be about to move the
  // other key.
  const takenBy = binding
    ? keymapBindingTakenBy(overrides, definition.id, binding, vimMode)
    : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const key = event.key
      // A bare Backspace or Delete edits the recording; with Ctrl, Alt or Cmd
      // held it is a key to record. Mod+Backspace for Delete selected result
      // could not be recorded at all (#972).
      if ((key === 'Backspace' || key === 'Delete') && !isChordEvent(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (definition.kind === 'shortcut') {
          setBinding('')
          return
        }
        setBinding((current) => {
          const tokens = current.split(/\s+/).filter(Boolean)
          tokens.pop()
          return tokens.join(' ')
        })
        return
      }

      const next =
        definition.kind === 'shortcut' ? shortcutBindingFromEvent(event) : sequenceTokenFromEvent(event)
      if (!next) return

      event.preventDefault()
      event.stopPropagation()

      if (definition.kind === 'shortcut') {
        setBinding(next)
        return
      }

      setBinding((current) => {
        const limit = definition.maxTokens ?? 2
        const tokens = current.split(/\s+/).filter(Boolean)
        if (limit <= 1) return next
        if (tokens.length >= limit) return next
        return [...tokens, next].join(' ')
      })
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [definition])

  const notices =
    conflict || blockingCommand || takenBy || (leaderKey && commandHits.length > 0) ? (
      <>
        {takenBy && !conflict && !blockingCommand && (
          <Notice tone="warning">
            <strong className="font-semibold">{takenBy.title}</strong> has this key everywhere in
            the app, so it would never reach this action. Pick another key, or move that one first.
          </Notice>
        )}
        {conflict && (
          <Notice tone="danger">
            Already used by <strong className="font-semibold">{conflict.title}</strong>. Two global
            shortcuts can’t share a key. Reset or reassign that one first.
          </Notice>
        )}
        {blockingCommand && (
          <Notice tone="danger">
            Already the key of the command{' '}
            <strong className="font-semibold">{blockingCommand.title}</strong>. Two of your keys
            can’t share one. Unbind or change that command first.
          </Notice>
        )}
        {leaderKey && commandHits.length > 0 && (
          <Notice tone="warning">
            Your key sequence for{' '}
            <strong className="font-semibold">
              {commandHits.map((hit) => hit.title).join(', ')}
            </strong>{' '}
            starts with this key. Built-in leader keys always win, so that command stops answering
            its keys until you move one of them.
          </Notice>
        )}
      </>
    ) : null

  return (
    <RecorderShell
      recorderKind="action"
      title={definition.title}
      description={definition.description}
      display={binding ? formatKeymapBinding(binding, definition.kind) : 'Press a key…'}
      hint={
        definition.kind === 'shortcut'
          ? `Press the shortcut you want; Backspace clears it. ${mac ? 'Command' : 'Ctrl'}-style chords are saved in the app’s cross-platform format. Unbind leaves the action with no key at all.`
          : `Press the sequence you want. Backspace removes the last token, and multi-step sequences stop at ${definition.maxTokens ?? 2} key${(definition.maxTokens ?? 2) === 1 ? '' : 's'}. Unbind leaves the action with no key at all.`
      }
      notices={notices}
      current={
        isUnboundBinding(currentBinding)
          ? UNBOUND_LABEL
          : formatKeymapBinding(currentBinding, definition.kind)
      }
      secondary={`Default: ${formatKeymapBinding(getDefaultKeymapBinding(definition.id), definition.kind)}`}
      canUnbind={!isUnboundBinding(currentBinding)}
      canSave={!!binding && !conflict && !blockingCommand}
      onUnbind={onUnbind}
      onClose={onClose}
      onSave={() => onSave(binding)}
    />
  )
}

function describeBlocking(conflict: CommandKeymapConflict, sequence: boolean): JSX.Element {
  if (sequence && conflict.kind === 'action') {
    return (
      <>
        The key right after the leader belongs to the built-in{' '}
        <strong className="font-semibold">{conflict.title}</strong>. Built-in leader keys always
        win, so pick another key after the leader.
      </>
    )
  }
  if (sequence) {
    return (
      <>
        Overlaps the key sequence of <strong className="font-semibold">{conflict.title}</strong>:
        one would start the other. Change one of them first.
      </>
    )
  }
  return (
    <>
      Already used by{' '}
      <strong className="font-semibold">
        {conflict.kind === 'command' ? `the command ${conflict.title}` : conflict.title}
      </strong>
      . Two of your keys can’t share one. Change or unbind that one first.
    </>
  )
}

function CommandRecorder({
  target,
  overrides,
  commandKeymaps,
  vimMode,
  onClose,
  onSave,
  onUnbind
}: {
  target: Extract<KeymapRecorderTarget, { kind: 'command' }>
  overrides: KeymapOverrides
  commandKeymaps: CommandKeymaps
  vimMode: boolean
  onClose: () => void
  onSave: (binding: string) => void
  onUnbind: () => void
}): JSX.Element {
  const currentBinding = commandKeymaps[target.id] ?? ''
  const [binding, setBinding] = useState(currentBinding)
  const [hint, setHint] = useState<string | null>(null)
  const mac = isMacPlatform()
  const leaderToken = leaderTokenOf(overrides)

  const complete = binding !== '' && binding !== COMMAND_LEADER_TOKEN
  const parsed = complete ? parseCommandBinding(binding, overrides) : null
  const conflicts = complete
    ? findCommandBindingConflicts(target.id, binding, { overrides, commandKeymaps })
    : { blocking: [], shadows: [] }
  const sequence = commandBindingKind(binding) === 'sequence'
  const canSave =
    complete && !!parsed?.ok && conflicts.blocking.length === 0 && binding !== currentBinding

  // The latest values for the window listener, which is installed once.
  const latest = { binding, canSave, onSave, onClose }
  const latestRef = useLatest(latest)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const step = commandRecorderStep(latestRef.current.binding, event, {
        leaderToken,
        shortcutFromEvent: shortcutBindingFromEvent,
        tokenFromEvent: sequenceTokenFromEvent
      })
      // Modifiers on their own, and Tab between the buttons, pass through.
      if (step.type === 'ignore' && !step.hint) return
      event.preventDefault()
      event.stopPropagation()
      if (step.type === 'save') {
        if (latestRef.current.canSave) latestRef.current.onSave(latestRef.current.binding)
        return
      }
      if (step.type === 'cancel') {
        latestRef.current.onClose()
        return
      }
      if (step.type === 'ignore') {
        setHint(step.hint ?? null)
        return
      }
      setHint(null)
      setBinding(step.binding)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [leaderToken, latestRef])

  const display =
    binding === COMMAND_LEADER_TOKEN
      ? `${formatCommandBinding(binding, overrides)} …`
      : binding
        ? formatCommandBinding(binding, overrides)
        : 'Press a key…'

  const notices = (
    <>
      {hint && <Notice tone="info">{hint}</Notice>}
      {parsed && !parsed.ok && <Notice tone="danger">{parsed.error}</Notice>}
      {conflicts.blocking.map((conflict) => (
        <Notice key={`b-${conflict.id}`} tone="danger">
          {describeBlocking(conflict, sequence)}
        </Notice>
      ))}
      {conflicts.shadows.map((conflict) => (
        <Notice key={`s-${conflict.id}`} tone="warning">
          This is the default key of <strong className="font-semibold">{conflict.title}</strong>.
          Your key wins, so {conflict.title} stops answering it until you move one of them.
        </Notice>
      ))}
      {sequence && !vimMode && (
        <Notice tone="info">
          Leader sequences work with Vim mode on. With it off, this one does nothing until Vim
          mode is back on.
        </Notice>
      )}
      {sequence && !leaderToken && (
        <Notice tone="info">The leader key is unbound, so no sequence can start right now.</Notice>
      )}
    </>
  )

  const leaderName = leaderToken ? getKeymapDisplay(overrides, 'vim.leaderPrefix') : ''
  return (
    <RecorderShell
      recorderKind="command"
      title={target.title}
      description={`${target.category} command · ${target.id}${target.builtinShortcut ? ` · also ${target.builtinShortcut}` : ''}`}
      display={display}
      hint={`Press a chord with Ctrl, Alt or ${mac ? 'Cmd' : 'Meta'}, or a function key${leaderName ? `, or ${leaderName} and then up to ${MAX_COMMAND_SEQUENCE_KEYS} keys for a leader sequence` : ''}. A command’s key wins over the defaults, the editor’s own keys included. Enter saves, Esc cancels, Backspace clears.`}
      notices={notices}
      current={currentBinding ? formatCommandBinding(currentBinding, overrides) : UNBOUND_LABEL}
      secondary="Default: Unbound"
      canUnbind={currentBinding !== ''}
      canSave={canSave}
      onUnbind={onUnbind}
      onClose={onClose}
      onSave={() => onSave(binding)}
    />
  )
}

function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }))
  ref.current = value
  return ref
}
