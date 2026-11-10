// Drives the built desktop app (apps/desktop/out) over CDP through the clip
// links (`zennotes://new`, `zennotes://daily`; docs/web-clipper-link.md), end
// to end: cold start, the running app (second instance), the clipboard hash,
// refusals, a daily note with typing in progress, silent clips, and a vault no
// window shows. Isolated userData, config dir and temp vaults; one instance.
// macOS only (Electron.app path, pbcopy). Build first:
//   npx electron-vite build   (in apps/desktop)
//   node tooling/scripts/clip-links-e2e.mjs
// It puts a test string on the clipboard and restores the previous text.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const SCRATCH = tmpdir()
const ELECTRON = `${WT}/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`
const MAIN = `${WT}/apps/desktop/out/main/index.js`
const PORT = 9341

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const exists = (p) => access(p).then(() => true, () => false)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// Refuse to start beside another dev instance of this build.
try {
  const running = execFileSync('pgrep', ['-f', `${WT}/apps/desktop/node_modules/electron`]).toString().trim()
  if (running) {
    console.error('Another dev instance of this build is running; refusing to start.', running)
    process.exit(2)
  }
} catch {}

const tmp = await mkdtemp(join(SCRATCH, 'clip-e2e-'))
const ud = join(tmp, 'ud')
const vault = join(tmp, 'Clip Test')
await mkdir(join(vault, '.zennotes'), { recursive: true })
await mkdir(join(vault, 'Reading'), { recursive: true })
await writeFile(join(vault, '.zennotes', 'vault.json'), JSON.stringify({ primaryNotesLocation: 'root', dailyNotes: { enabled: true } }))
await writeFile(join(vault, 'Welcome.md'), '# Welcome\n\nHello.\n')
const other = join(tmp, 'Other Vault')
await mkdir(join(other, '.zennotes'), { recursive: true })
await writeFile(join(other, '.zennotes', 'vault.json'), JSON.stringify({ primaryNotesLocation: 'inbox' }))
await writeFile(join(vault, 'Reading', 'Log.md'), '# Log\n\n- one\n')
await mkdir(join(ud, 'config'), { recursive: true })
// A populated config file means "been here before": no onboarding wizard.
await writeFile(join(ud, 'config', 'config.toml'), '[vim]\nenabled = true\n')
await writeFile(
  join(ud, 'zennotes.config.json'),
  JSON.stringify({
    workspaceMode: 'local',
    vaultRoot: vault,
    localVaults: [
      { root: vault, name: 'Clip Test', lastOpenedAt: Date.now() },
      { root: other, name: 'Other Vault', lastOpenedAt: 1 }
    ],
    remoteWorkspace: null,
    remoteWorkspaceProfileId: null,
    remoteWorkspaceProfiles: [],
    windowState: { x: 80, y: 80, width: 1280, height: 820, isMaximized: false },
    zoomFactor: 1,
    quickCaptureHotkey: ''
  })
)
const env = {
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  ZENNOTES_USER_DATA_PATH: ud,
  ZENNOTES_CONFIG_DIR: join(ud, 'config')
}

let savedClipboard = null
try {
  savedClipboard = execFileSync('pbpaste').toString()
} catch {}

const today = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

const coldLink = `zennotes://new?file=${enc('Clippings/Cold Start')}&content=${enc('# Cold Start\n\ncold body\n')}`
const app = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, MAIN, coldLink], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let appLog = ''
app.stdout.on('data', (c) => (appLog += c))
app.stderr.on('data', (c) => (appLog += c))
const appExited = new Promise((r) => app.once('exit', r))
const stop = async () => {
  if (app.exitCode !== null) return
  app.kill('SIGTERM')
  const t = setTimeout(() => app.kill('SIGKILL'), 5000)
  await appExited
  clearTimeout(t)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => void stop().then(() => process.exit(1)))

let ws
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP timeout ${method}`))
      }
    }, 15000)
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(150)
  }
  throw new Error(`timed out: ${label} (${last})`)
}
// The document itself, not the rendered text: live preview hides list markers.
const editorText = () => evaluate(`(() => { const c = document.querySelector('.cm-content'); if (!c) return ''; const view = c.cmView && c.cmView.view; return view ? view.state.doc.toString() : c.innerText })()`)
const toasts = () => evaluate(`[...document.querySelectorAll('[role=status]')].map(e => e.textContent)`)
const readVault = (rel) => readFile(join(vault, rel), 'utf8')
async function fire(link) {
  const child = spawn(ELECTRON, [MAIN, link], { env, stdio: 'ignore' })
  const t = setTimeout(() => child.kill('SIGKILL'), 15000)
  await new Promise((r) => child.once('exit', r))
  clearTimeout(t)
}
async function key(k, code, text) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'Escape' ? 27 : 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'Escape' ? 27 : 0 })
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(tmp, `${name}.png`), Buffer.from(r.data, 'base64'))
}

try {
  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    return res.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).includes('quickCapture'))
  }, 30000, 'page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  // 1. Cold start: the link that launched the app.
  await waitFor(() => exists(join(vault, 'Clippings', 'Cold Start.md')), 30000, 'cold start file')
  const coldBody = await waitFor(async () => ((await readVault('Clippings/Cold Start.md').catch(() => '')) === '# Cold Start\n\ncold body\n' ? 'yes' : ''), 10000, 'cold body').catch(() => '')
  check('cold start: note written', coldBody === 'yes')
  const coldToast = await waitFor(async () => (await toasts()).find((t) => t.includes('Clipped to Clippings/Cold Start')), 10000, 'cold toast').catch(() => null)
  check('cold start: toast names where it went', !!coldToast)
  const cold = await waitFor(async () => ((await editorText()).includes('cold body') ? 'yes' : ''), 15000, 'cold editor').catch(() => '')
  check('cold start: note opened in the editor', cold === 'yes')
  await shot('1-cold-start')

  // 2. Running app, clipboard body with a matching hash.
  const clipText = '---\nsource: "https://example.com/a"\n---\n\n# From Clipboard\n\nPlus+signs & #hash.\n'
  execFileSync('pbcopy', { input: clipText })
  await fire(`zennotes://new?vault=clip%20test&file=${enc('Clippings/From Clipboard')}&clipboard=${sha(clipText)}`)
  const got = await waitFor(async () => ((await readVault('Clippings/From Clipboard.md').catch(() => '')) === clipText ? 'yes' : ''), 15000, 'clipboard file').catch(() => '')
  check('clipboard: file has the exact clipboard text', got === 'yes')

  // 3. Hash mismatch: nothing written, a toast says so.
  await fire(`zennotes://new?file=${enc('Clippings/Mismatch')}&clipboard=${sha('something else')}`)
  const mismatchToast = await waitFor(async () => (await toasts()).find((t) => t.includes('did not arrive')), 10000, 'mismatch toast').catch(() => null)
  check('mismatch: toast shown', !!mismatchToast, mismatchToast ?? '')
  check('mismatch: nothing written', !(await exists(join(vault, 'Clippings', 'Mismatch.md'))))

  // 4. Traversal and unknown vault are refused.
  await fire(`zennotes://new?file=${enc('../escape')}&content=x`)
  await sleep(1500)
  check('traversal: nothing outside the vault', !(await exists(join(tmp, 'escape.md'))))
  check('traversal: toast shown', (await toasts()).some((t) => t.includes('cannot write to')))
  await fire('zennotes://new?vault=Nope&content=x')
  const nope = await waitFor(async () => (await toasts()).find((t) => t.includes('No vault is named')), 10000, 'unknown vault toast').catch(() => null)
  check('unknown vault: toast shown', !!nope)

  // 5. Append to a closed note.
  await fire(`zennotes://new?file=${enc('Reading/Log')}&content=${enc('- two')}&append&silent`)
  await waitFor(async () => (await readVault('Reading/Log.md')).includes('- two'), 10000, 'append').catch(() => false)
  check('append to closed note', (await readVault('Reading/Log.md')) === '# Log\n\n- one\n\n- two\n')

  // 6. Daily note open with typing in progress, then a clip into it.
  await fire('zennotes://daily')
  await waitFor(async () => (await editorText()).includes(today), 15000, 'daily note open')
  await sleep(300)
  check('bare daily: opens without a clip toast', !(await toasts()).some((t) => t.includes('Clipped to Daily')))
  await evaluate(`document.querySelector('.cm-content').focus()`)
  await key('Escape', 'Escape')
  await key('G', 'KeyG', 'G')
  await key('o', 'KeyO', 'o')
  await send('Input.insertText', { text: 'typed while clipping' })
  await fire(`zennotes://daily?content=${enc('- clipped')}&append`)
  const both = await waitFor(async () => {
    const t = await editorText()
    // Live preview draws `- clipped` as a bullet, so match the words.
    return t.includes('typed while clipping') && /(^|\n)(- |• |)clipped/.test(t) ? t : ''
  }, 10000, 'daily buffer').catch(() => '')
  check('daily: buffer keeps typing and gains the clip', !!both)
  await sleep(2500)
  const dailyFile = await readVault(`Daily Notes/${today}.md`).catch(() => '')
  check('daily: saved file has both', dailyFile.includes('typed while clipping') && dailyFile.includes('- clipped'), JSON.stringify(dailyFile))
  await shot('2-daily-typed-and-clipped')
  await key('Escape', 'Escape')
  await key('u', 'KeyU', 'u')
  await sleep(400)
  const afterUndo = await editorText()
  check('daily: u undoes the clip (it went through the editor)', !/(^|\n)(- |• |)clipped/.test(afterUndo) && afterUndo.includes('typed while clipping'), JSON.stringify(afterUndo))
  await sleep(2500)
  const savedAfterUndo = await readVault(`Daily Notes/${today}.md`).catch(() => '')
  check('daily: the undo is saved too', !savedAfterUndo.includes('- clipped') && savedAfterUndo.includes('typed while clipping'))

  // 7. Silent clip: written, editor stays on the daily note, toast offers Open.
  await fire(`zennotes://new?file=${enc('Clippings/Silent')}&content=${enc('quiet')}&silent`)
  await waitFor(() => exists(join(vault, 'Clippings', 'Silent.md')), 10000, 'silent file').catch(() => false)
  await sleep(500)
  check('silent: file written', await exists(join(vault, 'Clippings', 'Silent.md')))
  check('silent: editor did not switch', (await editorText()).includes('typed while clipping'))
  await shot('3-silent')

  // 8. A vault no window shows: main writes it (here in an inbox-mode vault).
  await fire(`zennotes://new?vault=other%20vault&file=${enc('Clippings/Elsewhere')}&content=${enc('far away')}&silent`)
  const far = await waitFor(async () => ((await readFile(join(other, 'inbox', 'Clippings', 'Elsewhere.md'), 'utf8').catch(() => '')) === 'far away' ? 'yes' : ''), 25000, 'other vault').catch(() => '')
  check('closed vault: main wrote it into the Inbox area', far === 'yes')
  check('closed vault: this window stayed on its note', (await editorText()).includes('typed while clipping'))
} catch (err) {
  check('driver', false, String(err))
  console.error(appLog.slice(-3000))
} finally {
  try {
    ws?.close()
  } catch {}
  await stop()
  if (savedClipboard !== null) execFileSync('pbcopy', { input: savedClipboard })
  console.log(`\nartifacts: ${tmp}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
