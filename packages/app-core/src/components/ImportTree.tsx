import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { ChevronRightIcon, DatabaseIcon, DocumentIcon } from './icons'
import { FolderGlyph } from './ImportGlyphs'

export interface ImportTreeItem {
  id: string
  title: string
  kind: 'page' | 'database' | 'folder' | 'note'
  /** Shown quietly at the end of the row: "12 notes". */
  detail?: string
  /** Already known. Absent on a page whose children load when it's opened. */
  children?: ImportTreeItem[]
}

interface Row {
  item: ImportTreeItem
  depth: number
  /** An ancestor is left out, so this one is too, whatever its own box says. */
  blocked: boolean
}

/**
 * What to bring over, as a tree with everything ticked. Both imports use it: a
 * Notion page's children load when it's opened, since listing them means
 * reading the page, while an Obsidian vault's are known up front.
 */
export function ImportTree({
  roots,
  excluded,
  onExcludedChange,
  loadChildren,
  onError,
  label
}: {
  roots: ImportTreeItem[]
  excluded: Set<string>
  onExcludedChange: (next: Set<string>) => void
  loadChildren?: (item: ImportTreeItem) => Promise<ImportTreeItem[]>
  onError?: (message: string) => void
  label: string
}): JSX.Element {
  const vimMode = useStore((s) => s.vimMode)
  const [loaded, setLoaded] = useState<Map<string, ImportTreeItem[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const treeRef = useRef<HTMLDivElement>(null)

  const childrenOf = useCallback(
    (item: ImportTreeItem): ImportTreeItem[] | undefined => item.children ?? loaded.get(item.id),
    [loaded]
  )
  const canOpen = (item: ImportTreeItem): boolean => {
    if (item.kind === 'database' || item.kind === 'note') return false
    const kids = childrenOf(item)
    return kids === undefined || kids.length > 0
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const walk = (items: ImportTreeItem[], depth: number, blocked: boolean): void => {
      for (const item of items) {
        out.push({ item, depth, blocked })
        if (expanded.has(item.id)) {
          walk(childrenOf(item) ?? [], depth + 1, blocked || excluded.has(item.id))
        }
      }
    }
    walk(roots, 0, false)
    return out
  }, [roots, expanded, excluded, childrenOf])

  const open = async (item: ImportTreeItem): Promise<void> => {
    if (!canOpen(item)) return
    setExpanded((set) => new Set(set).add(item.id))
    if (childrenOf(item) !== undefined || loading.has(item.id) || !loadChildren) return
    setLoading((set) => new Set(set).add(item.id))
    const done = (): void =>
      setLoading((set) => {
        const next = new Set(set)
        next.delete(item.id)
        return next
      })
    try {
      const items = await loadChildren(item)
      setLoaded((map) => new Map(map).set(item.id, items))
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
      setExpanded((set) => {
        const next = new Set(set)
        next.delete(item.id)
        return next
      })
    }
    done()
  }

  const close = (item: ImportTreeItem): void => {
    setExpanded((set) => {
      const next = new Set(set)
      next.delete(item.id)
      return next
    })
  }

  const toggle = (row: Row): void => {
    if (row.blocked) return
    const next = new Set(excluded)
    if (next.has(row.item.id)) next.delete(row.item.id)
    else next.add(row.item.id)
    onExcludedChange(next)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const row = rows[cursor]
    if (!row) return
    const { key } = e
    if (key === 'ArrowDown' || (vimMode && key === 'j')) setCursor((c) => Math.min(c + 1, rows.length - 1))
    else if (key === 'ArrowUp' || (vimMode && key === 'k')) setCursor((c) => Math.max(c - 1, 0))
    else if (key === 'ArrowRight' || (vimMode && key === 'l')) {
      if (canOpen(row.item) && !expanded.has(row.item.id)) void open(row.item)
      else if (rows[cursor + 1]?.depth === row.depth + 1) setCursor(cursor + 1)
    } else if (key === 'ArrowLeft' || (vimMode && key === 'h')) {
      if (expanded.has(row.item.id)) close(row.item)
      else if (row.depth > 0) {
        for (let i = cursor - 1; i >= 0; i--) {
          if (rows[i].depth === row.depth - 1) {
            setCursor(i)
            break
          }
        }
      }
    } else if (key === ' ') toggle(row)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    treeRef.current?.querySelector(`[data-tree-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  useEffect(() => {
    treeRef.current?.focus()
  }, [])

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKey}
      data-import-tree
      className="max-h-[46vh] overflow-y-auto rounded-xl border border-paper-300/60 bg-paper-100/40 p-1 outline-none transition-colors focus:border-accent/60"
    >
      {rows.map((row, index) => {
        const { item, depth, blocked } = row
        const isOpen = expanded.has(item.id)
        const out = blocked || excluded.has(item.id)
        const openable = canOpen(item)
        const Icon = item.kind === 'database' ? DatabaseIcon : item.kind === 'folder' ? FolderGlyph : DocumentIcon
        return (
          <div
            key={item.id}
            role="treeitem"
            aria-selected={index === cursor}
            aria-checked={!out}
            aria-expanded={openable ? isOpen : undefined}
            aria-level={depth + 1}
            data-tree-index={index}
            data-import-tree-item={item.id}
            data-import-tree-out={out ? 'true' : undefined}
            onMouseDown={() => setCursor(index)}
            className={[
              'flex items-center gap-1.5 rounded-lg py-1 pr-2.5 text-sm transition-colors',
              index === cursor ? 'bg-paper-200/80' : 'hover:bg-paper-200/40',
              out ? 'text-ink-400' : 'text-ink-800'
            ].join(' ')}
            style={{ paddingLeft: 6 + depth * 18 }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              disabled={!openable}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-500 hover:text-ink-800 disabled:invisible"
              onClick={() => (isOpen ? close(item) : void open(item))}
            >
              <ChevronRightIcon
                width={12}
                height={12}
                className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
            </button>
            <input
              type="checkbox"
              tabIndex={-1}
              checked={!out}
              disabled={blocked}
              aria-label={item.title}
              onChange={() => toggle(row)}
              className="shrink-0 accent-[rgb(var(--z-accent))]"
            />
            <Icon width={14} height={14} className="ml-1 shrink-0 opacity-60" />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {loading.has(item.id) && <span className="shrink-0 text-xs text-ink-400">…</span>}
            {item.detail && <span className="shrink-0 text-xs text-ink-400">{item.detail}</span>}
          </div>
        )
      })}
    </div>
  )
}
