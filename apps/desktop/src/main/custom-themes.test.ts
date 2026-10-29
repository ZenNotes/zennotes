import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCustomThemesDir,
  ensureCustomThemesDir,
  listCustomThemes,
  deleteCustomTheme,
  createCustomTheme,
  customThemeRevealTarget,
  resolveThemeAssetPath,
  startWatchingCustomThemes,
  stopWatchingCustomThemes
} from './custom-themes'

let tmp: string
const original = process.env.ZENNOTES_CONFIG_DIR

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'zen-ct-'))
  process.env.ZENNOTES_CONFIG_DIR = tmp
})
afterEach(async () => {
  if (original === undefined) delete process.env.ZENNOTES_CONFIG_DIR
  else process.env.ZENNOTES_CONFIG_DIR = original
  await rm(tmp, { recursive: true, force: true })
})

describe('custom themes (main)', () => {
  it('seeds + parses the Soft Paper folder on first run', async () => {
    await ensureCustomThemesDir()
    const dir = getCustomThemesDir()
    expect(existsSync(join(dir, 'soft-paper', 'manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'soft-paper', 'theme.css'))).toBe(true)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    const sp = (await listCustomThemes()).find((t) => t.slug === 'soft-paper')
    expect(sp?.name).toBe('Soft Paper')
    expect(sp?.modes).toBe('both')
    expect(sp?.css).toContain(':root')
    expect(sp?.css).toContain(':root[data-theme-mode="dark"]')
    expect(sp?.error).toBeUndefined()
  })

  it('reveal target is the theme.css for a valid slug, the dir otherwise (no traversal)', async () => {
    await ensureCustomThemesDir()
    const dir = getCustomThemesDir()
    expect(await customThemeRevealTarget('soft-paper')).toBe(join(dir, 'soft-paper', 'theme.css'))
    expect(await customThemeRevealTarget('missing')).toBe(dir)
    expect(await customThemeRevealTarget(undefined)).toBe(dir)
    expect(await customThemeRevealTarget('../../etc')).toBe(dir)
  })

  it('deletes only a bare-slug folder inside the themes dir', async () => {
    await ensureCustomThemesDir()
    const dir = getCustomThemesDir()
    const outside = join(tmp, 'secret.txt')
    await writeFile(outside, 'keep me')

    await deleteCustomTheme('../secret') // traversal → no-op
    expect(existsSync(outside)).toBe(true)

    await deleteCustomTheme('soft-paper')
    expect(existsSync(join(dir, 'soft-paper'))).toBe(false)
    expect((await listCustomThemes()).find((t) => t.slug === 'soft-paper')).toBeUndefined()
  })

  it('never resurrects a deleted example on a later ensure', async () => {
    await ensureCustomThemesDir()
    const folder = join(getCustomThemesDir(), 'soft-paper')
    await deleteCustomTheme('soft-paper')
    await ensureCustomThemesDir()
    expect(existsSync(folder)).toBe(false)
  })

  it('creates a new theme folder from the New theme command', async () => {
    const slug = await createCustomTheme({ name: 'My Cool Theme' })
    expect(slug).toBe('my-cool-theme')
    const dir = getCustomThemesDir()
    expect(existsSync(join(dir, 'my-cool-theme', 'theme.css'))).toBe(true)
    // A second create with the same name gets a unique slug.
    expect(await createCustomTheme({ name: 'My Cool Theme' })).toBe('my-cool-theme-2')
  })

  it('migrates a legacy <slug>.toml palette to a folder once', async () => {
    const dir = getCustomThemesDir()
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'paper.toml'),
      [
        'name = "Paper"',
        '[light]',
        'bg = "#ffffff"',
        'text = "#000000"',
        'accent = "#0000ff"',
        '[dark]',
        'bg = "#000000"',
        'text = "#ffffff"',
        'accent = "#00aaff"'
      ].join('\n')
    )
    await ensureCustomThemesDir()
    expect(existsSync(join(dir, 'paper', 'manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'paper', 'theme.css'))).toBe(true)
    expect(existsSync(join(dir, 'paper.toml.migrated'))).toBe(true)
    expect(existsSync(join(dir, 'paper.toml'))).toBe(false)
    const manifest = JSON.parse(await readFile(join(dir, 'paper', 'manifest.json'), 'utf8'))
    expect(manifest.name).toBe('Paper')
    expect(manifest.modes).toBe('both')
    const paper = (await listCustomThemes()).find((t) => t.slug === 'paper')
    expect(paper?.css).toContain('--z-bg: 255 255 255;')
  })

  it('refreshes a stale (.toml-era) README in place, leaves user content alone', async () => {
    const dir = getCustomThemesDir()
    await mkdir(dir, { recursive: true })
    // A pre-CSS-format README (mentions .toml, never manifest.json) → refreshed.
    await writeFile(join(dir, 'README.md'), '# ZenNotes themes\nDrop a `.toml` file here.\n')
    await ensureCustomThemesDir()
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('manifest.json')

    // A user-written README → untouched.
    await writeFile(join(dir, 'README.md'), '# my notes\nhello\n')
    await ensureCustomThemesDir()
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# my notes\nhello\n')
  })
})

describe('custom themes watcher', () => {
  // An unreadable theme folder used to end live theme updates: chokidar's
  // EACCES had no 'error' listener, and the watcher reported nothing after it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps reporting theme edits when one theme folder cannot be read',
    async () => {
      const dir = await ensureCustomThemesDir()
      const locked = join(dir, 'locked')
      await mkdir(locked)
      await chmod(locked, 0o000)
      let reports = 0
      try {
        startWatchingCustomThemes(() => reports++)
        await mkdir(join(dir, 'late'))
        await expect
          .poll(
            async () => {
              await writeFile(join(dir, 'late', 'theme.css'), `:root { --n: ${Date.now()}; }\n`)
              return reports
            },
            { interval: 300, timeout: 10_000 }
          )
          .toBeGreaterThan(0)
      } finally {
        await stopWatchingCustomThemes()
        // rm cannot clear a folder it cannot read.
        await chmod(locked, 0o755)
      }
    },
    15_000
  )
})

describe('resolveThemeAssetPath', () => {
  it('resolves a real file inside the theme folder, rejects escapes', async () => {
    const dir = await ensureCustomThemesDir()
    const font = join(dir, 'soft-paper', 'font.woff2')
    await writeFile(font, 'not-a-real-font')
    // resolveThemeAssetPath canonicalizes via realpath (macOS /var → /private/var).
    expect(resolveThemeAssetPath('soft-paper', 'font.woff2')).toBe(realpathSync(font))
    expect(resolveThemeAssetPath('soft-paper', '../../etc/hosts')).toBeNull()
    expect(resolveThemeAssetPath('soft-paper', '/etc/hosts')).toBeNull()
    expect(resolveThemeAssetPath('../evil', 'font.woff2')).toBeNull()
    expect(resolveThemeAssetPath('soft-paper', 'missing.woff2')).toBeNull()
    expect(resolveThemeAssetPath('soft-paper', '')).toBeNull()
  })
})
