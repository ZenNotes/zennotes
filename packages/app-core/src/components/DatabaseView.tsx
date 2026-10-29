import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { csvPathFromDatabaseTab, formDirFromCsvPath } from '@shared/databases'
import { serializeRows } from '@shared/database-csv'
import { useStore } from '../store'
import { isNoteEditingLocked, subscribeNoteEditingLocks } from '../lib/note-lifecycle-lock'
import {
  addField,
  addRowInView,
  addView,
  clearViewPicks,
  duplicateView,
  setActiveView,
  removeView,
  renameView,
  viewColumnFields,
  visibleColumnIds
} from '../lib/database-cells'
import { isImeComposing } from '../lib/ime'
import { useDatabaseViewCommand } from '../lib/database-view-commands'
import { DatabaseTableView } from './DatabaseTableView'
import { DatabaseBoardView } from './DatabaseBoardView'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { DatabaseFilterMenu } from './DatabaseFilterMenu'
import { DatabaseColumnsMenu } from './DatabaseColumnsMenu'
import { Button, IconButton } from './ui/Button'
import {
  DatabaseIcon,
  TableIcon,
  KanbanIcon,
  PlusIcon,
  FilterIcon,
  MoreIcon,
  ColumnsIcon
} from './icons'

/**
 * Host for a CSV database tab: loads the database, renders the header
 * (title + view switcher + add controls) and the active view.
 */
export function DatabaseView({
  tabPath,
  isActive = true
}: {
  tabPath: string
  isActive?: boolean
}): JSX.Element {
  const csvPath = csvPathFromDatabaseTab(tabPath)
  const doc = useStore((s) => (csvPath ? s.databases[csvPath] : undefined))
  const vault = useStore(s => s.vault)
  const locked = useSyncExternalStore(subscribeNoteEditingLocks, () => isNoteEditingLocked(vault, csvPath))
  const deletingRows = useStore((s) => !!(csvPath && s.databasesDeletingRows[csvPath]))
  const loading = useStore((s) => (csvPath ? !!s.databasesLoading[csvPath] : false))
  const loadDatabase = useStore((s) => s.loadDatabase)
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const renameDatabase = useStore((s) => s.renameDatabase)
  const createAllRecordPages = useStore((s) => s.createAllRecordPages)
  const vimMode = useStore((s) => s.vimMode)
  const [databaseMenu, setDatabaseMenu] = useState<{ x: number; y: number } | null>(null)
  const [viewMenu, setViewMenu] = useState<{ viewId: string; x: number; y: number } | null>(null)
  const [addViewMenu, setAddViewMenu] = useState<{ x: number; y: number } | null>(null)
  const [renamingView, setRenamingView] = useState<string | null>(null)
  const [rawMode, setRawMode] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const [columnsAnchor, setColumnsAnchor] = useState<DOMRect | null>(null)
  const columnsBtnRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // A request to open the Columns popover for a view, carried out once that
  // view is on screen with its Columns button drawn (the `c` key, the
  // palette, and a just-made table view all come through here).
  const pendingColumnsFor = useRef<string | null>(null)
  const [columnsRequest, setColumnsRequest] = useState(0)
  // Only `.base` databases rename by title (a legacy loose `.csv` doesn't).
  const canRenameTitle = !!csvPath && !!formDirFromCsvPath(csvPath)

  const transitioning = useStore(s => s.workspaceTransitioning)
  useEffect(() => {
    if (csvPath && !doc && !loading && !transitioning) void loadDatabase(csvPath)
  }, [csvPath, doc, loading, loadDatabase, transitioning])

  const activeViewId = doc ? (doc.views.find((v) => v.id === doc.activeViewId) ?? doc.views[0])?.id : undefined
  const activeViewType = doc?.views.find((v) => v.id === activeViewId)?.type
  // Each view has its own columns, so switching views closes the popover;
  // a request waiting for the new view opens it again right after.
  useEffect(() => {
    setColumnsAnchor(null)
  }, [activeViewId])
  useEffect(() => {
    if (!pendingColumnsFor.current || pendingColumnsFor.current !== activeViewId) return
    if (activeViewType !== 'table' || rawMode) return
    pendingColumnsFor.current = null
    const rect = columnsBtnRef.current?.getBoundingClientRect()
    if (rect) setColumnsAnchor(rect)
  }, [columnsRequest, activeViewId, activeViewType, rawMode])

  const openColumnsFor = useCallback((viewId: string): void => {
    pendingColumnsFor.current = viewId
    setRawMode(false)
    setColumnsRequest((n) => n + 1)
  }, [])

  // Palette commands for this database's views (Show Only Selected Rows is
  // the Table's: the selection lives there).
  useDatabaseViewCommand(csvPath, isActive, (command) => {
    if (!csvPath || !doc || !activeViewId) return
    if (command === 'columns') {
      if (activeViewType === 'table') openColumnsFor(activeViewId)
    } else if (command === 'new-table-view') {
      const next = addView(doc, 'table')
      updateDatabaseSchema(csvPath, next)
      openColumnsFor(next.activeViewId)
    } else if (command === 'duplicate-view') {
      updateDatabaseSchema(csvPath, duplicateView(doc, activeViewId))
    } else if (command === 'show-all-rows') {
      updateDatabaseSchema(csvPath, clearViewPicks(doc, activeViewId))
    }
  })

  // Back to the grid when the popover closes with nothing else focused (its
  // focused row unmounts with it); a click elsewhere keeps what it focused.
  const closeColumns = useCallback((): void => {
    setColumnsAnchor(null)
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (a && a !== document.body) return
      rootRef.current?.querySelector<HTMLElement>('[data-zen-db-grid]')?.focus({ preventScroll: true })
    })
  }, [])

  if (!csvPath) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        Invalid database.
      </div>
    )
  }
  if (!doc) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        {loading ? 'Loading database…' : 'Opening…'}
      </div>
    )
  }

  const activeView = doc.views.find((v) => v.id === doc.activeViewId) ?? doc.views[0]
  const columnCount = activeView.type === 'table' ? viewColumnFields(doc, activeView).length : 0
  const shownColumnCount = activeView.type === 'table' ? visibleColumnIds(doc, activeView).length : 0
  const someColumnsHidden = shownColumnCount < columnCount

  // A new table view opens the Columns popover at once, so a 44-column
  // database becomes a 5-column view in one go.
  const createView = (type: 'table' | 'board'): void => {
    const next = addView(doc, type)
    updateDatabaseSchema(csvPath, next)
    if (type === 'table') openColumnsFor(next.activeViewId)
  }
  const copyView = (viewId: string): void => updateDatabaseSchema(csvPath, duplicateView(doc, viewId))

  const addViewMenuItems: ContextMenuItem[] = [
    { label: 'New table view', icon: <TableIcon className="h-3.5 w-3.5" />, onSelect: () => createView('table') },
    { label: 'New board view', icon: <KanbanIcon className="h-3.5 w-3.5" />, onSelect: () => createView('board') },
    { kind: 'separator' },
    { label: 'Duplicate this view', onSelect: () => copyView(activeView.id) }
  ]

  const viewMenuItems = (viewId: string): ContextMenuItem[] => [
    { label: 'Rename view', onSelect: () => setRenamingView(viewId) },
    { label: 'Duplicate view', onSelect: () => copyView(viewId) },
    {
      label: 'Delete view',
      danger: true,
      disabled: doc.views.length <= 1,
      onSelect: () => updateDatabaseSchema(csvPath, removeView(doc, viewId))
    }
  ]

  return (
    <div ref={rootRef} {...((deletingRows || locked) ? { inert: '' } : {})} aria-busy={deletingRows || locked} className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        <DatabaseIcon className="h-4 w-4 shrink-0 text-ink-500" />
        {editingTitle && canRenameTitle ? (
          <input
            autoFocus
            defaultValue={doc.title}
            size={Math.max(doc.title.length + 1, 6)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim()
              setEditingTitle(false)
              if (next && next !== doc.title && csvPath) void renameDatabase(csvPath, next)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.currentTarget.value = doc.title
                e.currentTarget.blur()
              }
            }}
            className="max-w-full rounded border border-accent bg-paper-50 px-1.5 py-0.5 text-sm font-semibold text-ink-900 outline-none"
          />
        ) : (
          <h2
            className={[
              'truncate text-sm font-semibold text-ink-900',
              canRenameTitle ? 'cursor-text rounded px-1 -mx-1 hover:bg-paper-200/60' : ''
            ].join(' ')}
            title={canRenameTitle ? 'Double-click to rename' : undefined}
            onDoubleClick={() => canRenameTitle && setEditingTitle(true)}
          >
            {doc.title}
          </h2>
        )}
        <span className="shrink-0 text-xs text-ink-500">{doc.rows.length}</span>

        <div className="ml-2 flex items-center gap-0.5 rounded-md bg-paper-200/60 p-0.5">
          {doc.views.map((v) => {
            const active = v.id === activeView.id
            const Icon = v.type === 'board' ? KanbanIcon : TableIcon
            if (renamingView === v.id) {
              return (
                <input
                  key={v.id}
                  autoFocus
                  defaultValue={v.name}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => {
                    updateDatabaseSchema(csvPath, renameView(doc, v.id, e.currentTarget.value))
                    setRenamingView(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
                    else if (e.key === 'Escape') setRenamingView(null)
                  }}
                  className="w-24 rounded border border-accent bg-paper-50 px-1.5 py-1 text-xs text-ink-900 outline-none"
                />
              )
            }
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => updateDatabaseSchema(csvPath, setActiveView(doc, v.id))}
                onDoubleClick={() => setRenamingView(v.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setViewMenu({ viewId: v.id, x: e.clientX, y: e.clientY })
                }}
                title="Click to switch · double-click to rename · right-click for options"
                className={[
                  'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                  active ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'
                ].join(' ')}
              >
                <Icon className="h-3.5 w-3.5" />
                {v.name}
              </button>
            )
          })}
          <IconButton
            size="sm"
            title="Add a view"
            aria-label="Add a view"
            aria-haspopup="menu"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setAddViewMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={rawMode ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setRawMode((r) => !r)}
            title="Toggle the underlying CSV text"
          >
            {rawMode ? 'Grid' : 'Raw CSV'}
          </Button>
          {!rawMode && (
            <>
              <Button
                ref={filterBtnRef}
                variant={
                  filterAnchor || (activeView.filters?.length ?? 0) > 0 ? 'secondary' : 'ghost'
                }
                size="sm"
                title="Filter rows"
                onClick={(e) => {
                  // Read the anchor rect during dispatch — React nulls the
                  // synthetic event's currentTarget once dispatch ends, and
                  // the updater can run deferred (crashes the root otherwise).
                  const rect = e.currentTarget.getBoundingClientRect()
                  setFilterAnchor((prev) => (prev ? null : rect))
                }}
              >
                <FilterIcon className="h-3.5 w-3.5" /> Filter
                {(activeView.filters?.length ?? 0) > 0 ? ` (${activeView.filters.length})` : ''}
              </Button>
              {activeView.type === 'table' && (
                <Button
                  ref={columnsBtnRef}
                  variant={columnsAnchor || someColumnsHidden ? 'secondary' : 'ghost'}
                  size="sm"
                  title={vimMode ? 'Choose the columns this view shows (c)' : 'Choose the columns this view shows'}
                  aria-haspopup="dialog"
                  aria-expanded={!!columnsAnchor}
                  onClick={(e) => {
                    // Read the rect during dispatch, as the Filter button does.
                    const rect = e.currentTarget.getBoundingClientRect()
                    setColumnsAnchor((prev) => (prev ? null : rect))
                  }}
                >
                  <ColumnsIcon className="h-3.5 w-3.5" /> Columns
                  {someColumnsHidden ? ` ${shownColumnCount} of ${columnCount}` : ''}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateDatabaseSchema(csvPath, addField(doc))}
              >
                <PlusIcon className="h-3.5 w-3.5" /> Field
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // In a view with picks the new row joins them, or it
                  // would vanish the moment it was made.
                  const added = addRowInView(doc, activeView.id)
                  if (added.picksChanged) updateDatabaseSchema(csvPath, added.doc)
                  else updateDatabaseRows(csvPath, added.doc)
                }}
              >
                <PlusIcon className="h-3.5 w-3.5" /> Row
              </Button>
            </>
          )}
          <IconButton
            size="sm"
            title="More database actions"
            aria-label="More database actions"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setDatabaseMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <MoreIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {rawMode ? (
          <pre className="h-full select-text overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-ink-700">
            {serializeRows(doc.rows, doc.fields)}
          </pre>
        ) : activeView.type === 'table' ? (
          <DatabaseTableView
            csvPath={csvPath}
            doc={doc}
            view={activeView}
            isActive={isActive}
            onOpenColumns={() => openColumnsFor(activeView.id)}
          />
        ) : (
          <DatabaseBoardView csvPath={csvPath} doc={doc} view={activeView} />
        )}
      </div>

      {filterAnchor && !rawMode && (
        <DatabaseFilterMenu
          csvPath={csvPath}
          doc={doc}
          view={activeView}
          anchor={filterAnchor}
          ignoreRef={filterBtnRef}
          onClose={() => setFilterAnchor(null)}
        />
      )}

      {columnsAnchor && !rawMode && activeView.type === 'table' && (
        <DatabaseColumnsMenu
          csvPath={csvPath}
          doc={doc}
          view={activeView}
          anchor={columnsAnchor}
          ignoreRef={columnsBtnRef}
          onClose={closeColumns}
        />
      )}

      {databaseMenu && (
        <ContextMenu
          x={databaseMenu.x}
          y={databaseMenu.y}
          items={[
            {
              label: 'Create pages for all records',
              hint: vimMode ? 'O' : undefined,
              disabled: doc.rows.length === 0 || !formDirFromCsvPath(csvPath),
              onSelect: () => void createAllRecordPages(csvPath)
            }
          ]}
          onClose={() => setDatabaseMenu(null)}
        />
      )}

      {addViewMenu && (
        <ContextMenu
          x={addViewMenu.x}
          y={addViewMenu.y}
          items={addViewMenuItems}
          onClose={() => setAddViewMenu(null)}
        />
      )}

      {viewMenu && (
        <ContextMenu
          x={viewMenu.x}
          y={viewMenu.y}
          items={viewMenuItems(viewMenu.viewId)}
          onClose={() => setViewMenu(null)}
        />
      )}
    </div>
  )
}
