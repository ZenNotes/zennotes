#!/usr/bin/env node
/**
 * Legacy stdio entry for the ZenNotes MCP server. The real
 * implementation lives in ./server. Existing user installs (Claude
 * Code / Desktop / Codex configs that already point at this file)
 * keep working through this shim; new installs prefer the unified
 * `zn mcp` subcommand wired by mcp-integrations.ts.
 *
 * It reads the scope flags `zn mcp` takes (--allow-path, --deny-path,
 * --read-only, --access, ZenNotes/tui#21) off its own argv, so a client
 * that launches this file directly can be scoped the same way. A bad
 * entry stops it before it serves anything, with one line in the
 * client's log rather than a stack.
 */

import { parse } from '../cli/args.js'
import { mcpScopeFromArgs } from '../cli/commands/mcp.js'
import type { McpScope } from '@shared/mcp-scope'
import { runMcpServer } from './server.js'

let scope: McpScope | null
try {
  scope = mcpScopeFromArgs(parse(process.argv.slice(2)))
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[zennotes-mcp] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

runMcpServer({ scope }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[zennotes-mcp] fatal', err)
  process.exit(1)
})
