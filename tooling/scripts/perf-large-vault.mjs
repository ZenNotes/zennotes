#!/usr/bin/env node
import { spawn } from 'node:child_process'

const benches = [
  {
    workspace: '@zennotes/app-core',
    spec: 'src/lib/app-core.perf.test.ts'
  },
  {
    workspace: '@zennotes/desktop',
    spec: 'src/main/vault.perf.test.ts'
  }
]

function runBench({ workspace, spec }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['run', 'test:run', '--workspace', workspace, '--', spec],
      {
        env: { ...process.env, ZEN_PERF_BENCH: '1' },
        stdio: 'inherit',
        shell: process.platform === 'win32'
      }
    )
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${workspace} ${spec} exited with code ${code ?? 'unknown'}`))
    })
  })
}

for (const bench of benches) {
  await runBench(bench)
}
