#!/usr/bin/env node
/**
 * Editor improvements smoke test for discussion #516.
 *
 * Builds and launches the real Electron app against isolated user-data,
 * config, and vault directories. Assertions read rendered DOM state only.
 *
 * Usage:
 *   npm run test:editor-improvements
 *   ZEN_EDITOR_IMPROVEMENTS_SKIP_BUILD=1 npm run test:editor-improvements
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

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
// electron is a dependency of the desktop workspace, not of the repo root;
// hoisting is not a contract, so resolve it from where it is declared.
const requireDesktop = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
const electronPath = requireDesktop('electron')
const desktopOutMain = resolve(repoRoot, 'apps/desktop/out/main/index.js')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const skipBuild = process.env.ZEN_EDITOR_IMPROVEMENTS_SKIP_BUILD === '1'
const primaryPath = 'inbox/Editor Improvements.md'
const secondPath = 'inbox/Second Note.md'

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
  await Promise.all(
    ['inbox', 'quick', 'archive', 'trash'].map((folder) =>
      mkdir(join(vaultRoot, folder), { recursive: true })
    )
  )
  await writeFile(
    join(vaultRoot, primaryPath),
    [
      '# Runtime Heading',
      '',
      'Intro body',
      '',
      '## Fold Me',
      '',
      'Folded body line',
      '',
      '## Keep Visible',
      '',
      'Cursor marker position',
      '',
      'Replacement target',
      '',
      '$$',
      '\\begin{equation}a=b\\end{equation}',
      '$$',
      '',
      '$$',
      '\\begin{equation}c=d\\end{equation}',
      '$$',
      ''
    ].join('\n')
  )
  await writeFile(join(vaultRoot, secondPath), '# Second Note\n\nSecond body\n')
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
          height: 780,
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
    [
      '[vim]',
      'enabled = false',
      '',
      '[editor]',
      'live_preview = true',
      'show_heading_level_labels = true',
      'text_replacements_enabled = true',
      'tab_size = 3',
      '',
      '[text_replacements]',
      '"->" = "→"',
      ''
    ].join('\n')
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

async function until(client, expression, timeoutMs = 5000, intervalMs = 80) {
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
  const modifiers =
    (options.alt ? 1 : 0) |
    (options.ctrl ? 2 : 0) |
    (options.meta ? 4 : 0) |
    (options.shift ? 8 : 0)
  const printable = key.length === 1 && !options.ctrl && !options.meta
  const windowsVirtualKeyCode =
    options.windowsVirtualKeyCode ??
    (key === 'Enter'
      ? 13
      : key === 'Escape'
        ? 27
        : key === 'Tab'
          ? 9
          : key === 'End'
            ? 35
            : undefined)
  await client.send('Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    text: printable ? key : undefined,
    unmodifiedText: printable ? key : undefined,
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
  await sleep(70)
}

async function pressMod(client, key, code) {
  await press(client, key, {
    code,
    meta: process.platform === 'darwin',
    ctrl: process.platform !== 'darwin'
  })
}

async function clickPoint(client, point) {
  if (!point) return false
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await sleep(120)
  return true
}

async function clickExpression(client, expression) {
  const point = await evaluate(
    client,
    `(() => {
      const element = ${expression}
      if (!(element instanceof Element)) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`
  )
  return clickPoint(client, point)
}

async function openNote(client, path, expectedText) {
  const selector = `[data-sidebar-path=${JSON.stringify(path)}]`
  const present = await until(
    client,
    `(() => {
      const inbox = document.querySelector('[data-sidebar-type="folder"][data-sidebar-folder="inbox"]')
      if (inbox?.getAttribute('data-sidebar-collapsed') === 'true') inbox.click()
      return document.querySelector(${JSON.stringify(selector)}) != null
    })()`,
    20_000,
    120
  )
  if (!present) return false
  await clickExpression(client, `document.querySelector(${JSON.stringify(selector)})`)
  return !!(await until(
    client,
    `Array.from(document.querySelectorAll('.cm-line')).some((line) => (line.textContent ?? '').includes(${JSON.stringify(expectedText)}))`,
    10_000,
    100
  ))
}

function lineExpression(text, childSelector = null) {
  const line = `Array.from(document.querySelectorAll('.cm-line')).find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(text)}))`
  return childSelector ? `${line}?.querySelector(${JSON.stringify(childSelector)})` : line
}

async function main() {
  await prepareBuild()
  const tempRoot = await mkdtemp(join(tmpdir(), 'zennotes-editor-improvements-'))
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

    console.log('\nEditor improvements smoke test\n')
    const firstReady = await openNote(client, primaryPath, 'Runtime Heading')
    check('isolated primary note opens in real Electron', firstReady, log.slice(-500))
    if (!firstReady) throw new Error('Primary editor did not become ready')

    const labels = await evaluate(
      client,
      `Array.from(document.querySelectorAll('.cm-heading-level-label')).map((node) => node.textContent)`
    )
    check(
      'heading level labels render from the portable setting',
      Array.isArray(labels) && labels.includes('H1') && labels.filter((label) => label === 'H2').length >= 2,
      JSON.stringify(labels)
    )

    // DOM presence is not paint: at this window size the chips once rendered
    // at real coordinates UNDER the opaque sidebar (the centered column's
    // auto margin is 0 when the pane is narrower than the column cap, and the
    // chip offset reached beyond the content box). Assert the chips paint
    // inside the editor pane, where a user can actually see them.
    const labelPaint = await evaluate(
      client,
      `(() => {
        const editor = document.querySelector('.cm-editor')?.getBoundingClientRect()
        const chips = Array.from(document.querySelectorAll('.cm-heading-level-label')).map((n) =>
          n.getBoundingClientRect()
        )
        if (!editor || chips.length === 0) return null
        return {
          editorLeft: Math.round(editor.left),
          leftmostChip: Math.round(Math.min(...chips.map((r) => r.left))),
          inside: chips.every((r) => r.width > 0 && r.left >= editor.left)
        }
      })()`
    )
    check(
      'heading level labels paint inside the editor pane, not under the sidebar',
      !!labelPaint?.inside,
      JSON.stringify(labelPaint)
    )

    const tabSize = await evaluate(
      client,
      `getComputedStyle(document.querySelector('.cm-content')).tabSize`
    )
    check('configured tab size reaches CodeMirror', String(tabSize) === '3', String(tabSize))

    await clickExpression(client, lineExpression('Fold Me', '.cm-heading-fold-arrow'))
    const clickedFold = await until(
      client,
      `${lineExpression('Fold Me')}?.classList.contains('cm-heading-line-folded') === true`,
      3000,
      60
    )
    check('clicking the heading arrow folds its section', !!clickedFold)
    await clickExpression(client, lineExpression('Fold Me', '.cm-heading-fold-arrow'))

    await clickExpression(client, lineExpression('Fold Me'))
    const foldShortcutFocus = await evaluate(
      client,
      `(() => ({
        active: document.querySelector('.cm-activeLine')?.textContent,
        focused: document.activeElement === document.querySelector('.cm-content')
      }))()`
    )
    check(
      'heading line owns the cursor before the fold shortcut',
      foldShortcutFocus?.active?.includes('Fold Me') && foldShortcutFocus.focused,
      JSON.stringify(foldShortcutFocus)
    )
    await press(client, 'f', {
      code: 'KeyF',
      ctrl: process.platform !== 'darwin',
      meta: process.platform === 'darwin',
      alt: true
    })
    const keyboardFold = await until(
      client,
      `${lineExpression('Fold Me')}?.classList.contains('cm-heading-line-folded') === true`,
      3000,
      60
    )
    check('configured fold shortcut folds the heading at the cursor', !!keyboardFold)
    await press(client, 'u', {
      code: 'KeyU',
      ctrl: process.platform !== 'darwin',
      meta: process.platform === 'darwin',
      alt: true
    })
    const keyboardUnfold = await until(
      client,
      `${lineExpression('Fold Me')}?.classList.contains('cm-heading-line-folded') !== true`,
      3000,
      60
    )
    check('configured unfold shortcut unfolds the heading at the cursor', !!keyboardUnfold)

    await clickExpression(client, lineExpression('Replacement target'))
    await press(client, 'End')
    await press(client, ' ', { code: 'Space' })
    await press(client, '-', { code: 'Minus' })
    await press(client, '>', { code: 'Period', shift: true })
    const replacementApplied = await until(
      client,
      `Array.from(document.querySelectorAll('.cm-line')).some((line) => (line.textContent ?? '').includes('Replacement target →'))`,
      3000,
      60
    )
    check('typing -> expands to → in the real editor', !!replacementApplied)

    const equationTags = await evaluate(
      client,
      `Array.from(document.querySelectorAll('.cm-math-block .katex-html .tag')).map((node) => (node.textContent ?? '').replace(/[\\s\\u200b]/g, ''))`
    )
    check(
      'live editor numbers equation environments in document order',
      JSON.stringify(equationTags) === JSON.stringify(['(1)', '(2)']),
      JSON.stringify(equationTags)
    )

    await clickExpression(client, lineExpression('Cursor marker position'))
    await press(client, 'End')
    // A caret that exists but has not been laid out yet reports a rect of all
    // zeros. Both samples wait for a real box: right after Edit mode rebuilds
    // the editor, the first poll could land in that gap and read left: 0.
    const cursorBefore = await until(
      client,
      `(() => {
        const line = document.querySelector('.cm-activeLine')
        const cursor = document.querySelector('.cm-cursor-primary, .cm-cursor')
        if (!line || !cursor) return null
        const rect = cursor.getBoundingClientRect()
        if (rect.height === 0) return null
        return { text: line.textContent, left: Math.round(rect.left) }
      })()`,
      5000,
      80
    )
    await pressMod(client, '6', 'Digit6')
    const previewReady = await until(
      client,
      `document.querySelector('.prose-zen, [data-preview-root]') != null`,
      5000,
      80
    )
    check('Preview mode opens', !!previewReady)
    const previewTags = await evaluate(
      client,
      `Array.from(document.querySelectorAll('.prose-zen .katex-html .tag')).map((node) => (node.textContent ?? '').replace(/[\\s\\u200b]/g, ''))`
    )
    check(
      'Preview uses the same equation numbering',
      JSON.stringify(previewTags) === JSON.stringify(['(1)', '(2)']),
      JSON.stringify(previewTags)
    )
    await pressMod(client, '4', 'Digit4')
    const cursorAfter = await until(
      client,
      `(() => {
        const line = document.querySelector('.cm-activeLine')
        const cursor = document.querySelector('.cm-cursor-primary, .cm-cursor')
        if (!line || !cursor || !(line.textContent ?? '').includes('Cursor marker position')) return null
        const rect = cursor.getBoundingClientRect()
        if (rect.height === 0) return null
        return { text: line.textContent, left: Math.round(rect.left) }
      })()`,
      5000,
      80
    )
    check(
      'cursor position survives Preview and Edit mode switches',
      !!cursorBefore && !!cursorAfter && cursorBefore.text === cursorAfter.text && Math.abs(cursorBefore.left - cursorAfter.left) <= 1,
      JSON.stringify({ cursorBefore, cursorAfter })
    )

    const secondReady = await openNote(client, secondPath, 'Second Note')
    check('second note opens', secondReady)
    await press(client, 'Tab', { code: 'Tab', ctrl: true })
    const toggledFirst = await until(
      client,
      `Array.from(document.querySelectorAll('.cm-line')).some((line) => (line.textContent ?? '').includes('Runtime Heading'))`,
      5000,
      80
    )
    check('Ctrl+Tab switches to the most recently used note', !!toggledFirst)
    await press(client, 'Tab', { code: 'Tab', ctrl: true })
    const toggledSecond = await until(
      client,
      `Array.from(document.querySelectorAll('.cm-line')).some((line) => (line.textContent ?? '').includes('Second Note'))`,
      5000,
      80
    )
    check('pressing Ctrl+Tab again alternates back', !!toggledSecond)

    await pressMod(client, ',', 'Comma')
    const settingsReady = await until(
      client,
      `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Editor')`,
      5000,
      80
    )
    check('Settings opens in the Electron app', !!settingsReady)
    await clickExpression(
      client,
      `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Editor')`
    )
    const replacementsTabReady = await until(
      client,
      `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Text replacements')`,
      3000,
      60
    )
    if (replacementsTabReady) {
      await clickExpression(
        client,
        `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Text replacements')`
      )
    }
    const settingsRule = await until(
      client,
      `(() => {
        const trigger = document.querySelector('input[aria-label="Text to replace"]')
        const replacement = document.querySelector('input[aria-label="Replacement text"]')
        return trigger?.value === '->' && replacement?.value === '→'
      })()`,
      3000,
      60
    )
    check('Text replacements tab exposes the configured rule', !!settingsRule)

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
    console.log('All editor improvement checks passed.')
    return
  }
  throw new Error(`${failures.length} editor improvement check(s) failed: ${failures.join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
