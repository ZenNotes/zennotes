#!/usr/bin/env node
/**
 * `zen` — the ZenNotes command-line interface.
 *
 * Bundled by electron-vite as a third Node entry point alongside the
 * Electron main process and the MCP server. Invoked via the wrapper
 * shell script in build/zen, which sets ELECTRON_RUN_AS_NODE=1 and
 * runs Electron in plain-Node mode so users don't need a system Node
 * install.
 *
 * The CLI talks to the vault directly via the same vault-ops module
 * the MCP server uses — works whether or not the desktop app is
 * running. The running app's chokidar watcher picks up file changes
 * automatically.
 */

import { resolveVaultRoot } from '../mcp/vault-ops.js'
import { getString, parse, type ParsedArgs } from './args.js'
import { emitError } from './format.js'
import { renderHelp, renderVersion } from './help.js'
import {
  cmdArchive,
  cmdAppend,
  cmdCreate,
  cmdDelete,
  cmdDuplicate,
  cmdList,
  cmdMove,
  cmdPrepend,
  cmdRead,
  cmdRename,
  cmdRestore,
  cmdTrash,
  cmdUnarchive,
  cmdWrite
} from './commands/notes.js'
import { cmdBacklinks, cmdSearch, cmdSearchTitle } from './commands/search.js'
import {
  cmdFolderCreate,
  cmdFolderDelete,
  cmdFolderList,
  cmdFolderRename
} from './commands/folders.js'
import { cmdTaskList, cmdTaskToggle } from './commands/tasks.js'
import { cmdTagFind, cmdTagList } from './commands/tags.js'
import { cmdVaultInfo, cmdVaultList } from './commands/vault.js'
import { cmdCapture } from './commands/capture.js'
import { cmdOpen } from './commands/open.js'
import { cmdMcp } from './commands/mcp.js'

// `open` hands a file path to the desktop app; the file can live outside
// any vault, so it doesn't need the CLI to resolve a vault root.
const NO_VAULT_COMMANDS = new Set(['help', '--help', '-h', '--version', 'mcp', 'open'])

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(renderHelp())
    return 0
  }
  if (argv[0] === '--version') {
    process.stdout.write(renderVersion())
    return 0
  }

  const [command, ...rest] = argv

  // Some commands have a second-level subcommand (`zen folder list`,
  // `zen task toggle`, `zen tag find`, `zen search-title`). We resolve
  // the subcommand before parsing flags so positionals don't include it.
  const { subcommand, parsed } = peelSubcommand(command, rest)

  if (command === 'mcp') {
    await cmdMcp()
    return 0
  }

  const key = subcommand ? `${command} ${subcommand}` : command

  // Every other command needs the vault root. Resolving here lets us
  // emit a single, clean error if the user hasn't configured one.
  // `--vault <name|path>` selects among the app's known vaults and
  // always wins (an invalid selector errors loudly, never falls back).
  // `open` is special: it works without a vault (arbitrary markdown
  // files), but uses one when available so the vault-relative paths
  // `zen list` prints open from any directory. `vault list` enumerates
  // vaults, so it must work before any vault is configured.
  const vaultSelector = getString(parsed, 'vault')
  let vault = ''
  if (vaultSelector) {
    vault = await resolveVaultRoot(vaultSelector)
  } else if (command === 'open') {
    vault = await resolveVaultRoot().catch(() => '')
  } else if (!NO_VAULT_COMMANDS.has(command) && key !== 'vault list') {
    vault = await resolveVaultRoot()
  }
  const dispatch: Record<string, (v: string, args: ParsedArgs) => Promise<void>> = {
    list: cmdList,
    read: cmdRead,
    create: cmdCreate,
    write: cmdWrite,
    append: cmdAppend,
    prepend: cmdPrepend,
    rename: cmdRename,
    move: cmdMove,
    archive: cmdArchive,
    unarchive: cmdUnarchive,
    trash: cmdTrash,
    restore: cmdRestore,
    delete: cmdDelete,
    duplicate: cmdDuplicate,
    search: cmdSearch,
    'search-title': cmdSearchTitle,
    backlinks: cmdBacklinks,
    'folder list': cmdFolderList,
    'folder create': cmdFolderCreate,
    'folder rename': cmdFolderRename,
    'folder delete': cmdFolderDelete,
    'tag list': cmdTagList,
    'tag find': cmdTagFind,
    'task list': cmdTaskList,
    'task toggle': cmdTaskToggle,
    'vault info': cmdVaultInfo,
    'vault list': cmdVaultList,
    capture: cmdCapture,
    open: cmdOpen
  }

  const handler = dispatch[key]
  if (!handler) {
    emitError(`Unknown command: zen ${key}. Run \`zen --help\` for usage.`)
    return 1
  }
  await handler(vault, parsed)
  return 0
}

function peelSubcommand(
  command: string,
  rest: string[]
): { subcommand: string | null; parsed: ParsedArgs } {
  const SUBCOMMANDS: Record<string, string[]> = {
    folder: ['list', 'create', 'rename', 'delete'],
    tag: ['list', 'find'],
    task: ['list', 'toggle'],
    vault: ['info', 'list']
  }
  const choices = SUBCOMMANDS[command]
  if (!choices) return { subcommand: null, parsed: parse(rest) }
  const sub = rest[0]
  if (sub == null || !choices.includes(sub)) {
    return { subcommand: null, parsed: parse(rest) }
  }
  return { subcommand: sub, parsed: parse(rest.slice(1)) }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    emitError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
)
