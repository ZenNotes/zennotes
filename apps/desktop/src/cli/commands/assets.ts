import {
  deleteAsset,
  duplicateAsset,
  importAssetsToVault,
  listAssets,
  listSoftDeleted,
  migrateLooseAssets,
  moveAsset,
  renameAsset,
  restoreSoftDeleted,
  type RestoredSoftDeleted
} from '../../mcp/vault-ops.js'
import type { AssetMeta } from '@shared/ipc'
import { getBool, getMany, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk, pad, truncate } from '../format.js'

export async function cmdAssetList(vault: string, args: ParsedArgs): Promise<void> {
  let assets = await listAssets(vault)
  const kind = getString(args, 'kind')?.toLowerCase()
  if (kind) assets = assets.filter((asset) => asset.kind === kind)
  if (getBool(args, 'json')) {
    emitJson(assets)
    return
  }
  if (assets.length === 0) {
    emitLine('No assets found.')
    return
  }
  const widestKind = assets.reduce((w, asset) => Math.max(w, asset.kind.length), 0)
  for (const asset of assets) {
    const managed = asset.managed ? 'managed' : 'legacy'
    emitLine(`${pad(asset.kind, widestKind)}  ${pad(managed, 7)}  ${asset.path}  ${asset.name}`)
  }
}

export async function cmdAssetImport(vault: string, args: ParsedArgs): Promise<void> {
  const sourcePaths = [...args.positionals, ...getMany(args, 'source')]
  if (sourcePaths.length === 0) {
    throw new Error('zen asset import requires one or more source paths.')
  }
  const assets = await importAssetsToVault(vault, sourcePaths)
  if (getBool(args, 'json')) {
    emitJson(assets)
    return
  }
  if (assets.length === 0) {
    emitLine('No assets imported.')
    return
  }
  for (const asset of assets) emitAsset(asset, args, 'Imported')
}

export async function cmdAssetRename(vault: string, args: ParsedArgs): Promise<void> {
  const asset = await renameAsset(vault, requireAssetPath(args), requireTo(args, 'new name'))
  emitAsset(asset, args, 'Renamed')
}

export async function cmdAssetMove(vault: string, args: ParsedArgs): Promise<void> {
  const target = getString(args, 'to') ?? getString(args, 'dir') ?? args.positionals[1]
  if (!target) throw new Error('zen asset move requires --to <target-dir>.')
  const asset = await moveAsset(vault, requireAssetPath(args), target)
  emitAsset(asset, args, 'Moved')
}

export async function cmdAssetDuplicate(vault: string, args: ParsedArgs): Promise<void> {
  const asset = await duplicateAsset(vault, requireAssetPath(args))
  emitAsset(asset, args, 'Duplicated')
}

export async function cmdAssetTrash(vault: string, args: ParsedArgs): Promise<void> {
  const handle = await deleteAsset(vault, requireAssetPath(args))
  if (getBool(args, 'json')) {
    emitJson({ ok: true, handle })
    return
  }
  emitOk(`Moved to trash ${handle}`)
}

export async function cmdAssetRestore(vault: string, args: ParsedArgs): Promise<void> {
  const handle = requireHandle(args)
  const entry = (await listSoftDeleted(vault)).find((item) => item.handle === handle)
  if (entry && entry.kind !== 'asset') {
    throw new Error(`Handle ${handle} is a ${entry.kind}, not an asset.`)
  }
  const restored = await restoreSoftDeleted(vault, handle)
  if (restored.itemKind !== 'asset') {
    throw new Error(`Handle ${handle} restored a ${restored.itemKind}, not an asset.`)
  }
  emitRestoredAsset(restored, args)
}

export async function cmdAssetMigrate(vault: string, args: ParsedArgs): Promise<void> {
  const result = await migrateLooseAssets(vault)
  if (getBool(args, 'json')) {
    emitJson(result)
    return
  }
  emitOk(`Moved ${result.moved.length} assets`)
  if (result.skipped.length > 0) {
    emitLine(`Skipped ${result.skipped.length}:`)
    for (const skipped of result.skipped) {
      emitLine(`  ${skipped.path}: ${skipped.reason}`)
    }
  }
}

function requireAssetPath(args: ParsedArgs): string {
  const value = getString(args, 'path') ?? args.positionals[0]
  if (!value) throw new Error('An asset path is required.')
  return value
}

function requireHandle(args: ParsedArgs): string {
  const value = getString(args, 'handle') ?? args.positionals[0]
  if (!value) throw new Error('A recovery handle is required.')
  return value
}

function requireTo(args: ParsedArgs, label: string): string {
  const value = getString(args, 'to') ?? args.positionals[1]
  if (!value) throw new Error(`zen asset rename requires --to <${label}>.`)
  return value
}

function assetEmbed(asset: AssetMeta): string {
  return asset.id ? `![[asset:${asset.id}|${asset.name}]]` : `![[${asset.path}]]`
}

function emitAsset(asset: AssetMeta, args: ParsedArgs, verb: string): void {
  if (getBool(args, 'json')) {
    emitJson(asset)
    return
  }
  emitOk(`${verb} ${asset.path}`)
  emitLine(`  ${truncate(asset.name, 100)}`)
  emitLine(`  embed ${assetEmbed(asset)}`)
  if (asset.sourcePath) emitLine(`  source ${asset.sourcePath}`)
}

function emitRestoredAsset(asset: RestoredSoftDeleted & { itemKind: 'asset' }, args: ParsedArgs): void {
  const { itemKind: _itemKind, ...meta } = asset
  emitAsset(meta, args, 'Restored')
}
