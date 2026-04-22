import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { withGoEnv } from './go-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const serverRoot = resolve(repoRoot, 'apps/server')

const child = spawn('go', ['run', './cmd/zennotes-server'], {
  cwd: serverRoot,
  env: withGoEnv({
    ZENNOTES_DEV: '1'
  }),
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
