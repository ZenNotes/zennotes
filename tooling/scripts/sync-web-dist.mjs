import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const webDist = resolve(repoRoot, 'apps/web/dist')
const serverDist = resolve(repoRoot, 'apps/server/web/dist')

await rm(serverDist, { recursive: true, force: true })
await mkdir(serverDist, { recursive: true })
await cp(webDist, serverDist, { recursive: true, force: true })
