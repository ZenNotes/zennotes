import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { resolveServerBinary } from './server-binary.mjs'

// dev:server and dev:web-stack start the server this way. A ZenNotes/znserver
// checkout in ZENNOTES_SERVER_DIR keeps the edit-and-restart loop through
// `go run`; an explicit ZENNOTES_SERVER_BINARY runs as is; otherwise the pinned
// published release runs, so browser work needs neither Go nor a checkout.
const checkout = process.env.ZENNOTES_SERVER_DIR?.trim()
const explicit = process.env.ZENNOTES_SERVER_BINARY?.trim()
if (checkout && explicit) throw new Error('Choose ZENNOTES_SERVER_BINARY or ZENNOTES_SERVER_DIR, not both')
const env = { ...process.env, ZENNOTES_DEV: '1' }
const child = checkout
  ? spawn('go', ['run', './cmd/zennotes-server'], { cwd: resolve(checkout), env, stdio: 'inherit' })
  : spawn(await resolveServerBinary(), [], { env, stdio: 'inherit' })
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
