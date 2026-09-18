import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  rm,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareTerminalRuntime } from './terminal-runtime'
const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture(version = '1.0.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), "zn terminal ' "))
  roots.push(root)
  const bundleDir = path.join(root, 'resources', 'terminal')
  await mkdir(bundleDir, { recursive: true })
  const binary = `#!/bin/sh\nif [ "$1" = --desktop-integration ]; then\n  echo '{"protocol":1,"version":"${version}"}'\n  exit\nfi\nprintf '%s\\n' "$ZENNOTES_WORKSPACE_SOURCE" "$@"\nexit 7\n`
  await writeFile(path.join(bundleDir, 'zn'), binary, { mode: 0o755 })
  await writeFile(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      protocol: 1,
      version,
      platform: process.platform,
      arch: process.arch,
    }),
  )
  const legacy = path.join(root, 'legacy')
  await writeFile(legacy, '#!/bin/sh\nprintf "legacy:%s\\n" "$@"\n', {
    mode: 0o755,
  })
  return {
    root,
    bundleDir,
    userData: path.join(root, 'user data'),
    platform: process.platform,
    arch: process.arch,
    legacyCommand: [legacy],
  }
}
describe.skipIf(process.platform === 'win32')(
  'persistent terminal runtime',
  () => {
    it('survives bundle removal and preserves arguments, workspace context, exit code, and explicit rollback', async () => {
      const options = await fixture()
      const runtime = await prepareTerminalRuntime(options)
      expect(runtime?.version).toBe('1.0.0')
      await rm(options.bundleDir, { recursive: true })
      const result = await exec(runtime!.launcherPath, ['read', 'a b.md'], {
        env: { ...process.env, ZENNOTES_WORKSPACE_SOURCE: '' },
      }).catch((e) => e)
      expect(result.code).toBe(7)
      expect(result.stdout).toBe('app\nread\na b.md\n')
      const rollback = await exec(runtime!.launcherPath, ['read', 'a b.md'], {
        env: { ...process.env, ZENNOTES_CLI_ENGINE: 'legacy' },
      })
      expect(rollback.stdout).toBe('legacy:read\nlegacy:a b.md\n')
    })
    it('retains the active version if the replacement fails its integration probe', async () => {
      const options = await fixture()
      const first = await prepareTerminalRuntime(options)
      const current = await readlink(
        path.join(options.userData, 'cli', 'terminal', 'current'),
      )
      await writeFile(
        path.join(options.bundleDir, 'zn'),
        '#!/bin/sh\necho broken\n',
        { mode: 0o755 },
      )
      await expect(prepareTerminalRuntime(options)).rejects.toThrow(
        /integration/i,
      )
      expect(
        await readlink(
          path.join(options.userData, 'cli', 'terminal', 'current'),
        ),
      ).toBe(current)
      expect(
        createHash('sha256')
          .update(await readFile(first!.binaryPath))
          .digest('hex'),
      ).toBe(first!.sha256)
    })
    it('declines absent artifacts and refuses mismatched platforms or foreign launchers', async () => {
      const options = await fixture()
      await expect(
        prepareTerminalRuntime({ ...options, arch: 'unsupported' }),
      ).rejects.toThrow(/platform|architecture/i)
      await mkdir(path.join(options.userData, 'cli'), { recursive: true })
      const launcher = path.join(options.userData, 'cli', 'zn')
      await writeFile(launcher, 'owned by someone else')
      await expect(prepareTerminalRuntime(options)).rejects.toThrow(/managed/i)
      expect(await readFile(launcher, 'utf8')).toBe('owned by someone else')
      await rm(options.bundleDir, { recursive: true })
      expect(await prepareTerminalRuntime(options)).toBeNull()
    })
  },
)
