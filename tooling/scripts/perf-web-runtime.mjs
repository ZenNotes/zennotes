import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

import { withGoEnv } from './go-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const serverRoot = resolve(repoRoot, 'apps/server')
const webDistIndex = resolve(repoRoot, 'apps/web/dist/index.html')
const syncWebDistScript = resolve(repoRoot, 'tooling/scripts/sync-web-dist.mjs')

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const noteCount = parsePositiveInt(process.env.ZEN_PERF_WEB_NOTES, 5000)
const enforceBudgets = process.env.ZEN_PERF_ENFORCE === '1'
const skipWebBuild = process.env.ZEN_PERF_SKIP_WEB_BUILD === '1'
const externalVaultRoot = externalVaultRootFromEnv('ZEN_PERF_WEB_VAULT_ROOT')
const configuredTempRoot = process.env.ZEN_PERF_WEB_TEMP_ROOT?.trim()
  ? resolve(process.env.ZEN_PERF_WEB_TEMP_ROOT.trim())
  : null
const keepTempRoot = process.env.ZEN_PERF_KEEP_TEMP_ROOT === '1' || configuredTempRoot !== null
const skipSyntheticSeed = process.env.ZEN_PERF_WEB_SKIP_SEED === '1'
const cpuThrottleRate = parsePositiveFloat(
  process.env.ZEN_PERF_WEB_CPU_THROTTLE_RATE ?? process.env.ZEN_PERF_CPU_THROTTLE_RATE,
  1
)
const largeNoteLines = parseNonNegativeInt(process.env.ZEN_PERF_LARGE_NOTE_LINES, 0)
const largeNoteIndex = parseNonNegativeInt(process.env.ZEN_PERF_LARGE_NOTE_INDEX, 159)
const configuredSearchQuery =
  process.env.ZEN_PERF_WEB_SEARCH_QUERY?.trim() || process.env.ZEN_PERF_SEARCH_QUERY?.trim() || null

const budgets = {
  workspaceReadyMs: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_READY_MS, 1800),
  noteOpenMs: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_OPEN_MS, 120),
  searchInputMs: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SEARCH_MS, 120),
  scrollMs: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SCROLL_MS, 80),
  maxLongTaskMs: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_LONG_TASK_MS, 180),
  maxVisibleRows: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_VISIBLE_ROWS, 640),
  maxSidebarRows: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SIDEBAR_ROWS, 480),
  maxNoteListRows: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_NOTELIST_ROWS, 160),
  maxHeapMB: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_HEAP_MB, 256),
  maxDomNodes: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_DOM_NODES, 12000)
}
const allowDeferredChunks = process.env.ZEN_PERF_ALLOW_DEFERRED_CHUNKS === '1'
const deferredNormalFlowChunkPatterns = [
  /^Preview-/,
  /^NoteHoverPreview-/,
  /^wardley-/,
  /^vendor-markdown-/,
  /^vendor-highlight-/,
  /^vendor-d3-/,
  /^vendor-mermaid-/,
  /^vendor-jsxgraph-/,
  /^vendor-function-plot-/
]

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveFloat(raw, fallback) {
  const parsed = Number.parseFloat(raw ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function externalVaultRootFromEnv(specificName) {
  const raw = process.env[specificName]?.trim() || process.env.ZEN_PERF_VAULT_ROOT?.trim()
  return raw ? resolve(raw) : null
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function waitForFile(path, timeoutMs) {
  const startedAt = performance.now()
  const deadline = startedAt + timeoutMs
  while (performance.now() < deadline) {
    if (await fileExists(path)) return round(performance.now() - startedAt)
    await sleep(50)
  }
  return null
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: options.stdio ?? 'inherit'
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
    child.on('error', rejectPromise)
  })
}

async function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolvePromise(address.port)
          return
        }
        rejectPromise(new Error('Could not allocate a TCP port'))
      })
    })
    server.on('error', rejectPromise)
  })
}

function httpGetJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) {
          rejectPromise(new Error(`${url} returned HTTP ${res.statusCode}: ${body}`))
          return
        }
        try {
          resolvePromise(JSON.parse(body))
        } catch (err) {
          rejectPromise(err)
        }
      })
    })
    req.on('error', rejectPromise)
    req.setTimeout(1000, () => {
      req.destroy(new Error(`Timed out requesting ${url}`))
    })
  })
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      await httpGetJson(url)
      return
    } catch (err) {
      lastError = err
      await sleep(100)
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`)
}

function formatIndex(index) {
  return String(index).padStart(5, '0')
}

function largeNoteBody(lines, id) {
  const blocks = []
  for (let line = 0; line < lines; line += 1) {
    const section = line % 40
    blocks.push(
      `- Large note ${id} line ${formatIndex(line)} section-${section}: ${'fast editor hydration '.repeat(6)}#large-note #section-${section}`
    )
  }
  return `\n## Large note stress section\n\n${blocks.join('\n')}\n`
}

async function writeFilesInBatches(files, batchSize = 96) {
  for (let index = 0; index < files.length; index += batchSize) {
    await Promise.all(files.slice(index, index + batchSize).map(([path, body]) => writeFile(path, body)))
  }
}

async function seedVault(vaultRoot, count) {
  const inbox = join(vaultRoot, 'inbox')
  const quick = join(vaultRoot, 'quick')
  const archive = join(vaultRoot, 'archive')
  const trash = join(vaultRoot, 'trash')
  await Promise.all([
    mkdir(inbox, { recursive: true }),
    mkdir(quick, { recursive: true }),
    mkdir(archive, { recursive: true }),
    mkdir(trash, { recursive: true })
  ])

  const files = []
  for (let index = 0; index < count; index += 1) {
    const id = formatIndex(index)
    const topic = index % 20
    const sprint = index % 13
    const title = `Perf Note ${id} Topic ${topic}`
    const body = `# ${title}

This is a synthetic runtime benchmark note for ZenNotes.
It contains searchable token runtime-benchmark-${id} and shared topic-${topic}.

## Details

- Index: ${index}
- Topic: ${topic}
- Sprint: ${sprint}
- Status: ${index % 3 === 0 ? 'active' : 'reference'}

The body is intentionally modest so note-open timing measures app overhead more than disk throughput.

#perf #topic-${topic} #sprint-${sprint}
${largeNoteLines > 0 && index === Math.min(count - 1, largeNoteIndex) ? largeNoteBody(largeNoteLines, id) : ''}`
    files.push([join(inbox, `${id} - topic-${topic}.md`), body])
  }
  await writeFilesInBatches(files)
}

function appendBounded(buffer, chunk, maxLength = 12000) {
  const next = `${buffer}${chunk}`
  return next.length > maxLength ? next.slice(next.length - maxLength) : next
}

function startGoServer({ vaultRoot, bind, serverBinary, configPath, disablePersistedMetaCache }) {
  const env = {
    ...process.env,
    ZENNOTES_BIND: bind,
    ZENNOTES_CONFIG_PATH: configPath,
    ZENNOTES_VAULT_PATH: vaultRoot,
    ZENNOTES_ALLOW_INSECURE_NOAUTH: '1',
    ...(disablePersistedMetaCache ? { ZEN_PERF_DISABLE_PERSISTED_META_CACHE: '1' } : {})
  }
  const child = spawn(serverBinary, [], {
    cwd: serverRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (chunk) => {
    log = appendBounded(log, chunk)
  })
  child.stderr.on('data', (chunk) => {
    log = appendBounded(log, chunk)
  })
  return {
    child,
    log: () => log
  }
}

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    process.platform === 'darwin' ? '/Applications/Chromium.app/Contents/MacOS/Chromium' : null,
    process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : null,
    process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      : null,
    'google-chrome',
    'chromium',
    'chromium-browser'
  ].filter(Boolean)

  return candidates[0]
}

function startChrome({ debugPort, userDataDir }) {
  const chromePath = findChromePath()
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-sync',
      '--js-flags=--expose-gc',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
      'about:blank'
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let log = ''
  child.stdout.on('data', (chunk) => {
    log = appendBounded(log, chunk)
  })
  child.stderr.on('data', (chunk) => {
    log = appendBounded(log, chunk)
  })
  return {
    child,
    log: () => log
  }
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  connect() {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket = new WebSocket(this.webSocketUrl)
      this.socket.on('open', resolvePromise)
      this.socket.on('error', rejectPromise)
      this.socket.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        if (message.id && this.pending.has(message.id)) {
          const { resolve: resolvePending, reject } = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) reject(new Error(message.error.message))
          else resolvePending(message.result ?? {})
          return
        }
        if (message.method) {
          const listeners = this.listeners.get(message.method) ?? []
          for (const listener of listeners) listener(message.params ?? {})
        }
      })
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
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

  waitFor(method, timeoutMs = 10000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for CDP event ${method}`))
      }, timeoutMs)
      this.on(method, (params) => {
        clearTimeout(timer)
        resolvePromise(params)
      })
    })
  }

  close() {
    this.socket?.terminate?.()
    this.socket?.close()
  }
}

async function connectToPage(debugPort) {
  const deadline = Date.now() + 10000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${debugPort}/json/list`)
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) {
        const client = new CdpClient(page.webSocketDebuggerUrl)
        await client.connect()
        return client
      }
    } catch (err) {
      lastError = err
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for Chrome CDP page: ${lastError?.message ?? 'unknown error'}`)
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(text)
  }
  return result.result?.value
}

async function waitForExpression(client, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(client, expression)
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message ?? 'condition not met'}`)
}

async function prepareWebDist() {
  if (!skipWebBuild || !(await fileExists(webDistIndex))) {
    await run(npmCommand, ['run', 'build:nocheck', '--workspace', '@zennotes/web'], {
      shell: process.platform === 'win32'
    })
  }
  await run(process.execPath, [syncWebDistScript])
}

async function buildGoServer(outputPath) {
  await run('go', ['build', '-trimpath', '-o', outputPath, './cmd/zennotes-server'], {
    cwd: serverRoot,
    env: withGoEnv()
  })
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function round(value) {
  return Math.round(value * 100) / 100
}

function summarizeLongTasks(longTasks) {
  const durations = longTasks.map((task) => task.duration)
  return {
    count: longTasks.length,
    maxMs: round(Math.max(0, ...durations)),
    p95Ms: round(percentile(durations, 95))
  }
}

function sampleWindow(sample, timeOrigin) {
  if (!sample || typeof sample.at !== 'number' || typeof sample.durationMs !== 'number') {
    return null
  }
  const end = sample.at > 1_000_000_000_000 ? sample.at - timeOrigin : sample.at
  return {
    name: sample.name,
    start: end - sample.durationMs,
    end,
    durationMs: sample.durationMs
  }
}

function nearestSampleForLongTask(task, samples, timeOrigin) {
  const taskStart = task.startTime
  const taskEnd = task.startTime + task.duration
  let best = null
  for (const sample of samples) {
    const window = sampleWindow(sample, timeOrigin)
    if (!window) continue
    const overlap = Math.min(taskEnd, window.end) - Math.max(taskStart, window.start)
    const distance =
      overlap >= 0
        ? -overlap
        : Math.min(Math.abs(taskStart - window.end), Math.abs(taskEnd - window.start))
    if (!best || distance < best.distance) {
      best = { distance, sample: window }
    }
  }
  return best?.sample ?? null
}

function topLongTasks(longTasks, samples, timeOrigin, limit = 6) {
  return [...longTasks]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit)
    .map((task) => ({
      startTime: task.startTime,
      duration: task.duration,
      sample: nearestSampleForLongTask(task, samples, timeOrigin)
    }))
}

function performanceMetricValue(result, name) {
  const metric = result.metrics?.find((entry) => entry.name === name)
  return typeof metric?.value === 'number' ? metric.value : 0
}

function summarizePerformanceMetrics(result) {
  return {
    jsHeapUsedMB: round(performanceMetricValue(result, 'JSHeapUsedSize') / (1024 * 1024)),
    jsHeapTotalMB: round(performanceMetricValue(result, 'JSHeapTotalSize') / (1024 * 1024)),
    domNodes: Math.round(performanceMetricValue(result, 'Nodes')),
    documents: Math.round(performanceMetricValue(result, 'Documents')),
    eventListeners: Math.round(performanceMetricValue(result, 'JSEventListeners'))
  }
}

function scriptNameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const name = url.pathname.split('/').pop() ?? ''
    return name.endsWith('.js') ? name : null
  } catch {
    const name = String(rawUrl).split('?')[0].split('/').pop() ?? ''
    return name.endsWith('.js') ? name : null
  }
}

function budgetStatus(label, actual, budget, comparator = (a, b) => a <= b) {
  const ok = comparator(actual, budget)
  return {
    label,
    actual,
    budget,
    ok
  }
}

function findDeferredNormalFlowChunks(scripts) {
  return scripts.filter((script) =>
    deferredNormalFlowChunkPatterns.some((pattern) => pattern.test(script))
  )
}

function printMetric(label, value, suffix = 'ms') {
  console.log(`${label.padEnd(34)} ${String(value).padStart(8)}${suffix}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    sleep(1000).then(() => false)
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
      sleep(1000)
    ])
  }
}

async function main() {
  await prepareWebDist()

  const tempRoot = configuredTempRoot ?? await mkdtemp(join(tmpdir(), 'zennotes-web-perf-'))
  if (configuredTempRoot) await mkdir(tempRoot, { recursive: true })
  const vaultRoot = externalVaultRoot ?? join(tempRoot, 'vault')
  const chromeProfile = join(tempRoot, 'chrome-profile')
  const serverBinary = join(
    tempRoot,
    process.platform === 'win32' ? 'zennotes-server.exe' : 'zennotes-server'
  )
  if (externalVaultRoot) await access(vaultRoot, constants.R_OK)
  else await mkdir(vaultRoot, { recursive: true })
  await mkdir(chromeProfile, { recursive: true })

  const serverPort = await getFreePort()
  const debugPort = await getFreePort()
  let server = null
  let chrome = null
  let client = null

  try {
    const seedStartedAt = performance.now()
    if (!externalVaultRoot) {
      if (skipSyntheticSeed) await access(vaultRoot, constants.R_OK)
      else await seedVault(vaultRoot, noteCount)
    }
    const seedMs = round(performance.now() - seedStartedAt)

    await buildGoServer(serverBinary)
    server = startGoServer({
      vaultRoot,
      bind: `127.0.0.1:${serverPort}`,
      serverBinary,
      configPath: join(tempRoot, 'zennotes-perf-server.json'),
      disablePersistedMetaCache: Boolean(externalVaultRoot)
    })
    await waitForHttpOk(`http://127.0.0.1:${serverPort}/healthz`, 20000)
    chrome = startChrome({ debugPort, userDataDir: chromeProfile })
    client = await connectToPage(debugPort)

    const consoleMessages = []
    const networkScripts = []
    client.on('Runtime.consoleAPICalled', (event) => {
      const text = event.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ') ?? ''
      if (event.type === 'error' || text.includes('[zen:perf]')) {
        consoleMessages.push({ type: event.type, text })
      }
    })
    client.on('Network.requestWillBeSent', (event) => {
      const script = scriptNameFromUrl(event.request?.url ?? '')
      if (script) networkScripts.push(script)
    })

    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Network.enable'),
      client.send('Performance.enable')
    ])
    if (cpuThrottleRate !== 1) {
      await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottleRate })
    }
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          try { window.localStorage.setItem('zen:perf', '1') } catch {}
          window.__ZEN_RUNTIME_PERF__ = { longTasks: [] };
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__ZEN_RUNTIME_PERF__.longTasks.push({
                  name: entry.name,
                  startTime: Math.round(entry.startTime * 100) / 100,
                  duration: Math.round(entry.duration * 100) / 100
                });
              }
            }).observe({ type: 'longtask', buffered: true });
          } catch {}
        })();
      `
    })

    const appUrl = `http://127.0.0.1:${serverPort}/`
    const loadEvent = client.waitFor('Page.loadEventFired', 20000)
    await client.send('Page.navigate', { url: appUrl })
    await loadEvent

    const startup = await waitForExpression(
      client,
      `(() => {
        const rowCounts = () => {
          const noteListRows = document.querySelectorAll('[data-notelist-path]').length;
          const sidebarRows = document.querySelectorAll('[data-sidebar-type="note"]').length;
          return { noteListRows, sidebarRows, totalRows: noteListRows + sidebarRows };
        };
        const samples = window.__ZEN_PERF__?.getSamples?.() ?? [];
        const ready = samples.find((sample) => sample.name === 'renderer.workspace.ready');
        if (!ready) return null;
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource')
          .filter((entry) => entry.name.endsWith('.js'))
          .map((entry) => entry.name.split('/').pop());
        return {
          ready,
          appMounted: samples.find((sample) => sample.name === 'renderer.app.mounted') ?? null,
          storeInit: samples.find((sample) => sample.name === 'store.init') ?? null,
          refreshFetch: samples.find((sample) => sample.name === 'store.refreshNotes.fetch') ?? null,
          refreshApply: samples.find((sample) => sample.name === 'store.refreshNotes.apply') ?? null,
          workspaceRestore: samples.find((sample) => sample.name.startsWith('workspace.restore')) ?? null,
          rowCounts: rowCounts(),
          nav: nav ? {
            responseStart: Math.round(nav.responseStart * 100) / 100,
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd * 100) / 100,
            loadEventEnd: Math.round(nav.loadEventEnd * 100) / 100
          } : null,
          resources
        };
      })()`,
      20000,
      'workspace ready'
    )

    const inboxExpansion = await evaluate(
      client,
      `(async () => {
        const targetSidebarRows = ${externalVaultRoot ? 20 : 1};
        const rowCounts = () => {
          const noteListRows = document.querySelectorAll('[data-notelist-path]').length;
          const sidebarRows = document.querySelectorAll('[data-sidebar-type="note"]').length;
          return { noteListRows, sidebarRows, totalRows: noteListRows + sidebarRows };
        };
        const waitForRender = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const existingRows = rowCounts();
        if (existingRows.sidebarRows >= targetSidebarRows) {
          return { wallMs: 0, visibleRows: existingRows.sidebarRows, rows: existingRows, expandedAlready: true };
        }
        const startedAt = performance.now();
        const clickedFolders = new Set();
        const clickCollapsedFolder = (selector) => {
          const folders = [...document.querySelectorAll(selector)]
            .filter((folder) => folder.getAttribute('data-sidebar-collapsed') === 'true');
          const folder = folders.find((candidate) => {
            const key = candidate.getAttribute('data-sidebar-key') ?? candidate.textContent ?? '';
            return !clickedFolders.has(key);
          });
          if (!folder) return false;
          const key = folder.getAttribute('data-sidebar-key') ?? folder.textContent ?? '';
          clickedFolders.add(key);
          folder.click();
          return true;
        };
        const expandCollapsedFolder = async (selector) => {
          const expansionStartedAt = performance.now();
          if (!clickCollapsedFolder(selector)) return null;
          await waitForRender();
          return Math.round((performance.now() - expansionStartedAt) * 100) / 100;
        };

        let expandedFolders = 0;
        let totalWallMs = 0;
        let maxWallMs = 0;
        const recordExpansion = (wallMs) => {
          if (wallMs == null) return false;
          expandedFolders += 1;
          totalWallMs += wallMs;
          maxWallMs = Math.max(maxWallMs, wallMs);
          return true;
        };

        recordExpansion(await expandCollapsedFolder('[data-sidebar-type="folder"][data-sidebar-folder="inbox"][data-sidebar-subpath=""]'));

        let rows = rowCounts();
        while (rows.sidebarRows < targetSidebarRows && expandedFolders < 80) {
          const expanded = recordExpansion(
            await expandCollapsedFolder('[data-sidebar-type="folder"][data-sidebar-expandable="true"]')
          );
          if (!expanded) break;
          rows = rowCounts();
        }

        return {
          wallMs: maxWallMs,
          totalWallMs: Math.round(totalWallMs * 100) / 100,
          coverageWallMs: Math.round((performance.now() - startedAt) * 100) / 100,
          visibleRows: rows.sidebarRows,
          rows,
          expandedAlready: false,
          expandedFolders
        };
      })()`
    )

    const noteOpen = await evaluate(
      client,
      `(async () => {
        window.__ZEN_PERF__?.clear?.();
        const rows = [...document.querySelectorAll('[data-notelist-path]')];
        if (rows.length === 0) rows.push(...document.querySelectorAll('[data-sidebar-type="note"]'));
        const row = rows.length > 1 ? rows[rows.length - 1] : rows[0];
        if (!row) throw new Error('No note row was rendered');
        const path = row.getAttribute('data-notelist-path') ?? row.getAttribute('data-sidebar-path');
        const source = row.hasAttribute('data-notelist-path') ? 'notelist' : 'sidebar';
        const startedAt = performance.now();
        row.click();
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          const samples = window.__ZEN_PERF__?.getSamples?.() ?? [];
          const sample = [...samples].reverse().find((item) => item.name.startsWith('note.open.'));
          if (sample) {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const wallMs = Math.round((performance.now() - startedAt) * 100) / 100;
            let editorReadyWallMs = null;
            const editorDeadline = performance.now() + 2500;
            while (performance.now() < editorDeadline) {
              const readySamples = window.__ZEN_PERF__?.getSamples?.() ?? [];
              const editorReadySample = [...readySamples].reverse().find((item) =>
                item.name === 'editor.mount.view' || item.name === 'editor.doc.sync'
              );
              if (editorReadySample || document.querySelector('.cm-editor')) {
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                editorReadyWallMs = Math.round((performance.now() - startedAt) * 100) / 100;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const openSamples = (window.__ZEN_PERF__?.getSamples?.() ?? [])
              .filter((item) =>
                item.name.startsWith('note.open.') ||
                item.name.startsWith('editor.doc.') ||
                item.name.startsWith('editor.mount.')
              );
            return {
              path,
              source,
              wallMs,
              editorReadyWallMs,
              sample,
              samples: openSamples
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Timed out waiting for note.open perf sample');
      })()`
    )

    const searchQuery =
      configuredSearchQuery ??
      (externalVaultRoot
        ? basename(noteOpen.path, extname(noteOpen.path))
        : 'runtime-benchmark-04999')
    const search = await evaluate(
      client,
      `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'p',
          code: 'KeyP',
          metaKey: true,
          bubbles: true,
          cancelable: true
        }));
        const deadline = performance.now() + 3000;
        let input = null;
        while (performance.now() < deadline) {
          input = document.querySelector('input[placeholder^="Search notes"]');
          if (input) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!input) throw new Error('Search input did not open');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const startedAt = performance.now();
        const query = ${JSON.stringify(searchQuery)};
        setValue.call(input, query);
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: query,
          inputType: 'insertText'
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const results = [...document.querySelectorAll('[data-search-idx]')];
        return {
          wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
          resultCount: results.length,
          firstResult: results[0]?.textContent?.trim() ?? null
        };
      })()`
    )

    const scroll = await evaluate(
      client,
      `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rowCounts = () => {
          const noteListRows = document.querySelectorAll('[data-notelist-path]').length;
          const sidebarRows = document.querySelectorAll('[data-sidebar-type="note"]').length;
          return { noteListRows, sidebarRows, totalRows: noteListRows + sidebarRows };
        };
        const row = document.querySelector('[data-notelist-path]') ?? document.querySelector('[data-sidebar-type="note"]');
        let scroller = row?.parentElement ?? null;
        const scrollerKind = row?.hasAttribute('data-notelist-path') ? 'notelist' : 'sidebar';
        while (scroller && getComputedStyle(scroller).overflowY !== 'auto') {
          scroller = scroller.parentElement;
        }
        if (!scroller) throw new Error('Could not find note list scroller');
        const startedAt = performance.now();
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rows = rowCounts();
        return {
          wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
          visibleRows: rows.totalRows,
          sidebarRows: rows.sidebarRows,
          noteListRows: rows.noteListRows,
          scrollerKind,
          scrollTop: Math.round(scroller.scrollTop),
          scrollHeight: Math.round(scroller.scrollHeight)
        };
      })()`
    )

    const finalSnapshot = await evaluate(
      client,
      `(() => {
        const longTasks = window.__ZEN_RUNTIME_PERF__?.longTasks ?? [];
        const samples = window.__ZEN_PERF__?.getSamples?.() ?? [];
        const scripts = performance.getEntriesByType('resource')
          .filter((entry) => entry.name.endsWith('.js'))
          .map((entry) => entry.name.split('/').pop());
        return {
          longTasks,
          samples,
          timeOrigin: performance.timeOrigin,
          scripts: [...new Set(scripts)]
        };
      })()`
    )
    await evaluate(client, `(() => { globalThis.gc?.(); globalThis.gc?.(); return true })()`)
    const runtimeMetrics = summarizePerformanceMetrics(await client.send('Performance.getMetrics'))

    const longTaskSummary = summarizeLongTasks(finalSnapshot.longTasks)
    const loadedScripts = [...new Set([...finalSnapshot.scripts, ...networkScripts])]
    const deferredNormalFlowChunks = findDeferredNormalFlowChunks(loadedScripts)
    const statuses = [
      budgetStatus('workspace ready', startup.ready.durationMs, budgets.workspaceReadyMs),
      budgetStatus('inbox expansion', inboxExpansion.wallMs, budgets.scrollMs),
      budgetStatus('note open sample', noteOpen.sample.durationMs, budgets.noteOpenMs),
      budgetStatus('search input', search.wallMs, budgets.searchInputMs),
      budgetStatus('virtual scroll', scroll.wallMs, budgets.scrollMs),
      budgetStatus('max long task', longTaskSummary.maxMs, budgets.maxLongTaskMs),
      budgetStatus('visible note rows', scroll.visibleRows, budgets.maxVisibleRows),
      budgetStatus('sidebar note rows', scroll.sidebarRows, budgets.maxSidebarRows),
      budgetStatus('notelist note rows', scroll.noteListRows, budgets.maxNoteListRows),
      budgetStatus('js heap used', runtimeMetrics.jsHeapUsedMB, budgets.maxHeapMB),
      budgetStatus('dom nodes', runtimeMetrics.domNodes, budgets.maxDomNodes)
    ]

    console.log('\nZenNotes web runtime performance')
    console.log(`notes                              ${String(externalVaultRoot ? 'external' : noteCount).padStart(8)}`)
    if (externalVaultRoot) console.log(`vault                              ${vaultRoot}`)
    printMetric('cpu throttle rate', cpuThrottleRate, '')
    printMetric('large note lines', largeNoteLines, '')
    printMetric('large note index', largeNoteLines > 0 ? Math.min(noteCount - 1, largeNoteIndex) : 0, '')
    printMetric('search query length', searchQuery.length, '')
    printMetric('seed vault', seedMs)
    printMetric('workspace ready sample', startup.ready.durationMs)
    printMetric('app mounted sample', startup.appMounted?.durationMs ?? 0)
    printMetric('store init sample', startup.storeInit?.durationMs ?? 0)
    printMetric('refresh notes fetch', startup.refreshFetch?.durationMs ?? 0)
    printMetric('refresh notes apply', startup.refreshApply?.durationMs ?? 0)
    printMetric('workspace restore sample', startup.workspaceRestore?.durationMs ?? 0)
    printMetric('navigation DCL', startup.nav?.domContentLoaded ?? 0)
    printMetric('navigation load', startup.nav?.loadEventEnd ?? 0)
    printMetric('visible rows at ready', startup.rowCounts?.totalRows ?? 0, '')
    printMetric('sidebar rows at ready', startup.rowCounts?.sidebarRows ?? 0, '')
    printMetric('notelist rows at ready', startup.rowCounts?.noteListRows ?? 0, '')
    printMetric('inbox expansion wall', inboxExpansion.wallMs)
    printMetric('folder expansion total', inboxExpansion.totalWallMs ?? inboxExpansion.wallMs)
    printMetric('folder expansion coverage', inboxExpansion.coverageWallMs ?? inboxExpansion.wallMs)
    printMetric('folder expansion count', inboxExpansion.expandedFolders ?? 0, '')
    printMetric('inbox expanded rows', inboxExpansion.visibleRows, '')
    printMetric('inbox sidebar rows', inboxExpansion.rows?.sidebarRows ?? inboxExpansion.visibleRows, '')
    printMetric('inbox notelist rows', inboxExpansion.rows?.noteListRows ?? 0, '')
    printMetric('note open sample', noteOpen.sample.durationMs)
    printMetric('note open wall', noteOpen.wallMs)
    printMetric('editor ready wall', noteOpen.editorReadyWallMs ?? 0)
    if (Array.isArray(noteOpen.samples) && noteOpen.samples.length > 0) {
      console.log('\nNote open renderer samples')
      for (const sample of noteOpen.samples) {
        printMetric(sample.name, sample.durationMs)
      }
    }
    printMetric('search input wall', search.wallMs)
    printMetric('search results', search.resultCount, '')
    printMetric('virtual scroll wall', scroll.wallMs)
    console.log(`${'virtual scroll target'.padEnd(34)} ${String(scroll.scrollerKind).padStart(8)}`)
    printMetric('visible rows after scroll', scroll.visibleRows, '')
    printMetric('sidebar rows after scroll', scroll.sidebarRows, '')
    printMetric('notelist rows after scroll', scroll.noteListRows, '')
    printMetric('long tasks count', longTaskSummary.count, '')
    printMetric('long tasks max', longTaskSummary.maxMs)
    printMetric('long tasks p95', longTaskSummary.p95Ms)
    const slowLongTasks = topLongTasks(
      finalSnapshot.longTasks,
      finalSnapshot.samples,
      finalSnapshot.timeOrigin
    )
    if (slowLongTasks.length > 0) {
      console.log('\nTop long tasks')
      for (const task of slowLongTasks) {
        const sample = task.sample
        const sampleLabel = sample
          ? `${sample.name} (${round(sample.durationMs)}ms @ ${round(sample.start)}-${round(sample.end)}ms)`
          : 'unmatched'
        console.log(
          `- start ${round(task.startTime)}ms, duration ${round(task.duration)}ms, nearest ${sampleLabel}`
        )
      }
    }
    printMetric('js heap used', runtimeMetrics.jsHeapUsedMB, 'MB')
    printMetric('js heap total', runtimeMetrics.jsHeapTotalMB, 'MB')
    printMetric('dom nodes', runtimeMetrics.domNodes, '')
    printMetric('documents', runtimeMetrics.documents, '')
    printMetric('event listeners', runtimeMetrics.eventListeners, '')

    console.log('\nLoaded JS chunks')
    for (const script of loadedScripts) {
      console.log(`- ${script}`)
    }

    if (deferredNormalFlowChunks.length > 0) {
      console.log('\nDeferred chunks loaded during normal flow')
      for (const script of deferredNormalFlowChunks) {
        console.log(`- ${script}`)
      }
    }

    const failed = statuses.filter((status) => !status.ok)
    if (failed.length > 0) {
      console.log('\nBudget warnings')
      for (const status of failed) {
        console.log(`- ${status.label}: ${status.actual} > ${status.budget}`)
      }
    }

    const errors = consoleMessages.filter((message) => message.type === 'error')
    if (errors.length > 0) {
      console.log('\nConsole errors')
      for (const message of errors.slice(0, 10)) {
        console.log(`- ${message.text}`)
      }
    }

    if (search.resultCount === 0) {
      throw new Error('Search benchmark returned zero results')
    }
    if (errors.length > 0) {
      throw new Error('Runtime benchmark saw console errors')
    }
    if (!allowDeferredChunks && deferredNormalFlowChunks.length > 0) {
      throw new Error('Runtime benchmark loaded deferred-heavy chunks during normal flow')
    }
    if (enforceBudgets && failed.length > 0) {
      throw new Error('Runtime benchmark exceeded enforced budgets')
    }
    if (!externalVaultRoot && keepTempRoot) {
      const cacheWaitMs = await waitForFile(join(vaultRoot, '.zennotes', 'note-meta-cache-v1.json'), 2500)
      if (cacheWaitMs == null) {
        console.log('metadata cache wait                 missing')
      } else {
        printMetric('metadata cache wait', cacheWaitMs)
      }
    }
  } finally {
    client?.close()
    await stopChild(chrome?.child)
    await stopChild(server?.child)
    if (keepTempRoot) {
      console.log(`kept temp root                     ${tempRoot}`)
    } else {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
