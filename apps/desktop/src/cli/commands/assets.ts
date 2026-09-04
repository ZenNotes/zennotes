/**
 * Asset commands (#716): list and fetch the binary files embedded in notes.
 * Works against a local folder or a self-hosted server, like every `zn`
 * command — the VaultBackend seam picks the wire.
 *
 * `zn asset get` writes binary to stdout when no --output is given, so
 * `zn asset get assets/pic.png > x.png` and piping into other tools work.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { VaultBackend } from '../backend.js'
import { getBool, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, pad, truncate } from '../format.js'
import { formatRelativeAge } from '../format.js'

export async function cmdAssetList(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const assets = await vault.listAssets()
  if (getBool(args, 'json')) {
    emitJson(assets)
    return
  }
  if (assets.length === 0) {
    emitLine('No assets in this vault.')
    return
  }
  emitLine(`${pad('PATH', 48)}  ${pad('SIZE', 10)}  MODIFIED`)
  for (const a of assets) {
    emitLine(
      `${pad(truncate(a.path, 47), 48)}  ${pad(formatBytes(a.size), 10)}  ${formatRelativeAge(a.updatedAt)}`
    )
  }
}

export async function cmdAssetGet(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const rel = getString(args, 'path') ?? args.positionals[0]
  if (!rel) throw new Error('zn asset get requires an asset path (see `zn asset list`).')
  const output = getString(args, 'output')
  const bytes = await vault.readAsset(rel)

  if (output && output !== '-') {
    await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await fsp.writeFile(output, bytes)
    if (!getBool(args, 'quiet')) {
      emitLine(`Wrote ${bytes.length} bytes to ${output}.`)
    }
    return
  }

  // Binary to stdout. stdin/stdout are the streams `main()` returns through,
  // so drain the write to keep the process from exiting early on Windows.
  await new Promise<void>((resolve, reject) => {
    const flushed = process.stdout.write(bytes, (err) => {
      if (err) reject(err)
    })
    if (flushed) resolve()
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}
