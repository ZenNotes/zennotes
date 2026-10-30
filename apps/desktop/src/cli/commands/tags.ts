/**
 * `zn tag list` and `zn tag find` — enumerate and discover #tags
 * across live notes (excluding trash and the vault's template folder, whose
 * tags are the notes its templates will make, #1024).
 */

import { outsideTemplateFolder } from '@shared/template-folder'
import type { VaultBackend } from '../backend.js'
import { getBool, getNumber, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, pad } from '../format.js'

export async function cmdTagList(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const all = outsideTemplateFolder(await vault.listNotes(), await vault.templateFolder())
  const counts = new Map<string, number>()
  for (const n of all) {
    if (n.folder === 'trash') continue
    for (const t of n.tags) {
      const key = t.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const ordered = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  if (getBool(args, 'json')) {
    emitJson(ordered)
    return
  }
  if (ordered.length === 0) {
    emitLine('No tags in vault.')
    return
  }
  const widest = ordered.reduce((w, t) => Math.max(w, t.tag.length), 0)
  for (const t of ordered) {
    emitLine(`#${pad(t.tag, widest)}  ${t.count}`)
  }
}

export async function cmdTagFind(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const tag = (getString(args, 'tag') ?? args.positionals[0])?.replace(/^#/, '').toLowerCase()
  if (!tag) throw new Error('zn tag find requires a tag name (e.g. `zn tag find idea`).')
  const limit = getNumber(args, 'limit') ?? 200
  const all = outsideTemplateFolder(await vault.listNotes(), await vault.templateFolder())
  const matches = all
    .filter(
      (n) => n.folder !== 'trash' && n.tags.map((x) => x.toLowerCase()).includes(tag)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
  if (getBool(args, 'json')) {
    emitJson(matches)
    return
  }
  if (matches.length === 0) {
    emitLine(`No notes tagged #${tag}.`)
    return
  }
  for (const n of matches) emitLine(n.path)
}
