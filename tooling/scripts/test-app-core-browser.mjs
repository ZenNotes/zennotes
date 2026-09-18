import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveServerBinary } from './server-binary.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = resolve(process.argv[2] || join(root, 'dist/shared-packages/app-core-consumer.json'))
const evidence = JSON.parse(await readFile(manifest, 'utf8'))
const consumer = evidence.consumer
const run = await mkdtemp(join(consumer, 'browser-'))
console.log(`Browser evidence: ${run}`)
const vault = join(run, 'vault')
await mkdir(vault, { recursive: true })
const require = createRequire(join(consumer, 'package.json'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await sleep(100)
  }
  throw new Error(`${label}: ${last?.message || 'timed out'}`)
}
// Public navigation drops calls made while the workspace is still restoring,
// so every scripted navigation after a page load waits for the shell's
// readiness signal, exactly as a host would.
const workspaceReady = () => until(() => client.evaluate('window.packageShell?.getShellSnapshot().workspaceRestored === true'), 'workspace restored')
async function port() {
  return new Promise((done, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const number = server.address().port
      server.close(() => done(number))
    })
  })
}
class CDP {
  nextId = 0
  pending = new Map()
  listeners = new Map()
  constructor(socket) {
    this.socket = socket
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.done(message.result)
      } else if (typeof message.method === 'string' && this.listeners.has(message.method)) {
        this.listeners.get(message.method)(message.params)
      }
    })
  }
  on(method, callback) { this.listeners.set(method, callback) }
  send(method, params = {}) {
    return new Promise((done, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { done, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const value = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text)
    return value.result?.value
  }
  close() { this.socket.close() }
}
const apiPort = await port(), uiPort = await port(), debugPort = await port()
// The server is the pinned ZenNotes/znserver release (or an explicit binary or checkout).
const binary = await resolveServerBinary()
const children = []
const logs = {}
function launch(name, command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  logs[name] = ''
  child.stdout.on('data', (chunk) => { logs[name] += chunk })
  child.stderr.on('data', (chunk) => { logs[name] += chunk })
  children.push(child)
  return child
}
let client
const errors = [], requests = [], failed = [], networkErrors = []
const requestUrls = new Map()
const pendingAbsenceProbes = new Set()
const absenceProbes = new Map()
const token = 'isolated-package-test-only-token'
try {
  launch('server', binary, [], { cwd: run, env: { ...process.env,
    ZENNOTES_BIND: `127.0.0.1:${apiPort}`, ZENNOTES_DEFAULT_VAULT_PATH: vault,
    ZENNOTES_CONFIG_PATH: join(run, 'server.json'), ZENNOTES_BROWSE_ROOTS: vault,
    ZENNOTES_AUTH_TOKEN: token, ZENNOTES_BASE_PATH: ''
  } })
  const api = `http://127.0.0.1:${apiPort}`
  await until(async () => (await fetch(`${api}/api/healthz`, { signal: AbortSignal.timeout(1000) })).ok, 'API startup')
  const path = 'inbox/Package test.md'
  const original = '# Package test\n\nRead and edit this note.\n'
  const lazyPath = 'inbox/Lazy features.md'
  const lazyBody = '# Lazy features\n\n$$ x^2 + y^2 $$\n\n```mermaid\ngraph LR\n  A[Packaged] --> B[Working]\n```\n'
  const commandPath = 'inbox/Commands.md'
  const hostPath = 'inbox/Host hooks.md'
  const hostBody = Array.from({length:160}, (_,index) => `Host scroll line ${index + 1}`).join('\n')
  const orderedPaths = ['inbox/Order/Note 2.md', 'inbox/Order/Note 10.md', 'inbox/Order/Note 20.md']
  await mkdir(join(vault, 'inbox/Order/People.base/pages'), { recursive: true })
  const databasePath = 'inbox/Browse demo/Customers.base/data.csv'
  const schemaPath = 'inbox/Browse demo/Customers.base/schema.json'
  const databaseBytes = 'id,Name\nrow-1,Example customer\n'
  const schemaBytes = JSON.stringify({version:1,idFieldId:'id',fields:[{id:'id',name:'id',type:'text',hidden:true},{id:'name',name:'Name',type:'text'}],views:[{id:'table',name:'Table',type:'table',filters:[],sorts:[],columnOrder:['name']}],activeViewId:'table'})
  await mkdir(join(vault, 'inbox/Browse demo/Customers.base'), { recursive: true })
  await mkdir(join(vault, 'inbox/Browse demo/Empty'), { recursive: true })
  await writeFile(join(vault, databasePath), databaseBytes)
  await writeFile(join(vault, schemaPath), schemaBytes)
  const orderFixtures = [...orderedPaths.map(path => [path, `Original ${path}`]), ['inbox/Order/People.base/pages/Hidden.md', 'Database record']]
  for (const [notePath, body] of [[path, original], [lazyPath, lazyBody], [commandPath, 'Format me'], [hostPath, hostBody], ['inbox/Browse demo/Read me.md', 'Opened through the public Browse model.'], ...orderFixtures]) {
    const response = await fetch(`${api}/api/notes/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ path: notePath, body }) })
    assert.equal(response.status, 200)
  }
  launch('preview', process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'preview', '--port', String(uiPort), '--strictPort'], {
    cwd: consumer, env: { ...process.env, ZEN_CORE_SERVER: api }
  })
  const url = `http://127.0.0.1:${uiPort}`
  await until(async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok, 'built consumer startup')
  const chrome = process.env.ZEN_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
  launch('chrome', chrome, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(run, 'chrome-profile')}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', 'about:blank'])
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json()
    return pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl)
  }, 'Chrome startup')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  client = new CDP(socket)
  await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Network.enable')
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  client.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text))
  client.on('Runtime.consoleAPICalled', event => {
    const message = event.args.map(arg => arg.value ?? arg.description ?? '').join(' ')
    if (event.type === 'error' || /Measure loop restarted|Viewport failed to stabilize/.test(message)) errors.push(message)
  })
  client.on('Log.entryAdded', ({ entry }) => {
    if (entry.level !== 'error') return
    if (entry.source === 'network') networkErrors.push(entry)
    else errors.push(entry.text)
  })
  client.on('Network.requestWillBeSent', ({ requestId, request }) => {
    requestUrls.set(requestId, request.url)
    if (request.method === 'GET' && pendingAbsenceProbes.delete(request.url)) {
      absenceProbes.set(requestId, {url:request.url})
    }
  })
  client.on('Network.responseReceived', ({ requestId, response }) => {
    requests.push(response.url)
    const probe = absenceProbes.get(requestId)
    if (probe) probe.status = response.status
    if (response.status >= 400) failed.push({ requestId, url: response.url, status: response.status })
  })
  client.on('Network.loadingFailed', (event) => {
    // Navigation intentionally cancels in-flight requests from the old document.
    if (!event.canceled) failed.push({ url: requestUrls.get(event.requestId), error: event.errorText })
  })
  await client.send('Log.enable')
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('zen:prefs:v2', JSON.stringify({vimMode:false,livePreview:false,mathRenderer:'typst'}))` })
  await client.send('Page.navigate', { url })
  await until(() => client.evaluate(`!!document.querySelector('input[placeholder="Enter the server auth token"]')`), 'login')
  await client.evaluate(`document.querySelector('input[placeholder="Enter the server auth token"]').focus()`)
  await client.send('Input.insertText', { text: token })
  await client.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In').click()`)
  await until(() => client.evaluate(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Skip setup')?.click(); return !!document.querySelector('[data-sidebar-type="folder"]') })()`), 'workspace')
  await workspaceReady()
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(path)})`)
  // The first note open fetches the editor, store, and Markdown chunks on a
  // cold runner; allow the same window as the lazy renders below.
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Read and edit')`), 'editor', 60000)
  assert.equal(await client.evaluate(`document.querySelector('[data-consumer-selection]').textContent`), path)
  assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('#root > *')).display`), 'flex', 'Compiled Tailwind styles did not load')
  const beforeLazy = requests.filter((url) => /mermaid\.core|typst.*\.wasm|harper.*\.wasm/.test(url))
  assert.deepEqual(beforeLazy, [], 'Heavy features loaded before requested')
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  const modifier = process.platform === 'darwin' ? 4 : 2
  async function shortcut(key, code) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: modifier })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: modifier })
  }
  await shortcut('a', 'KeyA')
  const saved = '# Package test\n\nSaved from the installed editor: café 日本語.  \n\n- [ ] Preserve this task\n'
  await client.send('Input.insertText', { text: saved })
  await until(async () => (await readFile(join(vault, path), 'utf8')) === saved, 'exact UTF-8 save')
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(lazyPath)})`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(lazyPath)}`), 'public hook updates')
  await client.evaluate('window.packageNavigation.goBack()')
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Saved from the installed editor')`), 'public back navigation')
  await client.evaluate('window.packageNavigation.goForward()')
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Lazy features')`), 'public forward navigation')
  // CodeMirror updates its document before React commits the new toolbar's
  // callbacks. Wait for the painted note before interacting with that toolbar.
  await client.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  await until(() => client.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Preview'); if (!button) return false; button.click(); return true })()`), 'Preview control')
  await until(() => client.evaluate(`!!document.querySelector('[aria-label="Note preview"]')`), 'Preview mode')
  await until(() => client.evaluate(`document.querySelector('.prose-zen .mermaid svg') && document.querySelector('.prose-zen .zen-typst-math svg')`), 'lazy Mermaid and Typst render', 60000)
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'lazy-features.png'), Buffer.from(screenshot.data, 'base64'))
  await client.evaluate('window.packageNavigation.goHome()')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === 'Home'`), 'public Home navigation')
  // Native hosts can omit Harper; the default web package must also prove the
  // real worker/binary path works when the preference is enabled.
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('zen:prefs:v2', JSON.stringify({vimMode:false,livePreview:false,harperEnabled:true}))` })
  await client.send('Page.navigate', { url: `${url}/?grammar=1` })
  await until(() => client.evaluate(`location.search === '?grammar=1' && !!window.packageNavigation`), 'reload')
  await workspaceReady()
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(path)})`)
  await until(() => client.evaluate(`!!document.querySelector('.cm-content')`), 'reloaded editor')
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  await shortcut('a', 'KeyA')
  await client.send('Input.insertText', { text: '# Grammar\n\nThis is an mispelled sentense.\n' })
  await until(() => client.evaluate(`!!document.querySelector('.cm-harper-lint')`), 'Harper worker diagnostics', 60000)
  const grammarShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'grammar.png'), Buffer.from(grammarShot.data, 'base64'))

  // Exercise the public attachment surface using the real host upload path.
  // This server owns one immutable test vault, so its importer stays current.
  await client.evaluate(`window.attachmentImporter = {
    isCurrent: () => true,
    importFile: async (notePath, file) => {
      const [asset] = await window.zen.importFilesToNote(notePath, [window.zen.getPathForFile(file)])
      if (!asset) throw new Error('Host did not return an imported file')
      return asset
    },
    importPastedImage: input => window.zen.importPastedImage(input)
  }`)
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  await shortcut('a', 'KeyA')
  const attachmentBody = '# Attachments\n\nKeep this note.\n'
  await client.send('Input.insertText', { text: attachmentBody })
  await until(async () => (await readFile(join(vault, path), 'utf8')) === attachmentBody, 'attachment baseline save')
  const attached = await client.evaluate(`window.packageEditor.attachFiles(
    window.packageEditor.captureEditorInsertion(window.attachmentImporter),
    [new File(['public attachment bytes'], 'public-attachment.txt', {type:'text/plain'})])`)
  assert.equal(attached.status, 'inserted')
  const attachedBody = attachmentBody + attached.assets[0].markdown
  await until(async () => (await readFile(join(vault, path), 'utf8')) === attachedBody, 'exact attachment Markdown saved')
  assert.equal(await readFile(join(vault, attached.assets[0].path), 'utf8'), 'public attachment bytes')
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
  const pasted = await client.evaluate(`window.packageEditor.insertPastedImage(
    window.packageEditor.captureEditorInsertion(window.attachmentImporter),
    {data:Uint8Array.from(atob(${JSON.stringify(pngBase64)}),c=>c.charCodeAt(0)),mimeType:'image/png',suggestedName:'public-paste.png'})`)
  assert.equal(pasted.status, 'inserted')
  const pastedBody = attachedBody + '\n\n' + pasted.assets[0].markdown + '\n'
  await until(async () => (await readFile(join(vault, path), 'utf8')) === pastedBody, 'exact pasted image Markdown saved')
  assert.deepEqual(await readFile(join(vault, pasted.assets[0].path)), Buffer.from(pngBase64, 'base64'))
  const beforeRace = await readFile(join(vault, path), 'utf8')
  const otherBeforeRace = await readFile(join(vault, lazyPath), 'utf8')
  const uploadCount = () => requests.filter(url => url.endsWith('/api/assets/upload')).length
  const beforeUploads = uploadCount()
  await client.evaluate(`(() => {
    window.attachmentSaved = false
    const importer = {...window.attachmentImporter, importFile: async (notePath,file) => {
      const asset = await window.attachmentImporter.importFile(notePath,file)
      window.attachmentSaved = true
      await new Promise(done => {window.finishAttachment = done})
      return asset
    }}
    const target = window.packageEditor.captureEditorInsertion(importer)
    if (!target) throw new Error('No attachment target')
    window.pendingAttachment = window.packageEditor.attachFiles(target,
      [new File(['keep saved asset'],'slow-attachment.txt'),new File(['must not import'],'second-attachment.txt')])
  })()`)
  await until(() => client.evaluate('window.attachmentSaved'), 'slow attachment saved')
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(lazyPath)})`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(lazyPath)}`), 'note switch during upload')
  await client.evaluate('window.finishAttachment()')
  const stale = await client.evaluate('window.pendingAttachment')
  assert.equal(stale.status, 'saved-only')
  assert.equal(stale.assets.length, 1)
  assert.equal(uploadCount() - beforeUploads, 1, 'Import continued after the note changed')
  assert.equal(await readFile(join(vault, stale.assets[0].path), 'utf8'), 'keep saved asset')
  assert.equal(await readFile(join(vault, path), 'utf8'), beforeRace)
  assert.equal(await readFile(join(vault, lazyPath), 'utf8'), otherBeforeRace)
  const attachmentShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'attachment-race.png'), Buffer.from(attachmentShot.data, 'base64'))

  // Host buttons use only named public commands. Real mouse events move focus
  // onto each button before its handler runs, as an external toolbar can do.
  await client.send('Page.navigate', { url: `${url}/?commands=1` })
  await until(() => client.evaluate(`!!document.querySelector('[data-consumer-command]') && window.packageShell?.getShellSnapshot().workspaceRestored`), 'host command toolbar and restored workspace')
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(commandPath)})`)
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent === 'Format me'`), 'command note')
  async function clickHostCommand(command) {
    const point = await client.evaluate(`(() => {
      const button = document.querySelector('[data-consumer-command="${command}"]')
      const rect = button.getBoundingClientRect()
      return {x:rect.x + rect.width/2, y:rect.y + rect.height/2}
    })()`)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    assert.deepEqual(await client.evaluate('window.lastHostCommand'), { command, handled: true })
  }
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  await shortcut('a', 'KeyA')
  assert.equal(await client.evaluate('window.packageEditor.hasEditorSelection()'), true)
  await clickHostCommand('toggle-bold')
  await until(async () => (await readFile(join(vault, commandPath), 'utf8')) === '**Format me**', 'public bold save')
  assert.equal(await client.evaluate(`document.activeElement.classList.contains('cm-content')`), true)
  await clickHostCommand('undo')
  await until(async () => (await readFile(join(vault, commandPath), 'utf8')) === 'Format me', 'public undo save')
  await clickHostCommand('redo')
  await until(async () => (await readFile(join(vault, commandPath), 'utf8')) === '**Format me**', 'public redo save')
  await clickHostCommand('open-search')
  assert.deepEqual(await client.evaluate(`(() => {
    const field = document.querySelector('.cm-search [main-field]')
    return {focused:document.activeElement === field, value:field?.value, selection:[field?.selectionStart,field?.selectionEnd]}
  })()`), { focused: true, value: 'Format me', selection: [0, 9] })
  const commandsShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'commands.png'), Buffer.from(commandsShot.data, 'base64'))
  // A native back handler does not take focus before closing the search panel.
  assert.equal(await client.evaluate(`window.packageEditor.runEditorCommand('close-search')`), true)
  assert.equal(await client.evaluate(`document.activeElement.classList.contains('cm-content')`), true)
  assert.equal(await client.evaluate(`window.packageEditor.runEditorCommand('close-search')`), false)
  await shortcut('a', 'KeyA')
  await client.send('Input.insertText', { text: '  ' })
  assert.equal(await client.evaluate('window.packageEditor.hasEditorSelection()'), false)
  await clickHostCommand('set-task-list')
  await until(async () => (await readFile(join(vault, commandPath), 'utf8')) === '  - [ ] ', 'empty-line task marker save')

  await client.send('Page.navigate', { url: `${url}/?host=1` })
  await until(() => client.evaluate('!!window.packageHost'), 'host registration before mount')
  await workspaceReady()
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(hostPath)})`)
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Host scroll line 1')`), 'host note')
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  assert.deepEqual(await client.evaluate('window.firstEditorTyping'), ['on', 'sentences', 'true', 'true'])
  await shortcut(process.platform === 'darwin' ? 'ArrowDown' : 'End', process.platform === 'darwin' ? 'ArrowDown' : 'End')
  await until(() => client.evaluate(`window.getSelection()?.focusNode?.parentElement?.closest('.cm-line')?.textContent === 'Host scroll line 160'`), 'caret at note end')
  const caretIsClear = () => client.evaluate(`(() => {
    const cursor = document.querySelector('.cm-cursor')?.getBoundingClientRect()
    const scroller = document.querySelector('.cm-scroller').getBoundingClientRect()
    const toolbar = document.getElementById('host-selection-toolbar') ?? document.getElementById('host-keyboard-toolbar')
    return !!cursor && cursor.height > 0 && cursor.top >= scroller.top && cursor.bottom <= Math.min(scroller.bottom, toolbar.getBoundingClientRect().top) - 4
  })()`)
  await client.evaluate(`document.querySelector('.cm-scroller').scrollTop = 0; window.packageHost.refresh(); window.packageEditor.revealEditorCaret()`)
  await until(caretIsClear, 'caret above host keyboard toolbar')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false })
  await client.evaluate(`document.getElementById('host-keyboard-toolbar').style.height = '96px'; window.packageHost.refresh(); window.packageEditor.revealEditorCaret()`)
  await until(caretIsClear, 'caret above resized keyboard toolbar')
  await client.evaluate(`(() => {
    const selection = document.createElement('div')
    selection.id = 'host-selection-toolbar'
    selection.textContent = 'Host selection toolbar'
    selection.style.cssText = 'position:fixed;bottom:96px;left:0;right:0;height:140px;background:#40585b;color:white;z-index:10000;pointer-events:none'
    document.body.append(selection)
    window.packageHost.refresh()
    window.packageEditor.revealEditorCaret()
  })()`)
  await until(() => client.evaluate(`document.querySelector('.cm-scroller').getBoundingClientRect().bottom <= document.getElementById('host-selection-toolbar').getBoundingClientRect().top`), 'physical selection clearance')
  await until(caretIsClear, 'caret above selection toolbar')
  const hostShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'host-insets.png'), Buffer.from(hostShot.data, 'base64'))
  await client.evaluate(`window.packageHost.dispose(); document.getElementById('host-selection-toolbar').remove(); document.getElementById('host-keyboard-toolbar').remove()`)
  assert.deepEqual(await client.evaluate(`['autocorrect','autocapitalize','spellcheck','writingsuggestions'].map(name => document.querySelector('.cm-content').getAttribute(name))`), ['off', 'off', 'false', 'false'])
  assert.equal(await client.evaluate(`document.querySelector('.cm-editor').style.getPropertyValue('--zen-editor-host-bottom-inset')`), '')
  assert.equal(await readFile(join(vault, hostPath), 'utf8'), hostBody, 'Host configuration changed note bytes')

  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('zen:prefs:v2', JSON.stringify({vimMode:false,livePreview:false,noteSortOrder:'name-asc'}))` })
  await client.send('Page.navigate', { url: `${url}/?shell=1` })
  await until(() => client.evaluate(`!!document.querySelector('[data-consumer-adjacent]')`), 'host note navigation')
  await workspaceReady()
  await client.evaluate(`window.packageNavigation.openNote(${JSON.stringify(orderedPaths[0])})`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-title]')?.textContent === 'Note 2'`), 'shell React snapshot')
  const shellProof = await client.evaluate(`(() => {
    const api = window.packageShell, snapshot = api.getShellSnapshot()
    let immutable = false
    try { Object.assign(snapshot.notes[0], {title:'Changed'}) } catch { immutable = true }
    window.shellTransitions = []
    window.disposeShell = api.subscribeShell((next, previous) => window.shellTransitions.push([previous.selectedPath, next.selectedPath]))
    return {
      immutable, stable: snapshot === api.getShellSnapshot(),
      selected: snapshot.selectedNote.path,
      bodyExposed: snapshot.notes.some(note => 'body' in note),
      order: api.getBrowseNotes(snapshot, 'Order').map(note => note.path),
      pinned: api.getBrowseNotes(snapshot, 'Order', [${JSON.stringify(orderedPaths[2])}]).map(note => note.path),
      hidden: api.getBrowseNotes(snapshot, 'Order/People.base/pages').length,
      previous: api.getAdjacentNotePath(snapshot, snapshot.selectedPath, 'previous')
    }
  })()`)
  assert.deepEqual(shellProof, { immutable: true, stable: true, selected: orderedPaths[0], bodyExposed: false, order: orderedPaths, pinned: [orderedPaths[2], ...orderedPaths.slice(0,2)], hidden: 0, previous: null })
  async function clickAdjacent(direction) {
    const point = await client.evaluate(`(() => {
      const rect = document.querySelector('[data-consumer-adjacent="${direction}"]').getBoundingClientRect()
      return {x:rect.x + rect.width/2, y:rect.y + rect.height/2}
    })()`)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  await clickAdjacent('next')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-title]').textContent === 'Note 10'`), 'next Browse sibling')
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Original inbox/Order/Note 10.md')`), 'adjacent editor ready')
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  await shortcut('a', 'KeyA')
  await client.send('Input.insertText', { text: 'Edited via public sibling navigation: café.' })
  await clickAdjacent('next')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-title]').textContent === 'Note 20'`), 'second Browse sibling')
  await until(async () => (await readFile(join(vault, orderedPaths[1]), 'utf8')) === 'Edited via public sibling navigation: café.', 'sibling navigation saves edited note')
  await clickAdjacent('next')
  assert.equal(await client.evaluate('window.packageShell.getShellSnapshot().selectedPath'), orderedPaths[2], 'Adjacent navigation wrapped')
  await clickAdjacent('previous')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-title]').textContent === 'Note 10'`), 'previous Browse sibling')
  const shellShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'shell.png'), Buffer.from(shellShot.data, 'base64'))
  assert.ok((await client.evaluate('window.shellTransitions')).some(([previous, next]) => previous === orderedPaths[0] && next === orderedPaths[1]))
  await client.evaluate('window.disposeShell(); window.shellTransitions = []; window.packageNavigation.goHome()')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-title]').textContent === 'No note'`), 'shell hook Home')
  assert.deepEqual(await client.evaluate('window.shellTransitions'), [], 'Disposed shell subscriber still notified')
  for (const [notePath, body] of orderFixtures) {
    if (notePath !== orderedPaths[1]) assert.equal(await readFile(join(vault, notePath), 'utf8'), body, 'Sibling navigation changed another note')
  }

  await client.send('Page.navigate', { url: `${url}/?browse=1` })
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-folder="Browse demo"]')`), 'public Browse root')
  async function clickBrowse(selector) {
    const point = await client.evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return {x:rect.x + rect.width/2, y:rect.y + rect.height/2}
    })()`)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  await clickBrowse('[data-browse-folder="Browse demo"]')
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-database="Browse demo/Customers.base"]')`), 'public Browse database row')
  assert.deepEqual(await client.evaluate(`(() => {
    const snapshot = window.packageBrowse.getBrowseSnapshot()
    const rows = window.packageBrowse.getBrowseDirectory(snapshot, 'Browse demo')
    return {folders:rows.folders.map(row => row.title), databases:rows.databases.map(row => row.title), notes:rows.notes.map(row => row.title), frozen:Object.isFrozen(snapshot.folders) && Object.isFrozen(rows.databases[0])}
  })()`), { folders: ['Empty'], databases: ['Customers'], notes: ['Read me'], frozen: true })
  await clickBrowse('[data-browse-database="Browse demo/Customers.base"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="grid"]') && document.body.innerText.includes('Example customer')`), 'database opens from public Browse')
  assert.equal(await readFile(join(vault, databasePath), 'utf8'), databaseBytes, 'Opening Browse database changed CSV bytes')
  assert.equal(await readFile(join(vault, schemaPath), 'utf8'), schemaBytes, 'Opening Browse database changed schema bytes')
  const browseShot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(run, 'browse.png'), Buffer.from(browseShot.data, 'base64'))
  await clickBrowse('[data-browse-note="inbox/Browse demo/Read me.md"]')
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent === 'Opened through the public Browse model.'`), 'note opens from public Browse')
  await client.evaluate(`window.browseChanges = []; window.disposeBrowse = window.packageBrowse.subscribeBrowse(next => window.browseChanges.push(next.folders.map(row => row.directory)))`)
  await client.evaluate(`window.zen.createFolder('inbox', 'Browse demo/Later')`)
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-folder="Browse demo/Later"]')`), 'Browse hook updates after folder creation')
  assert.ok((await client.evaluate('window.browseChanges')).length > 0, 'Browse subscriber missed folder update')
  await client.evaluate(`window.disposeBrowse(); window.browseChanges = []; window.zen.createFolder('inbox', 'Browse demo/After disposal')`)
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-folder="Browse demo/After disposal"]')`), 'Browse hook stays live after other subscriber disposal')
  assert.deepEqual(await client.evaluate('window.browseChanges'), [], 'Disposed Browse subscriber still notified')
  async function dialogButton(label) {
    const point = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})
      const rect = button.getBoundingClientRect()
      return {x:rect.x + rect.width/2, y:rect.y + rect.height/2}
    })()`)
    await client.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1})
    await client.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1})
  }
  async function answerFolderPrompt(name, label) {
    await until(() => client.evaluate(`!!document.querySelector('[role="dialog"] input')`), 'folder prompt')
    await clickBrowse('[role="dialog"] input')
    await until(() => client.evaluate(`document.activeElement === document.querySelector('[role="dialog"] input')`), 'prompt input focused')
    await client.send('Input.dispatchKeyEvent', {type:'keyDown', key:'a', code:'KeyA', modifiers:modifier, commands:['selectAll']})
    await client.send('Input.dispatchKeyEvent', {type:'keyUp', key:'a', code:'KeyA', modifiers:modifier})
    await client.send('Input.insertText', { text: name })
    assert.equal(await client.evaluate(`document.querySelector('[role="dialog"] input').value`), name, 'Prompt text replacement')
    await dialogButton(label)
    await until(() => client.evaluate(`window.lastBrowseAction === 'completed'`), 'folder action completes')
  }
  await clickBrowse('[data-browse-create]')
  await answerFolderPrompt('Action folder', 'Create')
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-folder="Browse demo/Action folder"]')`), 'created folder appears')
  const actionNote = 'inbox/Browse demo/Action folder/Keep.md'
  const actionBody = 'Folder action bytes: café 日本語.  \n'
  const writtenAction = await fetch(`${api}/api/notes/write`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify({path:actionNote, body:actionBody})})
  assert.equal(writtenAction.status, 200)
  const commentBody = { path: actionNote, comments: [{id:'folder-comment',body:'Keep this thread',createdAt:1,updatedAt:1}] }
  const commentWrite = await fetch(`${api}/api/comments/write`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify(commentBody)})
  assert.equal(commentWrite.status, 200)
  await clickBrowse('[data-browse-database="Browse demo/Customers.base"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="grid"]')`), 'database active before parent rename')
  await clickBrowse('[data-browse-parent]')
  await clickBrowse('[data-browse-rename="Browse demo"]')
  await answerFolderPrompt('Browse renamed', 'Rename')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent.includes('Browse%20renamed')`), 'active database tab follows parent rename')
  assert.equal(await readFile(join(vault, 'inbox/Browse renamed/Customers.base/data.csv'), 'utf8'), databaseBytes)
  assert.equal(await readFile(join(vault, 'inbox/Browse renamed/Customers.base/schema.json'), 'utf8'), schemaBytes)
  const renamedAction = 'inbox/Browse renamed/Action folder/Keep.md'
  assert.equal(await readFile(join(vault, renamedAction), 'utf8'), actionBody)
  const commentsAfterRename = await fetch(`${api}/api/comments/read?path=${encodeURIComponent(renamedAction)}`, {headers:{Authorization:`Bearer ${token}`}}).then(response => response.json())
  assert.ok(JSON.stringify(commentsAfterRename).includes('Keep this thread'), 'Folder rename lost comments')
  await clickBrowse('[data-browse-folder="Browse renamed"]')
  await clickBrowse('[data-browse-delete="Browse renamed/Action folder"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`), 'folder deletion confirmation')
  await dialogButton('Cancel')
  await until(() => client.evaluate(`window.lastBrowseAction === 'cancelled'`), 'cancelled folder deletion')
  assert.equal(await readFile(join(vault, renamedAction), 'utf8'), actionBody)
  await clickBrowse('[data-browse-delete="Browse renamed/Customers.base"]')
  await until(() => client.evaluate(`document.body.innerText.includes('All records will be permanently deleted')`), 'database deletion confirmation')
  await dialogButton('Delete')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !document.querySelector('[data-browse-database="Browse renamed/Customers.base"]')`), 'database deletion')
  assert.equal(await client.evaluate(`window.packageShell.getShellSnapshot().selectedPath?.includes('Customers.base') ?? false`), false, 'Deleted database tab remained active')
  await assert.rejects(readFile(join(vault, 'inbox/Browse renamed/Customers.base/data.csv')), {code:'ENOENT'})
  await clickBrowse('[data-browse-delete="Browse renamed/Action folder"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`), 'confirmed folder deletion')
  await dialogButton('Delete')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !document.querySelector('[data-browse-folder="Browse renamed/Action folder"]')`), 'folder removed')
  await assert.rejects(readFile(join(vault, renamedAction)), {code:'ENOENT'})
  assert.equal(await readFile(join(vault, 'inbox/Browse renamed/Read me.md'), 'utf8'), 'Opened through the public Browse model.')
  const actionShot = await client.send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(run, 'browse-actions.png'), Buffer.from(actionShot.data, 'base64'))


  // Collision checks deliberately read an absent CSV. Admit only the first GET
  // for each exact target, after proving absence on disk; all other failures stay
  // fatal. A folder listing cannot replace this check because it hides .base internals.
  async function expectAbsentCsv(directory) {
    await assert.rejects(readFile(join(vault, directory, 'data.csv')), {code:'ENOENT'})
    pendingAbsenceProbes.add(`${url}/api/notes/read?path=${encodeURIComponent(directory + '/data.csv')}`)
  }
  const createdDir = 'inbox/Browse renamed/Untitled Database.base'
  await expectAbsentCsv(createdDir)
  await clickBrowse('[data-browse-create-database]')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !!document.querySelector('[data-browse-database="Browse renamed/Untitled Database.base"]')`), 'created database in Browse')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent.includes('Untitled%20Database.base') && !!document.querySelector('[role="grid"]')`), 'new database opens')
  const createdCsv = await readFile(join(vault, createdDir, 'data.csv'), 'utf8')
  const createdSchema = await readFile(join(vault, createdDir, 'schema.json'), 'utf8')
  const recordPath = `${createdDir}/Record.md`
  const recordBody = '# Record\n\nPreserve café 日本語.  \n'
  const recordWrite = await fetch(`${api}/api/notes/write`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify({path:recordPath, body:recordBody})})
  assert.equal(recordWrite.status, 200)
  const recordComment = await fetch(`${api}/api/comments/write`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify({path:recordPath, comments:[{id:'record-comment',body:'Record discussion',createdAt:1,updatedAt:1}]})})
  assert.equal(recordComment.status, 200)
  const projectsDir = 'inbox/Browse renamed/Projects.base'
  await expectAbsentCsv(projectsDir)
  await clickBrowse('[data-browse-rename-database="Browse renamed/Untitled Database.base"]')
  await answerFolderPrompt('Projects', 'Rename')
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent.includes('Projects.base') && !!document.querySelector('[data-browse-database="Browse renamed/Projects.base"]')`), 'renamed database remains selected')
  assert.equal(await readFile(join(vault, projectsDir, 'data.csv'), 'utf8'), createdCsv)
  assert.equal(await readFile(join(vault, projectsDir, 'schema.json'), 'utf8'), createdSchema)
  assert.equal(await readFile(join(vault, projectsDir, 'Record.md'), 'utf8'), recordBody)
  const recordComments = await fetch(`${api}/api/comments/read?path=${encodeURIComponent(projectsDir + '/Record.md')}`, {headers:{Authorization:`Bearer ${token}`}}).then(response => response.json())
  assert.ok(JSON.stringify(recordComments).includes('Record discussion'))
  await assert.rejects(readFile(join(vault, createdDir, 'data.csv')), {code:'ENOENT'})
  const databaseShot = await client.send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(run, 'database-actions.png'), Buffer.from(databaseShot.data, 'base64'))

  // Move an actively edited note through the external host's public action.
  const movingNote = 'inbox/Browse renamed/Read me.md'
  await clickBrowse(`[data-browse-note="${movingNote}"]`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(movingNote)} && !!document.querySelector('.cm-content')`), 'note before move')
  await client.evaluate(`document.querySelector('.cm-content').focus()`)
  await shortcut('a','KeyA')
  const movedBody = '# Read me\n\nMove this edited note: café 日本語.  \n'
  await client.send('Input.insertText', {text:movedBody})
  const movingComment = await fetch(`${api}/api/comments/write`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({path:movingNote,comments:[{id:'moving-note-comment',body:'Move my discussion',createdAt:1,updatedAt:1}]})})
  assert.equal(movingComment.status,200)
  await clickBrowse(`[data-note-move="${movingNote}"]`)
  await answerFolderPrompt('inbox/Moved notes','Move')
  const movedNote = 'inbox/Moved notes/Read me.md'
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(movedNote)}`), 'public moved note remains selected')
  assert.equal(await readFile(join(vault,movedNote),'utf8'),movedBody)
  await assert.rejects(readFile(join(vault,movingNote)),{code:'ENOENT'})
  const movedComments = await fetch(`${api}/api/comments/read?path=${encodeURIComponent(movedNote)}`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json())
  assert.ok(JSON.stringify(movedComments).includes('Move my discussion'))
  const moveShot = await client.send('Page.captureScreenshot',{format:'png'})
  await writeFile(join(run,'note-move.png'),Buffer.from(moveShot.data,'base64'))

  // Keep an inbound note active so the rename must update its cached editor,
  // then save another edit to prove it cannot restore the old link target.
  const linkedNote = 'inbox/Moved notes/Links.md'
  const linkedBody = 'See [[Read me#Heading|alias]] and `[[Read me]]`.  \n'
  const linkedWrite = await fetch(`${api}/api/notes/write`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({path:linkedNote,body:linkedBody})})
  assert.equal(linkedWrite.status,200)
  await clickBrowse('[data-browse-parent]')
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-folder="Moved notes"]')`), 'moved folder in Browse')
  await clickBrowse('[data-browse-folder="Moved notes"]')
  await until(() => client.evaluate(`!!document.querySelector('[data-browse-note="${linkedNote}"]')`), 'inbound note in Browse')
  await clickBrowse(`[data-browse-note="${linkedNote}"]`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(linkedNote)} && document.querySelector('.cm-content')?.textContent.includes('Read me')`), 'inbound editor before rename')
  await clickBrowse(`[data-note-rename="${movedNote}"]`)
  await answerFolderPrompt('Renamed guide','Rename')
  const renamedNote = 'inbox/Moved notes/Renamed guide.md'
  const rewrittenBody = linkedBody.replace('[[Read me#', '[[Renamed guide#')
  await until(() => client.evaluate(`document.querySelector('.cm-content')?.textContent.includes('Renamed guide')`), 'cached inbound editor updated')
  assert.equal(await readFile(join(vault,linkedNote),'utf8'),rewrittenBody)
  assert.equal(await readFile(join(vault,renamedNote),'utf8'),movedBody.replace('# Read me','# Renamed guide'))
  await assert.rejects(readFile(join(vault,movedNote)),{code:'ENOENT'})
  const renamedComments = await fetch(`${api}/api/comments/read?path=${encodeURIComponent(renamedNote)}`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json())
  assert.ok(JSON.stringify(renamedComments).includes('Move my discussion'))
  await clickBrowse('.cm-content > .cm-line:last-child')
  await until(() => client.evaluate(`document.activeElement === document.querySelector('.cm-content') && document.querySelector('.cm-content').contains(getSelection()?.anchorNode)`), 'inbound editor caret after rename')
  await shortcut('End','End')
  await client.send('Input.insertText',{text:'After rename: café 日本語.'})
  assert.ok(await client.evaluate(`document.querySelector('.cm-content').textContent.includes('After rename: café 日本語.')`), 'Follow-up keystrokes did not reach the inbound editor')
  await until(async () => (await readFile(join(vault, linkedNote),'utf8')).includes('After rename: café 日本語.'), 'follow-up edit saved')
  await clickBrowse(`[data-browse-note="${renamedNote}"]`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(renamedNote)} && document.querySelector('.cm-content')?.textContent.includes('Renamed guide')`), 'renamed note opens')
  const linkedAfterEdit = await readFile(join(vault,linkedNote),'utf8')
  assert.ok(linkedAfterEdit.includes('[[Renamed guide#Heading|alias]]'), 'Saving the cached editor restored the old target')
  assert.ok(linkedAfterEdit.includes('`[[Read me]]`'), 'Rename changed an inline-code link')
  assert.ok(linkedAfterEdit.includes('After rename: café 日本語.'), 'Edit after rename was lost')
  const renameShot = await client.send('Page.captureScreenshot',{format:'png'})
  await writeFile(join(run,'note-rename.png'),Buffer.from(renameShot.data,'base64'))

  // Exercise lifecycle through host-owned controls and real Go storage.
  const lifecycleBody = movedBody.replace('# Read me','# Renamed guide')
  await clickBrowse(`[data-note-archive="${renamedNote}"]`)
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !!document.querySelector('[data-note-restore="archive/Moved notes/Renamed guide.md"]')`), 'archived note in public shell')
  assert.equal(await readFile(join(vault,'archive/Moved notes/Renamed guide.md'),'utf8'),lifecycleBody)
  assert.notEqual(await client.evaluate(`document.querySelector('[data-consumer-selection]').textContent`),'archive/Moved notes/Renamed guide.md','Archive closes the clean editor')
  await assert.rejects(readFile(join(vault,renamedNote)),{code:'ENOENT'})
  await clickBrowse('[data-note-restore="archive/Moved notes/Renamed guide.md"]')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !document.querySelector('[data-note-restore="archive/Moved notes/Renamed guide.md"]')`),'restore archive')
  const restoredNote='inbox/Moved notes/Renamed guide.md'
  assert.equal(await readFile(join(vault,restoredNote),'utf8'),lifecycleBody)
  await until(() => client.evaluate(`!!document.querySelector('[data-note-trash="${restoredNote}"]')`),'restored note in Browse')
  await clickBrowse(`[data-browse-note="${restoredNote}"]`)
  await until(() => client.evaluate(`document.querySelector('[data-consumer-selection]').textContent === ${JSON.stringify(restoredNote)}`),'restored note opens')
  await clickBrowse(`[data-note-trash="${restoredNote}"]`)
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'trash confirmation')
  await dialogButton('Cancel')
  await until(() => client.evaluate(`window.lastBrowseAction === 'cancelled'`),'cancel trash')
  assert.equal(await readFile(join(vault,restoredNote),'utf8'),lifecycleBody)
  await clickBrowse(`[data-note-trash="${restoredNote}"]`)
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'confirmed trash')
  await dialogButton('Move to Trash')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !!document.querySelector('[data-note-restore="trash/Moved notes/Renamed guide.md"]')`),'trashed note in public shell')
  assert.equal(await readFile(join(vault,'trash/Moved notes/Renamed guide.md'),'utf8'),lifecycleBody)
  const trashedComments=await fetch(`${api}/api/comments/read?path=${encodeURIComponent('trash/Moved notes/Renamed guide.md')}`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json())
  assert.ok(JSON.stringify(trashedComments).includes('Move my discussion'),'Trash retained comments')
  await clickBrowse('[data-note-restore="trash/Moved notes/Renamed guide.md"]')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !!document.querySelector('[data-note-trash="${restoredNote}"]')`),'restore trash')
  assert.equal(await readFile(join(vault,restoredNote),'utf8'),lifecycleBody)
  await clickBrowse(`[data-note-trash="${restoredNote}"]`)
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'trash before permanent deletion')
  await dialogButton('Move to Trash')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !!document.querySelector('[data-note-delete="trash/Moved notes/Renamed guide.md"]')`),'note ready for permanent deletion')
  await clickBrowse('[data-note-delete="trash/Moved notes/Renamed guide.md"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'permanent deletion confirmation')
  await dialogButton('Cancel')
  await until(() => client.evaluate(`window.lastBrowseAction === 'cancelled'`),'cancel permanent deletion')
  assert.equal(await readFile(join(vault,'trash/Moved notes/Renamed guide.md'),'utf8'),lifecycleBody)
  await clickBrowse('[data-note-delete="trash/Moved notes/Renamed guide.md"]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'confirm permanent deletion')
  await dialogButton('Delete permanently')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed' && !document.querySelector('[data-note-delete="trash/Moved notes/Renamed guide.md"]')`),'permanently deleted note leaves public shell')
  await assert.rejects(readFile(join(vault,'trash/Moved notes/Renamed guide.md')),{code:'ENOENT'})
  const deletedComments=await fetch(`${api}/api/comments/read?path=${encodeURIComponent('trash/Moved notes/Renamed guide.md')}`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json())
  assert.deepEqual(deletedComments,[])
  const lifecycleShot=await client.send('Page.captureScreenshot',{format:'png'})
  await writeFile(join(run,'note-lifecycle.png'),Buffer.from(lifecycleShot.data,'base64'))

  // The same public batch API backs mobile and Sidebar selections.
  const batchPaths = ['inbox/Batch boundary/One.md', 'inbox/Batch boundary/Two.md']
  for (const [index, path] of batchPaths.entries()) {
    const response = await fetch(`${api}/api/notes/write`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({path,body:`# Batch ${index}\n\nExact café 日本語.  \n`}) })
    assert.equal(response.status,200)
  }
  await until(() => client.evaluate(`window.packageShell.getShellSnapshot().notes.filter(note => note.path.startsWith('inbox/Batch boundary/')).length === 2`), 'batch notes indexed')
  await clickBrowse('[data-batch-trash]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'batch confirmation')
  await dialogButton('Cancel')
  await until(() => client.evaluate(`window.lastBrowseAction === 'cancelled'`),'batch cancelled')
  for (const path of batchPaths) assert.ok(await readFile(join(vault,path),'utf8'))
  await clickBrowse('[data-batch-trash]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'batch confirmation again')
  await dialogButton('Move to Trash')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed'`),'batch completed')
  for (const [index,path] of batchPaths.entries()) {
    await assert.rejects(readFile(join(vault,path)),{code:'ENOENT'})
    assert.equal(await readFile(join(vault,path.replace('inbox/','trash/')),'utf8'),`# Batch ${index}\n\nExact café 日本語.  \n`)
  }
  await clickBrowse('[data-empty-trash]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'empty Trash confirmation')
  await dialogButton('Cancel')
  await until(() => client.evaluate(`window.lastBrowseAction === 'cancelled'`),'empty Trash cancelled')
  for (const path of batchPaths) assert.ok(await readFile(join(vault,path.replace('inbox/','trash/')),'utf8'))
  await clickBrowse('[data-empty-trash]')
  await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'empty Trash confirmation again')
  await dialogButton('Empty trash')
  await until(() => client.evaluate(`window.lastBrowseAction === 'completed'`),'empty Trash completed')
  for (const path of batchPaths) await assert.rejects(readFile(join(vault,path.replace('inbox/','trash/'))),{code:'ENOENT'})

  // Delete linked records through the actual grid context menu.
  const rowsSchema = {
    version: 1, idFieldId:'f_id', activeViewId:'table',
    fields:[{id:'f_id',name:'ID',type:'text',hidden:true},{id:'f_name',name:'Name',type:'text'},{id:'f_status',name:'Status',type:'text'}],
    views:[{id:'table',name:'Table',type:'table',filters:[],sorts:[],columnOrder:['f_name','f_status'],hiddenFieldIds:['f_id']}],
    pages:{record1:`${projectsDir}/Record.md`,record2:`${projectsDir}/Two.md`}
  }
  const rowData = [{id:'record1',cells:{f_id:'record1',f_name:'Record',f_status:'Ready'}},{id:'record2',cells:{f_id:'record2',f_name:'Two',f_status:'Open'}}]
  const secondPage = '# Two\n\nSecond exact page.  \n'
  await client.evaluate(`window.zen.writeNote(${JSON.stringify(projectsDir + '/Two.md')}, ${JSON.stringify(secondPage)})`)
  await client.evaluate(`window.zen.writeDatabaseSchema(${JSON.stringify(projectsDir + '/data.csv')}, ${JSON.stringify(rowsSchema)}, ${JSON.stringify(rowData)})`)
  await client.send('Page.navigate', { url: `${url}/?browse=1&rows=1` })
  await until(() => client.evaluate(`location.search.includes('rows=1') && window.packageBrowse?.getBrowseSnapshot().databases.some(row => row.title === 'Projects')`), 'seeded database indexed after reload')
  await workspaceReady()
  await client.evaluate(`window.packageNavigation.openNote(window.packageBrowse.getBrowseSnapshot().databases.find(row => row.title === 'Projects').path)`)
  await until(() => client.evaluate(`document.querySelector('[role="grid"]')?.textContent.includes('Ready')`),'linked rows loaded')
  async function deleteFirstRecord(choice) {
    const point = await client.evaluate(`(() => { const rect=document.querySelector('[role="grid"] tbody tr td:nth-child(2)').getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2} })()`)
    await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'right',clickCount:1})
    await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'right',clickCount:1})
    await until(() => client.evaluate(`!![...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent.trim() === 'Delete row')`),'row context menu')
    const menuPoint = await client.evaluate(`(() => { const rect=[...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent.trim() === 'Delete row').getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2} })()`)
    await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...menuPoint,button:'left',clickCount:1})
    await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...menuPoint,button:'left',clickCount:1})
    await until(() => client.evaluate(`!!document.querySelector('[role="dialog"]')`),'linked page confirmation')
    await dialogButton(choice)
  }
  await deleteFirstRecord('Keep note')
  await until(async () => !(await readFile(join(vault,projectsDir,'data.csv'),'utf8')).includes('record1'),'first row detached')
  assert.equal(await readFile(join(vault,projectsDir,'Record.md'),'utf8'),`---\nStatus: Ready\n---\n${recordBody}`)
  assert.equal(JSON.parse(await readFile(join(vault,projectsDir,'schema.json'),'utf8')).pages.record1,undefined)
  await deleteFirstRecord('Delete row + note')
  await until(async () => !(await readFile(join(vault,projectsDir,'data.csv'),'utf8')).includes('record2'),'second row deleted')
  await until(async () => { try { await readFile(join(vault,projectsDir,'Two.md')); return false } catch(error) { return error.code === 'ENOENT' } },'second page trashed')
  assert.equal(await readFile(join(vault,projectsDir.replace('inbox/','trash/'),'Two.md'),'utf8'),`---\nStatus: Open\n---\n${secondPage}`)
  const rowsShot = await client.send('Page.captureScreenshot',{format:'png'})
  await writeFile(join(run,'database-row-lifecycle.png'),Buffer.from(rowsShot.data,'base64'))

  assert.equal(pendingAbsenceProbes.size, 0, 'Expected collision probes were not sent')
  assert.equal(absenceProbes.size, 2, 'Expected exactly two collision probes')
  for (const probe of absenceProbes.values()) assert.equal(probe.status, 404, `Collision probe: ${probe.url}`)
  const expectedAbsence = (requestId) => absenceProbes.get(requestId)?.status === 404
  for (const entry of networkErrors) {
    if (!expectedAbsence(entry.networkRequestId) || entry.text !== 'Failed to load resource: the server responded with a status of 404 (Not Found)') errors.push(entry.text)
  }
  const unexpectedFailures = failed.filter(entry => entry.status !== 404 || !expectedAbsence(entry.requestId))
  assert.deepEqual(errors, [], 'Unexpected browser errors')
  assert.deepEqual(unexpectedFailures, [], 'Unexpected failed application requests')
  const result = { candidate: evidence.candidate, passed: ['installed editor loads', 'compiled styles', 'host React hook', 'exact UTF-8 save', 'public navigation', 'deferred heavy features', 'Mermaid SVG', 'Typst WASM and bundled fonts', 'Harper worker diagnostics', 'reload', 'public file attachment with exact saved bytes', 'public image paste with exact saved bytes', 'note switch stops insertion and remaining uploads', 'saved asset retained after note switch', 'host toolbar formatting with exact saved bytes', 'public undo and redo', 'Find field focus and native-back close', 'public selection query', 'empty-line list creation', 'no browser errors'], attachments: { attached, pasted, stale }, requests, errors, failed }
  result.passed.push('native typing before first focus', 'caret above keyboard after viewport resize', 'physical selection toolbar clearance', 'host disposal restores defaults without note edits')
  result.passed.push('immutable shell metadata and React hook', 'natural and pinned Browse order', 'hidden database records excluded', 'adjacent navigation saves exact bytes and stops at boundaries', 'shell subscription disposal')
  result.passed.push('Browse folder/database React model', 'database and note navigation from public Browse preserves bytes', 'Browse live folder refresh and subscription disposal', 'public folder creation prompt', 'parent folder rename preserves active database and exact bytes', 'folder comments follow rename', 'confirmed database deletion closes its tab', 'folder deletion cancellation and confirmation')
  result.passed.push('public database creation opens the canonical tab', 'public database rename preserves CSV, schema, records, and comments')
  result.passed.push('public note move preserves active editor, exact saved bytes, and comments')
  result.passed.push('public note rename preserves heading, exact bytes, and comments', 'cached inbound editor rewrites links and retains later edits')
  result.passed.push('public archive and restore preserve exact bytes and canonical paths', 'public trash cancellation and confirmation preserve bytes and comments', 'public restore from trash', 'permanent deletion cancellation and confirmation remove content and comments')
  result.passed.push('grid row deletion preserves standalone page properties and body', 'grid row deletion moves linked page after database save')
  result.passed.push('public batch trash cancellation and exact bytes', 'public Empty Trash cancellation and deletion')
  result.passed[result.passed.indexOf('no browser errors')] = 'no unexpected browser errors'
  result.expectedAbsenceProbes = [...absenceProbes.values()]
  result.networkErrors = networkErrors
  result.failed = unexpectedFailures
  await writeFile(join(run, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`PASS: ${result.passed.join(', ')}\nEvidence: ${run}`)
} catch (error) {
  // CI keeps only the console, so say what the page and the helpers saw
  // before the evidence directory is uploaded or lost.
  console.error(`Browser check failed: ${error.message}`)
  console.error(`Page errors: ${JSON.stringify(errors, null, 2)}`)
  console.error(`Failed requests: ${JSON.stringify(failed, null, 2)}`)
  console.error(`Network log errors: ${JSON.stringify(networkErrors.map(entry => entry.text), null, 2)}`)
  for (const [name, log] of Object.entries(logs)) {
    const tail = log.split('\n').slice(-40).join('\n').trim()
    if (tail) console.error(`--- ${name} output (tail) ---\n${tail}`)
  }
  if (client) {
    const pageState = await client.evaluate(`({
      url: location.href, title: document.title,
      editors: document.querySelectorAll('.cm-content').length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.textContent.slice(0, 200)),
      text: document.body.innerText.slice(0, 1500)
    })`).catch((reason) => ({ unavailable: reason.message }))
    console.error(`Page state: ${JSON.stringify(pageState, null, 2)}`)
    await writeFile(join(run, 'failure.txt'), await client.evaluate('document.body.innerText').catch(() => ''))
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (screenshot) await writeFile(join(run, 'failure.png'), Buffer.from(screenshot.data, 'base64'))
    const geometry = await client.evaluate(`({
      url: location.href,
      active: document.activeElement?.outerHTML.slice(0, 800),
      firstEditorTyping: window.firstEditorTyping,
      editors: [...document.querySelectorAll('.cm-content')].map(element => ({attributes:element.outerHTML.slice(0,400), bounds:element.getBoundingClientRect().toJSON()})),
      scrollers: [...document.querySelectorAll('.cm-scroller')].map(element => ({bounds:element.getBoundingClientRect().toJSON(),scrollTop:element.scrollTop}))
    })`).catch(() => null)
    await writeFile(join(run, 'geometry.json'), JSON.stringify(geometry, null, 2))
  }
  await writeFile(join(run, 'errors.json'), JSON.stringify({ errors, requests, failed, networkErrors, absenceProbes:[...absenceProbes.values()] }, null, 2))
  throw error
} finally {
  client?.close()
  for (const child of children.reverse()) child.kill()
  for (const [name, log] of Object.entries(logs)) await writeFile(join(run, `${name}.log`), log)
}
