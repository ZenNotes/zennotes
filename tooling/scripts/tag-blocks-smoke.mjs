#!/usr/bin/env node
/**
 * Block-level tag results smoke test (#837).
 *
 * Seeds a vault with tagged list items, a tagged heading section, a tagged
 * paragraph, a `#tag` inside fenced code, and a note tagged only in
 * frontmatter, launches the real desktop build twice (Vim on, then Vim off)
 * with its own userData and config dir, and drives the Tags view over the
 * Chrome DevTools Protocol:
 *   - a sidebar tag click opens the Tags view with each note's tagged blocks
 *     listed under it, code ignored, the frontmatter-only note a plain row,
 *   - j / } / { move over block rows and between notes,
 *   - Enter on a block opens the note with the caret and highlight on that line,
 *   - the filter narrows to the blocks whose text matches,
 *   - a block typed into an open note lists right away,
 *   - with Vim off, } is inert and the arrows and Enter still work,
 *   - Search notes with a #tag lists two blocks per note and a "+N more" row:
 *     Ctrl+J / the arrows reach the blocks, Enter opens one at its line, free
 *     text narrows and marks them, "+N more" opens the Tags view with the
 *     text still filtering, and the Settings toggle (saved to config.toml)
 *     turns the blocks off,
 *   - a tag on ZEN_TAG_BLOCKS_BULK notes (default 500) fills in, timed,
 *   - no console errors fire.
 *
 * Usage:
 *   node tooling/scripts/tag-blocks-smoke.mjs
 *   ZEN_TAG_BLOCKS_SKIP_BUILD=1 node tooling/scripts/tag-blocks-smoke.mjs   # reuse out/main
 *   ZEN_TAG_BLOCKS_SHOTS=<dir> ...                                          # keep screenshots
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { testWindowState } from './test-window-state.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const requireDesktop = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
const electronPath = requireDesktop('electron')
const desktopOutMain = resolve(repoRoot, 'apps/desktop/out/main/index.js')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const skipBuild = process.env.ZEN_TAG_BLOCKS_SKIP_BUILD === '1'
const shotsDir = process.env.ZEN_TAG_BLOCKS_SHOTS?.trim() || null
const BULK_NOTES = Number.parseInt(process.env.ZEN_TAG_BLOCKS_BULK ?? '500', 10) || 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IDEAS = [
  '# Ideas',
  '',
  'Some thoughts I keep in one place.',
  '',
  '- Groceries for the week',
  '- Recipe gallery for the website #idea',
  '  - start with ten recipes',
  '- Plugin store with reviews #idea #later',
  '',
  '## Dark mode schedule #idea',
  'Switch themes at sunset.',
  'Needs a setting.',
  '',
  '## Notes',
  '',
  'A paragraph about the zine',
  'that spans lines #idea and continues.',
  '',
  '```js',
  '// #idea inside code must not list',
  "const tag = '#idea'",
  '```',
  ''
].join('\n')

const JOURNAL = ['# Journal', '', 'Woke up early.', '', 'Write a zine about walking #idea', ''].join('\n')
const PROJECT = ['---', 'tags: [idea]', '---', '# Project', '', 'Only frontmatter tags here.', ''].join('\n')
const LATER = ['# Later', '', '- Something for later #later', ''].join('\n')

async function fileExists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
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
  const now = Date.now() / 1000
  const notes = [
    ['Ideas.md', IDEAS, now],
    ['Journal.md', JOURNAL, now - 60],
    ['Project.md', PROJECT, now - 120],
    ['Later.md', LATER, now - 180]
  ]
  for (const [name, body, mtime] of notes) {
    const p = join(inbox, name)
    await writeFile(p, body)
    await utimes(p, mtime, mtime)
  }
  if (BULK_NOTES > 0) {
    const bulk = join(inbox, 'bulk')
    await mkdir(bulk, { recursive: true })
    const filler = Array.from({ length: 40 }, (_, i) => `Filler line ${i} of plain prose.`).join('\n')
    const files = []
    for (let i = 0; i < BULK_NOTES; i++) {
      files.push([
        join(bulk, `bulk-${String(i).padStart(4, '0')}.md`),
        `# Bulk ${i}\n\n${filler}\n\n- first item\n- idea number ${i} #bulk\n- last item\n\n${filler}\n`
      ])
    }
    for (let i = 0; i < files.length; i += 100) {
      await Promise.all(files.slice(i, i + 100).map(([p, b]) => writeFile(p, b)))
    }
  }
}

async function seedUserData(userDataRoot, configRoot, vaultRoot, vim) {
  await Promise.all([mkdir(userDataRoot, { recursive: true }), mkdir(configRoot, { recursive: true })])
  await writeFile(
    join(userDataRoot, 'zennotes.config.json'),
    JSON.stringify(
      {
        workspaceMode: 'local',
        vaultRoot,
        remoteWorkspace: null,
        remoteWorkspaceProfileId: null,
        remoteWorkspaceProfiles: [],
        windowState: testWindowState(1280, 860),
        zoomFactor: 1,
        quickCaptureHotkey: ''
      },
      null,
      2
    )
  )
  await writeFile(join(configRoot, 'config.toml'), `[vim]\nenabled = ${vim}\n`)
}

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => res(a.port))
    })
    s.on('error', rej)
  })
}

function httpGetJson(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => {
        try {
          res(JSON.parse(b))
        } catch (e) {
          rej(e)
        }
      })
    })
    req.on('error', rej)
    req.setTimeout(1000, () => req.destroy(new Error('timeout')))
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 1
    this.pending = new Map()
    this.listeners = new Map()
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url)
      this.ws.on('open', res)
      this.ws.on('error', rej)
      this.ws.on('close', () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'))
        this.pending.clear()
      })
      this.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.id && this.pending.has(m.id)) {
          const { resolve: ok, reject } = this.pending.get(m.id)
          this.pending.delete(m.id)
          if (m.error) reject(new Error(m.error.message))
          else ok(m.result ?? {})
        } else if (m.method) {
          for (const l of this.listeners.get(m.method) ?? []) l(m.params ?? {})
        }
      })
    })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, l) {
    const a = this.listeners.get(method) ?? []
    a.push(l)
    this.listeners.set(method, a)
  }
  close() {
    this.ws?.terminate?.()
  }
}

async function connectPage(port) {
  const deadline = Date.now() + 30000
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && (String(t.url).startsWith('file:') || String(t.url).includes('index.html'))
      )
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        return c
      }
    } catch (e) {
      lastErr = e
    }
    await sleep(100)
  }
  throw new Error(`no CDP page: ${lastErr?.message ?? 'timeout'}`)
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}

async function until(client, expression, timeoutMs = 4000, intervalMs = 60) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evaluate(client, expression)
    if (v) return v
    await sleep(intervalMs)
  }
  return null
}

const KEY_CODES = {
  '}': ['BracketRight', 221, true],
  '{': ['BracketLeft', 219, true],
  '/': ['Slash', 191, false],
  ':': ['Semicolon', 186, true],
  '#': ['Digit3', 51, true],
  ' ': ['Space', 32, false],
  '-': ['Minus', 189, false],
  G: ['KeyG', 71, true]
}

/** A real key press through CDP: keyDown (with text for printable keys) + keyUp. */
async function press(client, key) {
  const named = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 }
  let code
  let keyCode
  let shift = false
  if (named[key]) {
    code = key
    keyCode = named[key]
  } else if (KEY_CODES[key]) {
    ;[code, keyCode, shift] = KEY_CODES[key]
  } else if (/^[a-z]$/.test(key)) {
    code = `Key${key.toUpperCase()}`
    keyCode = key.toUpperCase().charCodeAt(0)
  } else if (/^[A-Z]$/.test(key)) {
    code = `Key${key}`
    keyCode = key.charCodeAt(0)
    shift = true
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`
    keyCode = key.charCodeAt(0)
  } else {
    code = ''
    keyCode = 0
  }
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined
  const modifiers = shift ? 8 : 0
  await client.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {})
  })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
  await sleep(40)
}

/** Ctrl plus a letter, as a real key press (no text: a chord types nothing). */
async function pressCtrl(client, letter) {
  const code = `Key${letter.toUpperCase()}`
  const keyCode = letter.toUpperCase().charCodeAt(0)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', { type, key: letter, code, windowsVirtualKeyCode: keyCode, modifiers: 2 })
  }
  await sleep(60)
}

/** Mod (Cmd on macOS, Ctrl elsewhere) plus a key, as a real key press. */
async function pressMod(client, key, code, keyCode) {
  const modifiers = process.platform === 'darwin' ? 4 : 2
  for (const type of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  await sleep(80)
}

/** A real mouse click at the centre of the first element matching `selector`. */
async function clickAt(client, selector) {
  const rect = await evaluate(
    client,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })()`
  )
  if (!rect) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  await sleep(60)
  return true
}

async function typeText(client, text) {
  for (const ch of text) await press(client, ch)
}

async function screenshot(client, name) {
  if (!shotsDir) return
  await mkdir(shotsDir, { recursive: true })
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
  const file = join(shotsDir, `${name}.png`)
  await writeFile(file, Buffer.from(data, 'base64'))
  console.log(`        screenshot ${file}`)
}

async function dismissWhatsNew(client) {
  if (!(await until(client, `!!document.querySelector('[data-whats-new]')`, 4000))) return
  await evaluate(client, `document.querySelector('[data-whats-new-close]')?.click()`)
  await until(client, `!document.querySelector('[data-whats-new]')`, 2000)
}

/** What the Tags view lists, row by row, and where the cursor is. */
function tagRows(client) {
  return evaluate(
    client,
    `(() => [...document.querySelectorAll('[data-tag-view-index]')].map((el) => ({
      index: Number(el.getAttribute('data-tag-view-index')),
      note: el.getAttribute('data-tag-row'),
      block: el.getAttribute('data-tag-block-row'),
      text: (el.textContent || '').trim(),
      cursor: /(^|\\s)vim-cursor(\\s|$)/.test(el.className)
    })))()`
  )
}

function cursorRow(rows) {
  return rows.find((r) => r.cursor) ?? null
}

function devInstanceRunning() {
  try {
    // Anchored on the binary path, so a shell whose command line merely
    // mentions the pattern (a wrapper script, a watcher) never matches.
    const out = execFileSync('pgrep', ['-fl', '^[^ ]*Electron[.]app/Contents/MacOS/Electron --remote-debugging-port'], {
      encoding: 'utf8'
    })
    return out
      .split('\n')
      .filter((l) => l.trim() && !/zsh -c|pgrep/.test(l))
      .join('\n')
  } catch {
    return ''
  }
}

async function launch(label, vim, body) {
  const live = devInstanceRunning()
  if (live) throw new Error(`another dev ZenNotes is running; not starting a second one:\n${live}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'zennotes-tag-blocks-'))
  const vaultRoot = join(tempRoot, 'vault')
  const userDataRoot = join(tempRoot, 'user-data')
  const configRoot = join(tempRoot, 'config')
  await seedVault(vaultRoot)
  await seedUserData(userDataRoot, configRoot, vaultRoot, vim)
  const port = await getFreePort()
  const child = spawn(electronPath, [`--remote-debugging-port=${port}`, desktopOutMain], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ZENNOTES_USER_DATA_PATH: userDataRoot,
      ZENNOTES_CONFIG_DIR: configRoot
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exited = new Promise((res) => child.once('exit', res))
  const killChild = () => {
    if (child.exitCode == null) child.kill('SIGKILL')
  }
  process.once('exit', killChild)
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  const errors = []
  let client
  try {
    client = await connectPage(port)
    client.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') errors.push(e.args?.map((a) => a.value ?? a.description ?? '').join(' '))
    })
    client.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description ?? 'exception'))
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')])
    console.log(`\n${label}\n`)
    const ready = await until(client, `!!document.querySelector('[data-sidebar-tag]')`, 35000, 200)
    if (!ready) throw new Error(`notes never rendered; log tail: ${log.slice(-400)}`)
    await dismissWhatsNew(client)
    await sleep(300)
    await body(client, errors, { configRoot })
  } finally {
    client?.close()
    if (child.exitCode == null) child.kill('SIGTERM')
    const timer = setTimeout(killChild, 5000)
    await exited
    clearTimeout(timer)
    process.removeListener('exit', killChild)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

const failures = []
function check(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures.push(name)
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

async function openTagFromSidebar(client, tag) {
  return evaluate(
    client,
    `(() => {
      const row = document.querySelector('[data-sidebar-tag="${tag}"]');
      if (!row) return false;
      const chip = row.tagName === 'BUTTON' ? row : row.querySelector('button[title="#${tag}"]');
      chip?.click();
      return !!chip;
    })()`
  )
}

async function vimOnScenario(client, errors) {
  const clicked = await openTagFromSidebar(client, 'idea')
  check('a sidebar tag chip for #idea exists and opens the Tags view', !!clicked)
  const listed = await until(
    client,
    `document.querySelectorAll('[data-tag-block-row]').length >= 5 && !/Finding tagged blocks/.test(document.body.textContent)`,
    6000
  )
  const rows = await tagRows(client)
  check('the Tags view lists block rows under the notes', !!listed, JSON.stringify(rows))

  const shape = rows.map((r) => r.note ?? `  ${r.block}`)
  check(
    'blocks sit under their notes; code ignored; frontmatter-only note is a plain row',
    JSON.stringify(shape) ===
      JSON.stringify([
        'inbox/Ideas.md',
        '  inbox/Ideas.md:6',
        '  inbox/Ideas.md:8',
        '  inbox/Ideas.md:10',
        '  inbox/Ideas.md:16',
        'inbox/Journal.md',
        '  inbox/Journal.md:5',
        'inbox/Project.md'
      ]),
    JSON.stringify(shape)
  )
  const header = await evaluate(client, `document.querySelector('h1')?.parentElement?.textContent ?? ''`)
  check('the header counts notes and blocks', /3 notes · 5 blocks/.test(header), header)
  const sectionText = rows.find((r) => r.block === 'inbox/Ideas.md:10')?.text ?? ''
  check(
    'a tagged heading lists its section',
    /Dark mode schedule #idea/.test(sectionText) && /Switch themes at sunset/.test(sectionText),
    sectionText
  )
  const listText = rows.find((r) => r.block === 'inbox/Ideas.md:6')?.text ?? ''
  check('a tagged list item lists its child item', /start with ten recipes/.test(listText), listText)
  await screenshot(client, '01-tags-view-blocks')

  // Keyboard: the cursor starts on the first note row.
  check('the cursor starts on the first note row', cursorRow(await tagRows(client))?.note === 'inbox/Ideas.md')
  await press(client, 'j')
  check('j moves onto the first block row', cursorRow(await tagRows(client))?.block === 'inbox/Ideas.md:6')
  await press(client, '}')
  check('} hops past the blocks to the next note', cursorRow(await tagRows(client))?.note === 'inbox/Journal.md')
  await press(client, '{')
  check('{ hops back to the previous note', cursorRow(await tagRows(client))?.note === 'inbox/Ideas.md')
  await press(client, 'j')
  await press(client, 'j')
  await press(client, 'j')
  check('j walks the blocks in order', cursorRow(await tagRows(client))?.block === 'inbox/Ideas.md:10')
  await screenshot(client, '02-cursor-on-section-block')

  // Enter opens the note at the block's line, highlighted.
  await press(client, 'Enter')
  const landed = await until(
    client,
    `(() => {
      const line = document.querySelector('.cm-editor .cm-activeLine');
      const hl = document.querySelector('.cm-editor .cm-line.cm-task-jump-highlight');
      return line && /Dark mode schedule/.test(line.textContent) ? { active: line.textContent, highlighted: hl?.textContent ?? null } : null;
    })()`,
    4000
  )
  check('Enter opens the note with the caret on the block line', !!landed, JSON.stringify(landed))
  check('the jumped-to line is highlighted', !!landed?.highlighted && /Dark mode schedule/.test(landed.highlighted), JSON.stringify(landed))
  await screenshot(client, '03-jumped-to-section')

  // The jump is recorded: Ctrl+O from the note comes back to the Tags view.
  await pressCtrl(client, 'o')
  const back = await until(client, `!!document.querySelector('[data-tag-view-index]')`, 3000)
  check('Ctrl+O from the note comes back to the Tags view', !!back)
  await clickAt(client, '[data-tab-path="inbox/Ideas.md"]')
  await until(client, `!!document.querySelector('.cm-editor .cm-content')`, 3000)
  await evaluate(client, `document.querySelector('.cm-editor .cm-content')?.focus(), true`)

  // A block typed into the open note lists before it is saved.
  await press(client, 'G')
  await press(client, 'o')
  await typeText(client, '- Fresh idea typed just now #idea')
  await press(client, 'Escape')
  await clickAt(client, '[data-tab-path="zen://tags"]')
  const fresh = await until(
    client,
    `[...document.querySelectorAll('[data-tag-block-row]')].some((el) => /Fresh idea typed just now/.test(el.textContent))`,
    4000
  )
  check('a block typed into the open note lists right away', !!fresh, JSON.stringify(await tagRows(client)))

  // The filter narrows to blocks whose text matches.
  await press(client, '/')
  await typeText(client, 'plugin')
  const filtered = await until(
    client,
    `(() => { const rows = [...document.querySelectorAll('[data-tag-view-index]')]; return rows.length === 2 && rows[1].getAttribute('data-tag-block-row') === 'inbox/Ideas.md:8' ? rows.length : null })()`,
    3000
  )
  check('the filter narrows to the matching block under its note', !!filtered, JSON.stringify(await tagRows(client)))
  await screenshot(client, '04-filtered-to-block')
  await press(client, 'Escape')
  await press(client, 'Escape')

  // Bulk fill timing: a tag carried by BULK_NOTES notes, none open.
  if (BULK_NOTES > 0) {
    await press(client, ':')
    await typeText(client, 'tag bulk')
    const t0 = Date.now()
    await press(client, 'Enter')
    const filled = await until(
      client,
      `document.querySelectorAll('[data-tag-block-row]').length === ${BULK_NOTES} && !/Finding tagged blocks/.test(document.body.textContent)`,
      30000,
      20
    )
    const ms = Date.now() - t0
    check(`a tag on ${BULK_NOTES} notes fills in all ${BULK_NOTES} blocks`, !!filled, `after ${ms} ms`)
    console.log(`        ${BULK_NOTES}-note tag: blocks listed ${ms} ms after Enter`)
    const longTask = await evaluate(
      client,
      `(() => { const t0 = performance.now(); document.querySelector('[data-tag-view-index]')?.getBoundingClientRect(); return Math.round(performance.now() - t0) })()`
    )
    console.log(`        layout read after fill: ${longTask} ms`)
    await screenshot(client, '05-bulk-tag')
  }

  check('no console errors with Vim on', errors.length === 0, errors.slice(0, 3).join(' | '))
}

async function vimOffScenario(client, errors) {
  await openTagFromSidebar(client, 'idea')
  await until(client, `document.querySelectorAll('[data-tag-block-row]').length >= 5`, 6000)
  check('Vim off: the cursor starts on the first note row', cursorRow(await tagRows(client))?.note === 'inbox/Ideas.md')
  await press(client, '}')
  await press(client, 'j')
  check('Vim off: } and j do nothing', cursorRow(await tagRows(client))?.note === 'inbox/Ideas.md')
  await press(client, 'ArrowDown')
  await press(client, 'ArrowDown')
  check('Vim off: ArrowDown walks the block rows', cursorRow(await tagRows(client))?.block === 'inbox/Ideas.md:8')
  const hint = await evaluate(
    client,
    `[...document.querySelectorAll('div')].map((d) => d.textContent ?? '').filter((t) => /^\\S+ move · Enter open/.test(t)).pop() ?? ''`
  )
  check('Vim off: the footer hint names no single-key shortcut', /↑\/↓ move · Enter open note or block/.test(hint) && !/[{}]/.test(hint), hint)
  await screenshot(client, '06-vim-off')
  await press(client, 'Enter')
  const landed = await until(
    client,
    `(() => { const line = document.querySelector('.cm-editor .cm-activeLine'); return line && /Plugin store/.test(line.textContent) ? line.textContent : null })()`,
    4000
  )
  check('Vim off: Enter opens the block line', !!landed, String(landed))
  check('no console errors with Vim off', errors.length === 0, errors.slice(0, 3).join(' | '))
}

/** The Search notes rows, as text: a note's title, an indented block, "+N more". */
function paletteRows(client) {
  return evaluate(
    client,
    `(() => [...document.querySelectorAll('[data-search-idx]')].map((el) => ({
      label: el.dataset.searchBlock ? '  ' + el.dataset.searchBlock
        : el.dataset.searchMore ? '  ' + (el.textContent || '').replace('open in Tags', '').trim()
        : el.dataset.searchCreate !== undefined ? 'create'
        : (el.querySelector('span')?.textContent || '').trim(),
      active: el.className.split(/\\s+/).includes('bg-paper-200')
    })))()`
  )
}

async function openPalette(client, text) {
  await pressMod(client, 'p', 'KeyP', 80)
  const open = await until(client, `!!document.querySelector('input[placeholder^="Search notes"]')`, 3000)
  if (!open) return false
  await evaluate(client, `document.querySelector('input[placeholder^="Search notes"]').focus(), true`)
  await typeText(client, text)
  return true
}

/** Clear the palette's query with real Backspaces, then type `text`. */
async function retypePalette(client, text) {
  const len = await evaluate(client, `document.querySelector('input[placeholder^="Search notes"]')?.value.length ?? 0`)
  for (let i = 0; i < len; i++) await press(client, 'Backspace')
  await typeText(client, text)
}

async function moveToPaletteRow(client, label, nextKey) {
  for (let i = 0; i < 20; i++) {
    const rows = await paletteRows(client)
    if (rows.find((r) => r.active)?.label === label) return true
    await nextKey()
  }
  return false
}

async function paletteScenario(client, errors) {
  const opened = await openPalette(client, '#idea')
  check('Mod+P opens Search notes', opened)
  await until(client, `document.querySelectorAll('[data-search-block]').length >= 3`, 4000)
  let rows = (await paletteRows(client)).map((r) => r.label)
  const at = rows.indexOf('Ideas')
  check(
    'a #tag query lists two blocks under the note, then "+N more"',
    JSON.stringify(rows.slice(at, at + 4)) ===
      JSON.stringify(['Ideas', '  inbox/Ideas.md:6', '  inbox/Ideas.md:8', '  +3 more tagged blocks']),
    JSON.stringify(rows)
  )
  const j = rows.indexOf('Journal')
  check('every tagged note lists its own blocks', rows[j + 1] === '  inbox/Journal.md:5', JSON.stringify(rows))
  const pr = rows.indexOf('Project')
  check(
    'a note tagged only in frontmatter is a plain row in the palette',
    pr >= 0 && !(rows[pr + 1] ?? '').startsWith('  '),
    JSON.stringify(rows)
  )
  await screenshot(client, '07-palette-tag-blocks')

  const reached = await moveToPaletteRow(client, '  inbox/Ideas.md:6', () => pressCtrl(client, 'j'))
  check('Ctrl+J walks onto a block row', reached, JSON.stringify(await paletteRows(client)))
  await press(client, 'Enter')
  const landed = await until(
    client,
    `(() => {
      if (document.querySelector('input[placeholder^="Search notes"]')) return null;
      const line = document.querySelector('.cm-editor .cm-activeLine');
      const hl = document.querySelector('.cm-editor .cm-line.cm-task-jump-highlight');
      return line && /Recipe gallery/.test(line.textContent) && hl && /Recipe gallery/.test(hl.textContent) ? line.textContent : null;
    })()`,
    4000
  )
  check('Enter on a palette block opens the note at that line, highlighted', !!landed, String(landed))

  await openPalette(client, '#idea zine')
  await until(client, `document.querySelectorAll('[data-search-block]').length === 2`, 4000)
  rows = (await paletteRows(client)).map((r) => r.label)
  check(
    'free text narrows the blocks, across notes',
    rows.filter((r) => r.startsWith('  ')).sort().join('|') === '  inbox/Ideas.md:16|  inbox/Journal.md:5',
    JSON.stringify(rows)
  )
  const marks = await evaluate(client, `[...document.querySelectorAll('[data-block-match]')].map((m) => m.textContent.toLowerCase())`)
  check('the typed text is marked inside the blocks', marks.length >= 2 && marks.every((m) => m === 'zine'), JSON.stringify(marks))
  await screenshot(client, '08-palette-narrowed')

  await retypePalette(client, '#idea the')
  await until(client, `!!document.querySelector('[data-search-more]')`, 4000)
  rows = (await paletteRows(client)).map((r) => r.label)
  const more = rows.find((r) => r.startsWith('  +'))
  check('"+N more" counts the narrowed blocks', more === '  +1 more tagged block', JSON.stringify(rows))
  await moveToPaletteRow(client, more, () => press(client, 'ArrowDown'))
  await press(client, 'Enter')
  const tags = await until(
    client,
    `(() => {
      const filter = document.querySelector('input[placeholder^="Filter"]');
      const rows = document.querySelectorAll('[data-tag-block-row]').length;
      return filter && rows > 0 ? { filter: filter.value, rows } : null;
    })()`,
    4000
  )
  check('"+N more" opens the Tags view with the text still filtering', tags?.filter === 'the' && tags.rows === 3, JSON.stringify(tags))
  await screenshot(client, '09-more-opens-tags')
  check('no console errors in the palette', errors.length === 0, errors.slice(0, 3).join(' | '))
}

async function paletteVimOffScenario(client, errors, { configRoot }) {
  await openPalette(client, '#idea')
  await until(client, `document.querySelectorAll('[data-search-block]').length >= 3`, 4000)
  const reached = await moveToPaletteRow(client, '  inbox/Ideas.md:8', () => press(client, 'ArrowDown'))
  check('Vim off: the arrows walk onto a palette block', reached, JSON.stringify(await paletteRows(client)))
  await press(client, 'Enter')
  const landed = await until(
    client,
    `(() => { const line = document.querySelector('.cm-editor .cm-activeLine'); return line && /Plugin store/.test(line.textContent) ? line.textContent : null })()`,
    4000
  )
  check('Vim off: Enter on a palette block opens its line', !!landed, String(landed))

  // Settings → Search → Show tagged blocks in note search, off.
  await pressMod(client, ',', 'Comma', 188)
  const search = await until(client, `!!document.querySelector('input[placeholder="Search settings…"]')`, 3000)
  check('Settings opens', !!search)
  await evaluate(client, `document.querySelector('input[placeholder="Search settings…"]').focus(), true`)
  await typeText(client, 'tagged blocks')
  const sw = '[data-settings-search-id="search-tagged-blocks"] [role="switch"]'
  if (!(await until(client, `!!document.querySelector('${sw}')`, 1500))) await press(client, 'Enter')
  const found = await until(client, `!!document.querySelector('${sw}')`, 3000)
  check('Settings search finds "Show tagged blocks in note search"', !!found)
  await evaluate(client, `document.querySelector('${sw}')?.scrollIntoView({ block: 'center' }), true`)
  await screenshot(client, '10-setting-on')
  await clickAt(client, sw)
  const off = await until(client, `document.querySelector('${sw}')?.getAttribute('aria-checked') === 'false'`, 2000)
  check('the toggle turns off', !!off)
  const toml = await (async () => {
    for (let i = 0; i < 30; i++) {
      const text = await readFile(join(configRoot, 'config.toml'), 'utf8').catch(() => '')
      if (/tagged_blocks\s*=\s*false/.test(text)) return text
      await sleep(100)
    }
    return ''
  })()
  check('the setting is saved to config.toml as tagged_blocks = false', !!toml)
  await press(client, 'Escape')
  await until(client, `!document.querySelector('input[placeholder="Search settings…"]')`, 2000)

  await openPalette(client, '#idea')
  await sleep(400)
  const rows = await paletteRows(client)
  check(
    'with the setting off, a #tag query lists notes only',
    rows.length > 0 && rows.every((r) => !r.label.startsWith('  ')),
    JSON.stringify(rows)
  )
  await screenshot(client, '11-setting-off-plain-rows')
  await press(client, 'Escape')
  check('no console errors in the palette with Vim off', errors.length === 0, errors.slice(0, 3).join(' | '))
}

async function main() {
  if (!skipBuild || !(await fileExists(desktopOutMain))) {
    console.log('Building @zennotes/desktop (set ZEN_TAG_BLOCKS_SKIP_BUILD=1 to reuse the current build)…')
    await run(npmCommand, ['run', 'build', '--workspace', '@zennotes/desktop'])
  }
  await launch('Tag blocks smoke test, Vim on', true, async (client, errors, ctx) => {
    await vimOnScenario(client, errors)
    console.log('\n  Search notes, Vim on\n')
    await paletteScenario(client, errors, ctx)
  })
  await launch('Tag blocks smoke test, Vim off', false, async (client, errors, ctx) => {
    await vimOffScenario(client, errors)
    console.log('\n  Search notes, Vim off\n')
    await paletteVimOffScenario(client, errors, ctx)
  })
  console.log('')
  if (failures.length === 0) {
    console.log('All tag-block checks passed.')
    process.exit(0)
  }
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}

process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
