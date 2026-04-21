/**
 * Shared descriptors for the MCP client integrations ZenNotes knows
 * how to configure. Each entry describes where the client keeps its
 * MCP server configuration and how its entry for our server should be
 * shaped. Both the main process (read/write the files) and the
 * renderer (present the UI) rely on these constants.
 */

export type McpClientId = 'claude-code' | 'claude-desktop' | 'codex'

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
   */
  format: 'json' | 'toml'
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
  }
]

export function getMcpClientDescriptor(id: McpClientId): McpClientDescriptor {
  const found = MCP_CLIENTS.find((c) => c.id === id)
  if (!found) throw new Error(`Unknown MCP client: ${id}`)
  return found
}

/** Serialized state returned to the renderer for the settings UI. */
export interface McpClientStatus {
  id: McpClientId
  /** Absolute path to the client's config file on this machine. */
  configPath: string
  /** True if the config file currently contains a ZenNotes entry. */
  installed: boolean
  /** Whether the installed entry matches what we would currently install
   *  (same command / args / env). False when the server path changed
   *  because the app moved, or when an older version installed a
   *  different shape. */
  upToDate: boolean
  /** Human-readable diagnostic — surfaced beneath the row when the
   *  install state is ambiguous (file missing, permission error, etc). */
  note?: string
}

export interface McpServerRuntime {
  /** Absolute path to the Node binary that will run the server. */
  command: string
  /** Arguments — typically `[mcpEntryPath]`. */
  args: string[]
  /** Environment variables passed to the spawned server. */
  env: Record<string, string>
  /** Absolute path to the compiled MCP entry file. `null` when the
   *  build hasn\u2019t produced it yet (dev environment without a
   *  prior `npm run build`). */
  entryPath: string | null
}

/**
 * Shape returned when the renderer asks for the current server-side
 * instructions. `defaultValue` is the compiled default; `current` is
 * what the MCP server will actually send (either the user override
 * or the default); `isCustom` flags whether an override is in place.
 */
export interface McpInstructionsPayload {
  defaultValue: string
  current: string
  isCustom: boolean
  filePath: string
}
