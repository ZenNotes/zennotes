/**
 * The OPFS worker's message handling, kept apart from the worker global so
 * vitest drives the same code in process (test/opfs-host.test.ts). One call
 * runs at a time, in arrival order: no handle a call opens outlives it, and a
 * rename never races a write to the same file.
 */
import { OPFS_CLOSED, OPFS_FENCED, OpfsError, serializeOpfsError, type OpfsErrorShape } from './opfs-errors'
import type { OpfsDirectoryHandle } from './opfs-handles'
import { OpfsVaultStore } from './opfs-store'

export type OpfsOp =
  | 'open'
  | 'read'
  | 'write'
  | 'stat'
  | 'list'
  | 'mkdir'
  | 'rename'
  | 'copy'
  | 'deleteFile'
  | 'rmdir'
  | 'rmdirIfEmpty'
  | 'readStub'
  | 'fingerprint'
  | 'fileForUpload'
  | 'copyForSync'
  | 'download'
  | 'writeStub'
  | 'replaceStub'
  | 'evictToStub'

export interface OpfsRequest {
  id: number
  op: OpfsOp
  args: unknown[]
}

export type OpfsResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: OpfsErrorShape }

export interface OpfsOpenResult {
  foldsCase: boolean
}

export interface OpfsDispatcherDeps {
  root(): Promise<OpfsDirectoryHandle>
  /** The generation that owns a vault now (IndexedDB `fence`); absent in
   *  tests that do not fence. */
  currentGeneration?(vaultKey: string): Promise<number>
  randomId?(): string
  /** A reader: opens only an existing vault, prepares nothing and refuses
   *  every change (the export window, spike F1a). */
  readOnly?: boolean
  fetch?: typeof fetch
}

const READS = new Set<OpfsOp>(['open', 'read', 'stat', 'list', 'readStub', 'fingerprint'])

export interface OpfsDispatcher {
  handle(request: OpfsRequest): Promise<OpfsResponse>
}

export function fencedError(): OpfsError {
  return new OpfsError(
    OPFS_FENCED,
    'This vault is open in another tab now, so this tab stopped saving to it.',
    'OpfsFencedError'
  )
}

export function createOpfsDispatcher(deps: OpfsDispatcherDeps): OpfsDispatcher {
  let store: OpfsVaultStore | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const run = async (op: OpfsOp, args: unknown[]): Promise<unknown> => {
    if (deps.readOnly && !READS.has(op)) {
      throw new OpfsError('ZN-OPFS-READ-ONLY', 'This window only reads the vault.', 'NoModificationAllowedError')
    }
    if (op === 'open' && deps.readOnly) {
      const [vaultKey] = args as [string]
      store = await OpfsVaultStore.open(await deps.root(), vaultKey, { create: false })
      return { foldsCase: false } satisfies OpfsOpenResult
    }
    if (op === 'open') {
      const [vaultKey, generation] = args as [string, number]
      const currentGeneration = deps.currentGeneration
      const fence = currentGeneration
        ? async () => {
            if ((await currentGeneration(vaultKey)) !== generation) throw fencedError()
          }
        : undefined
      const next = await OpfsVaultStore.open(await deps.root(), vaultKey, {
        fence,
        randomId: deps.randomId,
        fetch: deps.fetch
      })
      const result: OpfsOpenResult = await next.prepare()
      store = next
      return result
    }
    if (!store) throw new OpfsError(OPFS_CLOSED, 'No vault is open in this tab.', 'InvalidStateError')
    const path = String(args[0] ?? '')
    switch (op) {
      case 'read':
        return await store.read(path)
      case 'write':
        return await store.write(path, args[1] as Uint8Array)
      case 'stat':
        return await store.stat(path)
      case 'list':
        return await store.list(path)
      case 'mkdir':
        return await store.mkdir(path)
      case 'rename':
        return await store.rename(path, String(args[1] ?? ''))
      case 'copy':
        return await store.copy(path, String(args[1] ?? ''))
      case 'deleteFile':
        return await store.deleteFile(path)
      case 'rmdir':
        return await store.rmdir(path)
      case 'rmdirIfEmpty':
        return await store.rmdirIfEmpty(path)
      case 'readStub':
        return await store.readStub(path)
      case 'fingerprint':
        return await store.fingerprint(path, args[1] === true, Number(args[2] ?? 0))
      case 'fileForUpload':
        return await store.fileForUpload(path, String(args[1] ?? ''), Number(args[2] ?? -1))
      case 'copyForSync':
        return await store.copyForSync(path, String(args[1] ?? ''), Number(args[2] ?? -1))
      case 'download':
        return await store.download(args[0] as Parameters<OpfsVaultStore['download']>[0])
      case 'writeStub':
        return await store.writeStub(path, args[1] as Parameters<OpfsVaultStore['writeStub']>[1])
      case 'replaceStub':
        return await store.replaceStub(path, String(args[1] ?? ''), args[2] as Parameters<OpfsVaultStore['replaceStub']>[2])
      case 'evictToStub':
        return await store.evictToStub(
          path,
          args[1] as Parameters<OpfsVaultStore['evictToStub']>[1],
          args[2] as Parameters<OpfsVaultStore['evictToStub']>[2]
        )
      default:
        throw new OpfsError('ZN-OPFS-STORAGE', `Unknown vault operation ${String(op)}`, 'NotSupportedError')
    }
  }

  return {
    handle(request) {
      const result = queue.then(async (): Promise<OpfsResponse> => {
        try {
          return { id: request.id, ok: true, value: await run(request.op, request.args) }
        } catch (error) {
          return { id: request.id, ok: false, error: serializeOpfsError(error) }
        }
      })
      queue = result
      return result
    }
  }
}
