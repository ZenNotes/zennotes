// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record pages mirror their database row's fields as frontmatter (the table is
// the source of truth). Editing the table — a cell value or an added field —
// must update an OPEN record page's frontmatter live, preserving its body.

const CSV = 'Untitled Database.base/data.csv'
const PAGE = 'Untitled Database.base/pages/test.md'

function baseDoc() {
  return {
    version: 1,
    idFieldId: 'f_id',
    activeViewId: 'v1',
    fields: [
      { id: 'f_id', name: 'id', type: 'text' },
      { id: 'f_name', name: 'Name', type: 'text' },
      { id: 'f_a', name: 'New field', type: 'text' }
    ],
    views: [{ id: 'v1', type: 'table', name: 'Table', columnOrder: ['f_name', 'f_a'] }],
    rows: [{ id: 'row1', cells: { f_id: 'row1', f_name: 'test', f_a: 'old' } }],
    pages: { row1: PAGE }
  }
}

function pageNote(body: string) {
  return {
    path: PAGE,
    title: 'test',
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: '',
    body
  }
}

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      scanTasks: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([]),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      writeNote: vi.fn().mockResolvedValue(pageNote('')),
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined),
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined)
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  return import('./store')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('record page ↔ table sync (table is the source)', () => {
  it('updates an open record page frontmatter when a table cell changes', async () => {
    const { useStore } = await loadStore()
    const doc = baseDoc()
    useStore.setState({
      databases: { [CSV]: doc as never },
      noteContents: { [PAGE]: pageNote('---\nNew field: old\n---\n# test\n\nbody text\n') as never }
    })

    // Edit the "New field" cell from "old" → "new" in the table.
    const next = {
      ...doc,
      rows: [{ id: 'row1', cells: { f_id: 'row1', f_name: 'test', f_a: 'new' } }]
    }
    useStore.getState().updateDatabaseRows(CSV, next as never)

    const body = useStore.getState().noteContents[PAGE]!.body
    expect(body).toContain('New field: new')
    expect(body).not.toContain('New field: old')
    expect(body).toContain('# test') // body preserved
    expect(body).toContain('body text')
  })

  it('adds a newly created field to an open record page frontmatter', async () => {
    const { useStore } = await loadStore()
    const doc = baseDoc()
    useStore.setState({
      databases: { [CSV]: doc as never },
      noteContents: { [PAGE]: pageNote('---\nNew field: old\n---\n# test\n') as never }
    })

    // Add "New field 2" via a schema change.
    const next = {
      ...doc,
      fields: [...doc.fields, { id: 'f_b', name: 'New field 2', type: 'text' }],
      rows: [{ id: 'row1', cells: { f_id: 'row1', f_name: 'test', f_a: 'old', f_b: 'testing' } }]
    }
    useStore.getState().updateDatabaseSchema(CSV, next as never)

    const body = useStore.getState().noteContents[PAGE]!.body
    expect(body).toContain('New field: old')
    expect(body).toContain('New field 2: testing')
  })

  it('leaves a record page that is not open untouched (lazily synced later)', async () => {
    const { useStore } = await loadStore()
    const doc = baseDoc()
    // No noteContents entry for PAGE → it isn't open.
    useStore.setState({ databases: { [CSV]: doc as never }, noteContents: {} })

    const next = { ...doc, rows: [{ id: 'row1', cells: { f_id: 'row1', f_name: 'test', f_a: 'new' } }] }
    useStore.getState().updateDatabaseRows(CSV, next as never)

    expect(useStore.getState().noteContents[PAGE]).toBeUndefined()
  })
})
