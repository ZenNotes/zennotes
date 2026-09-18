import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packWebDistribution } from './pack-web-artifact.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zennotes web artifact & test '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const distribution = join(root, 'dist')
  await mkdir(distribution)
  await writeFile(join(distribution, 'index.html'), '<script src="app.js"></script>')
  await writeFile(join(distribution, 'app.js'), 'console.log("first")')
  await writeFile(join(distribution, 'sw.js'), '/* service worker */')
  await writeFile(join(distribution, 'manifest.webmanifest'), '{}')
  return {
    distribution,
    output: join(root, 'output'),
    productVersion: '1.0.0',
    source: {
      repository: 'https://github.com/ZenNotes/zennotes',
      commit: 'a'.repeat(40),
      dirty: true
    },
    toolchain: { node: process.version }
  }
}

test('identical browser bytes produce an identical archive; changed bytes produce a new pin', async (t) => {
  const options = await fixture(t)
  const first = await packWebDistribution(options)
  const repeated = await packWebDistribution(options)
  assert.deepEqual(first, repeated)
  assert.equal(first.manifest.archive.url, undefined)
  assert.deepEqual(
    first.manifest.files.map((file) => file.path),
    ['app.js', 'index.html', 'manifest.webmanifest', 'sw.js']
  )
  await writeFile(join(options.distribution, 'app.js'), 'console.log("second")')
  const changed = await packWebDistribution(options)
  assert.notEqual(changed.manifest.version, first.manifest.version)
  assert.notEqual(changed.manifest.archive.sha256, first.manifest.archive.sha256)
  assert.ok((await readFile(first.archivePath)).length > 0)
})

test('refuses source symlinks and missing browser entrypoints', async (t) => {
  const options = await fixture(t)
  await rm(join(options.distribution, 'sw.js'))
  await assert.rejects(packWebDistribution(options), /Missing browser entrypoint/)
  try {
    await symlink('app.js', join(options.distribution, 'sw.js'))
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('symbolic links require OS permission')
      return
    }
    throw error
  }
  await assert.rejects(packWebDistribution(options), /regular files/)
})

test('requires explicit source provenance before packing', async (t) => {
  const options = await fixture(t)
  delete options.source.dirty
  await assert.rejects(packWebDistribution(options), /explicit dirty boolean/)
})

test('viewer archives have a distinct protocol, entrypoints and immutable identity', async (t) => {
  const options = await fixture(t)
  options.target = 'viewer'
  await assert.rejects(packWebDistribution(options), /Missing browser entrypoint/)
  await writeFile(join(options.distribution, 'share-viewer.js'), 'console.log("read only")')
  await writeFile(join(options.distribution, 'share-viewer.css'), 'body { color: black }')
  const first = await packWebDistribution(options)
  assert.equal(first.manifest.artifact, 'zennotes-share-viewer')
  assert.equal(first.manifest.protocol, 'share-page-payload-v1')
  assert.deepEqual(first.manifest.entrypoints, ['share-viewer.js', 'share-viewer.css'])
  assert.match(first.manifest.version, /^1\.0\.0-viewer\.h[a-f0-9]{16}$/)
  assert.deepEqual(await packWebDistribution(options), first)
  await writeFile(join(options.distribution, 'share-viewer.css'), 'body { color: blue }')
  assert.notEqual((await packWebDistribution(options)).manifest.version, first.manifest.version)
})

// The producer must not follow input links while adding the static license.
test('viewer license symlinks cannot overwrite files outside staging', async (t) => {
  const options = await fixture(t)
  const target = join(options.distribution, '..', 'outside.txt')
  await writeFile(target, 'unchanged')
  try { await symlink(target, join(options.distribution, 'LICENSE')) } catch (error) {
    if (error.code === 'EPERM') { t.skip('symbolic links require OS permission'); return }
    throw error
  }
  await assert.rejects(packWebDistribution({ ...options, target: 'viewer' }), /EEXIST/)
  assert.equal(await readFile(target, 'utf8'), 'unchanged')
})
