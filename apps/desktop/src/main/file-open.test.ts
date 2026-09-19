import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  argvRequestsNewWindow,
  candidatePathsFromArgv,
  isMarkdownFilePath,
  markdownPathsFromArgv,
  NEW_WINDOW_SWITCH,
  resolveMarkdownOpenTarget,
  vaultRelativeNotePath
} from './file-open'

describe('isMarkdownFilePath', () => {
  it('accepts .md and .markdown case-insensitively', () => {
    expect(isMarkdownFilePath('/a/b/Note.md')).toBe(true)
    expect(isMarkdownFilePath('/a/b/Note.MARKDOWN')).toBe(true)
    expect(isMarkdownFilePath('Note.Md')).toBe(true)
  })

  it('rejects other extensions and empty input', () => {
    expect(isMarkdownFilePath('/a/b/Note.txt')).toBe(false)
    expect(isMarkdownFilePath('/a/b/Note')).toBe(false)
    expect(isMarkdownFilePath('   ')).toBe(false)
  })
})

describe('vaultRelativeNotePath', () => {
  const root = path.resolve('/vault')

  it('returns a posix relative path for files inside the vault', () => {
    expect(vaultRelativeNotePath(root, path.join(root, 'inbox', 'A.md'))).toBe('inbox/A.md')
  })

  it('returns null for files outside the vault', () => {
    expect(vaultRelativeNotePath(root, path.resolve('/other/A.md'))).toBeNull()
  })

  it('returns null for the vault root itself', () => {
    expect(vaultRelativeNotePath(root, root)).toBeNull()
  })

  it('returns null when the path escapes the vault', () => {
    expect(vaultRelativeNotePath(root, path.resolve('/vault/../evil/A.md'))).toBeNull()
  })
})

describe('resolveMarkdownOpenTarget', () => {
  const vaultA = path.resolve('/vaults/A')
  const nestedVault = path.resolve('/vaults/A/nested')

  it('opens inside the vault that contains the file', () => {
    expect(resolveMarkdownOpenTarget(path.join(vaultA, 'note.md'), [vaultA])).toEqual({
      kind: 'vault',
      vaultRoot: vaultA,
      relPath: 'note.md'
    })
  })

  it('prefers the deepest matching vault', () => {
    expect(
      resolveMarkdownOpenTarget(path.join(nestedVault, 'note.md'), [vaultA, nestedVault])
    ).toEqual({ kind: 'vault', vaultRoot: nestedVault, relPath: 'note.md' })
  })

  it('falls back to an external file outside all known vaults', () => {
    const abs = path.resolve('/downloads/Lead.md')
    expect(resolveMarkdownOpenTarget(abs, [vaultA])).toEqual({ kind: 'external', absPath: abs })
  })
})

describe('markdownPathsFromArgv', () => {
  it('extracts markdown paths, skipping the exe, flags, and deep links', () => {
    const argv = [
      '/path/to/ZenNotes',
      '--enable-foo',
      'zennotes://open?path=x',
      '/docs/A.md',
      '/docs/B.txt',
      'C.markdown'
    ]
    expect(markdownPathsFromArgv(argv)).toEqual(['/docs/A.md', 'C.markdown'])
  })

  it('returns an empty array when there are no markdown arguments', () => {
    expect(markdownPathsFromArgv(['/path/to/ZenNotes'])).toEqual([])
  })

  // A `.desktop` `%U` hand-off is a Linux mechanism, and a drive-letter-less
  // file:// URL is invalid on win32 (`fileURLToPath` refuses it), so each
  // platform asserts its own native URL shape rather than the other's.
  it.skipIf(process.platform === 'win32')(
    'decodes file:// URLs from a .desktop %U hand-off, deep links stay skipped',
    () => {
      const argv = [
        '/path/to/ZenNotes',
        'file:///docs/Some%20Note.md',
        'zennotes://open?path=x'
      ]
      expect(markdownPathsFromArgv(argv)).toEqual(['/docs/Some Note.md'])
    }
  )

  it.runIf(process.platform === 'win32')(
    'decodes drive-letter file:// URLs on Windows, deep links stay skipped',
    () => {
      const argv = [
        'C:\\app\\ZenNotes.exe',
        'file:///C:/docs/Some%20Note.md',
        'zennotes://open?path=x'
      ]
      expect(markdownPathsFromArgv(argv)).toEqual(['C:\\docs\\Some Note.md'])
    }
  )
})

describe('candidatePathsFromArgv file:// decoding', () => {
  it('skips the application entry when Electron runs an unpackaged app', () => {
    expect(
      candidatePathsFromArgv(
        ['/path/to/Electron', '/repo/apps/desktop', '/vault/to/open'],
        true
      )
    ).toEqual(['/vault/to/open'])
  })

  it.skipIf(process.platform === 'win32')(
    'decodes folder and file URLs, skips other schemes and malformed URLs',
    () => {
      const argv = [
        '/path/to/ZenNotes',
        'file:///home/user/notes',
        'file://',
        'zennotes://open?path=x',
        '/plain/dir'
      ]
      expect(candidatePathsFromArgv(argv)).toEqual(['/home/user/notes', '/plain/dir'])
    }
  )

  it.runIf(process.platform === 'win32')(
    'decodes folder and file URLs on Windows, skips other schemes and malformed URLs',
    () => {
      const argv = [
        'C:\\app\\ZenNotes.exe',
        'file:///C:/home/user/notes',
        'file://',
        'zennotes://open?path=x',
        'C:\\plain\\dir'
      ]
      expect(candidatePathsFromArgv(argv)).toEqual(['C:\\home\\user\\notes', 'C:\\plain\\dir'])
    }
  )
})

describe('candidatePathsFromArgv own-app-path filter (#579)', () => {
  // nixpkgs wraps Electron so a Chromium switch lands BEFORE the positional
  // app directory; the index-based skip then eats the flag slot and the app's
  // own `…/apps/desktop` came through as a directory to open.
  it.skipIf(process.platform === 'win32')(
    'drops the app dir even when a switch precedes it and the index skip misses',
    () => {
      const argv = [
        '/nix/store/electron/bin/electron',
        '--ozone-platform-hint=auto',
        '/nix/store/zennotes/apps/desktop'
      ]
      expect(candidatePathsFromArgv(argv, true, '/nix/store/zennotes/apps/desktop')).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')('keeps real path arguments alongside the filter', () => {
    const argv = [
      '/nix/store/electron/bin/electron',
      '--ozone-platform-hint=auto',
      '/nix/store/zennotes/apps/desktop',
      '/home/user/vault',
      'file:///home/user/notes/todo.md'
    ]
    expect(candidatePathsFromArgv(argv, true, '/nix/store/zennotes/apps/desktop')).toEqual([
      '/home/user/vault',
      '/home/user/notes/todo.md'
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'compares resolved paths, so a trailing slash or dot segment still matches',
    () => {
      const argv = ['/bin/electron', '/repo/apps/desktop/', '/repo/apps/../apps/desktop']
      expect(candidatePathsFromArgv(argv, false, '/repo/apps/desktop')).toEqual([])
    }
  )
})

describe('--new-window switch (#815)', () => {
  // `zn open -n` forwards the switch ahead of the paths; the app must both
  // read it and keep treating it as a switch, never as a path to open.
  it('is read from anywhere in argv, and only as the exact switch', () => {
    expect(argvRequestsNewWindow(['/bin/ZenNotes', NEW_WINDOW_SWITCH, '/home/user/vault'])).toBe(
      true
    )
    expect(argvRequestsNewWindow(['/bin/ZenNotes', '/home/user/vault', NEW_WINDOW_SWITCH])).toBe(
      true
    )
    expect(argvRequestsNewWindow(['/bin/ZenNotes', '/home/user/vault'])).toBe(false)
    // A path that merely contains the words is a path.
    expect(argvRequestsNewWindow(['/bin/ZenNotes', '/vault/--new-window'])).toBe(false)
  })

  it('does not leak into the candidate paths', () => {
    const argv = ['/bin/ZenNotes', NEW_WINDOW_SWITCH, '/home/user/vault', '/home/user/todo.md']
    expect(candidatePathsFromArgv(argv)).toEqual(['/home/user/vault', '/home/user/todo.md'])
    expect(markdownPathsFromArgv(argv)).toEqual(['/home/user/todo.md'])
  })
})
