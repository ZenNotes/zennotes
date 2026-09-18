import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpm } from './pack-shared-package.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(repoRoot, 'packages/bridge-contract/package.json'))
const consumer = await mkdtemp(join(tmpdir(), 'zennotes contract & domain consumer '))

try {
  const packed = JSON.parse(execFileSync(process.execPath, [
    join(repoRoot, 'tooling/scripts/pack-shared-package.mjs'), 'bridge-contract'
  ], { cwd: repoRoot, encoding: 'utf8' }))
  const domain = JSON.parse(execFileSync(process.execPath, [
    join(repoRoot, 'tooling/scripts/pack-shared-package.mjs'), 'shared-domain'
  ], { cwd: repoRoot, encoding: 'utf8' }))
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'contract-consumer', private: true, type: 'module'
  }))
  // npm ci caches tarballs but never the registry metadata that resolving a
  // dependency range needs, so a fully offline install fails on a fresh CI cache.
  runNpm([
    'install', packed.archive, domain.archive, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'
  ], { cwd: consumer, stdio: 'inherit' })
  const installedRoot = join(consumer, 'node_modules/@zennotes/bridge-contract')
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(installed.version, packed.version)
  assert.equal(installed.private, undefined)
  assert.deepEqual(installed.dependencies ?? {}, {})
  const bridgeImports = Object.keys(installed.exports).map((path) => `${installed.name}/${path.slice(2)}`)

  const domainRoot = join(consumer, 'node_modules/@zennotes/shared-domain/dist')
  const modules = (await readdir(domainRoot, { recursive: true })).filter((path) => path.endsWith('.js'))
  const imports = [...bridgeImports, ...modules.map((path) => `@zennotes/shared-domain/${path.replace(/\\/g, '/').slice(0, -3)}`)]
  await writeFile(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict'
import { PORTABLE_PREF_KEYS } from '@zennotes/bridge-contract/app-config'
import { installZenBridge } from '@zennotes/bridge-contract/bridge'
import { IPC } from '@zennotes/bridge-contract/ipc'
assert.ok(PORTABLE_PREF_KEYS.includes('vimMode'))
assert.equal(typeof installZenBridge, 'function')
assert.ok(Object.keys(IPC).length > 0)
for (const name of ${JSON.stringify(imports)}) await import(name)
`)
  execFileSync(process.execPath, ['runtime.mjs'], { cwd: consumer, stdio: 'inherit' })
  await writeFile(join(consumer, 'consumer.ts'), `
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { VaultTask } from '@zennotes/bridge-contract/tasks'
import type { AppConfigPortable } from '@zennotes/bridge-contract/app-config'
export const platform: Awaited<ReturnType<ZenBridge['platform']>> = 'darwin'
export const priority: VaultTask['priority'] = 'high'
export const prefs: AppConfigPortable = { vimMode: true }
${imports.map((name, index) => `import * as module${index} from '${name}'`).join('\n')}
`)
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, types: [], lib: ['ES2022', 'DOM'], noEmit: true
    },
    include: ['consumer.ts']
  }))
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: consumer, stdio: 'inherit'
  })
  process.stdout.write('Contract and domain packages install, import, and typecheck without workspace source.\n')
} finally {
  await rm(consumer, { recursive: true, force: true })
}
