#!/usr/bin/env node
/**
 * Sidebar windowing + vim-navigation smoke test.
 *
 * The sidebar virtualizes large flat note lists: only the scrolled-into-view
 * window mounts full NoteLeaf rows; the rest render as inert, same-height
 * placeholders that keep the data-* attributes the keyboard-nav / range-select /
 * cursor logic reads from the DOM. This test guards that those interactions keep
 * working — i.e. that windowing never silently breaks vim motions or selection.
 *
 * It seeds a vault past the windowing threshold, launches the real desktop build,
 * and drives it over the Chrome DevTools Protocol:
 *   - windowing is actually active (most rows are placeholders),
 *   - j / k move the cursor one real row at a time,
 *   - G / gg scroll to the ends and the end rows render as full rows,
 *   - every row exposes a selection key (range-select sees the whole list),
 *   - clicking an off-screen placeholder opens its note,
 *   - no console errors fire during any of it.
 *
 * Usage:
 *   npm run test:sidebar-vim
 *   ZEN_SIDEBAR_VIM_NOTES=2000 npm run test:sidebar-vim
 *   ZEN_SIDEBAR_VIM_SKIP_BUILD=1 npm run test:sidebar-vim   # reuse out/main
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const desktopOutMain = resolve(repoRoot, 'apps/desktop/out/main/index.js')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Must exceed SIDEBAR_PROGRESSIVE_RENDER_THRESHOLD (240) so windowing engages.
const NOTE_COUNT = parsePositiveInt(process.env.ZEN_SIDEBAR_VIM_NOTES, 1000)
const skipBuild = process.env.ZEN_SIDEBAR_VIM_SKIP_BUILD === '1'

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pad = (n) => String(n).padStart(5, '0')
const lastNoteFile = `${pad(NOTE_COUNT - 1)} - note.md`

async function fileExists(p) {
  try { await access(p, constants.F_OK); return true } catch { return false }
}

async function prepareBuild() {
  if (skipBuild && (await fileExists(desktopOutMain))) return
  if (!skipBuild || !(await fileExists(desktopOutMain))) {
    console.log('Building @zennotes/desktop (set ZEN_SIDEBAR_VIM_SKIP_BUILD=1 to reuse the current build)…')
    await run(npmCommand, ['run', 'build', '--workspace', '@zennotes/desktop'])
  }
}
function run(command, args) {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${command} ${args.join(' ')} exited ${code}`))))
    child.on('error', rej)
  })
}

async function seedVault(root) {
  const inbox = join(root, 'inbox')
  await mkdir(inbox, { recursive: true })
  await Promise.all(['quick', 'archive', 'trash'].map((d) => mkdir(join(root, d), { recursive: true })))
  const files = []
  for (let i = 0; i < NOTE_COUNT; i++) {
    files.push([join(inbox, `${pad(i)} - note.md`), `# Note ${pad(i)}\n\nBody token note-${i}.\n`])
  }
  for (let i = 0; i < files.length; i += 100) {
    await Promise.all(files.slice(i, i + 100).map(([p, b]) => writeFile(p, b)))
  }
}
async function seedUserData(userDataRoot, vaultRoot) {
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(join(userDataRoot, 'zennotes.config.json'), JSON.stringify({
    workspaceMode: 'local', vaultRoot, remoteWorkspace: null, remoteWorkspaceProfileId: null,
    remoteWorkspaceProfiles: [], windowState: { x: 60, y: 60, width: 1280, height: 860, isMaximized: false },
    zoomFactor: 1, quickCaptureHotkey: ''
  }, null, 2))
}

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => res(a.port)) })
    s.on('error', rej)
  })
}
function httpGetJson(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) })
    req.on('error', rej); req.setTimeout(1000, () => req.destroy(new Error('timeout')))
  })
}
class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.listeners = new Map() }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url)
      this.ws.on('open', res); this.ws.on('error', rej)
      this.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {}) }
        else if (m.method) for (const l of this.listeners.get(m.method) ?? []) l(m.params ?? {})
      })
    })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  on(method, l) { const a = this.listeners.get(method) ?? []; a.push(l); this.listeners.set(method, a) }
  close() { this.ws?.terminate?.(); this.ws?.close() }
}
async function connectPage(port) {
  const deadline = Date.now() + 20000
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (String(t.url).startsWith('file:') || String(t.url).includes('index.html')))
      if (page) { const c = new Cdp(page.webSocketDebuggerUrl); await c.connect(); return c }
    } catch (e) { lastErr = e }
    await sleep(100)
  }
  throw new Error(`no CDP page: ${lastErr?.message ?? 'timeout'}`)
}
async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
/** Poll an evaluated expression until it returns truthy (or time out → null). */
async function until(client, expression, timeoutMs = 4000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evaluate(client, expression)
    if (v) return v
    await sleep(intervalMs)
  }
  return null
}
function pressKey(client, key, shift = false) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  return evaluate(client, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, shiftKey: ${shift}, bubbles: true, cancelable: true })); return true; })()`)
}
/** The data-sidebar-idx of the currently vim-highlighted sidebar row (or null). */
function cursorState(client) {
  return evaluate(client, `(() => {
    const el = [...document.querySelectorAll('[data-sidebar-idx]')].find(e => /(^|\\s)vim-cursor/.test(e.className));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { idx: Number(el.getAttribute('data-sidebar-idx')), tag: el.tagName, type: el.dataset.sidebarType,
      text: (el.textContent || '').trim().length, inView: r.top >= -40 && r.bottom <= window.innerHeight + 40 };
  })()`)
}

async function main() {
  await prepareBuild()
  const tempRoot = await mkdtemp(join(tmpdir(), 'zennotes-sidebar-vim-'))
  const vaultRoot = join(tempRoot, 'vault')
  const userDataRoot = join(tempRoot, 'user-data')
  await seedVault(vaultRoot)
  await seedUserData(userDataRoot, vaultRoot)
  const port = await getFreePort()

  const child = spawn(electronPath, [`--remote-debugging-port=${port}`, desktopOutMain], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ZENNOTES_USER_DATA_PATH: userDataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c)); child.stderr.on('data', (c) => (log += c))

  const errors = []
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) console.log(`  PASS  ${name}`)
    else { failures.push(name); console.error(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
  }

  let client
  try {
    client = await connectPage(port)
    client.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') errors.push(e.args?.map((a) => a.value ?? a.description ?? '').join(' '))
    })
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')])

    console.log(`\nSidebar vim smoke test — ${NOTE_COUNT} notes\n`)

    // Wait for the seeded notes to render; expand inbox if it loads collapsed.
    const ready = await until(client, `(() => {
      const notes = document.querySelectorAll('[data-sidebar-type="note"]').length;
      if (notes === 0) {
        const f = document.querySelector('[data-sidebar-type="folder"][data-sidebar-folder="inbox"][data-sidebar-subpath=""]');
        if (f && f.getAttribute('data-sidebar-collapsed') === 'true') f.click();
      }
      return notes >= ${NOTE_COUNT - 5};
    })()`, 35000, 200)
    check('vault loads and notes render in the sidebar', !!ready,
      ready ? '' : `log tail: ${JSON.stringify(log.slice(-300))}`)
    if (!ready) throw new Error('notes never rendered — aborting')
    await sleep(300)

    // 1. Windowing is active: every row present, but most are cheap placeholders.
    const counts = await evaluate(client, `(() => ({
      all: document.querySelectorAll('[data-sidebar-type="note"]').length,
      full: document.querySelectorAll('button[data-sidebar-type="note"]').length,
      placeholders: document.querySelectorAll('div[data-sidebar-type="note"]').length,
    }))()`)
    check('windowing active — all rows present, most are placeholders',
      counts.all >= NOTE_COUNT - 5 && counts.placeholders > counts.full && counts.full < 200, JSON.stringify(counts))

    // 2. Placeholders occupy real vertical space → list has full scroll height.
    const space = await evaluate(client, `(() => {
      const s = document.querySelector('.overflow-y-auto');
      const last = document.querySelector('[data-sidebar-path$=${JSON.stringify(lastNoteFile)}]');
      return { scrollHeight: s?.scrollHeight ?? 0, lastTop: Math.round(last?.getBoundingClientRect().top ?? -1) };
    })()`)
    check('placeholders occupy real space (full scroll height)',
      space.scrollHeight >= NOTE_COUNT * 36 - 80 && space.lastTop > (NOTE_COUNT - 30) * 36, JSON.stringify(space))

    // 3. Focus the sidebar + place the cursor on the first note (mousedown only — no open).
    await evaluate(client, `(() => { document.querySelector('[data-sidebar-type="note"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`)
    const focused = await until(client, `!!document.querySelector('.glass-sidebar.panel-focused')`, 2000)
    check('sidebar takes focus', !!focused)
    const start = await cursorState(client)
    check('cursor lands on a real (full) note row', !!start && start.tag === 'BUTTON' && start.type === 'note' && start.text > 0, JSON.stringify(start))
    const firstIdx = start?.idx ?? 0

    // 4. j moves down exactly one real, visible row at a time.
    let prev = firstIdx, jOk = true, jDetail = ''
    for (let i = 0; i < 6; i++) {
      await pressKey(client, 'j')
      const landed = await until(client, `(() => { const el = [...document.querySelectorAll('[data-sidebar-idx]')].find(e => /(^|\\s)vim-cursor/.test(e.className)); return el && Number(el.getAttribute('data-sidebar-idx')) === ${prev + 1}; })()`, 1500)
      const c = await cursorState(client)
      if (!landed || !c || c.idx !== prev + 1 || c.tag !== 'BUTTON' || c.text === 0 || !c.inView) { jOk = false; jDetail = `step ${i}: ${JSON.stringify(c)} (wanted idx ${prev + 1})`; break }
      prev = c.idx
    }
    check('j moves down one real, visible row at a time', jOk, jDetail)

    // 5. k moves up one row at a time.
    let kOk = true, kDetail = ''
    for (let i = 0; i < 3; i++) {
      await pressKey(client, 'k')
      const landed = await until(client, `(() => { const el = [...document.querySelectorAll('[data-sidebar-idx]')].find(e => /(^|\\s)vim-cursor/.test(e.className)); return el && Number(el.getAttribute('data-sidebar-idx')) === ${prev - 1}; })()`, 1500)
      const c = await cursorState(client)
      if (!landed || !c || c.idx !== prev - 1 || c.tag !== 'BUTTON') { kOk = false; kDetail = `step ${i}: ${JSON.stringify(c)} (wanted idx ${prev - 1})`; break }
      prev = c.idx
    }
    check('k moves up one real row at a time', kOk, kDetail)

    // 6. G scrolls to the bottom and the last note (a placeholder until now) renders full.
    await pressKey(client, 'G', true)
    const gOk = await until(client, `(() => {
      const s = document.querySelector('.overflow-y-auto');
      return s.scrollTop >= s.scrollHeight - s.clientHeight - 80 && !!document.querySelector('button[data-sidebar-path$=${JSON.stringify(lastNoteFile)}]');
    })()`, 3000)
    check('G scrolls to the bottom; the last note renders as a full row', !!gOk)

    // 7. gg scrolls back to the top and the first note renders full.
    await pressKey(client, 'g'); await sleep(70); await pressKey(client, 'g')
    const ggOk = await until(client, `(() => {
      const s = document.querySelector('.overflow-y-auto');
      return s.scrollTop <= 80 && !!document.querySelector('button[data-sidebar-idx="${firstIdx}"]');
    })()`, 3000)
    check('gg scrolls back to the top; the first note renders as a full row', !!ggOk)

    // 8. Range-select reads selection keys from the DOM — every row must expose one.
    const selKeys = await evaluate(client, `document.querySelectorAll('[data-sidebar-select-key]').length`)
    check('every note row exposes a selection key (range-select sees all rows)', selKeys >= NOTE_COUNT - 5, `select-keys=${selKeys}`)

    // 9. Clicking an off-screen placeholder opens its note (placeholders aren't inert dead-ends).
    const opened = await evaluate(client, `(() => {
      const el = document.querySelector('div[data-sidebar-type="note"][data-sidebar-path$=${JSON.stringify(lastNoteFile)}]');
      if (!el) return 'no-placeholder';
      el.click();
      return el.getAttribute('data-sidebar-path');
    })()`)
    const openedOk = opened && opened !== 'no-placeholder' && await until(client, `(() => {
      const active = document.querySelector('[data-sidebar-path$=${JSON.stringify(lastNoteFile)}]');
      return active && /(^|\\s)(bg-paper|text-accent|vim-cursor)/.test(active.className) || !!document.querySelector('.cm-editor');
    })()`, 3000)
    check('clicking an off-screen placeholder opens its note', !!openedOk, JSON.stringify(opened))

    // 10. No console errors throughout.
    check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    client?.close()
    child.kill('SIGTERM')
    await sleep(500); if (child.exitCode == null) child.kill('SIGKILL')
    await rm(tempRoot, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length === 0) {
    console.log('✓ All sidebar vim-navigation checks passed.')
    process.exit(0)
  }
  console.error(`✗ ${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
