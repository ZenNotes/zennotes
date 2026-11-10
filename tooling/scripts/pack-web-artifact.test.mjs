import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cloudWebRelease, packWebDistribution } from './pack-web-artifact.mjs'

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

test('a cloud-web release is named for the product version and commit, before the build', () => {
  assert.deepEqual(cloudWebRelease({ productVersion: '2.85.0', commit: '0123456789abcdef'.repeat(2) + '01234567', dirty: false }), {
    release: '2.85.0-0123456789ab',
    base: '/vendor/cloud-web/releases/2.85.0-0123456789ab/'
  })
  assert.throws(() => cloudWebRelease({ productVersion: '2.85.0', commit: 'nope', dirty: false }), /40-hex/)
})

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

test('ZenNotes in your browser packs as its own artifact, with its headers and notices', async (t) => {
  const options = await fixture(t)
  options.target = 'cloud-web'
  // The website refuses a pin without the base its files were built for.
  await assert.rejects(packWebDistribution(options), /needs the base it was built for/)
  await assert.rejects(packWebDistribution({ ...options, base: '/somewhere/else/' }), /needs the base it was built for/)
  options.base = cloudWebRelease({ productVersion: '1.0.0', commit: options.source.commit, dirty: true }).base
  assert.equal(options.base, '/vendor/cloud-web/releases/1.0.0-aaaaaaaaaaaa-dirty/')
  await assert.rejects(packWebDistribution(options), /Missing browser entrypoint: headers.json/)
  await writeFile(join(options.distribution, 'headers.json'), '{"schemaVersion":1}')
  await writeFile(join(options.distribution, 'THIRD_PARTY_NOTICES.txt'), 'TikZJax notices')
  const first = await packWebDistribution(options)
  assert.equal(first.manifest.artifact, 'zennotes-cloud-web')
  assert.equal(first.manifest.protocol, 'browser-vault-v1')
  assert.match(first.manifest.version, /^1\.0\.0-cloud-web\.h[a-f0-9]{16}$/)
  assert.equal(first.manifest.base, options.base)
  assert.ok(first.manifest.files.some((file) => file.path === 'LICENSE'))
  assert.deepEqual(await packWebDistribution(options), first)
  // The base is part of what the version names: the same bytes built for
  // another folder are another pin.
  const elsewhere = await packWebDistribution({ ...options, output: `${options.output}-2`, base: '/vendor/cloud-web/releases/1.0.0-bbbbbbbbbbbb/' })
  assert.notEqual(elsewhere.manifest.version, first.manifest.version)
  const { base: _base, ...webOptions } = options
  await assert.rejects(packWebDistribution({ ...options, target: 'web' }), /has no base/)
  const web = await packWebDistribution({ ...webOptions, target: 'web' })
  assert.notEqual(web.manifest.version, first.manifest.version)
  assert.equal(web.manifest.base, undefined)
})
