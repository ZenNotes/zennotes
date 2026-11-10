// The portable vault package runs on the iPhone, on Android and in a browser
// tab, so it may reach a host only through the interfaces in its host.ts.
// This walks every module specifier in packages/portable-vault/src and fails
// on anything that would tie the package to one host: a Capacitor plugin, a
// native secure-storage module, app-core (the phones' one app-core import,
// relocateLocalVault, stays with the host caller), Node built-ins outside
// tests, Vite's import.meta.env, or a relative import out of the package.
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(repoRoot, 'packages/portable-vault')
const sourceRoot = join(packageRoot, 'src')
const ts = createRequire(join(packageRoot, 'package.json'))('typescript')

/** Bare specifiers the package may import, by prefix. Tests may also use vitest. */
const ALLOWED = ['@zennotes/bridge-contract/', '@zennotes/shared-domain/']
const ALLOWED_DEPENDENCIES = new Set(['@zennotes/bridge-contract', '@zennotes/shared-domain'])

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  }))
  return groups.flat().filter((path) => /\.(?:ts|tsx|mts)$/.test(path))
}

export function specifiersIn(path, source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const found = []
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') specifier = node.arguments[0]
    if (specifier && ts.isStringLiteralLike(specifier)) found.push(specifier.text)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'env' &&
        ts.isMetaProperty(node.expression) && node.expression.name.text === 'meta') {
      found.push('import.meta.env')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

export function boundaryProblem(file, specifier) {
  const test = /\.test\.tsx?$/.test(file) || file.startsWith(join(packageRoot, 'test') + sep)
  if (specifier === 'import.meta.env') return 'reads import.meta.env (pass build settings through HostShell instead)'
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier)
    const inside = (root) => target === root || target.startsWith(root + sep)
    // Tests share their host double in test/, which is never packed.
    if (inside(sourceRoot) || (test && inside(join(packageRoot, 'test')))) return null
    return `imports ${specifier}, outside the package`
  }
  if (/^(?:@capacitor|@aparajita|@capacitor-community)\//.test(specifier)) return `imports ${specifier} (a native plugin belongs to the host)`
  if (specifier.startsWith('@zennotes/app-core')) return `imports ${specifier} (app-core stays with the host caller)`
  if (specifier.startsWith('node:')) return test ? null : `imports ${specifier} outside a test`
  if (test && (specifier === 'vitest' || specifier.startsWith('vitest/'))) return null
  if (ALLOWED.some((prefix) => specifier.startsWith(prefix))) return null
  return `imports ${specifier}, which is not a declared dependency`
}

export async function checkPortableVaultBoundary() {
  const problems = []
  for (const file of [...await sourceFiles(sourceRoot), ...await sourceFiles(join(packageRoot, 'test')).catch(() => [])]) {
    for (const specifier of specifiersIn(file, await readFile(file, 'utf8'))) {
      const problem = boundaryProblem(file, specifier)
      if (problem) problems.push(`${relative(repoRoot, file)} ${problem}`)
    }
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (!ALLOWED_DEPENDENCIES.has(name)) problems.push(`package.json depends on ${name}`)
  }
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    // Shipped files (TikZJax) may be a pattern under ./assets/; code is one file under ./src/.
    if (typeof target === 'string' && target.startsWith('./assets/') && key.endsWith('/*') && target.endsWith('/*')) {
      const directory = join(packageRoot, target.slice(2, -2))
      if (!(await readdir(directory).then((names) => names.length > 0, () => false))) {
        problems.push(`package.json export ${key} names ${target}, which holds no files`)
      }
      continue
    }
    if (typeof target !== 'string' || !target.startsWith('./src/') || key.includes('*')) {
      problems.push(`package.json export ${key} must name one file under ./src/`)
      continue
    }
    if (!await readFile(join(packageRoot, target)).then(() => true, () => false)) {
      problems.push(`package.json export ${key} names ${target}, which does not exist`)
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkPortableVaultBoundary()
  if (problems.length > 0) {
    process.stderr.write(`portable-vault boundary check failed:\n${problems.map((line) => `  ${line}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write('portable-vault boundary check passed.\n')
}
