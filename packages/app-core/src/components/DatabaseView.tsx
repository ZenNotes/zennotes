import { useEffect, useState } from 'react'
import { csvPathFromDatabaseTab, formDirFromCsvPath } from '@shared/databases'
import { serializeRows } from '@shared/database-csv'
import { useStore } from '../store'
import {
  addField,
  addRow,
  addView,
  setActiveView,
  removeView,
  renameView
} from '../lib/database-cells'
import { isImeComposing } from '../lib/ime'
import { DatabaseTableView } from './DatabaseTableView'
import { DatabaseBoardView } from './DatabaseBoardView'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Button, IconButton } from './ui/Button'
import { DatabaseIcon, TableIcon, KanbanIcon, PlusIcon } from './icons'

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
  const loading = useStore((s) => (csvPath ? !!s.databasesLoading[csvPath] : false))
  const loadDatabase = useStore((s) => s.loadDatabase)
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const renameDatabase = useStore((s) => s.renameDatabase)
  const [viewMenu, setViewMenu] = useState<{ viewId: string; x: number; y: number } | null>(null)
  const [renamingView, setRenamingView] = useState<string | null>(null)
  const [rawMode, setRawMode] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  // Only `.base` databases rename by title (a legacy loose `.csv` doesn't).
  const canRenameTitle = !!csvPath && !!formDirFromCsvPath(csvPath)

  useEffect(() => {
    if (csvPath && !doc && !loading) void loadDatabase(csvPath)
  }, [csvPath, doc, loading, loadDatabase])

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

  const viewMenuItems = (viewId: string): ContextMenuItem[] => [
    { label: 'Rename view', onSelect: () => setRenamingView(viewId) },
    {
      label: 'Delete view',
      danger: true,
      disabled: doc.views.length <= 1,
      onSelect: () => updateDatabaseSchema(csvPath, removeView(doc, viewId))
    }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
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
            title="Add board view"
            onClick={() => updateDatabaseSchema(csvPath, addView(doc, 'board'))}
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
                variant="ghost"
                size="sm"
                onClick={() => updateDatabaseSchema(csvPath, addField(doc))}
              >
                <PlusIcon className="h-3.5 w-3.5" /> Field
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateDatabaseRows(csvPath, addRow(doc))}
              >
                <PlusIcon className="h-3.5 w-3.5" /> Row
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {rawMode ? (
          <pre className="h-full select-text overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-ink-700">
            {serializeRows(doc.rows, doc.fields)}
          </pre>
        ) : activeView.type === 'table' ? (
          <DatabaseTableView csvPath={csvPath} doc={doc} view={activeView} isActive={isActive} />
        ) : (
          <DatabaseBoardView csvPath={csvPath} doc={doc} view={activeView} />
        )}
      </div>

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
