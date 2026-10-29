import { describe, expect, it } from 'vitest'
import {
  compareMcpScopePaths,
  foldMcpScopePath,
  isInsideMcpScopeEntry,
  isInsideMcpScopeEntryFolded,
  isMcpScopeActive,
  isMcpToolOffered,
  MCP_TOOL_ACCESS,
  mcpAccessRefusal,
  mcpScopeAccessInfo,
  mcpScopeFromFlags,
  mcpScopeInstructions,
  mcpToolAnnotations,
  newMcpScope
} from './mcp-scope'

// The flag refusals, tool lists and listings are held to the Go `zn mcp` by
// the shared fixture (bridge-contract/fixtures/mcp-scope.json); these cover
// the pure rules underneath it.

describe('MCP scope matching', () => {
  it('matches whole segments only', () => {
    expect(isInsideMcpScopeEntry('Projects/x.md', 'Projects')).toBe(true)
    expect(isInsideMcpScopeEntry('Projects', 'Projects')).toBe(true)
    expect(isInsideMcpScopeEntry('Projects2/x.md', 'Projects')).toBe(false)
    expect(isInsideMcpScopeEntry('projects/x.md', 'Projects')).toBe(false)
  })

  it('folds case and accents for deny entries, the way zn does', () => {
    expect(foldMcpScopePath('Café/Menu.md')).toBe('cafe/menu.md')
    expect(foldMcpScopePath('CAFÉ')).toBe('cafe')
    // Lower-cased one code point at a time, so no final sigma: Go's
    // strings.ToLower has none.
    expect(foldMcpScopePath('ΟΔΟΣ')).toBe('οδοσ')
    expect(isInsideMcpScopeEntryFolded('café/MENU.md', 'CAFE')).toBe(true)
    expect(isInsideMcpScopeEntryFolded('Cafeteria/x.md', 'Café')).toBe(false)
  })

  it('sorts by code point, as Go sorts strings', () => {
    // UTF-16 order puts the emoji's surrogate pair first; byte order does not.
    expect(['😀', '～'].sort(compareMcpScopePaths)).toEqual(['～', '😀'])
    expect(['b', 'B', 'a'].sort(compareMcpScopePaths)).toEqual(['B', 'a', 'b'])
  })
})

describe('MCP scope flags', () => {
  it('means full access when no flag is given', () => {
    expect(mcpScopeFromFlags({ allow: [], deny: [] })).toBeNull()
    expect(isMcpScopeActive(mcpScopeFromFlags({ access: 'write' }))).toBe(false)
    expect(isMcpScopeActive(mcpScopeFromFlags({ readOnly: true }))).toBe(true)
  })

  it('refuses rather than widen', () => {
    expect(() => newMcpScope({ allow: ['Projects', '.git'] })).toThrow('names a hidden folder')
    expect(() => newMcpScope({ access: 'owner' })).toThrow('--access must be')
  })
})

describe('MCP tools under a scope', () => {
  const read = newMcpScope({ access: 'read' })
  const comment = newMcpScope({ access: 'comment' })
  const write = newMcpScope({ access: 'write', allow: ['Projects'] })

  it('offers each tool by its access class', () => {
    expect(isMcpToolOffered('read_note', read)).toBe(true)
    expect(isMcpToolOffered('add_comment', read)).toBe(false)
    expect(isMcpToolOffered('add_comment', comment)).toBe(true)
    expect(isMcpToolOffered('toggle_task', comment)).toBe(false)
    expect(isMcpToolOffered('toggle_task', write)).toBe(true)
    expect(isMcpToolOffered('anything', null)).toBe(true)
  })

  it('never offers a tool that acts on every path to a client that sees some', () => {
    expect(isMcpToolOffered('empty_trash', write)).toBe(false)
    expect(isMcpToolOffered('empty_trash', newMcpScope({ access: 'write' }))).toBe(true)
  })

  it('treats a tool nobody classified as acting on every path', () => {
    expect(MCP_TOOL_ACCESS).not.toHaveProperty('new_tool')
    expect(isMcpToolOffered('new_tool', write)).toBe(false)
    expect(isMcpToolOffered('new_tool', read)).toBe(false)
    expect(mcpToolAnnotations('new_tool')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })

  it('says what a tool does to the vault', () => {
    expect(mcpToolAnnotations('search_text')).toEqual({
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false
    })
    expect(mcpToolAnnotations('delete_folder')).toMatchObject({ destructiveHint: true })
    expect(mcpToolAnnotations('append_to_note')).toMatchObject({ destructiveHint: false })
  })

  it('refuses a tool above the access level without naming a path', () => {
    expect(mcpAccessRefusal(read)).toBe('This assistant can only read this vault.')
    expect(mcpAccessRefusal(comment)).toBe(
      'This assistant can only read this vault and comment on notes.'
    )
  })
})

describe('what a scoped client is told', () => {
  it('asks the model not to guess at hidden notes only when paths are hidden', () => {
    const narrowed = mcpScopeInstructions(newMcpScope({ access: 'read', allow: ['Projects'] }))
    expect(narrowed).toContain('do not guess')
    expect(narrowed).toContain('You can read but not change anything.')
    expect(narrowed).toContain('`vault_info`')
    expect(mcpScopeInstructions(newMcpScope({ access: 'comment' }))).not.toContain('do not guess')
  })

  it('reports allow entries sorted and never the deny entries', () => {
    const scope = newMcpScope({ access: 'read', allow: ['Zeta', 'Alpha'], deny: ['Secret'] })
    const info = mcpScopeAccessInfo(scope, ['Zeta', 'Alpha'], ['Zeta'])
    expect(info).toEqual({ level: 'read', partial: true, allow: ['Alpha', 'Zeta'], missingAllow: ['Zeta'] })
    expect(JSON.stringify(info)).not.toContain('Secret')
    expect(mcpScopeAccessInfo(scope, [], [], 'why').blocked).toBe('why')
  })
})
