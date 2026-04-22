import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export function withGoEnv(extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
  }

  if (!env.GOCACHE) {
    const cacheDir = resolve(tmpdir(), 'zennotes-go-build-cache')
    mkdirSync(cacheDir, { recursive: true })
    env.GOCACHE = cacheDir
  }

  return env
}
