// Scoped access for the MCP servers (ZenNotes/tui#21): what an MCP client may
// see and change, fixed when the server starts from its own launch flags. No
// tool argument can name or widen a scope; tools only narrow inside it.
//
// This module is the normative copy of the rules. The desktop's bundled MCP
// server imports it (apps/desktop/src/mcp/scoped-backend.ts), and the Go
// `zn mcp` mirrors it in internal/mcp/scope.go in ZenNotes/tui, so a client
// gets the same answers whichever binary its config launches. The shared
// fixture packages/bridge-contract/fixtures/mcp-scope.json holds both to the
// same bytes; change the rules here, there and in the fixture together.

/** How much a client may do to what it can see. */
export type McpAccess = 'read' | 'comment' | 'write'

const ACCESS_RANK: Record<McpAccess, number> = { read: 0, comment: 1, write: 2 }

/** Whether `have` allows what `need` asks for. */
export function mcpAccessAtLeast(have: McpAccess, need: McpAccess): boolean {
  return ACCESS_RANK[have] >= ACCESS_RANK[need]
}

/**
 * An access level plus the paths a client may see. An empty `allow` means
 * the whole vault; a non-empty one shows only what it names (default-deny),
 * and `deny` hides paths even inside it. Entries are vault-relative paths
 * exactly as the tools report them, so remapped system folders need no
 * translation.
 */
export interface McpScope {
  access: McpAccess
  allow: string[]
  deny: string[]
}

/** The `zn mcp` flags a scope is built from, as parsed off the command line. */
export interface McpScopeFlags {
  allow?: readonly string[]
  deny?: readonly string[]
  access?: string
  readOnly?: boolean
}

/** Reads `read`, `comment` or `write`, and the spellings people reach for. */
export function parseMcpAccess(raw: string): McpAccess {
  switch (raw.trim().toLowerCase()) {
    case 'read':
    case 'read-only':
    case 'readonly':
      return 'read'
    case 'comment':
      return 'comment'
    case 'write':
    case 'edit':
      return 'write'
  }
  throw new Error(`--access must be read, comment or write, not ${goQuote(raw)}`)
}

/**
 * Builds a scope from `zn mcp` flags. `readOnly` lowers access to read
 * whatever `access` says; no access at all is write, the behavior without a
 * scope. A bad entry throws: it never silently widens what a client sees.
 */
export function newMcpScope(flags: McpScopeFlags): McpScope {
  let access: McpAccess = 'write'
  if ((flags.access ?? '').trim()) access = parseMcpAccess(flags.access ?? '')
  if (flags.readOnly) access = 'read'
  return {
    access,
    allow: normalizeMcpScopeEntries('--allow-path', flags.allow ?? []),
    deny: normalizeMcpScopeEntries('--deny-path', flags.deny ?? [])
  }
}

/** The scope the flags ask for, or null when none were given: full access,
 *  exactly as before scopes existed. */
export function mcpScopeFromFlags(flags: McpScopeFlags): McpScope | null {
  if (
    (flags.allow ?? []).length === 0 &&
    (flags.deny ?? []).length === 0 &&
    !flags.access &&
    !flags.readOnly
  ) {
    return null
  }
  return newMcpScope(flags)
}

/**
 * Validates entries the way the Tasks folder lists are validated
 * (`normalizeTasksExcludedFolder`: forward slashes, trimmed segments, no `.`
 * or `..`, at most 512 characters, duplicates dropped, order kept), and
 * refuses hidden entries, which never hold anything a client can see. A
 * leading slash is accepted: an entry is always vault-relative.
 */
export function normalizeMcpScopeEntries(flag: string, values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const parts: string[] = []
    for (const seg of raw.replace(/\\/g, '/').split('/')) {
      const s = seg.trim()
      if (!s) continue
      if (s === '.' || s === '..') {
        throw new Error(
          `${flag} ${goQuote(raw)}: . and .. are not allowed; name a folder or note inside the vault`
        )
      }
      if (s.startsWith('.')) {
        throw new Error(`${flag} ${goQuote(raw)} names a hidden folder, which an assistant never sees`)
      }
      if (s.includes('\u0000')) throw new Error(`${flag} ${goQuote(raw)} is not a valid path`)
      parts.push(s)
    }
    if (parts.length === 0) {
      throw new Error(`${flag} ${goQuote(raw)} is empty; name a folder or note inside the vault`)
    }
    const joined = parts.join('/')
    if (joined.length > 512) throw new Error(`${flag} ${goQuote(raw)} is longer than 512 characters`)
    if (seen.has(joined)) continue
    seen.add(joined)
    out.push(joined)
  }
  return out
}

/** Whether the scope narrows the paths at all. */
export function isMcpScopeRestricted(scope: McpScope): boolean {
  return scope.allow.length > 0 || scope.deny.length > 0
}

/** Whether the scope changes anything compared with full access. */
export function isMcpScopeActive(scope: McpScope | null | undefined): scope is McpScope {
  return !!scope && (isMcpScopeRestricted(scope) || scope.access !== 'write')
}

/* ---------- Matching ---------------------------------------------------- */

/**
 * Case and accent folding: decompose, drop the nonspacing marks, recompose,
 * lower-case one code point at a time. The Go side is `search.Fold`; lowering
 * per code point keeps JavaScript's context-sensitive final sigma out of it,
 * so both sides fold `ΟΔΟΣ` the same way.
 */
export function foldMcpScopePath(value: string): string {
  const stripped = value.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC')
  let out = ''
  for (const ch of stripped) out += ch.toLowerCase()
  return out
}

/** The segment-prefix rule of the Tasks folder lists: `Projects` covers
 *  `Projects/x.md`, never `Projects2/x.md`. */
export function isInsideMcpScopeEntry(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`)
}

/** The same rule after case and accent folding. Deny entries match this way
 *  on purpose: on a case- or normalization-insensitive volume a near miss
 *  must over-hide, never leak. */
export function isInsideMcpScopeEntryFolded(path: string, entry: string): boolean {
  return isInsideMcpScopeEntry(foldMcpScopePath(path), foldMcpScopePath(entry))
}

/** Sorts by code point, which is UTF-8 byte order, as Go's sort.Strings does. */
export function compareMcpScopePaths(a: string, b: string): number {
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const ca = ia.next()
    const cb = ib.next()
    if (ca.done || cb.done) return ca.done === cb.done ? 0 : ca.done ? -1 : 1
    const diff = (ca.value.codePointAt(0) ?? 0) - (cb.value.codePointAt(0) ?? 0)
    if (diff !== 0) return diff
  }
}

/* ---------- Tools ------------------------------------------------------- */

/**
 * What a tool needs. `unscopedWrite` acts on content regardless of path
 * (empty_trash deletes every trashed note), so no path-restricted client gets
 * it.
 */
export type McpToolClass = 'read' | 'comment' | 'write' | 'unscopedWrite'

/** Every MCP tool and what it needs. A tool missing here is treated as
 *  `unscopedWrite`, and a test in each engine fails until it is classified. */
export const MCP_TOOL_ACCESS: Readonly<Record<string, McpToolClass>> = {
  vault_info: 'read',
  list_notes: 'read',
  list_folders: 'read',
  list_assets: 'read',
  read_note: 'read',
  search_text: 'read',
  search_by_title: 'read',
  search_by_tag: 'read',
  list_tags: 'read',
  backlinks: 'read',
  list_tasks: 'read',
  list_comments: 'read',
  add_comment: 'comment',
  reply_to_comment: 'comment',
  resolve_comment: 'comment',
  toggle_task: 'write',
  write_note: 'write',
  append_to_note: 'write',
  prepend_to_note: 'write',
  insert_at_line: 'write',
  replace_in_note: 'write',
  create_note: 'write',
  rename_note: 'write',
  move_note: 'write',
  duplicate_note: 'write',
  archive_note: 'write',
  unarchive_note: 'write',
  move_to_trash: 'write',
  restore_from_trash: 'write',
  delete_note: 'write',
  create_folder: 'write',
  rename_folder: 'write',
  delete_folder: 'write',
  empty_trash: 'unscopedWrite'
}

/** Tools that may destroy content rather than add to it or move it. */
export const MCP_DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'write_note',
  'replace_in_note',
  'delete_note',
  'delete_folder',
  'empty_trash'
])

export function mcpToolClass(name: string): McpToolClass {
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_ACCESS, name)
    ? (MCP_TOOL_ACCESS[name] as McpToolClass)
    : 'unscopedWrite'
}

/** Whether a scope offers a tool. No scope is full access. A tool a scope
 *  does not offer is not listed at all, so the model never plans around it. */
export function isMcpToolOffered(name: string, scope: McpScope | null | undefined): boolean {
  if (!scope) return true
  switch (mcpToolClass(name)) {
    case 'read':
      return true
    case 'comment':
      return mcpAccessAtLeast(scope.access, 'comment')
    case 'write':
      return scope.access === 'write'
    default:
      return scope.access === 'write' && !isMcpScopeRestricted(scope)
  }
}

export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** Tells clients which tools only read and which can destroy, so a client
 *  that confirms destructive calls can, scoped or not. The vault is a closed
 *  world. `readOnlyHint` and `idempotentHint` are spelled out even when false,
 *  as the Go MCP SDK always sends them, so both engines list the same bytes. */
export function mcpToolAnnotations(name: string): McpToolAnnotations {
  if (mcpToolClass(name) === 'read') {
    return { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }
  return {
    readOnlyHint: false,
    destructiveHint: MCP_DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: false,
    openWorldHint: false
  }
}

/** The answer to a tool above the scope's access level. It names no path, so
 *  it says nothing about the vault. */
export function mcpAccessRefusal(scope: McpScope): string {
  switch (scope.access) {
    case 'read':
      return 'This assistant can only read this vault.'
    case 'comment':
      return 'This assistant can only read this vault and comment on notes.'
  }
  return 'This assistant cannot use that tool on a vault it only partly sees.'
}

/** Appended to the server instructions while a scope is active, so the model
 *  neither guesses at hidden notes nor tries tools it does not have. */
export function mcpScopeInstructions(scope: McpScope): string {
  let text = '\n\n## Access\n\n'
  if (isMcpScopeRestricted(scope)) {
    text +=
      "This server shows part of the user's vault. Paths and notes you are not shown do not exist for you: do not guess at them, and treat a [[link]] that does not resolve as pointing outside what you can see. "
  }
  if (scope.access === 'read') text += 'You can read but not change anything. '
  else if (scope.access === 'comment') text += 'You can read and comment on notes, but not change them. '
  return `${text}Call \`vault_info\` to see what you can reach.`
}

/** The sentence vault_info adds to its notes when the paths are narrowed. */
export const MCP_SCOPE_VAULT_INFO_NOTE =
  ' You see part of this vault: `access.allow` lists what was shared (empty means everything except some hidden paths). Anything else does not exist for you.'

export interface McpScopeAccessInfo {
  level: McpAccess
  partial: boolean
  allow: string[]
  missingAllow: string[]
  blocked?: string
}

/**
 * The scope as vault_info reports it: allow entries in the vault's spelling
 * and the ones that match nothing. Deny entries are never named, since the
 * names alone can say too much. `blocked` is why the scope shares nothing,
 * when it does not.
 */
export function mcpScopeAccessInfo(
  scope: McpScope,
  allow: readonly string[],
  missingAllow: readonly string[],
  blocked?: string | null
): McpScopeAccessInfo {
  const info: McpScopeAccessInfo = {
    level: scope.access,
    partial: isMcpScopeRestricted(scope),
    allow: [...allow].sort(compareMcpScopePaths),
    missingAllow: [...missingAllow].sort(compareMcpScopePaths)
  }
  if (blocked) info.blocked = blocked
  return info
}

/* ---------- Messages ---------------------------------------------------- */

/** Go's `%q` for the strings a flag can hold, so a refusal reads byte for
 *  byte the same from either engine: printable text as is, ASCII controls
 *  escaped the way strconv.Quote escapes them. */
function goQuote(value: string): string {
  const named: Record<string, string> = {
    '\u0007': '\\a',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\u000b': '\\v',
    '\\': '\\\\',
    '"': '\\"'
  }
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (named[ch]) out += named[ch]
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}"`
}
