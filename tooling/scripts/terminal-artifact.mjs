import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/
const supported = (platform, arch) =>
  ['darwin', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch)

export function inspectTerminalBinary(bytes, platform, arch) {
  if (!supported(platform, arch))
    throw new Error(
      `Unsupported terminal platform/architecture: ${platform}/${arch}`,
    )
  if (bytes.length < 32)
    throw new Error('Terminal artifact is not a native executable.')
  if (platform === 'darwin') {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf)
      throw new Error('Terminal artifact is not a Mach-O executable.')
    if (bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007))
      throw new Error('Terminal architecture mismatch.')
  } else {
    if (
      !bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
    )
      throw new Error('Terminal artifact is not an ELF64 executable.')
    if (bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62))
      throw new Error('Terminal architecture mismatch.')
  }
}

export function validateTerminalRelease(manifest, platform, arch) {
  if (manifest?.schemaVersion !== 1)
    throw new Error('Unsupported terminal release manifest.')
  if (manifest.release === null) return null
  const pin = manifest.release
  if (
    pin?.repository !== 'ZenNotes/tui' ||
    pin.protocol !== 1 ||
    typeof pin.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pin.version) ||
    !/^[a-f0-9]{40}$/.test(pin.commit ?? '')
  )
    throw new Error(
      'Terminal release requires a version, source commit, and integration protocol.',
    )
  const artifact = pin.artifacts?.[`${platform}-${arch}`]
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? ''))
    throw new Error(
      `Missing verified terminal artifact for ${platform}-${arch}.`,
    )
  const goArch = arch === 'x64' ? 'amd64' : arch
  const expected = `https://github.com/ZenNotes/tui/releases/download/v${pin.version}/zn_${pin.version}_${platform}_${goArch}.tar.gz`
  if (artifact.url !== expected)
    throw new Error(
      'Terminal artifact URL must name the pinned GitHub release archive.',
    )
  return { ...pin, artifact }
}

async function checkProbe(binary, manifest) {
  const { stdout } = await exec(binary, ['--desktop-integration'], {
    timeout: 10000,
    maxBuffer: 65536,
  })
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    throw new Error('Terminal integration probe returned invalid JSON.')
  }
  if (result.protocol !== 1 || result.version !== manifest.version)
    throw new Error('Terminal integration probe does not match the artifact.')
}

async function installStage(output, bytes, license, manifest, probe) {
  inspectTerminalBinary(bytes, manifest.platform, manifest.arch)
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== 1 ||
    !versionPattern.test(manifest.version ?? '')
  )
    throw new Error('Invalid terminal integration manifest.')
  await mkdir(dirname(output), { recursive: true })
  const stage = await mkdtemp(`${output}.stage-`)
  const retired = `${output}.retired-${randomUUID()}`
  let replaced = false
  try {
    const binary = join(stage, 'zn')
    await writeFile(binary, bytes, { mode: 0o755 })
    await writeFile(join(stage, 'LICENSE'), license)
    await writeFile(
      join(stage, 'manifest.json'),
      JSON.stringify({ ...manifest, binarySha256: hash(bytes) }, null, 2) +
        '\n',
    )
    if (
      probe &&
      manifest.platform === process.platform &&
      manifest.arch === process.arch
    )
      await checkProbe(binary, manifest)
    try {
      await rename(output, retired)
      replaced = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      await rename(stage, output)
    } catch (error) {
      if (replaced) await rename(retired, output)
      throw error
    }
    if (replaced) await rm(retired, { recursive: true, force: true })
    return manifest
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export async function stageTerminalArtifact({
  platform = process.platform,
  arch = process.arch,
  manifestPath = join(root, 'apps/desktop/terminal-release.json'),
  output,
  localDirectory,
  allowLocal = false,
  probe = true,
  fetchImpl = fetch,
} = {}) {
  if (!supported(platform, arch))
    throw new Error(
      `Unsupported terminal platform/architecture: ${platform}/${arch}`,
    )
  if (!output)
    throw new Error('A terminal artifact output directory is required.')
  if (localDirectory) {
    if (!allowLocal)
      throw new Error('Local terminal artifacts require explicit opt-in.')
    const source = join(localDirectory, `${platform}-${arch}`)
    const manifest = JSON.parse(
      await readFile(join(source, 'manifest.json'), 'utf8'),
    )
    if (
      !manifest.local ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    )
      throw new Error(
        'Local terminal artifact platform or architecture mismatch.',
      )
    const bytes = await readFile(join(source, 'zn'))
    if (hash(bytes) !== manifest.binarySha256)
      throw new Error('Local terminal artifact checksum mismatch.')
    return installStage(
      output,
      bytes,
      await readFile(join(source, 'LICENSE')),
      manifest,
      probe,
    )
  }
  const pin = validateTerminalRelease(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    platform,
    arch,
  )
  if (!pin) {
    // A reused packaging directory must not retain a development candidate.
    await rm(output, { recursive: true, force: true })
    return null
  }
  const response = await fetchImpl(pin.artifact.url, {
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok)
    throw new Error(
      `Terminal artifact download failed: HTTP ${response.status}.`,
    )
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 96 * 1024 * 1024)
      throw new Error('Terminal artifact exceeds the download limit.')
    chunks.push(chunk)
  }
  const archive = Buffer.concat(chunks)
  if (hash(archive) !== pin.artifact.sha256)
    throw new Error('Terminal release checksum mismatch.')
  const scratch = await mkdtemp(join(tmpdir(), 'zn-terminal-artifact-'))
  try {
    const archivePath = join(scratch, 'release.tar.gz')
    await writeFile(archivePath, archive)
    // Read only the named files to stdout. Archive paths are never extracted
    // onto the build filesystem, including links or traversal entries.
    const unpack = async (name) =>
      (
        await exec('tar', ['-xOzf', archivePath, name], {
          encoding: 'buffer',
          maxBuffer: 128 * 1024 * 1024,
        })
      ).stdout
    const bytes = await unpack('zn'),
      license = await unpack('LICENSE')
    return installStage(
      output,
      bytes,
      license,
      {
        schemaVersion: 1,
        protocol: pin.protocol,
        version: pin.version,
        platform,
        arch,
        source: { repository: pin.repository, commit: pin.commit },
        archiveSha256: pin.artifact.sha256,
        local: false,
      },
      probe,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  const platform = option('--platform') ?? process.platform,
    arch = option('--arch') ?? process.arch
  const output = resolve(
    option('--output') ??
      join(root, 'apps/desktop/build/terminal', `${platform}-${arch}`),
  )
  const binary = option('--local-binary')
  if (binary) {
    const license = option('--license')
    if (!license)
      throw new Error(
        'A local candidate requires --license from the TUI repository.',
      )
    if (platform !== process.platform || arch !== process.arch)
      throw new Error(
        'Local candidates must be staged on their native host for the integration probe.',
      )
    const bytes = await readFile(binary)
    inspectTerminalBinary(bytes, platform, arch)
    const { stdout } = await exec(binary, ['--desktop-integration'], {
      timeout: 10000,
    })
    const integration = JSON.parse(stdout)
    await installStage(
      output,
      bytes,
      await readFile(license),
      {
        schemaVersion: 1,
        protocol: integration.protocol,
        version: integration.version,
        platform,
        arch,
        local: true,
      },
      true,
    )
  } else {
    await stageTerminalArtifact({ platform, arch, output })
  }
  console.log(output)
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
