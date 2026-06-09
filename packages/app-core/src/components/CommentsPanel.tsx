import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { NoteComment, NoteContent } from '@shared/ipc'
import { useStore } from '../store'
import { commentQuote } from '../lib/comments'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'
import {
  ArrowUpRightIcon,
  CheckSquareIcon,
  CloseIcon,
  FeedbackIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon
} from './icons'

export interface CommentDraft {
  anchorStart: number
  anchorEnd: number
  anchorText: string
}

interface Props {
  note: NoteContent
  draft: CommentDraft | null
  onCaptureDraft: () => CommentDraft | null
  onClearDraft: () => void
  onJump: (comment: NoteComment) => void
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})
const EMPTY_COMMENTS: NoteComment[] = []

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function isCommitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}

export function CommentsPanel({
  note,
  draft,
  onCaptureDraft,
  onClearDraft,
  onJump
}: Props): JSX.Element {
  const comments = useStore((s) => s.noteComments[note.path] ?? EMPTY_COMMENTS)
  const activeCommentId = useStore((s) => s.activeCommentId)
  const loadNoteComments = useStore((s) => s.loadNoteComments)
  const addNoteComment = useStore((s) => s.addNoteComment)
  const updateNoteComment = useStore((s) => s.updateNoteComment)
  const deleteNoteComment = useStore((s) => s.deleteNoteComment)
  const setActiveCommentId = useStore((s) => s.setActiveCommentId)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const panelWidth = useStore((s) => s.panelWidths.comments)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(panelWidth, (px) => setPanelWidth('comments', px))

  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const notePathRef = useRef(note.path)
  const commentsFocused = focusedPanel === 'comments'

  useEffect(() => {
    void loadNoteComments(note.path)
  }, [loadNoteComments, note.path])

  useEffect(() => {
    if (!draft) return
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [draft])

  useEffect(() => {
    if (notePathRef.current === note.path) return
    notePathRef.current = note.path
    setBody('')
    setEditingId(null)
    setEditBody('')
    onClearDraft()
  }, [note.path])

  useEffect(() => {
    if (!activeCommentId) return
    const raf = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-comment-card-id="${cssEscape(activeCommentId)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [activeCommentId, comments])

  const unresolved = useMemo(
    () => comments.filter((comment) => comment.resolvedAt == null),
    [comments]
  )
  const resolved = useMemo(
    () => comments.filter((comment) => comment.resolvedAt != null),
    [comments]
  )
  const orderedComments = useMemo(() => [...unresolved, ...resolved], [resolved, unresolved])

  useEffect(() => {
    if (!commentsFocused) return
    const active = document.activeElement
    if (!(active instanceof Node && panelRef.current?.contains(active))) {
      panelRef.current?.focus({ preventScroll: true })
    }
    if (
      orderedComments.length > 0 &&
      (!activeCommentId || !orderedComments.some((comment) => comment.id === activeCommentId))
    ) {
      setActiveCommentId(orderedComments[0].id)
    }
  }, [activeCommentId, commentsFocused, orderedComments, setActiveCommentId])

  const beginDraft = (): void => {
    const next = onCaptureDraft()
    if (next) requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const cancelDraft = (): void => {
    setBody('')
    onClearDraft()
  }

  const submit = async (): Promise<void> => {
    if (!draft) return
    const trimmed = body.trim()
    if (!trimmed) return
    const created = await addNoteComment({
      notePath: note.path,
      ...draft,
      body: trimmed
    })
    setBody('')
    onClearDraft()
    if (created) {
      setActiveCommentId(created.id)
      onJump(created)
    }
  }

  const startEdit = (comment: NoteComment): void => {
    setEditingId(comment.id)
    setEditBody(comment.body)
    setActiveCommentId(comment.id)
  }

  const saveEdit = async (comment: NoteComment): Promise<void> => {
    await updateNoteComment(note.path, comment.id, { body: editBody })
    setEditingId(null)
    setEditBody('')
  }

  let rowIndex = 0

  return (
    <aside
      ref={panelRef}
      aria-label="Comments"
      data-comments-panel
      tabIndex={-1}
      onMouseDownCapture={() => setFocusedPanel('comments')}
      onFocusCapture={() => setFocusedPanel('comments')}
      style={{ width: panelWidth }}
      className={[
        'relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/24 shadow-[inset_1px_0_0_rgb(var(--z-bg)/0.25)] outline-none transition-shadow',
        commentsFocused ? 'ring-1 ring-inset ring-accent/18' : ''
      ].join(' ')}
    >
      <PanelResizeHandle onStart={startResize} />
      <div className="border-b border-paper-300/60 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-400">
              Comments
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-500">
              <Pill>{unresolved.length} open</Pill>
              <Pill>{resolved.length} resolved</Pill>
            </div>
          </div>
          <button
            type="button"
            data-comments-new
            data-comment-card-control
            onClick={beginDraft}
            title="New comment"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-paper-300/70 bg-paper-100 text-ink-700 transition-colors hover:border-accent/40 hover:bg-paper-200 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <PlusIcon width={15} height={15} />
          </button>
        </div>
        <div
          aria-hidden={!commentsFocused}
          className={[
            'mt-3 flex h-5 items-center gap-1 overflow-hidden transition-opacity',
            commentsFocused ? 'opacity-100' : 'pointer-events-none opacity-0'
          ].join(' ')}
        >
          <CommentKeyHint keyLabel="j/k" label="Move" />
          <CommentKeyHint keyLabel="↵" label="Jump" />
          <CommentKeyHint keyLabel="n" label="New" />
          <CommentKeyHint keyLabel="e" label="Edit" />
          <CommentKeyHint keyLabel="r" label="Resolve" />
          <CommentKeyHint keyLabel="d" label="Delete" />
          <CommentKeyHint keyLabel="esc" label="Back to note" />
        </div>

        {draft && (
          <div className="mt-4 rounded-lg border border-accent/35 bg-paper-100/72 p-3 shadow-[0_14px_32px_-28px_rgb(var(--z-shadow)/0.85)]">
            <div className="line-clamp-2 border-l-2 border-accent/60 pl-2.5 text-xs leading-5 text-ink-700">
              {commentQuote(draft)}
            </div>
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (isCommitShortcut(event)) {
                  event.preventDefault()
                  void submit()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelDraft()
                }
              }}
              aria-keyshortcuts="Meta+Enter Control+Enter Escape"
              placeholder="Add a comment…"
              rows={4}
              className="mt-3 w-full resize-none rounded-md border border-paper-300/70 bg-paper-50 px-3 py-2.5 text-sm leading-5 text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60 focus:ring-1 focus:ring-accent/20"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                data-comment-card-control
                onClick={cancelDraft}
                aria-keyshortcuts="Escape"
                title="Cancel (Esc)"
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                <span>Cancel</span>
                <InlineShortcut>Esc</InlineShortcut>
              </button>
              <button
                type="button"
                data-comment-card-control
                disabled={!body.trim()}
                onClick={() => void submit()}
                aria-keyshortcuts="Meta+Enter Control+Enter"
                title="Comment (⌘↵)"
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-default disabled:bg-paper-300 disabled:text-ink-500"
              >
                <span>Comment</span>
                <InlineShortcut tone="light">⌘↵</InlineShortcut>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {comments.length === 0 && !draft ? (
          <div className="rounded-lg border border-dashed border-paper-300/75 bg-paper-100/42 px-4 py-6 text-center">
            <FeedbackIcon className="mx-auto text-ink-400" width={20} height={20} />
            <div className="mt-3 text-sm font-medium text-ink-800">No comments</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {unresolved.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                rowIndex={rowIndex++}
                active={activeCommentId === comment.id}
                commentsFocused={commentsFocused}
                editing={editingId === comment.id}
                editBody={editBody}
                onEditBody={setEditBody}
                onJump={() => {
                  setActiveCommentId(comment.id)
                  onJump(comment)
                }}
                onEdit={() => startEdit(comment)}
                onCancelEdit={() => {
                  setEditingId(null)
                  setEditBody('')
                }}
                onSave={() => void saveEdit(comment)}
                onResolve={() =>
                  void updateNoteComment(note.path, comment.id, { resolvedAt: Date.now() })
                }
                onDelete={() => void deleteNoteComment(note.path, comment.id)}
              />
            ))}
            {resolved.length > 0 && unresolved.length > 0 && (
              <div className="px-1 pt-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
                Resolved
              </div>
            )}
            {resolved.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                rowIndex={rowIndex++}
                active={activeCommentId === comment.id}
                commentsFocused={commentsFocused}
                editing={editingId === comment.id}
                editBody={editBody}
                onEditBody={setEditBody}
                onJump={() => {
                  setActiveCommentId(comment.id)
                  onJump(comment)
                }}
                onEdit={() => startEdit(comment)}
                onCancelEdit={() => {
                  setEditingId(null)
                  setEditBody('')
                }}
                onSave={() => void saveEdit(comment)}
                onResolve={() =>
                  void updateNoteComment(note.path, comment.id, { resolvedAt: null })
                }
                onDelete={() => void deleteNoteComment(note.path, comment.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function CommentCard({
  comment,
  rowIndex,
  active,
  commentsFocused,
  editing,
  editBody,
  onEditBody,
  onJump,
  onEdit,
  onCancelEdit,
  onSave,
  onResolve,
  onDelete
}: {
  comment: NoteComment
  rowIndex: number
  active: boolean
  commentsFocused: boolean
  editing: boolean
  editBody: string
  onEditBody: (body: string) => void
  onJump: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onResolve: () => void
  onDelete: () => void
}): JSX.Element {
  const resolved = comment.resolvedAt != null
  const showActionShortcuts = active && commentsFocused && !editing
  const handleCardClick = (event: MouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('button, textarea, input, select, a, [data-comment-card-control]')) return
    onJump()
  }

  return (
    <article
      data-comment-card-id={comment.id}
      data-comments-idx={rowIndex}
      data-comment-id={comment.id}
      onClick={handleCardClick}
      className={[
        'rounded-lg border p-3.5 transition-colors',
        editing ? '' : 'cursor-pointer hover:border-accent/35',
        active
          ? 'border-accent/55 bg-paper-100 shadow-[0_14px_34px_-28px_rgb(var(--z-shadow)/0.9),0_0_0_1px_rgb(var(--z-accent)/0.16)]'
          : resolved
            ? 'border-paper-300/55 bg-paper-100/36 opacity-75'
            : 'border-paper-300/70 bg-paper-50/82'
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-paper-300/70 bg-paper-200/80 text-xs font-semibold text-ink-700">
          Y
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink-900">You</span>
            <span className="shrink-0 text-xs text-ink-400">
              {dateFormatter.format(new Date(comment.updatedAt))}
            </span>
          </div>

          <button
            type="button"
            data-comment-card-control
            data-comment-action="jump"
            onClick={onJump}
            className="mt-2 block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            title="Jump to annotation"
          >
            <div className="line-clamp-2 border-l-2 border-accent/50 pl-2.5 text-xs leading-5 text-ink-600">
              {commentQuote(comment)}
            </div>
          </button>

          {editing ? (
            <div className="mt-3">
              <textarea
                value={editBody}
                onChange={(event) => onEditBody(event.target.value)}
                autoFocus
                onKeyDown={(event) => {
                  if (isCommitShortcut(event)) {
                    event.preventDefault()
                    if (editBody.trim()) onSave()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    onCancelEdit()
                  }
                }}
                aria-keyshortcuts="Meta+Enter Control+Enter Escape"
                rows={4}
                className="w-full resize-none rounded-md border border-paper-300/70 bg-paper-50 px-3 py-2 text-sm leading-5 text-ink-900 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/20"
              />
              <div className="relative z-10 mt-2 flex justify-end gap-2" data-comment-card-control>
                <button
                  type="button"
                  data-comment-card-control
                  onMouseDown={(event) => {
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onCancelEdit()
                  }}
                  aria-keyshortcuts="Escape"
                  title="Cancel (Esc)"
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  <span>Cancel</span>
                  <InlineShortcut>Esc</InlineShortcut>
                </button>
                <button
                  type="button"
                  data-comment-card-control
                  data-comment-action="save"
                  disabled={!editBody.trim()}
                  onMouseDown={(event) => {
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onSave()
                  }}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  title="Save (⌘↵)"
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-default disabled:bg-paper-300 disabled:text-ink-500"
                >
                  <span>Save</span>
                  <InlineShortcut tone="light">⌘↵</InlineShortcut>
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-5 text-ink-900">{comment.body}</p>
          )}
        </div>
      </div>

      <div className="relative z-10 mt-3 flex items-center justify-end gap-1" data-comment-card-control>
        <div className="flex items-center gap-1">
          <IconTextButton
            title="Jump"
            action="jump"
            shortcut="↵"
            showShortcut={showActionShortcuts}
            onClick={onJump}
          >
            <ArrowUpRightIcon width={13} height={13} />
          </IconTextButton>
          {!editing && (
            <IconTextButton
              title="Edit"
              action="edit"
              shortcut="e"
              showShortcut={showActionShortcuts}
              onClick={onEdit}
            >
              <PencilIcon width={13} height={13} />
            </IconTextButton>
          )}
          <IconTextButton
            title={resolved ? 'Reopen' : 'Resolve'}
            action="resolve"
            shortcut="r"
            showShortcut={showActionShortcuts}
            onClick={onResolve}
          >
            <CheckSquareIcon width={13} height={13} />
          </IconTextButton>
          <IconTextButton
            title="Delete"
            action="delete"
            shortcut="d"
            showShortcut={showActionShortcuts}
            onClick={onDelete}
            danger
          >
            <TrashIcon width={13} height={13} />
          </IconTextButton>
        </div>
      </div>
    </article>
  )
}

function IconTextButton({
  title,
  action,
  shortcut,
  showShortcut = false,
  children,
  onClick,
  danger = false
}: {
  title: string
  action?: string
  shortcut?: string
  showShortcut?: boolean
  children: JSX.Element
  onClick: () => void
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={title}
      aria-keyshortcuts={shortcut === '↵' ? 'Enter' : shortcut}
      data-comment-card-control
      data-comment-action={action}
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
      className={[
        'group relative z-10 flex h-8 w-8 items-center justify-center rounded-md transition-colors',
        danger
          ? 'text-[rgb(var(--z-red))] hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/35'
          : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45'
      ].join(' ')}
    >
      {children}
      {shortcut && (
        <kbd
          aria-hidden="true"
          className={[
            'pointer-events-none absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded border border-paper-300/80 bg-paper-50 px-1 font-mono text-2xs leading-none text-ink-600 shadow-[0_4px_10px_-8px_rgb(var(--z-shadow)/0.9)] transition-opacity',
            showShortcut ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          ].join(' ')}
        >
          {shortcut}
        </kbd>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-paper-300/75 bg-paper-100 px-2 py-1 text-xs font-medium text-ink-800 opacity-0 shadow-float transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {title}
      </span>
    </button>
  )
}

function CommentKeyHint({
  keyLabel,
  label
}: {
  keyLabel: string
  label: string
}): JSX.Element {
  return (
    <span
      title={label}
      className="shrink-0 rounded-md border border-paper-300/60 bg-paper-100/80 px-1.5 py-0.5 text-2xs leading-none text-ink-500"
    >
      <kbd className="font-mono text-ink-700">{keyLabel}</kbd>
    </span>
  )
}

function InlineShortcut({
  children,
  tone = 'default'
}: {
  children: ReactNode
  tone?: 'default' | 'light'
}): JSX.Element {
  return (
    <kbd
      className={[
        'rounded border px-1 font-mono text-2xs leading-4',
        tone === 'light'
          ? 'border-white/30 bg-white/12 text-white/80'
          : 'border-paper-300/80 bg-paper-50 text-ink-500'
      ].join(' ')}
    >
      {children}
    </kbd>
  )
}

function Pill({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2.5 py-1 tabular-nums text-ink-600">
      {children}
    </span>
  )
}
