/**
 * Pure three-way reconcile for synced vaults.
 *
 * For every path we compare three content hashes:
 *   L = local hash  (null if the file is absent locally)
 *   R = remote hash (null if absent on the server)
 *   B = base hash   (the bytes at the last successful sync; null if never synced)
 *
 * Because the server has no content hashes of its own and no tombstones (a delete
 * is just a missing file), the base snapshot is what lets us tell "deleted here"
 * apart from "new there". Decisions are hash-only — never mtime — so clock skew
 * across machines can't corrupt them.
 */

export interface FileState {
  hash: string
  size: number
}

export interface BaseEntry {
  contentHash: string
  size: number
}

export type ConflictReason =
  | 'both-edited' // edited differently on both sides
  | 'first-sync-clash' // same path, different bytes, never synced before
  | 'delete-vs-edit' // deleted locally, edited remotely → resurrect from server
  | 'edit-vs-delete' // edited locally, deleted remotely → resurrect to server

export type SyncAction =
  | { kind: 'push'; path: string } // local → server
  | { kind: 'pull'; path: string } // server → local
  | { kind: 'deleteRemote'; path: string } // remove on server
  | { kind: 'deleteLocal'; path: string } // remove locally
  | { kind: 'conflict'; path: string; reason: ConflictReason }
  | { kind: 'converge'; path: string } // L === R but ≠ B: update base, no transfer
  | { kind: 'forget'; path: string } // deleted on both sides: drop the base entry

/** Paths that must never participate in sync (per-device / cache files). */
const NEVER_SYNC_PREFIXES = ['.zennotes/sync-state.json', '.zennotes/note-meta-cache']

export function isNeverSync(path: string): boolean {
  return NEVER_SYNC_PREFIXES.some((p) => path === p || path.startsWith(p))
}

export function reconcile(
  local: Map<string, FileState>,
  remote: Map<string, FileState>,
  base: Map<string, BaseEntry>
): SyncAction[] {
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...base.keys()])
  const actions: SyncAction[] = []

  for (const path of paths) {
    if (isNeverSync(path)) continue
    const L = local.get(path)?.hash ?? null
    const R = remote.get(path)?.hash ?? null
    const B = base.get(path)?.contentHash ?? null

    if (L !== null && R !== null) {
      if (L === B && R === B) continue // unchanged both sides
      if (L !== B && R === B) {
        actions.push({ kind: 'push', path })
        continue
      }
      if (L === B && R !== B) {
        actions.push({ kind: 'pull', path })
        continue
      }
      // both changed (or never synced)
      if (L === R) {
        actions.push({ kind: 'converge', path })
        continue
      }
      actions.push({
        kind: 'conflict',
        path,
        reason: B === null ? 'first-sync-clash' : 'both-edited'
      })
      continue
    }

    if (L !== null && R === null) {
      if (B === null) {
        actions.push({ kind: 'push', path }) // new local
        continue
      }
      if (L === B) {
        actions.push({ kind: 'deleteLocal', path }) // deleted remotely, local unchanged
        continue
      }
      actions.push({ kind: 'conflict', path, reason: 'edit-vs-delete' })
      continue
    }

    if (L === null && R !== null) {
      if (B === null) {
        actions.push({ kind: 'pull', path }) // new remote
        continue
      }
      if (R === B) {
        actions.push({ kind: 'deleteRemote', path }) // deleted locally, remote unchanged
        continue
      }
      actions.push({ kind: 'conflict', path, reason: 'delete-vs-edit' })
      continue
    }

    // L === null && R === null
    if (B !== null) actions.push({ kind: 'forget', path }) // deleted on both sides
  }

  return actions
}
