/**
 * MCP client integration management. Reads and writes the config
 * files that Claude Code, Claude Desktop, and Codex use to discover
 * custom MCP servers, so the user can toggle ZenNotes on/off without
 * leaving the app.
 *
 * The server we install is the compiled Node entry at
 * <appResources>/out/main/mcp.js, executed with the packaged Electron
 * binary in a plain-Node mode (ELECTRON_RUN_AS_NODE=1). This keeps
 * the install deterministic: users do not need a system Node.
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError
} from 'jsonc-parser'
import {
  MCP_CLIENTS,
  type McpClientDescriptor,
  type McpClientId,
  type McpClientStatus,
  type McpServerRuntime
} from '@shared/mcp-clients'
import { findManagedCliBinary } from './cli-install'

/* ---------- Runtime discovery ----------------------------------------- */

/**
 * Find the compiled MCP entry on disk.
 *
 *  - In dev (`npm run dev`), electron-vite writes to `<project>/out/main/mcp.js`.
 *  - In a packaged app, it lives under the app.asar / Resources tree.
 *    Electron copies the `out/` tree into the app bundle alongside
 *    `out/main/index.js`, so starting from `__dirname` (which is
 *    `<resources>/app.asar/out/main`) and using `mcp.js` next to
 *    `index.js` works in both builds.
 */
function resolveMcpEntryCandidate(): string {
  // `import.meta.url` on Windows yields `file:///C:/...`; use
  // fileURLToPath so we get a native path rather than `/C:/...`.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, 'mcp.js')
}

export async function getMcpServerRuntime(): Promise<McpServerRuntime> {
  const entry = resolveMcpEntryCandidate()
  let exists = false
  try {
    await fsp.access(entry)
    exists = true
  } catch {
    exists = false
  }

  // When the user has installed the `zn` CLI from Settings, prefer
  // that as the MCP launcher: `zn mcp` is one stable absolute path
  // that survives app moves and reads better in client config files.
  // Otherwise fall back to invoking the Electron binary in plain-Node
  // mode against the bundled mcp.js (the historical install shape;
  // no system Node required).
  const managedCli = await findManagedCliBinary()
  if (managedCli) {
    return {
      command: managedCli,
      args: ['mcp'],
      env: {},
      entryPath: exists ? entry : null
    }
  }
  const command = process.execPath
  const args = [entry]
  const env = {
    ELECTRON_RUN_AS_NODE: '1'
  }
  return {
    command,
    args,
    env,
    entryPath: exists ? entry : null
  }
}

/* ---------- Path helpers --------------------------------------------- */

function homeDir(): string {
  return app.getPath('home')
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config')
}

function clientConfigPath(descriptor: McpClientDescriptor): string {
  switch (descriptor.id) {
    case 'claude-code':
      // Claude Code stores user-scope MCP servers in ~/.claude.json under
      // the top-level `mcpServers` object.
      return path.join(homeDir(), '.claude.json')
    case 'claude-desktop':
      // Claude Desktop\u2019s config location differs by OS.
      if (process.platform === 'darwin') {
        return path.join(
          homeDir(),
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json'
        )
      }
      if (process.platform === 'win32') {
        return path.join(
          process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json'
        )
      }
      return path.join(xdgConfigHome(), 'Claude', 'claude_desktop_config.json')
    case 'codex':
      // Codex CLI reads from ~/.codex/config.toml.
      return path.join(homeDir(), '.codex', 'config.toml')
    case 'opencode':
      // OpenCode global config lives at ~/.config/opencode/opencode.json.
      return path.join(xdgConfigHome(), 'opencode', 'opencode.json')
  }
}

/* ---------- JSON client (Claude Code + Claude Desktop) --------------- */

interface JsonMcpEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface JsonMcpConfig {
  mcpServers?: Record<string, JsonMcpEntry>
  [key: string]: unknown
}

async function readJsonConfig(filePath: string): Promise<JsonMcpConfig> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonMcpConfig
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeJsonConfig(filePath: string, data: JsonMcpConfig): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function entriesEqual(a: JsonMcpEntry | undefined, b: JsonMcpEntry): boolean {
  if (!a) return false
  if (a.command !== b.command) return false
  if ((a.args ?? []).length !== b.args.length) return false
  for (let i = 0; i < b.args.length; i++) {
    if ((a.args ?? [])[i] !== b.args[i]) return false
  }
  const aEnv = a.env ?? {}
  const bEnv = b.env ?? {}
  const keys = new Set([...Object.keys(aEnv), ...Object.keys(bEnv)])
  for (const k of keys) {
    if (aEnv[k] !== bEnv[k]) return false
  }
  return true
}

/* ---------- TOML client (Codex) ------------------------------------- */

const MARK_START = '# >>> zennotes mcp begin (managed) >>>'
const MARK_END = '# <<< zennotes mcp end (managed) <<<'

function tomlEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function tomlArray(values: string[]): string {
  return '[' + values.map((v) => `"${tomlEscape(v)}"`).join(', ') + ']'
}

function tomlInlineTable(values: Record<string, string>): string {
  const pairs = Object.entries(values).map(
    ([k, v]) => `${k} = "${tomlEscape(v)}"`
  )
  return '{ ' + pairs.join(', ') + ' }'
}

function renderTomlBlock(
  serverKey: string,
  runtime: { command: string; args: string[]; env: Record<string, string> }
): string {
  const lines = [
    MARK_START,
    `[mcp_servers.${serverKey}]`,
    `command = "${tomlEscape(runtime.command)}"`,
    `args = ${tomlArray(runtime.args)}`
  ]
  if (Object.keys(runtime.env).length > 0) {
    lines.push(`env = ${tomlInlineTable(runtime.env)}`)
  }
  lines.push(MARK_END)
  return lines.join('\n')
}

async function readTomlFile(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function stripManagedBlock(contents: string): string {
  const startIdx = contents.indexOf(MARK_START)
  if (startIdx < 0) return contents
  const endIdx = contents.indexOf(MARK_END, startIdx)
  if (endIdx < 0) return contents
  const afterEnd = endIdx + MARK_END.length
  const before = contents.slice(0, startIdx).replace(/\n+$/, '')
  const after = contents.slice(afterEnd).replace(/^\n+/, '')
  if (before && after) return `${before}\n\n${after}`
  if (before) return `${before}\n`
  return after
}

function tomlBlockMatches(
  contents: string,
  expected: string
): boolean {
  const startIdx = contents.indexOf(MARK_START)
  if (startIdx < 0) return false
  const endIdx = contents.indexOf(MARK_END, startIdx)
  if (endIdx < 0) return false
  const block = contents.slice(startIdx, endIdx + MARK_END.length).trim()
  return block === expected.trim()
}

async function writeTomlFile(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, contents.endsWith('\n') ? contents : contents + '\n', 'utf8')
}

/* ---------- OpenCode (JSONC with `mcp.<key>` structure) ------------- */

interface OpenCodeMcpEntry {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>
  [key: string]: unknown
}

/**
 * OpenCode reads its config as JSONC: comments and trailing commas are
 * legal in `opencode.json`, and `opencode.jsonc` is an accepted name too.
 * A strict JSON.parse rejects a config OpenCode itself is happy with, and
 * the reader that used to stand here answered that rejection with `{}`, so
 * Install wrote the file back holding nothing but our entry and every
 * provider the user had configured was gone (#1104).
 *
 * The rule now: a file we cannot read is a file we do not write. Any parse
 * error throws, and the caller surfaces it, the same way a broken
 * ~/.claude.json already does for the Claude clients.
 */
function parseOpenCodeConfig(raw: string, filePath: string): OpenCodeConfig {
  if (raw.trim() === '') return {}
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false
  })
  if (errors.length > 0) {
    const first = errors[0]
    const { line, column } = lineAndColumn(raw, first.offset)
    throw new Error(
      `ZenNotes could not read ${filePath} (${printParseErrorCode(first.error)} at line ${line}, column ${column}) and left it unchanged. Fix the file, or add the ZenNotes entry to it by hand.`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${filePath} does not hold a JSON object, so ZenNotes left it unchanged.`
    )
  }
  const cfg = parsed as OpenCodeConfig
  if (
    cfg.mcp !== undefined &&
    (cfg.mcp === null || typeof cfg.mcp !== 'object' || Array.isArray(cfg.mcp))
  ) {
    throw new Error(
      `The "mcp" setting in ${filePath} is not an object, so ZenNotes left the file unchanged.`
    )
  }
  return cfg
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset)
  const lastBreak = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: offset - lastBreak
  }
}

/** Match the file's own indentation and line endings, so an edit reads like the user's file. */
function openCodeFormatting(raw: string): FormattingOptions {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const indent = /^([ \t]+)\S/m.exec(raw)?.[1]
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol }
}

/**
 * Set or remove `mcp.<serverKey>` by editing the text in place rather than
 * re-serializing the parsed object, so the user's comments, key order and
 * layout survive both Install and Uninstall. An `mcp` block that Uninstall
 * leaves empty is removed with it, as the strict JSON path always did.
 */
function editOpenCodeConfig(
  raw: string,
  serverKey: string,
  entry: OpenCodeMcpEntry | undefined
): string {
  const created = raw.trim() === ''
  const base = created ? '{}' : raw
  const formattingOptions = openCodeFormatting(base)
  let next = applyEdits(base, modify(base, ['mcp', serverKey], entry, { formattingOptions }))
  if (entry === undefined) {
    const remaining = parseJsonc(next, [], { allowTrailingComma: true }) as OpenCodeConfig
    if (remaining.mcp && Object.keys(remaining.mcp).length === 0) {
      next = applyEdits(next, modify(next, ['mcp'], undefined, { formattingOptions }))
    }
  }
  return created ? `${next}\n` : next
}

/**
 * OpenCode loads both `opencode.json` and `opencode.jsonc`. Keep writing the
 * `.json` name we always have, unless the user keeps only a `.jsonc` file:
 * then edit that one instead of starting a second config beside it.
 */
async function resolveClientConfigPath(descriptor: McpClientDescriptor): Promise<string> {
  const configPath = clientConfigPath(descriptor)
  if (descriptor.format !== 'opencode') return configPath
  const jsoncPath = configPath.replace(/\.json$/, '.jsonc')
  if (await pathExists(configPath)) return configPath
  if (await pathExists(jsoncPath)) return jsoncPath
  return configPath
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

function buildOpenCodeEntry(
  runtime: { command: string; args: string[]; env: Record<string, string> }
): OpenCodeMcpEntry {
  return {
    type: 'local',
    command: [runtime.command, ...runtime.args],
    ...(Object.keys(runtime.env).length > 0 ? { environment: { ...runtime.env } } : {}),
    enabled: true
  }
}

/* ---------- Public API ----------------------------------------------- */

export async function getMcpClientStatuses(): Promise<McpClientStatus[]> {
  const runtime = await getMcpServerRuntime()
  const statuses: McpClientStatus[] = []
  for (const descriptor of MCP_CLIENTS) {
    const configPath = await resolveClientConfigPath(descriptor)
    let installed = false
    let upToDate = false
    let note: string | undefined

    if (!runtime.entryPath) {
      note =
        'The MCP server entry has not been built yet. Run `npm run build` once so the installer has something to point at.'
    }

    try {
      if (descriptor.format === 'json') {
        const cfg = await readJsonConfig(configPath)
        const entry = cfg.mcpServers?.[descriptor.serverKey]
        if (entry) {
          installed = true
          upToDate = entriesEqual(entry, {
            command: runtime.command,
            args: runtime.args,
            env: runtime.env
          })
        }
      } else if (descriptor.format === 'opencode') {
        const raw = await readTomlFile(configPath)
        const cfg = parseOpenCodeConfig(raw, configPath)
        const entry = cfg.mcp?.[descriptor.serverKey]
        installed = entry !== undefined
        if (entry) {
          const expected = buildOpenCodeEntry({
            command: runtime.command,
            args: runtime.args,
            env: runtime.env
          })
          upToDate =
            entry.type === 'local' &&
            JSON.stringify(entry.command) === JSON.stringify(expected.command) &&
            JSON.stringify(entry.environment ?? {}) === JSON.stringify(expected.environment ?? {})
        }
      } else {
        const raw = await readTomlFile(configPath)
        const expected = renderTomlBlock(descriptor.serverKey, {
          command: runtime.command,
          args: runtime.args,
          env: runtime.env
        })
        installed = raw.includes(MARK_START) && raw.includes(MARK_END)
        upToDate = tomlBlockMatches(raw, expected)
      }
    } catch (err) {
      note = (err as Error).message
    }

    statuses.push({
      id: descriptor.id,
      configPath,
      installed,
      upToDate,
      note
    })
  }
  return statuses
}

export async function installMcpForClient(id: McpClientId): Promise<McpClientStatus> {
  const descriptor = MCP_CLIENTS.find((c) => c.id === id)
  if (!descriptor) throw new Error(`Unknown MCP client: ${id}`)
  const runtime = await getMcpServerRuntime()
  if (!runtime.entryPath) {
    throw new Error(
      'The ZenNotes MCP server has not been built. Run `npm run build` (or launch from a packaged build) so the installer has a file to register.'
    )
  }
  const configPath = await resolveClientConfigPath(descriptor)

  if (descriptor.format === 'json') {
    const cfg = await readJsonConfig(configPath)
    const next: JsonMcpConfig = { ...cfg }
    const servers = { ...(cfg.mcpServers ?? {}) }
    servers[descriptor.serverKey] = {
      command: runtime.command,
      args: runtime.args,
      env: runtime.env
    }
    next.mcpServers = servers
    await writeJsonConfig(configPath, next)
  } else if (descriptor.format === 'opencode') {
    const raw = await readTomlFile(configPath)
    parseOpenCodeConfig(raw, configPath)
    const entry = buildOpenCodeEntry({
      command: runtime.command,
      args: runtime.args,
      env: runtime.env
    })
    const next = editOpenCodeConfig(raw, descriptor.serverKey, entry)
    await fsp.mkdir(path.dirname(configPath), { recursive: true })
    await fsp.writeFile(configPath, next, 'utf8')
  } else {
    const raw = await readTomlFile(configPath)
    const stripped = stripManagedBlock(raw)
    const block = renderTomlBlock(descriptor.serverKey, {
      command: runtime.command,
      args: runtime.args,
      env: runtime.env
    })
    const joined = stripped ? `${stripped.replace(/\n+$/, '')}\n\n${block}\n` : `${block}\n`
    await writeTomlFile(configPath, joined)
  }

  return (await getMcpClientStatuses()).find((s) => s.id === id)!
}

export async function uninstallMcpForClient(id: McpClientId): Promise<McpClientStatus> {
  const descriptor = MCP_CLIENTS.find((c) => c.id === id)
  if (!descriptor) throw new Error(`Unknown MCP client: ${id}`)
  const configPath = await resolveClientConfigPath(descriptor)

  if (descriptor.format === 'json') {
    const cfg = await readJsonConfig(configPath)
    if (cfg.mcpServers && cfg.mcpServers[descriptor.serverKey]) {
      const nextServers = { ...cfg.mcpServers }
      delete nextServers[descriptor.serverKey]
      const next: JsonMcpConfig = { ...cfg }
      if (Object.keys(nextServers).length === 0) {
        delete next.mcpServers
      } else {
        next.mcpServers = nextServers
      }
      await writeJsonConfig(configPath, next)
    }
  } else if (descriptor.format === 'opencode') {
    const raw = await readTomlFile(configPath)
    const cfg = parseOpenCodeConfig(raw, configPath)
    if (cfg.mcp?.[descriptor.serverKey]) {
      const next = editOpenCodeConfig(raw, descriptor.serverKey, undefined)
      await fsp.writeFile(configPath, next, 'utf8')
    }
  } else {
    const raw = await readTomlFile(configPath)
    if (raw.includes(MARK_START)) {
      const stripped = stripManagedBlock(raw)
      await writeTomlFile(configPath, stripped)
    }
  }

  return (await getMcpClientStatuses()).find((s) => s.id === id)!
}

// Exported for tests / renderer diagnostics if ever useful.
export const __internal = {
  clientConfigPath,
  parseOpenCodeConfig,
  editOpenCodeConfig,
  renderTomlBlock,
  stripManagedBlock,
  tomlBlockMatches,
  homeDir
}

// Suppress unused lint in strict builds — os/path used above.
void os
