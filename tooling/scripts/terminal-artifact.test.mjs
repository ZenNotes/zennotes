import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  inspectTerminalBinary,
  stageTerminalArtifact,
  validateTerminalRelease,
} from './terminal-artifact.mjs'

function executable(platform, arch) {
  const b = Buffer.alloc(64)
  if (platform === 'darwin') {
    b.writeUInt32LE(0xfeedfacf)
    b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else {
    b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    b.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  }
  return b
}
test('native artifact architecture must match the desktop target', () => {
  for (const platform of ['darwin', 'linux'])
    for (const arch of ['x64', 'arm64']) {
      assert.doesNotThrow(() =>
        inspectTerminalBinary(executable(platform, arch), platform, arch),
      )
      assert.throws(
        () =>
          inspectTerminalBinary(
            executable(platform, arch),
            platform,
            arch === 'x64' ? 'arm64' : 'x64',
          ),
        /architecture/,
      )
    }
  assert.throws(
    () => inspectTerminalBinary(Buffer.from('#!/bin/sh\n'), 'darwin', 'arm64'),
    /executable/,
  )
})
test('release pins require immutable version, source commit, and checksums', () => {
  assert.equal(
    validateTerminalRelease(
      { schemaVersion: 1, release: null },
      'darwin',
      'arm64',
    ),
    null,
  )
  const valid = {
    schemaVersion: 1,
    release: {
      repository: 'ZenNotes/tui',
      version: '1.0.0',
      commit: 'a'.repeat(40),
      protocol: 1,
      artifacts: {
        'darwin-arm64': {
          url: 'https://github.com/ZenNotes/tui/releases/download/v1.0.0/zn_1.0.0_darwin_arm64.tar.gz',
          sha256: 'b'.repeat(64),
        },
      },
    },
  }
  assert.equal(
    validateTerminalRelease(valid, 'darwin', 'arm64').version,
    '1.0.0',
  )
  assert.throws(
    () => validateTerminalRelease(valid, 'linux', 'x64'),
    /artifact/,
  )
  const bad = structuredClone(valid)
  bad.release.artifacts['darwin-arm64'].url =
    'https://github.com/ZenNotes/tui/releases/latest/download/zn.tar.gz'
  assert.throws(() => validateTerminalRelease(bad, 'darwin', 'arm64'), /URL/)
})
test('local candidates require opt-in and checksum verification without replacing an existing stage on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zn-artifact-'))
  try {
    const local = join(root, 'local'),
      staged = join(root, 'output')
    const target = join(local, 'linux-arm64')
    await mkdir(target, { recursive: true })
    const bytes = executable('linux', 'arm64')
    await writeFile(join(target, 'zn'), bytes)
    await writeFile(join(target, 'LICENSE'), 'MIT\n')
    const manifest = {
      schemaVersion: 1,
      protocol: 1,
      version: '1.0.0-local',
      platform: 'linux',
      arch: 'arm64',
      local: true,
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest))
    const options = {
      platform: 'linux',
      arch: 'arm64',
      localDirectory: local,
      output: staged,
      probe: false,
    }
    await assert.rejects(stageTerminalArtifact(options), /local/i)
    await stageTerminalArtifact({ ...options, allowLocal: true })
    assert.deepEqual(await readFile(join(staged, 'zn')), bytes)
    await writeFile(
      join(target, 'zn'),
      Buffer.concat([bytes, Buffer.from('changed')]),
    )
    await assert.rejects(
      stageTerminalArtifact({ ...options, allowLocal: true }),
      /checksum/i,
    )
    assert.deepEqual(await readFile(join(staged, 'zn')), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a disabled release removes a previously staged candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zn-artifact-disabled-'))
  try {
    const output = join(root, 'output'),
      manifestPath = join(root, 'release.json')
    await mkdir(output)
    await writeFile(join(output, 'zn'), 'stale local candidate')
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, release: null }),
    )
    assert.equal(await stageTerminalArtifact({ output, manifestPath }), null)
    await assert.rejects(readFile(join(output, 'zn')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a pinned release verifies its archive before replacing the previous executable', async () => {
  const { execFileSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'zn-artifact-release-'))
  try {
    const source = join(root, 'source'),
      output = join(root, 'output'),
      manifestPath = join(root, 'release.json')
    await mkdir(source)
    const bytes = executable('linux', 'x64')
    await writeFile(join(source, 'zn'), bytes)
    await writeFile(join(source, 'LICENSE'), 'MIT\n')
    const archive = execFileSync('tar', [
      '-czf',
      '-',
      '-C',
      source,
      'zn',
      'LICENSE',
    ])
    const url =
      'https://github.com/ZenNotes/tui/releases/download/v1.0.0/zn_1.0.0_linux_amd64.tar.gz'
    const release = {
      schemaVersion: 1,
      release: {
        repository: 'ZenNotes/tui',
        version: '1.0.0',
        commit: 'a'.repeat(40),
        protocol: 1,
        artifacts: {
          'linux-x64': {
            url,
            sha256: createHash('sha256').update(archive).digest('hex'),
          },
        },
      },
    }
    await writeFile(manifestPath, JSON.stringify(release))
    let downloaded = archive
    const options = {
      platform: 'linux',
      arch: 'x64',
      output,
      manifestPath,
      probe: false,
      fetchImpl: async (requested) => {
        assert.equal(requested, url)
        return new Response(downloaded)
      },
    }
    await stageTerminalArtifact(options)
    assert.deepEqual(await readFile(join(output, 'zn')), bytes)
    assert.equal(await readFile(join(output, 'LICENSE'), 'utf8'), 'MIT\n')
    const installed = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    )
    assert.equal(installed.local, false)
    assert.equal(installed.source.commit, release.release.commit)
    downloaded = Buffer.from('corrupt download')
    await assert.rejects(stageTerminalArtifact(options), /checksum/i)
    assert.deepEqual(await readFile(join(output, 'zn')), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
