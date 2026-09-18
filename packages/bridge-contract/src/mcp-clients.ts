export type McpClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'opencode'

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
  /** Human-readable diagnostic , surfaced beneath the row when the
   *  install state is ambiguous (file missing, permission error, etc). */
  note?: string
}

export interface McpServerRuntime {
  /** Absolute path to the Node binary that will run the server. */
  command: string
  /** Arguments , typically `[mcpEntryPath]`. */
  args: string[]
  /** Environment variables passed to the spawned server. */
  env: Record<string, string>
  /** Absolute path to the compiled MCP entry file. `null` when the
   *  build hasn\u2019t produced it yet (dev environment without a
   *  prior `npm run build`). */
  entryPath: string | null
  /** Set when this build cannot run or install the MCP server at all (the
   *  web client). The settings page shows this sentence instead of the
   *  runtime details and the client list (#672). */
  unavailableReason?: string
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
