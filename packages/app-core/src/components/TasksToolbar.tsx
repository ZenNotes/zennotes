import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type KanbanLaneBy } from '../store'
import { emptyTasksShowLabel } from '../lib/empty-tasks'
import { isKeyboardContextMenuKey } from '../lib/keyboard-context-menu'
import { tasksKeySheet, type TasksKeysView } from '../lib/tasks-keys'
import type { LaneOption } from '../lib/kanban-lanes'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { KeyboardIcon, SlidersIcon } from './icons'

/**
 * The Tasks views' toolbar controls, shared by the list, the calendar and the
 * board: one View menu for the display options, and a Keys button for the
 * keyboard cheat sheet. Both replaced controls that had crowded the toolbar
 * (a separate switch per option, and a paragraph of key hints).
 */

/** A key as the cheat sheet draws it. */
export function KeyChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="inline-flex min-w-5 justify-center whitespace-nowrap rounded border border-paper-300 bg-paper-200/85 px-1.5 py-0.5 font-mono text-2xs leading-none text-ink-700">
      {children}
    </kbd>
  )
}

/** For a toolbar button's onMouseDown: a click does not move focus onto it,
 *  so the menu or sheet it opens hands focus back to the view, and the board
 *  or list keys work again after Esc. Tab still reaches the button. */
function keepFocusOnClick(e: React.MouseEvent): void {
  e.preventDefault()
}

/**
 * Whether a toolbar button that holds keyboard focus (reached with Tab) owns
 * this key, so a view's key handler stands aside: Enter and Space press the
 * button, Shift+F10 opens the View menu from its button, Escape hands the
 * keyboard back to the view. A button that took focus from a click does not
 * count (`:focus-visible`), so the board keys keep working after a mouse
 * click on the toolbar; selects are left to the view as before, whose `j`
 * would otherwise change a select's value by typeahead.
 */
export function tasksToolbarOwnsKey(e: KeyboardEvent): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active || active.tagName !== 'BUTTON') return false
  if (!active.closest('[data-tasks-toolbar]') || !active.matches(':focus-visible')) return false
  if (isKeyboardContextMenuKey(e) && active.hasAttribute('data-tasks-view-options')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    active.click()
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    active.blur()
    return true
  }
  return true
}

/** The board's lane choice for the View menu (#1027). */
export interface TasksViewLanes {
  value: KanbanLaneBy
  options: readonly LaneOption[]
  onChange: (next: KanbanLaneBy) => void
}

/**
 * The View menu (#1026): display options for the Tasks views, today Hide
 * empty tasks, and on the board its lanes (#1027, "Lanes: None", "Lanes:
 * Priority" and on); board options belong in it, not as more toolbar
 * controls. Beside it, only when something is hidden, a quiet "3 hidden"
 * that shows them on a click.
 */
export function TasksViewOptions({
  hidden,
  lanes
}: {
  hidden: number
  lanes?: TasksViewLanes
}): JSX.Element {
  const hide = useStore((s) => s.hideEmptyTasks)
  const setHide = useStore((s) => s.setHideEmptyTasks)
  const vimMode = useStore((s) => s.vimMode)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; top: number } | null>(null)

  const openMenu = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenu({ x: rect.left, y: rect.bottom + 4, top: rect.top })
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <button
        ref={buttonRef}
        type="button"
        data-tasks-view-options
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onMouseDown={keepFocusOnClick}
        onClick={() => (menu ? setMenu(null) : openMenu())}
        title={`View options${vimMode ? ' (v)' : ''}`}
        className="flex items-center gap-1 whitespace-nowrap rounded-md border border-paper-300/60 bg-paper-200/60 px-2 py-0.5 text-xs text-current/80 transition-colors hover:bg-paper-200 hover:text-current/90"
      >
        <SlidersIcon width={12} height={12} aria-hidden="true" />
        View
      </button>
      {hide && hidden > 0 && (
        <button
          type="button"
          data-empty-tasks-hidden
          onMouseDown={keepFocusOnClick}
          onClick={() => setHide(false)}
          title={emptyTasksShowLabel(hidden)}
          aria-label={emptyTasksShowLabel(hidden)}
          className="whitespace-nowrap rounded-full px-1.5 py-0.5 text-2xs text-current/45 transition-colors hover:bg-paper-200/80 hover:text-current/75"
        >
          {hidden} hidden
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchorTop={menu.top}
          title="View"
          items={[
            {
              label: 'Hide empty tasks',
              checked: hide,
              hint: vimMode ? 'E' : undefined,
              keywords: ['empty', 'blank', 'placeholder', 'template'],
              onSelect: () => setHide(!hide)
            },
            ...(lanes ? laneMenuItems(lanes) : [])
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** The lane fields as View menu rows, one checked: "Lanes: Priority". */
function laneMenuItems({ value, options, onChange }: TasksViewLanes): ContextMenuItem[] {
  return [
    { kind: 'separator' },
    ...options.map(
      (option): ContextMenuItem => ({
        label: `Lanes: ${option.label}`,
        checked: option.value === value,
        keywords: ['lanes', 'swimlanes', 'rows', 'split'],
        onSelect: () => onChange(option.value)
      })
    )
  ]
}

const SHEET_TITLES: Record<TasksKeysView, string> = {
  list: 'List keys',
  calendar: 'Calendar keys',
  kanban: 'Board keys'
}

/**
 * The Keys button and its cheat sheet (`?` in Vim mode). The popover is a
 * small modal dialog: the views stand aside while it is open, and Escape or
 * `?` closes it and gives focus back to whatever held it.
 */
export function TasksKeysButton({
  view,
  dndEnabled = true,
  subtasks = false,
  lanes = false,
  laneMoves = false
}: {
  view: TasksKeysView
  dndEnabled?: boolean
  /** The board's Subtasks group (Tab / Shift+Tab); see tasksKeySheet. */
  subtasks?: boolean
  /** The board's Lanes group, while it has lanes (#1027). */
  lanes?: boolean
  /** Cards move between those lanes (Shift+J / K). */
  laneMoves?: boolean
}): JSX.Element {
  const vimMode = useStore((s) => s.vimMode)
  const listOrder = useStore((s) => s.tasksListOrder)
  const dayAdd = useStore((s) => s.vaultSettings.dailyNotes.enabled)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

  const close = useCallback((restoreFocus: boolean): void => {
    setAnchor(null)
    if (restoreFocus) previousFocusRef.current?.focus?.({ preventScroll: true })
    previousFocusRef.current = null
  }, [])

  const open = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
  }

  useEffect(() => {
    if (!anchor) return
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      const toggle = e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey
      if (e.key === 'Escape' || toggle) {
        e.preventDefault()
        e.stopImmediatePropagation()
        close(true)
      } else if (e.key === 'Tab') {
        // Nothing inside to tab to; keep focus on the sheet.
        e.preventDefault()
      }
    }
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [anchor, close])

  const sheet = tasksKeySheet(view, { vimMode, dndEnabled, listOrder, subtasks, lanes, laneMoves, dayAdd })

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-tasks-keys
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onMouseDown={keepFocusOnClick}
        onClick={() => (anchor ? close(true) : open())}
        title={`Keyboard shortcuts${vimMode ? ' (?)' : ''}`}
        className="flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs text-current/55 transition-colors hover:bg-paper-200/80 hover:text-current/85"
      >
        <KeyboardIcon width={14} height={14} aria-hidden="true" />
        Keys
      </button>
      {anchor &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            tabIndex={-1}
            data-tasks-keys-popover
            style={{ top: anchor.top, right: anchor.right }}
            className="fixed z-popover max-h-[80vh] w-[92vw] max-w-dialog-xs overflow-y-auto rounded-xl border border-paper-300/70 bg-paper-100 p-3 text-xs text-ink-900 shadow-float outline-none"
          >
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <span className="font-semibold">{SHEET_TITLES[view]}</span>
              <span className="text-2xs text-ink-500">{vimMode ? 'Vim mode' : 'Vim mode off'}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              {sheet.groups.map((group) => (
                <div key={group.title} data-tasks-keys-group={group.title}>
                  <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-500">
                    {group.title}
                  </div>
                  <ul className="space-y-1">
                    {group.rows.map((row) => (
                      <li
                        key={`${row.keys} ${row.label}`}
                        className="flex items-center gap-2 whitespace-nowrap"
                      >
                        <KeyChip>{row.keys}</KeyChip>
                        <span className="text-ink-700">{row.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-paper-300/60 pt-2 text-2xs text-ink-500">
              {sheet.mouse}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
