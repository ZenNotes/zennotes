import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packWebDistribution } from './pack-web-artifact.mjs'
import { runNpm } from './pack-shared-package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
runNpm(['run', 'build', '--workspace', '@zennotes/share-viewer'], { cwd: root, stdio: 'inherit' })
const product = JSON.parse(await readFile(join(root, 'apps/share-viewer/package.json'), 'utf8'))
const result = await packWebDistribution({
  target: 'viewer', distribution: join(root, 'apps/share-viewer/dist'), output: join(root, 'dist/viewer-artifacts'),
  productVersion: product.version,
  source: {
    repository: 'https://github.com/ZenNotes/zennotes',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    lockfileSha256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex')
  },
  toolchain: { node: process.version, npm: runNpm(['--version'], { encoding: 'utf8' }).trim() }
})
console.log(JSON.stringify({ version: result.manifest.version, archive: result.archivePath, manifest: result.manifestPath }, null, 2))
