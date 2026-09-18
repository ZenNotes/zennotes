import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pinPath = join(repoRoot, 'tooling/server-release.json')

// The Go server lives in ZenNotes/znserver. Anything here that needs a running
// server (the browser harness, perf runs, dev:web-stack) takes, in order, an
// explicit binary, an explicit checkout built with Go, or the pinned published
// release verified against the SHA-256 recorded in tooling/server-release.json.
// Nothing in this repository builds the server from source any more.
export async function resolveServerBinary({ log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const explicit = process.env.ZENNOTES_SERVER_BINARY?.trim()
  const checkout = process.env.ZENNOTES_SERVER_DIR?.trim()
  if (explicit && checkout) throw new Error('Choose ZENNOTES_SERVER_BINARY or ZENNOTES_SERVER_DIR, not both')
  if (explicit) {
    await access(explicit, constants.X_OK)
    return resolve(explicit)
  }
  if (checkout) return buildFromCheckout(resolve(checkout), log)
  return downloadPinned(log)
}

export async function readServerPin() {
  return JSON.parse(await readFile(pinPath, 'utf8'))
}

export function pinnedAssetKey() {
  return `${process.platform}-${process.arch}`
}

async function buildFromCheckout(dir, log) {
  const out = join(dir, 'bin', process.platform === 'win32' ? 'zennotes-server.exe' : 'zennotes-server')
  log(`[server] building ${out} from ${dir}`)
  execFileSync('go', ['build', '-trimpath', '-o', out, './cmd/zennotes-server'], { cwd: dir, stdio: 'inherit' })
  return out
}

async function sha256Of(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function downloadPinned(log) {
  const pin = await readServerPin()
  const key = pinnedAssetKey()
  const asset = pin.assets[key]
  if (!asset) throw new Error(`No pinned server binary for ${key}; set ZENNOTES_SERVER_BINARY or ZENNOTES_SERVER_DIR`)
  const directory = join(repoRoot, 'dist/server-binaries', pin.version)
  const target = join(directory, asset.file)
  if ((await sha256Of(target)) === asset.sha256) {
    await chmod(target, 0o755)
    return target
  }
  const url = `https://github.com/${pin.repository}/releases/download/${pin.version}/${asset.file}`
  log(`[server] downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`Server download failed: HTTP ${response.status} for ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error(`Server download checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`)
  }
  await mkdir(directory, { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, bytes, { mode: 0o755 })
  await rename(temp, target)
  await chmod(target, 0o755)
  return target
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await resolveServerBinary()}\n`)
}
