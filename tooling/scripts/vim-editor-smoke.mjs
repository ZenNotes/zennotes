#!/usr/bin/env node
/**
 * Vim editor motion smoke test.
 *
 * Builds and launches the real Electron renderer against an isolated vault,
 * then drives wrapped-line and viewport motions through CDP. The assertions
 * intentionally read only rendered DOM state, not private app or editor state.
 *
 * Usage:
 *   npm run test:vim-editor
 *   ZEN_VIM_EDITOR_SKIP_BUILD=1 npm run test:vim-editor
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
const skipBuild = process.env.ZEN_VIM_EDITOR_SKIP_BUILD === '1'
const notePath = 'inbox/Vim Motion Runtime.md'

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
    child.on('error', rejectPromise)
  })
}

async function prepareBuild() {
  if (skipBuild && (await fileExists(desktopOutMain))) return
  console.log('Building @zennotes/desktop...')
  await run(npmCommand, ['run', 'build', '--workspace', '@zennotes/desktop'])
}

async function seedVault(vaultRoot) {
  const inbox = join(vaultRoot, 'inbox')
  await Promise.all(
    ['inbox', 'quick', 'archive', 'trash'].map((folder) =>
      mkdir(join(vaultRoot, folder), { recursive: true })
    )
  )
  const wrapped = Array.from(
    { length: 90 },
    (_, index) => `wrapped-${String(index + 1).padStart(2, '0')}`
  ).join(' ')
  const lines = [
    wrapped,
    'brackets alpha [beta] gamma [delta] omega',
    ...Array.from(
      { length: 88 },
      (_, index) => `Logical line ${String(index + 3).padStart(2, '0')}`
    )
  ]
  await writeFile(join(inbox, 'Vim Motion Runtime.md'), `${lines.join('\n')}\n`)
}

async function seedUserData(userDataRoot, configRoot, vaultRoot) {
  await Promise.all([
    mkdir(userDataRoot, { recursive: true }),
    mkdir(configRoot, { recursive: true })
  ])
  await writeFile(
    join(userDataRoot, 'zennotes.config.json'),
    `${JSON.stringify(
      {
        workspaceMode: 'local',
        vaultRoot,
        remoteWorkspace: null,
        remoteWorkspaceProfileId: null,
        remoteWorkspaceProfiles: [],
        windowState: {
          x: 60,
          y: 60,
          width: 1180,
          height: 760,
          isMaximized: false
        },
        zoomFactor: 1,
        quickCaptureHotkey: ''
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(configRoot, 'config.toml'),
    `[vim]\nenabled = true\n\n[editor]\nword_wrap = true\nline_number_mode = "relative"\neditor_max_width = 520\n`
  )
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolvePromise(address.port)
        else rejectPromise(new Error('Could not allocate a CDP port'))
      })
    })
    server.on('error', rejectPromise)
  })
}

function httpGetJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch (error) {
          rejectPromise(error)
        }
      })
    })
    request.on('error', rejectPromise)
    request.setTimeout(1000, () => request.destroy(new Error('CDP request timed out')))
  })
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.id = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  connect() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket = new WebSocket(this.url)
      this.socket.on('open', resolvePromise)
      this.socket.on('error', rejectPromise)
      this.socket.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error.message))
          else pending.resolve(message.result ?? {})
          return
        }
        if (message.method) {
          for (const listener of this.listeners.get(message.method) ?? []) {
            listener(message.params ?? {})
          }
        }
      })
    })
  }

  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  close() {
    this.socket?.terminate?.()
    this.socket?.close()
  }
}

async function connectPage(port) {
  const deadline = Date.now() + 20_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          target.webSocketDebuggerUrl &&
          (String(target.url).startsWith('file:') || String(target.url).includes('index.html'))
      )
      if (page) {
        const client = new CdpClient(page.webSocketDebuggerUrl)
        await client.connect()
        return client
      }
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(`No Electron page target: ${lastError?.message ?? 'timeout'}`)
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    )
  }
  return response.result?.value
}

async function until(client, expression, timeoutMs = 4000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression)
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

async function press(client, key, options = {}) {
  const code =
    options.code ??
    (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key)
  const modifiers = (options.shift ? 8 : 0) | (options.ctrl ? 2 : 0)
  const windowsVirtualKeyCode =
    key === 'Enter'
      ? 13
      : key === 'Escape'
        ? 27
        : key === 'Backspace'
          ? 8
          : key === 'Tab'
            ? 9
            : undefined
  await client.send('Input.dispatchKeyEvent', {
    type: key.length === 1 ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    text: key.length === 1 && !options.ctrl ? key : undefined,
    unmodifiedText: key.length === 1 && !options.ctrl ? key.toLowerCase() : undefined,
    modifiers,
    windowsVirtualKeyCode
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode
  })
  await sleep(60)
}

async function keys(client, sequence) {
  for (const key of sequence) await press(client, key)
}

async function gotoLine(client, line) {
  await keys(client, String(line).split(''))
  await press(client, 'G', { shift: true })
  await sleep(100)
}

async function ex(client, command) {
  await press(client, ':', { code: 'Semicolon', shift: true })
  const promptReady = await until(
    client,
    `document.activeElement instanceof HTMLInputElement`,
    2000,
    40
  )
  if (!promptReady) throw new Error(`Ex prompt did not open for :${command}`)
  await evaluate(
    client,
    `(() => {
      const input = document.activeElement
      input.value = ${JSON.stringify(command)}
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(command)} }))
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(enter, 'keyCode', { value: 13 })
      Object.defineProperty(enter, 'which', { value: 13 })
      input.dispatchEvent(enter)
      return input.isConnected
    })()`
  )
  await sleep(120)
}

function editorSnapshot(client) {
  return evaluate(
    client,
    `(() => {
      const editor = document.querySelector('.cm-editor')
      const scroller = editor?.querySelector('.cm-scroller')
      const content = editor?.querySelector('.cm-content')
      const cursor = editor?.querySelector('.cm-cursor-primary, .cm-cursor')
      const active = editor?.querySelector('.cm-activeLine')
      if (!editor || !scroller || !content || !cursor || !active) return null
      const cursorRect = cursor.getBoundingClientRect()
      const lineRect = active.getBoundingClientRect()
      const lineText = active.textContent ?? ''
      const logicalLine = lineText.startsWith('wrapped-')
        ? 1
        : lineText.startsWith('brackets alpha')
          ? 2
          : Number.parseInt(/^Logical line (\\d+)/.exec(lineText)?.[1] ?? '', 10)
      return {
        logicalLine,
        lineText: lineText.slice(0, 80),
        lineLength: lineText.length,
        markerX: lineText.indexOf('X'),
        markerY: lineText.indexOf('Y'),
        cursorTop: Math.round(cursorRect.top * 10) / 10,
        cursorLeft: Math.round(cursorRect.left * 10) / 10,
        lineTop: Math.round(lineRect.top * 10) / 10,
        lineHeight: Number.parseFloat(getComputedStyle(content).lineHeight) || 20,
        scrollTop: Math.round(scroller.scrollTop * 10) / 10,
        scrollHeight: Math.round(scroller.scrollHeight * 10) / 10,
        clientHeight: Math.round(scroller.clientHeight * 10) / 10,
        focused: document.activeElement === content,
        normalMode: scroller.classList.contains('cm-vimMode')
      }
    })()`
  )
}

async function leaveInsertMode(client) {
  // Chromium reserves synthetic Escape in remote-debugging sessions. Vim's
  // equivalent Ctrl-[ route exercises the same real insert-mode exit handler.
  await press(client, '[', { code: 'BracketLeft', ctrl: true })
  return until(
    client,
    `document.querySelector('.cm-scroller')?.classList.contains('cm-vimMode') === true`,
    2000,
    40
  )
}

async function focusEditor(client) {
  await evaluate(
    client,
    `(() => {
      const content = document.querySelector('.cm-content')
      content?.focus()
      return document.activeElement === content
    })()`
  )
  await sleep(100)
}

async function main() {
  await prepareBuild()
  const tempRoot = await mkdtemp(join(tmpdir(), 'zennotes-vim-editor-'))
  const vaultRoot = join(tempRoot, 'vault')
  const userDataRoot = join(tempRoot, 'user-data')
  const configRoot = join(tempRoot, 'config')
  await seedVault(vaultRoot)
  await seedUserData(userDataRoot, configRoot, vaultRoot)
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
  let log = ''
  child.stdout.on('data', (chunk) => {
    log = `${log}${chunk}`.slice(-20_000)
  })
  child.stderr.on('data', (chunk) => {
    log = `${log}${chunk}`.slice(-20_000)
  })

  const failures = []
  const errors = []
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`  PASS  ${name}`)
    else {
      failures.push(name)
      console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
    }
  }

  let client
  try {
    client = await connectPage(port)
    client.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') {
        errors.push(event.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '))
      }
    })
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')])

    console.log('\nVim editor motion smoke test\n')
    const noteReady = await until(
      client,
      `(() => {
        let note = document.querySelector('[data-sidebar-path=${JSON.stringify(notePath)}]')
        if (!note) {
          const inbox = document.querySelector('[data-sidebar-type="folder"][data-sidebar-folder="inbox"]')
          if (inbox?.getAttribute('data-sidebar-collapsed') === 'true') inbox.click()
          return false
        }
        note.click()
        return true
      })()`,
      30_000,
      150
    )
    check('isolated vault note opens', !!noteReady, log.slice(-400))
    const editorReady = await until(
      client,
      `document.querySelectorAll('.cm-line').length >= 1`,
      10_000,
      100
    )
    const editorDiagnostic = editorReady
      ? null
      : await evaluate(
          client,
          `(() => ({
            title: document.title,
            body: (document.body.textContent ?? '').slice(0, 600),
            editors: document.querySelectorAll('.cm-editor').length,
            lines: document.querySelectorAll('.cm-line').length,
            note: (() => {
              const el = document.querySelector('[data-sidebar-path=${JSON.stringify(notePath)}]')
              return el ? { tag: el.tagName, path: el.getAttribute('data-sidebar-path') } : null
            })()
          }))()`
        )
    check(
      'real CodeMirror editor renders the 90-line note',
      !!editorReady,
      JSON.stringify(editorDiagnostic)
    )
    if (!noteReady || !editorReady) throw new Error('Editor did not become ready')
    await focusEditor(client)

    await keys(client, ['g', 'g', '0'])
    const lineStart = await editorSnapshot(client)
    await press(client, '$')
    const dollar = await editorSnapshot(client)
    check(
      '$ stays on the current wrapped display row',
      !!lineStart && !!dollar && Math.abs(dollar.cursorTop - lineStart.cursorTop) < lineStart.lineHeight / 2,
      JSON.stringify({ lineStart, dollar })
    )

    await keys(client, ['g', 'g', '0'])
    await press(client, 'A', { shift: true })
    await press(client, 'X', { shift: true })
    const leftAInsert = await leaveInsertMode(client)
    const afterA = await editorSnapshot(client)
    check(
      'A inserts at the current display-row end',
      !!leftAInsert && !!afterA && afterA.markerX > 5 && afterA.markerX < afterA.lineLength - 10,
      JSON.stringify(afterA)
    )
    await press(client, 'u')

    await keys(client, ['g', 'g', '0', 'j'])
    await press(client, 'I', { shift: true })
    await press(client, 'Y', { shift: true })
    const leftIInsert = await leaveInsertMode(client)
    const afterI = await editorSnapshot(client)
    check(
      'I inserts at the current display-row start',
      !!leftIInsert && !!afterI && afterI.markerY > 5 && afterI.markerY < afterI.lineLength - 10,
      JSON.stringify(afterI)
    )
    await press(client, 'u')

    await keys(client, ['g', 'g', '0'])
    const wrappedCountStart = await editorSnapshot(client)
    await keys(client, ['8', 'j'])
    const wrappedCounted = await editorSnapshot(client)
    check(
      '8j from a wrapped line follows logical relative line numbers',
      wrappedCountStart?.logicalLine === 1 && wrappedCounted?.logicalLine === 9,
      JSON.stringify({ wrappedCountStart, wrappedCounted })
    )

    await gotoLine(client, 10)
    await keys(client, ['3', 'j'])
    const counted = await editorSnapshot(client)
    check(
      '3j follows logical relative line numbers',
      counted?.logicalLine === 13,
      JSON.stringify(counted)
    )

    await gotoLine(client, 5)
    await ex(client, '13')
    const exLine = await editorSnapshot(client)
    check(':13 jumps to logical line 13', exLine?.logicalLine === 13, JSON.stringify(exLine))
    if (!(await evaluate(client, `document.activeElement === document.querySelector('.cm-content')`))) {
      await press(client, 'Escape')
      await focusEditor(client)
    }

    await gotoLine(client, 2)
    await press(client, '0')
    const bracketStart = await editorSnapshot(client)
    await keys(client, ['f', '['])
    const forwardBracket = await editorSnapshot(client)
    await press(client, '$')
    await keys(client, ['F', '['])
    const backwardBracket = await editorSnapshot(client)
    check(
      'f[ and F[ find square brackets in both directions',
      !!bracketStart &&
        !!forwardBracket &&
        !!backwardBracket &&
        forwardBracket.cursorLeft > bracketStart.cursorLeft + 20 &&
        backwardBracket.cursorLeft > forwardBracket.cursorLeft + 20,
      JSON.stringify({ bracketStart, forwardBracket, backwardBracket })
    )

    await gotoLine(client, 45)
    await press(client, 'L', { shift: true })
    const firstL = await editorSnapshot(client)
    await press(client, 'L', { shift: true })
    const secondL = await editorSnapshot(client)
    check(
      'repeated L continues scrolling down from the viewport edge',
      !!firstL && !!secondL && secondL.scrollTop > firstL.scrollTop + firstL.lineHeight / 2,
      JSON.stringify({ firstL, secondL })
    )

    await gotoLine(client, 45)
    await press(client, 'H', { shift: true })
    const firstH = await editorSnapshot(client)
    await press(client, 'H', { shift: true })
    const secondH = await editorSnapshot(client)
    check(
      'repeated H continues scrolling up from the viewport edge',
      !!firstH && !!secondH && secondH.scrollTop < firstH.scrollTop - firstH.lineHeight / 2,
      JSON.stringify({ firstH, secondH })
    )

    check('no renderer console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    client?.close()
    child.kill('SIGTERM')
    await sleep(500)
    if (child.exitCode == null) child.kill('SIGKILL')
    await rm(tempRoot, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length === 0) {
    console.log('All Vim editor motion checks passed.')
    return
  }
  throw new Error(`${failures.length} Vim editor motion check(s) failed: ${failures.join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
