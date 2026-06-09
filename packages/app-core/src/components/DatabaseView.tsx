import { useEffect } from 'react'
import { csvPathFromDatabaseTab } from '@shared/databases'
import { useStore } from '../store'
import { addField, addRow, addView, setActiveView } from '../lib/database-cells'
import { DatabaseTableView } from './DatabaseTableView'
import { DatabaseBoardView } from './DatabaseBoardView'
import { Button, IconButton } from './ui/Button'
import { DatabaseIcon, TableIcon, KanbanIcon, PlusIcon } from './icons'

/**
 * Host for a CSV database tab: loads the database, renders the header
 * (title + view switcher + add controls) and the active view.
 */
export function DatabaseView({ tabPath }: { tabPath: string }): JSX.Element {
  const csvPath = csvPathFromDatabaseTab(tabPath)
  const doc = useStore((s) => (csvPath ? s.databases[csvPath] : undefined))
  const loading = useStore((s) => (csvPath ? !!s.databasesLoading[csvPath] : false))
  const loadDatabase = useStore((s) => s.loadDatabase)
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        <DatabaseIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="truncate text-sm font-semibold text-ink-900">{doc.title}</h2>
        <span className="shrink-0 text-xs text-ink-500">{doc.rows.length}</span>

        <div className="ml-2 flex items-center gap-0.5 rounded-md bg-paper-200/60 p-0.5">
          {doc.views.map((v) => {
            const active = v.id === activeView.id
            const Icon = v.type === 'board' ? KanbanIcon : TableIcon
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => updateDatabaseSchema(csvPath, setActiveView(doc, v.id))}
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
          <Button variant="ghost" size="sm" onClick={() => updateDatabaseSchema(csvPath, addField(doc))}>
            <PlusIcon className="h-3.5 w-3.5" /> Field
          </Button>
          <Button variant="secondary" size="sm" onClick={() => updateDatabaseRows(csvPath, addRow(doc))}>
            <PlusIcon className="h-3.5 w-3.5" /> Row
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeView.type === 'table' ? (
          <DatabaseTableView csvPath={csvPath} doc={doc} view={activeView} />
        ) : (
          <DatabaseBoardView csvPath={csvPath} doc={doc} view={activeView} />
        )}
      </div>
    </div>
  )
}
