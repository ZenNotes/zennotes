import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../lib/i18n';
import { csvPathFromDatabaseTab } from '@shared/databases'
import { mergeTemplates } from '@shared/template-files'
import { localizedBuiltinTemplates } from '../lib/builtin-templates-i18n'
import type { NoteTemplate } from '@bridge-contract/templates'
import { renderMarkdown } from '../lib/markdown'
import { renderTemplate } from '../lib/template-render'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'
import { useStore } from '../store'
import {
  addField,
  addRow,
  addView,
  setActiveView,
  removeView,
  renameView
} from '../lib/database-cells'
import { DatabaseTableView } from './DatabaseTableView'
import { DatabaseBoardView } from './DatabaseBoardView'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Button, IconButton } from './ui/Button'
import { DatabaseIcon, TableIcon, KanbanIcon, PlusIcon, PanelLeftIcon, PanelRightIcon } from './icons'

/** A short, plain-text teaser of a template body for the picker card. */
function templateExcerpt(body: string): string {
  return body
    .replace(/\{\{.*?\}\}/g, '')
    .replace(/[#>*`_~[\]()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
}

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
  const t = useT()
  const csvPath = csvPathFromDatabaseTab(tabPath)
  const doc = useStore((s) => (csvPath ? s.databases[csvPath] : undefined))
  const loading = useStore((s) => (csvPath ? !!s.databasesLoading[csvPath] : false))
  const loadDatabase = useStore((s) => s.loadDatabase)
  const updateDatabaseRows = useStore((s) => s.updateDatabaseRows)
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const [viewMenu, setViewMenu] = useState<{ viewId: string; x: number; y: number } | null>(null)
  const [renamingView, setRenamingView] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tplPreview, setTplPreview] = useState<{ tpl: NoteTemplate; top: number } | null>(null)
  // Grace timer so the mouse can travel from a card onto the preview without it
  // vanishing (mirrors the connections panel's hover-preview behavior).
  const previewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPreviewClose = (): void => {
    if (previewCloseTimer.current) {
      clearTimeout(previewCloseTimer.current)
      previewCloseTimer.current = null
    }
  }
  const schedulePreviewClose = (): void => {
    cancelPreviewClose()
    previewCloseTimer.current = setTimeout(() => {
      previewCloseTimer.current = null
      setTplPreview(null)
    }, 140)
  }
  const customTemplates = useStore((s) => s.customTemplates)
  const language = useStore((s) => s.language)
  const templates = useMemo(
    () => mergeTemplates(localizedBuiltinTemplates(language), customTemplates),
    [customTemplates, language],
  )
  const settingsWidth = useStore((s) => s.panelWidths.databaseSettings)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(settingsWidth, (px) =>
    setPanelWidth('databaseSettings', px),
  )

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
    { label: t('Rename view'), onSelect: () => setRenamingView(viewId) },
    {
      label: t('Delete view'),
      danger: true,
      disabled: doc.views.length <= 1,
      onSelect: () => updateDatabaseSchema(csvPath, removeView(doc, viewId))
    }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        {!sidebarOpen && isActive && (
          <IconButton size="sm" title={t("Show sidebar (⌘1)")} onClick={() => toggleSidebar()}>
            <PanelLeftIcon className="h-4 w-4" />
          </IconButton>
        )}
        <DatabaseIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="truncate text-sm font-semibold text-ink-900">{doc.title}</h2>
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
                    if (e.key === 'Enter') e.currentTarget.blur()
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
                title={t("Click to switch · double-click to rename · right-click for options")}
                className={[
                  'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                  active ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'
                ].join(' ')}
              >
                <Icon className="h-3.5 w-3.5" />
                {v.name === 'Table' || v.name === 'Board' ? t(v.name) : v.name}
              </button>
            )
          })}
          <IconButton
            size="sm"
            title={t("Add board view")}
            onClick={() => updateDatabaseSchema(csvPath, addView(doc, 'board'))}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {activeView.type !== 'table' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateDatabaseSchema(csvPath, addField(doc))}
            >
              <PlusIcon className="h-3.5 w-3.5" /> {t('Field')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => updateDatabaseRows(csvPath, addRow(doc))}
          >
            <PlusIcon className="h-3.5 w-3.5" /> {t('Add')}
          </Button>
          <div className="mx-2 h-4 w-px self-center bg-paper-300" />
          <IconButton
            size="sm"
            title={t('Form settings')}
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <PanelRightIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeView.type === 'table' ? (
            <DatabaseTableView csvPath={csvPath} doc={doc} view={activeView} isActive={isActive} />
          ) : (
            <DatabaseBoardView csvPath={csvPath} doc={doc} view={activeView} />
          )}
        </div>
        {settingsOpen && (
          <aside
            style={{ width: settingsWidth }}
            className="relative shrink-0 overflow-y-auto border-l border-paper-300/70 bg-paper-50/18 p-4"
          >
            <PanelResizeHandle onStart={startResize} />
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
              {t('Form settings')}
            </div>
            <div className="mt-3 text-sm font-medium text-ink-900">
              {t('Record page template')}
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              {t('Used as the body of new record pages. Existing pages are left unchanged.')}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={() =>
                  updateDatabaseSchema(csvPath, { ...doc, recordPageTemplate: undefined })
                }
                className={[
                  'w-full rounded-xl border p-2.5 text-left transition-colors',
                  !doc.recordPageTemplate
                    ? 'border-accent bg-accent/5 ring-1 ring-accent/35'
                    : 'border-paper-300/65 bg-paper-50/70 hover:border-accent/35 hover:bg-paper-50',
                ].join(' ')}
              >
                <div className="text-sm font-medium text-ink-900">{t('None')}</div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {t('No template — just a # title heading.')}
                </div>
              </button>
              {templates.map((tpl) => {
                const selected = doc.recordPageTemplate === tpl.id
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() =>
                      updateDatabaseSchema(csvPath, { ...doc, recordPageTemplate: tpl.id })
                    }
                    onPointerEnter={(e) => {
                      cancelPreviewClose()
                      setTplPreview({ tpl, top: e.currentTarget.getBoundingClientRect().top })
                    }}
                    onPointerLeave={schedulePreviewClose}
                    className={[
                      'block w-full rounded-xl border p-2.5 text-left transition-colors',
                      selected
                        ? 'border-accent bg-accent/5 ring-1 ring-accent/35'
                        : 'border-paper-300/65 bg-paper-50/70 hover:border-accent/35 hover:bg-paper-50',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-ink-900">{tpl.name}</div>
                      <span className="shrink-0 rounded-full bg-paper-200/80 px-2 py-0.5 text-2xs uppercase tracking-[0.14em] text-ink-500">
                        hover
                      </span>
                    </div>
                    <div className="mt-1.5 line-clamp-3 text-xs leading-5 text-ink-600">
                      {templateExcerpt(tpl.body)}
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>
        )}
        {tplPreview && (
          <div
            className="fixed z-toast flex max-h-[70vh] w-[380px] flex-col overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-50 shadow-float"
            style={{
              // Sit just left of the settings sidebar (its real width + a gap)
              // so the popover never overlaps the cards — overlap steals the
              // hover and makes the preview flicker on the card's left half.
              right: settingsWidth + 12,
              top: Math.max(16, Math.min(tplPreview.top, window.innerHeight - 340)),
            }}
            // Keep the preview open while the pointer is over it, so the mouse
            // can slide from the card onto the preview (connections behavior).
            onPointerEnter={cancelPreviewClose}
            onPointerLeave={schedulePreviewClose}
          >
            <div className="shrink-0 border-b border-paper-300/60 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400">
                {t('Template preview')}
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-ink-900">
                {tplPreview.tpl.name}
              </div>
            </div>
            <div
              className="prose-zen min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm"
              dangerouslySetInnerHTML={{
                // Fill the template tokens with example data (today's date, a
                // sample title, cursor stripped) so the preview reads like a
                // real page instead of raw {{…}} placeholders.
                __html: renderMarkdown(
                  renderTemplate(tplPreview.tpl.body, { title: t('Example title') }).body,
                ),
              }}
            />
          </div>
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
