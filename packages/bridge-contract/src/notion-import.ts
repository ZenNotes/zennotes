/** What the renderer hears about a Notion import. The token goes in once and
 *  never comes back out: status says only whether one is set. */

export interface NotionImportResult {
  /** Vault-relative path of the folder the import made. */
  folder: string
  /** Vault-relative path of its report note. */
  reportPath: string
  pages: number
  databases: number
  rows: number
  files: number
  /** Things the report lists as left out or changed. */
  issues: number
  /** A Logseq import: journals that came over, and things kept as written. */
  journals?: number
  kept?: number
}

export interface NotionImportProgress {
  phase: 'finding' | 'reading' | 'writing' | 'done' | 'stopped' | 'failed'
  done: number
  total: number
  title?: string
  error?: string
  result?: NotionImportResult
}

export interface NotionImportStatus {
  /** Signed in with Notion: the import can reach the whole workspace. */
  signedIn: boolean
  tokenSet: boolean
  /** False when the system has no secure storage to hold a token. */
  canStore: boolean
  /** The active vault is on a server: an import only writes to a local one. */
  remote: boolean
  running: boolean
  /** An earlier run stopped partway and what it read is still there. */
  resumable: boolean
  progress: NotionImportProgress | null
}

/** One line in the picker. A page's children load when it's opened. */
export interface NotionTreeItem {
  id: string
  title: string
  kind: 'page' | 'database'
}

export interface NotionImportTree {
  workspace: string
  items: NotionTreeItem[]
}

/** One line in the Obsidian picker: the whole vault's shape is known up front. */
export interface ObsidianTreeItem {
  /** Path from the vault's top. */
  id: string
  title: string
  kind: 'folder' | 'note'
  noteCount?: number
  fileCount?: number
  children?: ObsidianTreeItem[]
}

export interface ObsidianImportScan {
  /** The folder, shown to the person and used to open it as its own vault. */
  path: string
  name: string
  /** It holds a `.obsidian` settings folder. */
  isObsidian: boolean
  notes: number
  files: number
  tree: ObsidianTreeItem[]
}

/** What a chosen Logseq graph holds, before anything is copied. */
export interface LogseqImportScan {
  path: string
  name: string
  /** It has `logseq/config.edn`. */
  isLogseq: boolean
  pages: number
  journals: number
  /** Files under assets/, draws/ and whiteboards/. */
  files: number
  /** `.org` pages, which come over as written. */
  orgPages: number
  /** Every journal's date (YYYY-MM-DD), so the app can say where each daily note goes. */
  journalDates: string[]
}

/** Where the app keeps the daily note for one date, as its settings say. */
export interface LogseqDailyNotePlace {
  /** Inside the main notes area, '' for its top. */
  subpath: string
  title: string
  /** The vault already has a daily note for that date. */
  exists: boolean
}

export interface LogseqImportStartOptions {
  /** The folder to make inside the main notes area. */
  folder: string
  /** Journals become daily notes at these places; left out, they stay in the folder. */
  dailyNotes?: Record<string, LogseqDailyNotePlace>
  bullets: boolean
  includeTasks: boolean
}

export type NotionImportTokenResult = { ok: true } | { ok: false; error: string }
