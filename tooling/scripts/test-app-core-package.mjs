import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packAppCore } from './pack-app-core.mjs'
import { filesIn, runNpm } from './pack-shared-package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const candidate = process.argv[2]
  ? JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
  : await packAppCore()
// Keep the consumer for browser checks and diagnosis. It deliberately lives
// outside the checkout, and nested installation exposes undeclared dependencies.
const consumer = await mkdtemp(join(tmpdir(), 'zennotes core consumer & '))
console.log(`Consumer: ${consumer}`)
for (const entry of [candidate, ...candidate.dependencies]) {
  assert.equal(createHash('sha256').update(await readFile(entry.archive)).digest('hex'), entry.sha256, `Candidate checksum mismatch: ${entry.name}`)
}
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const installedVersion = (name) => {
  const version = lock.packages[`node_modules/${name}`]?.version
  assert.ok(version, `Missing locked consumer dependency: ${name}`)
  return version
}
const runtime = ['react', 'react-dom', 'zustand', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight']
const development = ['typescript', 'vite', '@types/node', '@types/react', '@types/react-dom']
await writeFile(join(consumer, 'package.json'), JSON.stringify({
  name: 'zennotes-isolated-core-consumer', private: true, type: 'module', version: '0.0.0',
  description: 'Isolated package validation host', homepage: 'https://zennotes.org',
  dependencies: Object.fromEntries([
    ...runtime.map((name) => [name, installedVersion(name)]),
    ...[candidate, ...candidate.dependencies].map((entry) => [entry.name, `file:${entry.archive}`])
  ]),
  devDependencies: Object.fromEntries(development.map((name) => [name,
    name === 'vite' && process.env.ZEN_CORE_VITE_VERSION ? process.env.ZEN_CORE_VITE_VERSION : installedVersion(name)
  ]))
}, null, 2) + '\n')
runNpm(['install', '--install-strategy=nested', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'inherit' })
const require = createRequire(join(consumer, 'package.json'))
const core = createRequire(join(consumer, 'node_modules/@zennotes/app-core/dist/main.js'))
const installed = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8')).packages
for (const name of runtime) {
  assert.equal(core.resolve(name), require.resolve(name), `app-core has a second ${name} instance`)
}
// Drawing libraries own independent Zustand stores. Parser node properties,
// editor extensions, and React hooks must share runtime identity across packages.
for (const name of runtime.filter(name => name !== 'zustand')) {
  const copies = Object.keys(installed).filter(path => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
  assert.equal(copies.length, 1, `Installed multiple ${name} copies: ${copies.join(', ')}`)
  for (const [path, entry] of Object.entries(installed)) {
    if (!path || !(name in { ...entry.dependencies, ...entry.peerDependencies })) continue
    const fromDependency = createRequire(join(consumer, path, 'package.json'))
    assert.equal(fromDependency.resolve(name), require.resolve(name), `${path} has a second ${name} instance`)
  }
}
for (const privatePath of ['store', 'dist/store.js', 'src/store.ts', 'lib/cm-format']) {
  assert.throws(() => require.resolve(`@zennotes/app-core/${privatePath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
await mkdir(join(consumer, 'src/bridge'), { recursive: true })
// Exercise the current host adapter, with only public package imports. No source
// aliases or links back to the workspace are available to this build.
const bridge = (await readFile(join(root, 'apps/web/src/bridge/http-bridge.ts'), 'utf8'))
  .replaceAll("from '@shared/", "from '@zennotes/shared-domain/")
  .replace('supportsHarper: true', "supportsHarper: import.meta.env.VITE_ZEN_CORE_HARPER !== '0'")
await writeFile(join(consumer, 'src/bridge/http-bridge.ts'), bridge)
await cp(join(root, 'apps/web/src/env.d.ts'), join(consumer, 'src/env.d.ts'))
await writeFile(join(consumer, 'src/editor-types.ts'), `
import { runEditorCommand, hasEditorSelection, type EditorCommand, type EditorInsertionTarget, type EditorViewport } from '@zennotes/app-core/editor'
import { getShellSnapshot, type ShellSnapshot } from '@zennotes/app-core/shell'
import { getBrowseSnapshot } from '@zennotes/app-core/browse'
import { requestNoteBatch, requestEmptyTrash, type NoteBatchResult, requestMoveNote, requestRenameNote, requestArchiveNote, requestTrashNote, restoreNote, requestDeleteNotePermanently, type NoteActionHost, type NoteActionResult } from '@zennotes/app-core/notes'
import { getTasksSnapshot, moveTaskToColumn, getTodayTasks } from '@zennotes/app-core/tasks'
import { getWorkspaceSnapshot, flushWorkspace } from '@zennotes/app-core/workspace'
import { getSettingsSnapshot, setEditorFontSize } from '@zennotes/app-core/settings'
import { getHostInfo } from '@zennotes/app-core/host'
import { getAppCommands, runAppCommand } from '@zennotes/app-core/commands'
import { prompt, confirm } from '@zennotes/app-core/dialogs'
const noteHost: NoteActionHost = { isCurrent: () => true }
const moveResult: Promise<NoteActionResult> = requestMoveNote(noteHost, 'inbox/Note.md')
const renameResult: Promise<NoteActionResult> = requestRenameNote(noteHost, 'inbox/Note.md')
const archiveResult: Promise<NoteActionResult> = requestArchiveNote(noteHost, 'inbox/Note.md')
const trashResult: Promise<NoteActionResult> = requestTrashNote(noteHost, 'inbox/Note.md')
const restoreResult: Promise<NoteActionResult> = restoreNote(noteHost, 'trash/Note.md')
const deleteResult: Promise<NoteActionResult> = requestDeleteNotePermanently(noteHost, 'trash/Note.md')
const batch: Promise<NoteBatchResult> = requestNoteBatch(noteHost, ['inbox/Note.md'], 'trash')
const empty: Promise<NoteActionResult> = requestEmptyTrash(noteHost)
const taskGroup = getTasksSnapshot().groupBy
const workspace = getWorkspaceSnapshot()
const settings = getSettingsSnapshot()
const hostInfo = getHostInfo()
const descriptions = getAppCommands()
// @ts-expect-error Task snapshots cannot mutate store state.
getTasksSnapshot().tasks.push({})
// @ts-expect-error Workspace snapshots contain no operations.
workspace.setState({})
const command: EditorCommand = 'toggle-bold'
const handled: boolean = runEditorCommand(command)
const selected: boolean = hasEditorSelection()
// @ts-expect-error Only named semantic commands cross the public boundary.
runEditorCommand('dispatch')
// @ts-expect-error Hosts cannot inject arbitrary editor commands.
runEditorCommand(() => true)
// @ts-expect-error Hosts must capture a real target rather than manufacture one.
const forged: EditorInsertionTarget = {}
// @ts-expect-error The public target must not expose a CodeMirror view.
type PrivateView = EditorInsertionTarget['view']
// @ts-expect-error Host geometry never exposes an editor DOM node.
type PrivateElement = EditorViewport['editor']['dom']
function checkBounds(viewport: EditorViewport) {
  // @ts-expect-error Measured geometry is an immutable snapshot.
  viewport.editor.bottom = 100
}
const snapshot: ShellSnapshot = getShellSnapshot()
// @ts-expect-error Hosts cannot mutate the published note index.
snapshot.notes.push({})
// @ts-expect-error Metadata is immutable, including each note.
snapshot.notes[0].title = 'Changed'
// @ts-expect-error Body contents are not part of the shell boundary.
type PrivateBody = ShellSnapshot['notes'][number]['body']
// @ts-expect-error Store operations do not leak through the snapshot.
snapshot.setState({})
const browse = getBrowseSnapshot()
// @ts-expect-error Folder rows are immutable copies.
browse.folders[0].directory = 'Changed'
// @ts-expect-error Enabled date settings are read-only.
browse.dateDirectories.daily = 'Changed'
// @ts-expect-error The full settings object remains private.
browse.vaultSettings
`)
await writeFile(join(consumer, 'src/main.tsx'), `
import { installBridge } from './bridge/http-bridge'
installBridge()
// Match native preference/bootstrap ordering before evaluating app-core.
const { renderZenNotesApp } = await import('@zennotes/app-core/main')
const navigation = await import('@zennotes/app-core/navigation')
navigation.installHomeGuard()
const editor = await import('@zennotes/app-core/editor')
const shell = await import('@zennotes/app-core/shell')
const browse = await import('@zennotes/app-core/browse')
const notes = await import('@zennotes/app-core/notes')
if (new URLSearchParams(location.search).has('host')) {
  const toolbar = document.createElement('div')
  toolbar.id = 'host-keyboard-toolbar'
  toolbar.textContent = 'Host keyboard toolbar'
  toolbar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:80px;background:#524333;color:white;z-index:10000;pointer-events:none'
  document.body.append(toolbar)
  const overlap = (bounds: {top:number;bottom:number;left:number;right:number}, overlay: HTMLElement | null) => {
    if (!overlay) return 0
    const bar = overlay.getBoundingClientRect()
    if (bar.top >= bounds.bottom || bar.bottom <= bounds.top || bar.left >= bounds.right || bar.right <= bounds.left) return 0
    return Math.ceil(Math.min(bounds.bottom - bounds.top, bounds.bottom - bar.top + 8))
  }
  const registration = editor.installEditorHost({
    nativeTyping: true,
    measureBottomInsets: viewport => ({
      layout: overlap(viewport.editor, document.getElementById('host-selection-toolbar')),
      scroll: overlap(viewport.scroll, document.getElementById('host-keyboard-toolbar'))
    })
  })
  const focus = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('cm-content')) return
    Object.assign(window, { firstEditorTyping: ['autocorrect','autocapitalize','spellcheck','writingsuggestions'].map(name => (event.target as HTMLElement).getAttribute(name)) })
    document.removeEventListener('focus', focus, true)
  }
  document.addEventListener('focus', focus, true)
  Object.assign(window, { packageHost: registration })
}
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'
const root = document.getElementById('root')!
renderZenNotesApp(root)
// A host-rendered observer exercises the React hook from outside the package.
const { createRoot } = await import('react-dom/client')
const { useState } = await import('react')
function Browse() {
  const [directory, setDirectory] = useState('')
  const lifecycle = shell.useShellSnapshot()
  const snapshot = browse.useBrowseSnapshot()
  const rows = browse.getBrowseDirectory(snapshot, directory)
  // This isolated fixture has one fixed vault; native hosts capture their actual vault token.
  const host = { isCurrent: () => true }
  const run = async (action: () => Promise<string>) => {
    Object.assign(window, { lastBrowseAction: null })
    const result = await action()
    Object.assign(window, { lastBrowseAction: result })
  }
  return <section aria-label="Host Browse" style={{position:'fixed',right:16,top:140,width:250,padding:16,display:'grid',gap:8,background:'#303030',color:'#eee',border:'1px solid #777'}}>
    <strong data-browse-directory>{directory || 'All notes'}</strong>
    <button data-browse-parent onClick={() => setDirectory(directory.slice(0, Math.max(0, directory.lastIndexOf('/'))))}>Parent folder</button>
    <button data-batch-trash onClick={() => void run(async () => (await notes.requestNoteBatch(host, lifecycle.notes.filter(note => note.path.startsWith('inbox/Batch boundary/')).map(note => note.path), 'trash')).status)}>Trash batch</button>
    <button data-empty-trash onClick={() => void run(() => notes.requestEmptyTrash(host))}>Empty trash</button>
    <button data-browse-create onClick={() => void run(() => browse.requestCreateBrowseFolder(host, directory))}>New folder</button>
    <button data-browse-create-database onClick={() => void run(() => browse.createBrowseDatabase(host, directory))}>New database</button>
    {rows.folders.map(row => <div key={row.directory}>
      <button data-browse-folder={row.directory} onClick={() => setDirectory(row.directory)}>{row.title}</button>
      <button data-browse-rename={row.directory} onClick={() => void run(() => browse.requestRenameBrowseFolder(host, row.directory))}>Rename</button>
      <button data-browse-delete={row.directory} onClick={() => void run(() => browse.requestDeleteBrowseDirectory(host, row.directory))}>Delete</button>
    </div>)}
    {rows.databases.map(row => <div key={row.path}><button data-browse-database={row.directory} onClick={() => void navigation.openNote(row.path)}>{row.title}</button>
      <button data-browse-rename-database={row.directory} onClick={() => void run(() => browse.requestRenameBrowseDatabase(host, row.directory))}>Rename</button>
      <button data-browse-delete={row.directory} onClick={() => void run(() => browse.requestDeleteBrowseDirectory(host, row.directory))}>Delete</button>
    </div>)}
    {rows.notes.map(row => <div key={row.path}>
      <button data-browse-note={row.path} onClick={() => void navigation.openNote(row.path)}>{row.title}</button>
      <button data-note-rename={row.path} onClick={() => void run(() => notes.requestRenameNote(host,row.path))}>Rename</button>
      <button data-note-move={row.path} onClick={() => void run(() => notes.requestMoveNote(host,row.path))}>Move</button>
      <button data-note-archive={row.path} onClick={() => void run(() => notes.requestArchiveNote(host,row.path))}>Archive</button>
      <button data-note-trash={row.path} onClick={() => void run(() => notes.requestTrashNote(host,row.path))}>Trash</button>
    </div>)}
    {lifecycle.notes.filter(note => note.folder === 'archive' || note.folder === 'trash').map(note => <div key={note.path}>
      <span>{note.title}</span>
      <button data-note-restore={note.path} onClick={() => void run(() => notes.restoreNote(host,note.path))}>Restore</button>
      {note.folder === 'trash' && <button data-note-delete={note.path} onClick={() => void run(() => notes.requestDeleteNotePermanently(host,note.path))}>Delete permanently</button>}
    </div>)}
  </section>
}
function Selection() {
  const path = navigation.useSelectedNotePath()
  const snapshot = shell.useShellSnapshot()
  return <>
    <output data-consumer-selection>{path ?? 'Home'}</output>
    <output data-consumer-title>{snapshot.selectedNote?.title ?? 'No note'}</output>
    {new URLSearchParams(location.search).has('browse') && <Browse />}
    {new URLSearchParams(location.search).has('shell') && <div aria-label="Host note navigation">
      {(['previous', 'next'] as const).map(direction => <button key={direction} data-consumer-adjacent={direction} onClick={() => {
        const current = shell.getShellSnapshot()
        const target = current.selectedPath && shell.getAdjacentNotePath(current, current.selectedPath, direction)
        if (target) void navigation.openNote(target)
      }}>{direction}</button>)}
    </div>}
    {new URLSearchParams(location.search).has('commands') && <div aria-label="Host commands">
      {(['toggle-bold', 'undo', 'redo', 'open-search', 'set-task-list'] as const).map(command =>
        <button key={command} data-consumer-command={command} onClick={() => {
          const handled = editor.runEditorCommand(command)
          Object.assign(window, { lastHostCommand: { command, handled } })
        }}>{command}</button>
      )}
    </div>}
  </>
}
createRoot(document.getElementById('selection')!).render(<Selection />)
Object.assign(window, { packageNavigation: navigation, packageEditor: editor, packageShell: shell, packageBrowse: browse })
`)
await writeFile(join(consumer, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>ZenNotes package consumer</title></head><body><div id="root"></div><div id="selection" style="position:fixed;bottom:0;right:0;z-index:9999"></div><script type="module" src="/src/main.tsx"></script></body></html>')
await writeFile(join(consumer, 'vite.config.ts'), `
import { defineConfig } from 'vite'
import { zenNotesAssets } from '@zennotes/app-core/vite'
export default defineConfig({
  base: './',
  plugins: zenNotesAssets({ harper: process.env.ZEN_CORE_HARPER !== '0' }),
  build: { target: 'es2022', manifest: true, outDir: process.env.ZEN_CORE_OUT_DIR || 'dist' },
  preview: { host: '127.0.0.1', proxy: {
    '/api': { target: process.env.ZEN_CORE_SERVER, ws: true },
    '/assets-data': { target: process.env.ZEN_CORE_SERVER }
  } }
})
`)
await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx',
    strict: true, noEmit: true, resolveJsonModule: true, esModuleInterop: true,
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['vite/client', 'node']
  }, include: ['src', 'vite.config.ts']
}, null, 2))
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], { cwd: consumer, stdio: 'inherit' })
execFileSync(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], { cwd: consumer, stdio: 'inherit' })
const output = await filesIn(join(consumer, 'dist'))
assert.ok(output.some((file) => /harper.*\.wasm$/.test(file)), 'Harper WASM is missing')
assert.ok(output.some((file) => /typst.*\.wasm$/.test(file)), 'Typst WASM is missing')
assert.ok(output.some((file) => /excalidraw-assets\/fonts\/.+\.woff2$/.test(file)), 'Drawing fonts are missing')
assert.ok(output.some((file) => /KaTeX.+\.woff2$/.test(file)), 'Math fonts are missing')
execFileSync(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], {
  cwd: consumer, stdio: 'inherit',
  env: { ...process.env, ZEN_CORE_HARPER: '0', VITE_ZEN_CORE_HARPER: '0', ZEN_CORE_OUT_DIR: 'dist-native-spelling' }
})
assert.ok(!(await filesIn(join(consumer, 'dist-native-spelling'))).some((file) => /harper.*\.wasm$/.test(file)), 'Native-spelling build included Harper WASM')
const result = { consumer, candidate, passed: ['candidate checksums', 'nested install', 'singleton peers', 'private exports rejected', 'public typecheck', 'production build', 'font and WASM assets', 'native-spelling build omits Harper'] }
await writeFile(join(consumer, 'result.json'), JSON.stringify(result, null, 2) + '\n')
await writeFile(join(root, 'dist/shared-packages/app-core-consumer.json'), JSON.stringify(result, null, 2) + '\n')
console.log(`PASS: ${result.passed.join(', ')}\nEvidence: ${join(consumer, 'result.json')}`)
