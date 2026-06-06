/**
 * `zen vault info` — print the resolved vault root + a small sanity
 * snapshot. Useful as a sanity check after install (`zen vault info`
 * should match what the GUI shows).
 *
 * `zen vault list` — every vault the app knows about, the default
 * marked with `*`. Point any other command at a specific vault with
 * `--vault <name|path>`.
 */

import path from 'node:path'
import {
  listFolders,
  listNotes,
  readKnownVaultsFromConfig,
  resolveVaultRoot
} from '../../mcp/vault-ops.js'
import { getBool, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, formatRelativeAge, pad } from '../format.js'

export async function cmdVaultInfo(vault: string, args: ParsedArgs): Promise<void> {
  const [notes, subfolders] = await Promise.all([listNotes(vault), listFolders(vault)])
  const counts = {
    inbox: 0,
    quick: 0,
    archive: 0,
    trash: 0
  }
  for (const n of notes) counts[n.folder] += 1

  const summary = {
    vaultRoot: vault,
    counts,
    subfolderCount: subfolders.length
  }
  if (getBool(args, 'json')) {
    emitJson(summary)
    return
  }
  emitLine(`Vault: ${vault}`)
  emitLine(`  inbox:   ${counts.inbox}`)
  emitLine(`  quick:   ${counts.quick}`)
  emitLine(`  archive: ${counts.archive}`)
  emitLine(`  trash:   ${counts.trash}`)
  emitLine(`  subfolders: ${subfolders.length}`)
}

export async function cmdVaultList(_vault: string, args: ParsedArgs): Promise<void> {
  const known = await readKnownVaultsFromConfig()
  // The vault commands without --vault would use this one — mark it.
  const defaultRoot = await resolveVaultRoot().catch(() => null)

  const entries = known.map((vault) => ({
    name: vault.name,
    root: vault.root,
    lastOpenedAt: vault.lastOpenedAt,
    isDefault: defaultRoot !== null && path.resolve(vault.root) === defaultRoot
  }))

  if (getBool(args, 'json')) {
    emitJson(entries)
    return
  }

  if (entries.length === 0) {
    emitLine('No vaults known yet. Open one in ZenNotes, or pass --vault <path>.')
    return
  }

  const nameWidth = Math.max(...entries.map((entry) => entry.name.length), 4)
  for (const entry of entries) {
    const marker = entry.isDefault ? '*' : ' '
    const age = entry.lastOpenedAt != null ? formatRelativeAge(entry.lastOpenedAt) : ''
    emitLine(`${marker} ${pad(entry.name, nameWidth)}  ${pad(age, 8)}  ${entry.root}`)
  }
}
