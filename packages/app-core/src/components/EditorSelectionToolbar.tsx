import { useEffect, useRef, useState } from 'react'
import type { JSX, SVGProps } from 'react'
import type { BlockType } from '../lib/cm-format'
import { formatKeyToken } from '../lib/keymaps'
import { useStore } from '../store'
import {
  BoldIcon,
  CheckSquareIcon,
  ChevronRightIcon,
  CodeIcon,
  FeedbackIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  SigmaIcon,
  StrikethroughIcon
} from './icons'

type IconCmp = (p: SVGProps<SVGSVGElement>) => JSX.Element

interface Props {
  x: number
  y: number
  /** Toggle a symmetric inline marker (`**`, `*`, `~~`, `` ` ``, `==`, `$`). */
  onWrap: (marker: string) => void
  onLink: () => void
  onComment: () => void
  /** "Turn into" — re-type the selected line(s) as a block. */
  onBlockType: (type: BlockType) => void
  /** Return focus to the editor (Escape / after acting via keyboard). */
  onDismiss: () => void
}

// `binding` is in canonical modifier order so `formatKeyToken` shows it right.
const FORMATS: Array<{ label: string; marker: string; binding: string; Icon: IconCmp }> = [
  { label: 'Bold', marker: '**', binding: 'Mod+B', Icon: BoldIcon },
  { label: 'Italic', marker: '*', binding: 'Mod+I', Icon: ItalicIcon },
  { label: 'Strikethrough', marker: '~~', binding: 'Shift+Mod+S', Icon: StrikethroughIcon },
  { label: 'Highlight', marker: '==', binding: 'Shift+Mod+H', Icon: HighlighterIcon },
  { label: 'Code', marker: '`', binding: 'Mod+E', Icon: CodeIcon },
  { label: 'Math', marker: '$', binding: 'Shift+Mod+M', Icon: SigmaIcon }
]

const BLOCKS: Array<{ type: BlockType; label: string; Icon?: IconCmp; glyph?: string }> = [
  { type: 'paragraph', label: 'Text', glyph: 'T' },
  { type: 'h1', label: 'Heading 1', glyph: 'H1' },
  { type: 'h2', label: 'Heading 2', glyph: 'H2' },
  { type: 'h3', label: 'Heading 3', glyph: 'H3' },
  { type: 'bullet', label: 'Bulleted list', Icon: ListIcon },
  { type: 'numbered', label: 'Numbered list', glyph: '1.' },
  { type: 'todo', label: 'To-do list', Icon: CheckSquareIcon },
  { type: 'quote', label: 'Quote', glyph: '“' },
  { type: 'code', label: 'Code', Icon: CodeIcon }
]

const BTN =
  'flex h-8 w-8 items-center justify-center rounded-md text-ink-700 outline-none transition-colors hover:bg-paper-200/80 hover:text-accent focus-visible:bg-paper-200/90 focus-visible:text-accent'

interface Hint {
  label: string
  binding?: string
}

function BlockGlyph({ Icon, glyph }: { Icon?: IconCmp; glyph?: string }): JSX.Element {
  if (Icon) return <Icon width={16} height={16} />
  return <span className="text-xs font-semibold tabular-nums">{glyph}</span>
}

function KeyCap({ binding }: { binding: string }): JSX.Element {
  return (
    <kbd className="rounded border border-paper-300 bg-paper-200/70 px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-600">
      {formatKeyToken(binding)}
    </kbd>
  )
}

/**
 * A Notion-style floating "bubble" toolbar over a text selection: a "Turn into"
 * block-type menu, quick inline formatting, a link, and a comment. The footer
 * shows the focused/hovered action's keyboard shortcut. Fully keyboard-navigable
 * (arrows / Enter / Esc) once focused via `Mod+/`.
 */
export function EditorSelectionToolbar({
  x,
  y,
  onWrap,
  onLink,
  onComment,
  onBlockType,
  onDismiss
}: Props): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [hint, setHint] = useState<Hint | null>(null)
  // In Vim mode, h/j/k/l navigate the toolbar too (the controls aren't text
  // inputs, so the letters are free to act as motions).
  const vimMode = useStore((s) => s.vimMode)
  // Roving focus over the toolbar's controls in render order: turn-into,
  // formats…, link, comment.
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuRefs = useRef<Array<HTMLButtonElement | null>>([])
  const TURN_INTO_INDEX = 0
  const FORMAT_START = 1 // first control of the format row
  // Remembered format-row column, so going Turn into → row → Turn into returns
  // to where you were.
  const lastFormatRef = useRef(FORMAT_START)

  useEffect(() => {
    if (menuOpen) menuRefs.current[menuIndex]?.focus()
  }, [menuOpen, menuIndex])

  // Keep the editor's selection: never let a toolbar mousedown move focus/caret.
  const keepSelection = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  const currentIndex = (): number =>
    itemRefs.current.findIndex((el) => el === document.activeElement)

  // h/l (← →): move across the format row; on the Turn-into row there's nothing
  // to move to horizontally.
  const moveHorizontal = (dir: 1 | -1): void => {
    const els = itemRefs.current
    const last = els.length - 1
    const cur = currentIndex()
    if (cur < FORMAT_START) return
    const count = last - FORMAT_START + 1
    if (count <= 0) return
    const rel = (((cur - FORMAT_START + dir) % count) + count) % count
    const next = FORMAT_START + rel
    lastFormatRef.current = next
    els[next]?.focus()
  }

  // j/k (↓ ↑): move between the two rows — Turn into ↔ the format row,
  // returning to the column you left.
  const moveVertical = (): void => {
    const els = itemRefs.current
    const cur = currentIndex()
    if (cur === TURN_INTO_INDEX) {
      const col = Math.min(Math.max(lastFormatRef.current, FORMAT_START), els.length - 1)
      els[col]?.focus()
    } else {
      if (cur >= FORMAT_START) lastFormatRef.current = cur
      els[TURN_INTO_INDEX]?.focus()
    }
  }

  const onToolbarKeyDown = (e: React.KeyboardEvent): void => {
    const k = e.key
    if (menuOpen) {
      const down = k === 'ArrowDown' || (vimMode && k === 'j')
      const up = k === 'ArrowUp' || (vimMode && k === 'k')
      const back = k === 'Escape' || (vimMode && k === 'h')
      if (down) {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % BLOCKS.length)
      } else if (up) {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + BLOCKS.length) % BLOCKS.length)
      } else if (k === 'Enter' || k === ' ' || (vimMode && k === 'l')) {
        e.preventDefault()
        onBlockType(BLOCKS[menuIndex].type)
        setMenuOpen(false)
        onDismiss()
      } else if (back) {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(false)
        itemRefs.current[TURN_INTO_INDEX]?.focus()
      }
      return
    }
    const right = k === 'ArrowRight' || (vimMode && k === 'l')
    const left = k === 'ArrowLeft' || (vimMode && k === 'h')
    const down = k === 'ArrowDown' || (vimMode && k === 'j')
    const up = k === 'ArrowUp' || (vimMode && k === 'k')
    if (right) {
      e.preventDefault()
      // On the Turn-into row the `›` opens its submenu; elsewhere move across.
      if (currentIndex() === TURN_INTO_INDEX) {
        setMenuIndex(0)
        setMenuOpen(true)
      } else {
        moveHorizontal(1)
      }
    } else if (left) {
      e.preventDefault()
      moveHorizontal(-1)
    } else if (down || up) {
      e.preventDefault()
      moveVertical()
    } else if (k === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
    }
  }

  // Assigns the next roving-order ref index as each control renders.
  let idx = 0
  const ref = (): ((el: HTMLButtonElement | null) => void) => {
    const at = idx++
    return (el) => {
      itemRefs.current[at] = el
    }
  }

  return (
    <div
      data-selection-toolbar
      role="toolbar"
      aria-label="Format selection"
      onMouseDown={keepSelection}
      onKeyDown={onToolbarKeyDown}
      className="fixed z-50 flex w-[268px] flex-col rounded-xl bg-paper-100 p-1 text-ink-700 shadow-float ring-1 ring-paper-300"
      style={{ left: x, top: y, transform: 'translateX(-50%)' }}
    >
      {/* Turn into */}
      <button
        ref={ref()}
        data-toolbar-item
        type="button"
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink-700 outline-none transition-colors hover:bg-paper-200/80 focus-visible:bg-paper-200/90"
        onMouseDown={keepSelection}
        onMouseEnter={() => setHint({ label: 'Turn into' })}
        onFocus={() => setHint({ label: 'Turn into' })}
        onClick={() => (menuOpen ? setMenuOpen(false) : (setMenuIndex(0), setMenuOpen(true)))}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <ListIcon width={15} height={15} className="shrink-0 text-ink-500" />
        <span className="flex-1">Turn into</span>
        <ChevronRightIcon
          width={14}
          height={14}
          className={`shrink-0 text-ink-500 transition-transform ${menuOpen ? 'rotate-90' : ''}`}
        />
      </button>

      <div className="my-1 h-px bg-paper-300/70" aria-hidden />

      {/* Inline formatting */}
      <div className="flex items-center gap-0.5">
        {FORMATS.map(({ label, marker, binding, Icon }) => (
          <button
            key={marker}
            ref={ref()}
            data-toolbar-item
            type="button"
            title={`${label} · ${formatKeyToken(binding)}`}
            aria-label={`${label} (${formatKeyToken(binding)})`}
            aria-keyshortcuts={binding}
            className={BTN}
            onMouseDown={keepSelection}
            onMouseEnter={() => setHint({ label, binding })}
            onFocus={() => setHint({ label, binding })}
            onClick={() => onWrap(marker)}
          >
            <Icon width={16} height={16} />
          </button>
        ))}
        <button
          ref={ref()}
          data-toolbar-item
          type="button"
          title={`Link · ${formatKeyToken('Mod+K')}`}
          aria-label={`Insert link (${formatKeyToken('Mod+K')})`}
          aria-keyshortcuts="Mod+K"
          className={BTN}
          onMouseDown={keepSelection}
          onMouseEnter={() => setHint({ label: 'Link', binding: 'Mod+K' })}
          onFocus={() => setHint({ label: 'Link', binding: 'Mod+K' })}
          onClick={onLink}
        >
          <LinkIcon width={16} height={16} />
        </button>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-paper-300/70" aria-hidden />
        <button
          ref={ref()}
          data-toolbar-item
          type="button"
          title="Comment"
          aria-label="Add comment to selection"
          className={BTN}
          onMouseDown={keepSelection}
          onMouseEnter={() => setHint({ label: 'Comment' })}
          onFocus={() => setHint({ label: 'Comment' })}
          onClick={onComment}
        >
          <FeedbackIcon width={16} height={16} />
        </button>
      </div>

      {/* Footer: shows the active action's keyboard shortcut on the popup. */}
      <div className="mt-1 border-t border-paper-300/70 pt-1">
        <div className="flex h-6 items-center justify-between px-1.5 text-xs text-ink-500">
          <span className="truncate">{hint?.label ?? 'Format selection'}</span>
          {hint?.binding ? (
            <KeyCap binding={hint.binding} />
          ) : (
            <span className="font-mono text-[11px] text-ink-400">{formatKeyToken('Mod+/')} nav</span>
          )}
        </div>
      </div>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Turn into"
          className="absolute left-1 top-full z-10 mt-1 w-[200px] overflow-hidden rounded-lg bg-paper-100 p-1 shadow-float ring-1 ring-paper-300"
          onMouseDown={keepSelection}
        >
          {BLOCKS.map(({ type, label, Icon, glyph }, i) => (
            <button
              key={type}
              ref={(el) => {
                menuRefs.current[i] = el
              }}
              role="menuitem"
              type="button"
              className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-ink-700 outline-none transition-colors hover:bg-paper-200/80 hover:text-accent focus-visible:bg-paper-200/90 focus-visible:text-accent ${
                i === menuIndex ? 'bg-paper-200/80' : ''
              }`}
              onMouseEnter={() => setMenuIndex(i)}
              onMouseDown={keepSelection}
              onClick={() => {
                onBlockType(type)
                setMenuOpen(false)
                onDismiss()
              }}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-500">
                <BlockGlyph Icon={Icon} glyph={glyph} />
              </span>
              <span className="flex-1">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
