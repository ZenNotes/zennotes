/**
 * Shared descriptors for the MCP client integrations ZenNotes knows
 * how to configure. Each entry describes where the client keeps its
 * MCP server configuration and how its entry for our server should be
 * shaped. Both the main process (read/write the files) and the
 * renderer (present the UI) rely on these constants.
 */

import type { McpClientId } from '@zennotes/bridge-contract/mcp-clients'
export type {
  McpClientId,
  McpClientStatus,
  McpServerRuntime,
  McpInstructionsPayload
} from '@zennotes/bridge-contract/mcp-clients'

export interface McpClientDescriptor {
  id: McpClientId
  /** Human-readable name shown in Settings. */
  label: string
  /** One-line description shown below the label. */
  description: string
  /**
   * How the client stores its MCP server configuration. The actual
   * path is resolved in the main process because it depends on the
   * user's home directory and OS.
   *   - json: a JSON file with `mcpServers.<key>` structure (Claude
   *     Desktop, Claude Code user scope).
   *   - toml: a TOML file with `[mcp_servers.<key>]` tables (Codex).
   *   - opencode: a JSON file with `mcp.<key>` structure and array-
   *     format command (OpenCode).
   */
  format: 'json' | 'toml' | 'opencode'
  /** Key ZenNotes uses inside the client's config — stable forever
   *  so re-runs upgrade the existing entry instead of creating a
   *  duplicate. */
  serverKey: string
}

export const MCP_SERVER_KEY = 'zennotes'

export const MCP_CLIENTS: McpClientDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description:
      'Anthropic\u2019s CLI. Installs as a user-scope MCP server in ~/.claude.json so every Claude Code session can reach your vault.',
    format: 'json',
    serverKey: MCP_SERVER_KEY
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    description:
      'The Claude desktop app. Registers the server in claude_desktop_config.json. Requires a full restart of Claude Desktop to take effect.',
    format: 'json',
    serverKey: MCP_SERVER_KEY
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    description:
      'OpenAI\u2019s Codex CLI. Appends a [mcp_servers.zennotes] entry to ~/.codex/config.toml.',
    format: 'toml',
    serverKey: MCP_SERVER_KEY
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description:
      'An open-source AI coding agent. Writes a managed local MCP entry into the global ~/.config/opencode/opencode.json.',
    format: 'opencode',
    serverKey: MCP_SERVER_KEY
  }
]

export function getMcpClientDescriptor(id: McpClientId): McpClientDescriptor {
  const found = MCP_CLIENTS.find((c) => c.id === id)
  if (!found) throw new Error(`Unknown MCP client: ${id}`)
  return found
}
