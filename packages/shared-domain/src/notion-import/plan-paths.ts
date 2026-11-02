import { FORM_DIR_SUFFIX, FORM_PAGES_DIR } from '../databases'

/**
 * Where each Notion page and database lands inside the import folder.
 *
 * A Notion page can hold subpages, a Markdown file can't, so a page with
 * children is `Title.md` beside a `Title/` folder. Rows become record pages in
 * their database's `pages/` folder, with any subpages under `pages/<Row>/`,
 * where the note walker still finds them.
 *
 * A database inside a record page moves up to the nearest ordinary folder: the
 * folder list does not descend into `.base`, so a nested one would be
 * invisible. Database titles are also unique across the whole import, not just
 * per folder, because a database's `[[wikilink]]` resolves by title alone.
 */

export interface NotionPlanNode {
  id: string
  kind: 'page' | 'database'
  title: string
  parentId: string | null
  /** A row of the database `parentId` names. */
  isRow?: boolean
}

export interface NotionPlannedNode {
  id: string
  kind: 'page' | 'database'
  /** Relative to the import folder: a `.md` file, or a `.base` folder. */
  path: string
  /** The file or folder name, with no extension or suffix. */
  name: string
  /** The name had to differ from the title, so the note has to say the title. */
  renamed: boolean
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const MAX_NAME_LENGTH = 100

/** Folder and file names the import itself needs at its top level. */
export const NOTION_ASSETS_DIR = 'assets'
export const NOTION_REPORT_NAME = 'Import Report'

/**
 * A name safe on every platform the vault may travel to, and safe inside a
 * wikilink: `#`, `^`, `[`, `]` and `|` all mean something there, and a leading
 * dot would hide the note from every walker.
 */
export function safeNotionName(title: string): string {
  let name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:\u0000-\u001f*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (name.length > MAX_NAME_LENGTH) {
    // Array.from walks code points, so an emoji is never cut in half.
    name = Array.from(name).slice(0, MAX_NAME_LENGTH).join('').replace(/[. ]+$/, '')
  }
  if (name.toLowerCase().endsWith(FORM_DIR_SUFFIX)) {
    name = `${name.slice(0, -FORM_DIR_SUFFIX.length)} base`
  }
  if (WINDOWS_RESERVED.test(name)) name = `${name}-`
  return name || 'Untitled'
}

function claimName(taken: Set<string>, base: string): string {
  let candidate = base
  let n = 1
  while (taken.has(candidate.toLowerCase())) {
    n += 1
    candidate = `${base} ${n}`
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

export function planNotionPaths(nodes: NotionPlanNode[]): Map<string, NotionPlannedNode> {
  const ids = new Set(nodes.map((node) => node.id))
  const children = new Map<string | null, NotionPlanNode[]>()
  for (const node of nodes) {
    // A parent the token can't see makes its child a top-level page.
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }

  const planned = new Map<string, NotionPlannedNode>()
  const takenByDir = new Map<string, Set<string>>()
  takenByDir.set('', new Set([NOTION_ASSETS_DIR, NOTION_REPORT_NAME.toLowerCase()]))
  const databaseTitles = new Set<string>()

  const takenIn = (dir: string): Set<string> => {
    let taken = takenByDir.get(dir)
    if (!taken) {
      taken = new Set()
      takenByDir.set(dir, taken)
    }
    return taken
  }
  const join = (dir: string, leaf: string): string => (dir ? `${dir}/${leaf}` : leaf)

  /** `dir` receives pages; `databaseDir` receives databases, and differs from
   *  `dir` only inside a `.base` folder. */
  const place = (node: NotionPlanNode, dir: string, databaseDir: string): void => {
    if (planned.has(node.id)) return
    const safe = safeNotionName(node.title)
    const renamed = safe !== node.title.trim()
    const kids = children.get(node.id) ?? []

    if (node.kind === 'database') {
      const taken = takenIn(databaseDir)
      // Unique across the import and in its folder.
      let name = claimName(databaseTitles, safe)
      if (taken.has(name.toLowerCase())) {
        name = claimName(databaseTitles, `${safe} database`)
      }
      taken.add(name.toLowerCase())
      const path = join(databaseDir, `${name}${FORM_DIR_SUFFIX}`)
      planned.set(node.id, { id: node.id, kind: 'database', path, name, renamed })
      for (const kid of kids) place(kid, `${path}/${FORM_PAGES_DIR}`, databaseDir)
      return
    }

    const name = claimName(takenIn(dir), safe)
    const path = join(dir, `${name}.md`)
    planned.set(node.id, { id: node.id, kind: 'page', path, name, renamed })
    const childDir = join(dir, name)
    const insideBase = dir.includes(`${FORM_DIR_SUFFIX}/`)
    for (const kid of kids) place(kid, childDir, insideBase ? databaseDir : childDir)
  }

  for (const root of children.get(null) ?? []) place(root, '', '')
  // Only a parent cycle reaches this; API data shouldn't have one, but losing
  // a page to it would be silent.
  for (const node of nodes) if (!planned.has(node.id)) place(node, '', '')
  return planned
}
