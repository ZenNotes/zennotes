import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageNames = ['bridge-contract', 'shared-domain']

// tsc reads include and exclude as glob patterns, and globs only understand
// forward slashes, so a Windows path.join result matches nothing (TS18003).
export function tsconfigPath(path) {
  return path.split(sep).join('/')
}

export function runNpm(args, options) {
  const cli = process.env.npm_execpath
  if (cli) return execFileSync(process.execPath, [cli, ...args], options)
  if (process.platform === 'win32') {
    throw new Error('Run this script through npm run so the npm JavaScript CLI is available on Windows.')
  }
  return execFileSync('npm', args, options)
}

export async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesIn(path) : [path]
  }))
  return groups.flat()
}

async function isFile(path) {
  try { return (await stat(path)).isFile() } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function candidateSuffix() {
  const inputs = ['LICENSE', 'tsconfig.base.json', 'package-lock.json', 'tooling/scripts/pack-shared-package.mjs']
    .map((path) => join(repoRoot, path))
  for (const name of packageNames) {
    const root = join(repoRoot, 'packages', name)
    inputs.push(join(root, 'package.json'), join(root, 'tsconfig.json'), ...await filesIn(join(root, 'src')))
    if (name === 'bridge-contract') inputs.push(...await filesIn(join(root, 'fixtures')))
  }
  const hash = createHash('sha256')
  hash.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }))
  for (const file of inputs.sort()) {
    const bytes = await readFile(file)
    hash.update(`${relative(repoRoot, file).replace(/\\/g, '/')}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return `boundaries.h${hash.digest('hex').slice(0, 16)}`
}

// Source workspaces use extensionless imports. Published ESM and declarations
// need resolvable file extensions; rewrite only module specifiers, never note data.
export async function resolvePublishedImports(directory, ts, aliases = {}) {
  for (const file of await filesIn(directory)) {
    if (!file.endsWith('.js') && !file.endsWith('.ts')) continue
    const source = await readFile(file, 'utf8')
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const literals = []
    function visit(node) {
      let specifier
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
      if (specifier && ts.isStringLiteral(specifier)) literals.push(specifier)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    let rewritten = source
    for (const literal of literals.sort((a, b) => b.pos - a.pos)) {
      const alias = Object.keys(aliases).find((prefix) => literal.text.startsWith(prefix))
      if (alias) {
        const replacement = aliases[alias] + literal.text.slice(alias.length)
        rewritten = rewritten.slice(0, literal.getStart(ast) + 1) + replacement + rewritten.slice(literal.end - 1)
        continue
      }
      if (!literal.text.startsWith('.')) continue
      if (/\.(?:js|mjs|cjs|json)$/.test(literal.text)) continue
      if (await isFile(resolve(dirname(file), literal.text.split('?')[0]))) continue
      const target = resolve(dirname(file), literal.text)
      const suffix = await isFile(`${target}.js`) ? '.js'
        : await isFile(join(target, 'index.js')) ? '/index.js' : null
      if (!suffix) throw new Error(`Unresolved published import ${literal.text} in ${file}`)
      rewritten = rewritten.slice(0, literal.getStart(ast) + 1) + literal.text + suffix + rewritten.slice(literal.end - 1)
    }
    if (rewritten !== source) await writeFile(file, rewritten)
  }
}

export async function packSharedPackage(name, candidateVersion) {
  if (!packageNames.includes(name)) throw new Error(`Unsupported shared package: ${name}`)
  const packageRoot = join(repoRoot, 'packages', name)
  const source = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const version = candidateVersion ?? `${source.version}-${await candidateSuffix()}`
  const output = join(repoRoot, 'dist/shared-packages')
  const stage = await mkdtemp(join(tmpdir(), `zennotes-${name}-package-`))
  const require = createRequire(join(packageRoot, 'package.json'))
  try {
    const config = {
      extends: tsconfigPath(join(packageRoot, 'tsconfig.json')),
      compilerOptions: {
        composite: false, declaration: true, types: [], lib: ['ES2022', 'DOM'],
        rootDir: tsconfigPath(join(packageRoot, 'src')), outDir: tsconfigPath(join(stage, 'dist'))
      },
      include: [tsconfigPath(join(packageRoot, 'src/**/*.ts'))],
      exclude: [tsconfigPath(join(packageRoot, 'src/**/*.test.ts'))]
    }
    await writeFile(join(stage, 'tsconfig.json'), JSON.stringify(config))
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')], {
      cwd: repoRoot, stdio: 'inherit'
    })
    await resolvePublishedImports(join(stage, 'dist'), require('typescript'))
    const exports = Object.fromEntries(Object.entries(source.exports).map(([key, path]) => {
      const entry = path.replace('./src/', './dist/').replace(/\.ts$/, '')
      return [key, { types: `${entry}.d.ts`, import: `${entry}.js`, default: `${entry}.js` }]
    }))
    for (const [key, targets] of Object.entries(exports)) {
      if (key.includes('*')) continue
      for (const target of new Set(Object.values(targets))) {
        if (!await isFile(join(stage, target))) throw new Error(`Missing export target ${key}: ${target}`)
      }
    }
    const dependencies = Object.fromEntries(Object.entries(source.dependencies ?? {}).map(([key, value]) => [
      key, key.startsWith('@zennotes/') ? version : value
    ]))
    const files = ['dist', 'LICENSE']
    if (name === 'bridge-contract') {
      await cp(join(packageRoot, 'fixtures'), join(stage, 'fixtures'), { recursive: true })
      files.push('fixtures')
    }
    await cp(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'))
    await writeFile(join(stage, 'package.json'), JSON.stringify({
      name: source.name, version, type: 'module', license: 'MIT', exports, files, dependencies
    }, null, 2) + '\n')
    await mkdir(output, { recursive: true })
    const packed = JSON.parse(runNpm([
      'pack', '--json', '--ignore-scripts'
    ], { cwd: stage, encoding: 'utf8' }))[0]
    const stagedArchive = join(stage, packed.filename)
    const archive = join(output, packed.filename)
    const bytes = await readFile(stagedArchive)
    try {
      await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!bytes.equals(await readFile(archive))) {
        throw new Error(`Candidate ${version} already exists with different bytes. Choose a new version.`)
      }
    }
    const manifest = {
      name: source.name, version, file: packed.filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: packed.integrity,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0
    }
    await writeFile(`${archive}.json`, JSON.stringify(manifest, null, 2) + '\n')
    return { archive, ...manifest }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await packSharedPackage(process.argv[2], process.argv[3]), null, 2) + '\n')
}
