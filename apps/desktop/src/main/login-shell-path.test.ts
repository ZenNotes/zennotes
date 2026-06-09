import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCommandViaLoginShell } from './login-shell-path'

const onPosix = process.platform !== 'win32'

describe('resolveCommandViaLoginShell', () => {
  // The core of issue #73: GUI apps inherit a minimal PATH, so a bare command
  // name can't be resolved. A login shell sources the user's profile and
  // returns an absolute path. `sh` is guaranteed present on POSIX systems.
  it.skipIf(!onPosix)('resolves a ubiquitous command to an absolute path', async () => {
    const resolved = await resolveCommandViaLoginShell('sh')
    expect(resolved).toBeTruthy()
    expect(path.isAbsolute(resolved as string)).toBe(true)
    expect(path.basename(resolved as string)).toBe('sh')
  })

  it('returns null for a command that does not exist', async () => {
    expect(await resolveCommandViaLoginShell('zen-not-a-real-binary-9f3a2b')).toBeNull()
  })

  it('rejects unsafe command names without spawning a shell', async () => {
    expect(await resolveCommandViaLoginShell('rg; rm -rf /')).toBeNull()
    expect(await resolveCommandViaLoginShell('$(touch /tmp/zen-pwned)')).toBeNull()
    expect(await resolveCommandViaLoginShell('rg fzf')).toBeNull()
    expect(await resolveCommandViaLoginShell('')).toBeNull()
  })
})
