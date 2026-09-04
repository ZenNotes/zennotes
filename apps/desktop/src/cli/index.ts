#!/usr/bin/env node
/**
 * `zn` — the ZenNotes command-line interface.
 *
 * Bundled by electron-vite as a third Node entry point alongside the
 * Electron main process and the MCP server. Invoked via the wrapper
 * shell script in build/zen, which sets ELECTRON_RUN_AS_NODE=1 and
 * runs Electron in plain-Node mode so users don't need a system Node
 * install.
 *
 * For a local vault the CLI talks to it directly via the same vault-ops
 * module the MCP server uses — works whether or not the desktop app is
 * running. The running app's chokidar watcher picks up file changes
 * automatically. For a vault behind a self-hosted server, the same
 * commands go over the server's HTTP API instead (#493); which one you
 * get is decided once here and handed to the command as a backend.
 */

import { createBackend, type VaultBackend } from './backend.js'
import { resolveTarget } from './vault-target.js'
import { parse, type ParsedArgs } from './args.js'
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
import { cmdAssetGet, cmdAssetList } from './commands/assets.js'
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
import {
  cmdBaseAdd,
  cmdBaseCreate,
  cmdBaseGet,
  cmdBaseList,
  cmdBaseRows,
  cmdBaseSet
} from './commands/base.js'

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

  // Some commands have a second-level subcommand (`zn folder list`,
  // `zn task toggle`, `zn tag find`, `zn search-title`). We resolve
  // the subcommand before parsing flags so positionals don't include it.
  const { subcommand, parsed } = peelSubcommand(command, rest)

  if (command === 'mcp') {
    await cmdMcp()
    return 0
  }

  const key = subcommand ? `${command} ${subcommand}` : command

  // `vault list` enumerates every vault and server, so it must work before
  // anything is configured — there is nothing to resolve first.
  if (key === 'vault list') {
    await cmdVaultList(parsed)
    return 0
  }

  // `open` is special: it hands file paths to the desktop app, so it works
  // without a vault (arbitrary markdown files) but uses one when available so
  // the vault-relative paths `zn list` prints open from any directory. A
  // remote vault has no local paths to hand over, so say so plainly.
  if (command === 'open') {
    const target = await resolveTarget(parsed).catch(() => null)
    if (target?.kind === 'remote') {
      throw new Error(
        'zn open hands file paths to the desktop app, so it needs a local vault. ' +
          'Use `zn read <path>` to print a note from a server instead.'
      )
    }
    await cmdOpen(target?.root ?? '', parsed)
    return 0
  }

  const dispatch: Record<string, (v: VaultBackend, args: ParsedArgs) => Promise<void>> = {
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
    'asset list': cmdAssetList,
    'asset get': cmdAssetGet,
    'tag list': cmdTagList,
    'tag find': cmdTagFind,
    'task list': cmdTaskList,
    'task toggle': cmdTaskToggle,
    'vault info': cmdVaultInfo,
    'base list': cmdBaseList,
    'base create': cmdBaseCreate,
    'base rows': cmdBaseRows,
    'base get': cmdBaseGet,
    'base add': cmdBaseAdd,
    'base set': cmdBaseSet,
    capture: cmdCapture
  }

  const handler = dispatch[key]
  if (!handler) {
    emitError(`Unknown command: zn ${key}. Run \`zn --help\` for usage.`)
    return 1
  }

  // Resolved only once the command is known, so a typo reports the typo rather
  // than complaining that no vault is configured. Picking the backend here is
  // what lets no command care whether its vault is a folder or a server.
  await handler(createBackend(await resolveTarget(parsed)), parsed)
  return 0
}

function peelSubcommand(
  command: string,
  rest: string[]
): { subcommand: string | null; parsed: ParsedArgs } {
  const SUBCOMMANDS: Record<string, string[]> = {
    folder: ['list', 'create', 'rename', 'delete'],
    asset: ['list', 'get'],
    tag: ['list', 'find'],
    task: ['list', 'toggle'],
    vault: ['info', 'list'],
    base: ['list', 'create', 'rows', 'get', 'add', 'set']
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
