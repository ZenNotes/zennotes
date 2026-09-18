import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filesIn, packSharedPackage, resolvePublishedImports, runNpm, tsconfigPath } from './pack-shared-package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(root, 'packages/app-core')
const require = createRequire(join(packageRoot, 'package.json'))

export async function packAppCore() {
  const contract = await packSharedPackage('bridge-contract')
  const domain = await packSharedPackage('shared-domain')
  const source = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const stage = await mkdtemp(join(tmpdir(), 'zennotes-app-core-package-'))
  try {
    const config = {
      extends: tsconfigPath(join(packageRoot, 'tsconfig.json')),
      compilerOptions: {
        composite: false, declaration: true, noEmit: false, types: [],
        rootDir: tsconfigPath(join(root, 'packages')), outDir: tsconfigPath(join(stage, 'emit'))
      },
      include: [tsconfigPath(join(packageRoot, 'src/**/*.ts')), tsconfigPath(join(packageRoot, 'src/**/*.tsx'))],
      exclude: [tsconfigPath(join(packageRoot, 'src/**/*.test.ts')), tsconfigPath(join(packageRoot, 'src/**/*.test.tsx'))]
    }
    await writeFile(join(stage, 'tsconfig.json'), JSON.stringify(config))
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')], { cwd: root, stdio: 'inherit' })
    const payload = join(stage, 'package')
    await mkdir(payload)
    // TypeScript follows source aliases while checking. Ship only app-core's
    // emitted files; contract/domain are separately pinned dependencies.
    await cp(join(stage, 'emit/app-core/src'), join(payload, 'dist'), { recursive: true })
    for (const file of await filesIn(join(packageRoot, 'src'))) {
      if (/\.(?:ts|tsx)$/.test(file) && !file.endsWith('.d.ts')) continue
      const target = join(payload, 'dist', relative(join(packageRoot, 'src'), file))
      await mkdir(dirname(target), { recursive: true })
      await cp(file, target)
    }
    await resolvePublishedImports(join(payload, 'dist'), require('typescript'), {
      '@shared/': '@zennotes/shared-domain/',
      '@bridge-contract/': '@zennotes/bridge-contract/'
    })

    const theme = require(join(packageRoot, 'build/tailwind-preset.cjs'))
    const css = await require('postcss')([
      require('tailwindcss')({ ...theme, content: [join(payload, 'dist/**/*.js')] }),
      require('autoprefixer')()
    ]).process(await readFile(join(packageRoot, 'src/styles/index.css'), 'utf8'), { from: undefined })
    await writeFile(join(payload, 'dist/styles/index.css'), css.css)
    await cp(join(packageRoot, 'build'), join(payload, 'build'), { recursive: true })
    await cp(join(root, 'LICENSE'), join(payload, 'LICENSE'))
    await cp(join(packageRoot, 'README.md'), join(payload, 'README.md'))

    const exports = {
      './main': { types: './dist/main.d.ts', import: './dist/main.js' },
      './navigation': { types: './dist/navigation.d.ts', import: './dist/navigation.js' },
      './notes': { types: './dist/notes.d.ts', import: './dist/notes.js' },
      './shell': { types: './dist/shell.d.ts', import: './dist/shell.js' },
      './browse': { types: './dist/browse.d.ts', import: './dist/browse.js' },
      './tasks': { types: './dist/tasks.d.ts', import: './dist/tasks.js' },
      './workspace': { types: './dist/workspace.d.ts', import: './dist/workspace.js' },
      './settings': { types: './dist/settings.d.ts', import: './dist/settings.js' },
      './commands': { types: './dist/commands.d.ts', import: './dist/commands.js' },
      './dialogs': { types: './dist/dialogs.d.ts', import: './dist/dialogs.js' },
      './host': { types: './dist/host.d.ts', import: './dist/host.js' },
      './editor': { types: './dist/editor.d.ts', import: './dist/editor.js' },
      './styles.css': './dist/styles/index.css',
      './vite': { types: './build/vite.d.ts', import: './build/vite.mjs' }
    }
    const dependencies = {
      ...source.dependencies,
      [contract.name]: contract.version,
      [domain.name]: domain.version
    }
    const peerDependencies = { vite: '^6.4.3 || ^7.0.0 || ^8.0.0' }
    for (const name of ['react', 'react-dom', 'zustand', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight']) {
      peerDependencies[name] = dependencies[name]
      delete dependencies[name]
    }
    const metadata = {
      name: source.name, type: 'module', license: 'MIT', exports,
      files: ['dist', 'build', 'LICENSE'], dependencies, peerDependencies,
      peerDependenciesMeta: { vite: { optional: true } }
    }
    const hash = createHash('sha256').update(JSON.stringify(metadata))
    for (const file of (await filesIn(payload)).sort()) {
      const bytes = await readFile(file)
      hash.update(`${relative(payload, file).split('\\').join('/')}\0${bytes.length}\0`)
      hash.update(bytes)
    }
    const version = `${source.version}-core.h${hash.digest('hex').slice(0, 16)}`
    await writeFile(join(payload, 'package.json'), JSON.stringify({ ...metadata, version }, null, 2) + '\n')
    const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts'], { cwd: payload, encoding: 'utf8' }))[0]
    const output = join(root, 'dist/shared-packages')
    await mkdir(output, { recursive: true })
    const archive = join(output, packed.filename)
    const bytes = await readFile(join(payload, packed.filename))
    try { await copyFile(join(payload, packed.filename), archive, constants.COPYFILE_EXCL) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!bytes.equals(await readFile(archive))) throw new Error(`Package candidate already exists with different bytes: ${version}`)
    }
    const manifest = {
      name: source.name, version, file: packed.filename, archive,
      sha256: createHash('sha256').update(bytes).digest('hex'), integrity: packed.integrity,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
      sourceLockSha256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
      toolchain: { node: process.version, typescript: require('typescript/package.json').version, tailwind: require('tailwindcss/package.json').version },
      dependencies: [contract, domain]
    }
    await writeFile(`${archive}.json`, JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await packAppCore(), null, 2) + '\n')
}
