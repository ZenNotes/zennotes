#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const runs = parsePositiveInt(process.env.ZEN_PERF_RUNS, 3)
const target = process.env.ZEN_PERF_REPEAT_TARGET ?? 'both'
const warmCacheRepeat = process.env.ZEN_PERF_REPEAT_WARM_CACHE === '1'
const enforceRepeatBudgets =
  process.env.ZEN_PERF_REPEAT_ENFORCE === '1' || process.env.ZEN_PERF_ENFORCE === '1'

const targets =
  target === 'web'
    ? ['web']
    : target === 'desktop'
      ? ['desktop']
      : target === 'both'
        ? ['web', 'desktop']
        : []

if (targets.length === 0) {
  console.error('ZEN_PERF_REPEAT_TARGET must be web, desktop, or both')
  process.exit(1)
}

const metricNames = {
  web: [
    'cpu throttle rate',
    'large note lines',
    'large note index',
    'workspace ready sample',
    'store init sample',
    'refresh notes fetch',
    'refresh notes apply',
    'inbox expansion wall',
    'folder expansion total',
    'folder expansion coverage',
    'folder expansion count',
    'note open sample',
    'note open wall',
    'editor ready wall',
    'search input wall',
    'virtual scroll wall',
    'visible rows after scroll',
    'sidebar rows after scroll',
    'notelist rows after scroll',
    'long tasks count',
    'long tasks max',
    'long tasks p95',
    'js heap used',
    'js heap total',
    'dom nodes',
    'documents',
    'event listeners',
    'metadata cache wait'
  ],
  desktop: [
    'cpu throttle rate',
    'large note lines',
    'large note index',
    'main ready-to-show',
    'main did-finish-load',
    'main list notes',
    'renderer workspace ready',
    'store init sample',
    'refresh notes fetch',
    'refresh notes apply',
    'inbox expansion wall',
    'folder expansion total',
    'folder expansion coverage',
    'folder expansion count',
    'note open sample',
    'note open wall',
    'editor ready wall',
    'search input wall',
    'virtual scroll wall',
    'visible rows after scroll',
    'sidebar rows after scroll',
    'notelist rows after scroll',
    'long tasks count',
    'long tasks max',
    'long tasks p95',
    'js heap used',
    'js heap total',
    'dom nodes',
    'documents',
    'event listeners',
    'metadata cache wait'
  ]
}

const repeatBudgets = {
  web: [
    {
      label: 'workspace ready sample',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_READY_MS, 1800)
    },
    {
      label: 'note open wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_OPEN_WALL_MS, 180)
    },
    {
      label: 'editor ready wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_EDITOR_READY_WALL_MS, 700)
    },
    {
      label: 'search input wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SEARCH_MS, 120)
    },
    {
      label: 'virtual scroll wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SCROLL_MS, 80)
    },
    {
      label: 'visible rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_VISIBLE_ROWS, 640)
    },
    {
      label: 'sidebar rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_SIDEBAR_ROWS, 480)
    },
    {
      label: 'notelist rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_NOTELIST_ROWS, 160)
    },
    {
      label: 'long tasks max',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_LONG_TASK_MS, 180)
    },
    {
      label: 'js heap used',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_HEAP_MB, 256)
    },
    {
      label: 'dom nodes',
      budget: parsePositiveInt(process.env.ZEN_PERF_WEB_BUDGET_DOM_NODES, 12000)
    }
  ],
  desktop: [
    {
      label: 'main ready-to-show',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_MAIN_READY_MS, 1800)
    },
    {
      label: 'main list notes',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_LIST_NOTES_MS, 900)
    },
    {
      label: 'renderer workspace ready',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_READY_MS, 1800)
    },
    {
      label: 'note open wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_OPEN_WALL_MS, 180)
    },
    {
      label: 'editor ready wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_EDITOR_READY_WALL_MS, 700)
    },
    {
      label: 'search input wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_SEARCH_MS, 120)
    },
    {
      label: 'virtual scroll wall',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_SCROLL_MS, 80)
    },
    {
      label: 'visible rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_VISIBLE_ROWS, 960)
    },
    {
      label: 'sidebar rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_SIDEBAR_ROWS, 640)
    },
    {
      label: 'notelist rows after scroll',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_NOTELIST_ROWS, 160)
    },
    {
      label: 'long tasks max',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_LONG_TASK_MS, 180)
    },
    {
      label: 'js heap used',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_HEAP_MB, 320)
    },
    {
      label: 'dom nodes',
      budget: parsePositiveInt(process.env.ZEN_PERF_DESKTOP_BUDGET_DOM_NODES, 14000)
    }
  ]
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

function parseMetrics(output, names) {
  const metrics = new Map()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+([0-9]+(?:\.[0-9]+)?)(?:ms|MB)?$/.exec(line.trim())
    if (!match) continue
    const label = match[1].trim()
    if (!names.includes(label)) continue
    metrics.set(label, Number.parseFloat(match[2]))
  }
  return metrics
}

function metricValues(samples, name) {
  return samples
    .map((sample) => sample.get(name))
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
}

function targetEnvPrefix(targetName) {
  return targetName === 'web' ? 'WEB' : 'DESKTOP'
}

function runBenchmark(targetName, runIndex, warmTempRoot) {
  const script = targetName === 'web' ? 'perf:web-runtime' : 'perf:desktop-runtime'
  const env = { ...process.env }
  if (runIndex > 0) {
    if (targetName === 'web') env.ZEN_PERF_SKIP_WEB_BUILD = '1'
    else env.ZEN_PERF_SKIP_DESKTOP_BUILD = '1'
  }
  if (warmTempRoot) {
    const prefix = targetEnvPrefix(targetName)
    env[`ZEN_PERF_${prefix}_TEMP_ROOT`] = warmTempRoot
    if (runIndex > 0) env[`ZEN_PERF_${prefix}_SKIP_SEED`] = '1'
  }

  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ['run', script], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      output += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      output += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(parseMetrics(output, metricNames[targetName]))
        return
      }
      reject(new Error(`${script} run ${runIndex + 1} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function printSummary(targetName, samples) {
  const names = metricNames[targetName]
  const failures = []
  console.log(`\nZenNotes ${targetName} runtime repeat summary`)
  console.log(`runs                              ${String(samples.length).padStart(8)}`)
  console.log('metric                              p50       p95       max       min')
  for (const name of names) {
    const values = metricValues(samples, name)
    if (values.length === 0) continue
    const p50 = round(percentile(values, 50))
    const p95 = round(percentile(values, 95))
    const max = round(Math.max(...values))
    const min = round(Math.min(...values))
    console.log(
      `${name.padEnd(32)} ${String(p50).padStart(8)} ${String(p95).padStart(9)} ${String(max).padStart(9)} ${String(min).padStart(9)}`
    )
  }
  for (const { label, budget } of repeatBudgets[targetName]) {
    const values = metricValues(samples, label)
    if (values.length === 0) {
      failures.push({ label, actual: 'missing', budget })
      continue
    }
    const p95 = round(percentile(values, 95))
    if (p95 > budget) failures.push({ label, actual: p95, budget })
  }
  if (failures.length > 0) {
    console.log('\nRepeat budget warnings')
    for (const failure of failures) {
      console.log(`- ${failure.label}: p95 ${failure.actual} > ${failure.budget}`)
    }
  }
  return failures
}

const allFailures = []
for (const targetName of targets) {
  const samples = []
  const warmTempRoot = warmCacheRepeat
    ? await mkdtemp(join(tmpdir(), `zennotes-${targetName}-warm-repeat-`))
    : null
  if (warmTempRoot) {
    console.log(`\nZenNotes ${targetName} warm-cache temp root ${warmTempRoot}`)
  }
  try {
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      console.log(`\nZenNotes ${targetName} runtime repeat ${runIndex + 1}/${runs}`)
      samples.push(await runBenchmark(targetName, runIndex, warmTempRoot))
    }
  } finally {
    if (warmTempRoot && process.env.ZEN_PERF_KEEP_TEMP_ROOT !== '1') {
      await rm(warmTempRoot, { recursive: true, force: true })
    }
  }
  allFailures.push(...printSummary(targetName, samples).map((failure) => ({ targetName, ...failure })))
}

if (enforceRepeatBudgets && allFailures.length > 0) {
  throw new Error('Repeat runtime benchmark exceeded enforced p95 budgets')
}
