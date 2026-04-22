import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { withGoEnv } from './go-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const serverRoot = resolve(repoRoot, 'apps/server')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd = repoRoot, options = {}) {
  const shell = options.shell ?? false
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
      shell,
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

await run(npmCommand, ['run', 'prepare-web'], serverRoot, {
  shell: process.platform === 'win32',
})

await run('go', ['test', './...'], serverRoot, {
  env: withGoEnv(),
})
