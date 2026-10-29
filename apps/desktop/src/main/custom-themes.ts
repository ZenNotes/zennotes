/**
 * Loads user-authored themes from `~/.config/zennotes/themes/<slug>/`.
 *
 * Each theme is a folder (Obsidian-style):
 *   <slug>/manifest.json  — name, author, version, description, modes, preview
 *   <slug>/theme.css      — arbitrary CSS (may embed fonts/images)
 *   <slug>/<assets…>      — referenced as url(zen-theme://<slug>/<file>)
 *
 * We parse + validate here in the main process, then hand structured
 * `CustomTheme` objects (incl. the raw `theme.css`) to the renderer over IPC.
 * The directory is watched so edits show up live. Legacy `*.toml` palette files
 * from the pre-release WIP are migrated to folders once, on launch.
 */
import { promises as fs } from 'node:fs'
import * as fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import { parse as parseToml } from 'smol-toml'
import {
  parseThemeManifest,
  readTomlPalettes,
  scaffoldThemeCss,
  type CustomTheme,
  type CustomThemeModes,
  type CustomThemePalette
} from '@shared/custom-themes'
import { getConfigDir } from './app-config'

export function getCustomThemesDir(): string {
  return path.join(getConfigDir(), 'themes')
}

/** A bare slug/name that resolves to a direct child of the themes dir. */
function isSafeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && !!slug && !/[/\\]/.test(slug) && !slug.includes('..')
}

// --- Seeded example -------------------------------------------------------
// Soft Paper, a port of Nick Milo's Obsidian theme. Generated from palettes so
// it stays consistent with `.toml` migration output and exercises the full
// token set; the README teaches the format.
const SOFT_PAPER_LIGHT: CustomThemePalette = {
  bg: '#eee6dd',
  chrome: '#e6dbd1',
  surface: '#dcd3cb',
  border: '#cac1b9',
  text: '#575279',
  muted: '#797593',
  faint: '#9893a5',
  accent: '#1a7da4',
  accentSoft: '#1a9caa',
  accentMuted: '#56949f',
  red: '#ba7184',
  green: '#5ba57b',
  yellow: '#d1954a',
  blue: '#286983',
  purple: '#907aa9',
  aqua: '#669ea6'
}
const SOFT_PAPER_DARK: CustomThemePalette = {
  bg: '#303446',
  chrome: '#292c3c',
  surface: '#414559',
  border: '#51576d',
  text: '#c6ceef',
  muted: '#b5bddc',
  faint: '#838ba7',
  accent: '#85c1dc',
  accentSoft: '#8caaee',
  accentMuted: '#81c8be',
  red: '#e78284',
  green: '#a6d189',
  yellow: '#e5c890',
  blue: '#8caaee',
  purple: '#ca9ee6',
  aqua: '#81c8be'
}

function softPaperManifest(): string {
  return (
    JSON.stringify(
      {
        name: 'Soft Paper',
        author: 'Nick Milo (port)',
        version: '1.0.0',
        description: 'A warm, paper-like theme (light + dark).',
        modes: 'both',
        preview: { light: '#1a7da4', dark: '#85c1dc' }
      },
      null,
      2
    ) + '\n'
  )
}

// A neutral starting point for the "New theme" command. The author edits from here.
const NEW_THEME_LIGHT: CustomThemePalette = { bg: '#ffffff', text: '#1d1d1f', accent: '#007aff' }
const NEW_THEME_DARK: CustomThemePalette = { bg: '#1c1c1e', text: '#ffffff', accent: '#0a84ff' }

const README = `# ZenNotes themes

Each subfolder here is a theme. Drop one in and it shows up under
**Settings → Appearance → Custom themes** (edits apply live). The folder name is
the theme's id, so \`my-theme/\` → "my-theme".

## Layout

\`\`\`
my-theme/
  manifest.json   # name, author, version, description, modes, preview
  theme.css       # the styles (required)
  my-font.woff2   # optional assets (fonts, images)
\`\`\`

## manifest.json

\`\`\`json
{
  "name": "My Theme",
  "author": "you",
  "version": "1.0.0",
  "description": "A short description.",
  "modes": "both",
  "preview": { "light": "#007aff", "dark": "#0a84ff" }
}
\`\`\`

\`modes\` is \`"light"\`, \`"dark"\`, or \`"both"\`. \`preview\` colors are only used for
the swatch on the Settings card. A missing manifest is fine: the theme is then
named after its folder and assumed to support both modes.

## theme.css

Only the **active** theme's CSS is loaded, so you can use \`:root\` unscoped.
Put dark-mode overrides under \`[data-theme-mode="dark"]\`:

\`\`\`css
:root {
  --z-bg: 255 255 255;     /* tokens are space-separated RGB triplets */
  --z-fg-1: 29 29 31;
  --z-accent: 0 122 255;
  /* …see Soft Paper for the full --z-* set… */
}
:root[data-theme-mode="dark"] {
  --z-bg: 28 28 30;
  --z-fg-1: 255 255 255;
  --z-accent: 10 132 255;
}
\`\`\`

You can also write any other CSS (fonts, backgrounds, component tweaks).

## Fonts & images

Reference files that live beside \`theme.css\` with the \`zen-theme://\` scheme
(the host is your folder name). Remote URLs are not loaded.

\`\`\`css
@font-face {
  font-family: "My Font";
  src: url(zen-theme://my-theme/my-font.woff2) format("woff2");
}
:root { --z-text-font: "My Font", ui-sans-serif, sans-serif; }
\`\`\`

See \`soft-paper/\` in this folder for a complete example.
`

/** Write a theme folder (manifest + theme.css). Overwrites existing files. */
async function writeThemeFolder(
  dir: string,
  slug: string,
  manifestJson: string,
  css: string
): Promise<void> {
  const folder = path.join(dir, slug)
  await fs.mkdir(folder, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(folder, 'manifest.json'), manifestJson),
    fs.writeFile(path.join(folder, 'theme.css'), css)
  ])
}

/** Create the themes dir on first run (seeding Soft Paper + README), and migrate
 *  any leftover `*.toml` palette files from the pre-release WIP. */
export async function ensureCustomThemesDir(): Promise<string> {
  const dir = getCustomThemesDir()
  let existed = true
  try {
    await fs.access(dir)
  } catch {
    existed = false
  }
  await fs.mkdir(dir, { recursive: true })
  await migrateTomlThemes(dir)
  if (!existed) {
    await writeThemeFolder(
      dir,
      'soft-paper',
      softPaperManifest(),
      scaffoldThemeCss({
        name: 'Soft Paper',
        slug: 'soft-paper',
        light: SOFT_PAPER_LIGHT,
        dark: SOFT_PAPER_DARK
      })
    ).catch(() => {})
    await fs.writeFile(path.join(dir, 'README.md'), README).catch(() => {})
  } else {
    await refreshStaleReadme(dir)
  }
  return dir
}

/** Replace a pre-CSS-format README (the retired `.toml` palette docs) in place so
 *  upgrading users don't read instructions for a format that no longer works.
 *  Leaves an already-current or user-written README untouched. */
async function refreshStaleReadme(dir: string): Promise<void> {
  const file = path.join(dir, 'README.md')
  try {
    const current = await fs.readFile(file, 'utf8')
    // Old auto-generated READMEs documented `.toml` palettes and never mention
    // manifest.json — the defining word of the folder format. Refresh only those.
    if (current !== README && current.includes('.toml') && !current.includes('manifest.json')) {
      await fs.writeFile(file, README)
    }
  } catch {
    /* missing or unreadable — respect the user's choice and leave it */
  }
}

/** Convert each legacy `themes/<slug>.toml` palette to a `themes/<slug>/` folder
 *  (once). The source is renamed `<slug>.toml.migrated` so it isn't re-read or
 *  re-converted, and is left in place if the slug folder already exists. */
async function migrateTomlThemes(dir: string): Promise<void> {
  let entries: fsSync.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.toml')) continue
    const slug = entry.name.replace(/\.toml$/i, '')
    if (!isSafeSlug(slug) || fsSync.existsSync(path.join(dir, slug))) continue
    try {
      const text = await fs.readFile(path.join(dir, entry.name), 'utf8')
      const { name, light, dark } = readTomlPalettes(parseToml(text))
      if (!light && !dark) continue // unusable palette — leave the file alone
      const modes: CustomThemeModes = light && dark ? 'both' : dark ? 'dark' : 'light'
      const manifest = JSON.stringify({ name: name ?? slug, modes }, null, 2) + '\n'
      const css = scaffoldThemeCss({ name: name ?? slug, slug, light, dark })
      await writeThemeFolder(dir, slug, manifest, css)
      await fs.rename(path.join(dir, entry.name), path.join(dir, `${entry.name}.migrated`))
    } catch {
      /* leave the .toml in place if we couldn't convert it */
    }
  }
}

/** Parse every theme folder under the themes dir into a validated CustomTheme. */
export async function listCustomThemes(): Promise<CustomTheme[]> {
  const dir = getCustomThemesDir()
  let entries: fsSync.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const themes: CustomTheme[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const slug = entry.name
    const folder = path.join(dir, slug)
    try {
      const css = await fs.readFile(path.join(folder, 'theme.css'), 'utf8')
      let manifestRaw: unknown = null
      try {
        manifestRaw = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'))
      } catch {
        /* manifest optional — fall back to slug-named defaults */
      }
      const m = parseThemeManifest(manifestRaw, slug)
      themes.push({
        slug,
        name: m.name,
        author: m.author,
        version: m.version,
        description: m.description,
        modes: m.modes,
        css,
        preview: m.preview
      })
    } catch {
      themes.push({
        slug,
        name: slug,
        modes: 'both',
        css: '',
        error: 'No readable theme.css here. Add one (see README.md) or use New theme.'
      })
    }
  }
  themes.sort((a, b) => a.name.localeCompare(b.name))
  return themes
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'my-theme'
  )
}

/** Scaffold a new theme folder from a neutral starter palette. Returns the slug
 *  (unique within the themes dir) or null on failure. */
export async function createCustomTheme(input: { name?: string }): Promise<string | null> {
  const dir = await ensureCustomThemesDir()
  const name = (input?.name && input.name.trim()) || 'My Theme'
  const base = slugify(name)
  let slug = base
  let n = 2
  while (fsSync.existsSync(path.join(dir, slug))) slug = `${base}-${n++}`
  if (path.dirname(path.resolve(path.join(dir, slug))) !== path.resolve(dir)) return null
  try {
    const manifest =
      JSON.stringify(
        { name, author: '', version: '1.0.0', description: '', modes: 'both' },
        null,
        2
      ) + '\n'
    const css = scaffoldThemeCss({ name, slug, light: NEW_THEME_LIGHT, dark: NEW_THEME_DARK })
    await writeThemeFolder(dir, slug, manifest, css)
    return slug
  } catch {
    return null
  }
}

/**
 * Resolve a `zen-theme://<slug>/<relPath>` asset to an absolute file path,
 * sandboxed to the theme's own folder. Returns null for anything that escapes
 * the folder (traversal, symlink, absolute path) or isn't a file.
 */
export function resolveThemeAssetPath(slug: string, relPath: string): string | null {
  if (!isSafeSlug(slug) || typeof relPath !== 'string' || !relPath) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null
  }
  decoded = decoded.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!decoded || decoded.includes('\0') || path.isAbsolute(decoded)) return null
  const themeDir = path.join(getCustomThemesDir(), slug)
  const abs = path.resolve(themeDir, decoded)
  const root = path.resolve(themeDir)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  let real: string
  let realRoot: string
  try {
    real = fsSync.realpathSync(abs)
    realRoot = fsSync.realpathSync(themeDir)
  } catch {
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
  try {
    if (!fsSync.statSync(real).isFile()) return null
  } catch {
    return null
  }
  return real
}

let watcher: ReturnType<typeof chokidar.watch> | null = null

/** Watch the themes dir (incl. one level into each theme folder) and call
 *  `onChange` (debounced) with the fresh list. */
export function startWatchingCustomThemes(onChange: (themes: CustomTheme[]) => void): void {
  const dir = getCustomThemesDir()
  void watcher?.close()
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void listCustomThemes().then(onChange)
    }, 200)
  }
  const w = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 1,
    // A theme folder the app cannot read costs that folder, not the watcher.
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  })
  watcher = w
  w.on('add', fire)
    .on('change', fire)
    .on('unlink', fire)
    .on('addDir', fire)
    .on('unlinkDir', fire)
    // With no listener, chokidar's 'error' rejects inside its own scan and
    // the watcher stops reporting edits for the rest of the session.
    .on('error', (error) => console.warn('[zen] the themes watcher could not watch a path:', error))
}

/** Test/teardown hook: stop the themes watcher. */
export async function stopWatchingCustomThemes(): Promise<void> {
  await watcher?.close().catch(() => {})
  watcher = null
}

/** What to reveal in the file manager: a theme's `theme.css` when the slug is
 *  valid and exists, otherwise its folder, otherwise the themes dir. */
export async function customThemeRevealTarget(slug?: string): Promise<string> {
  const dir = await ensureCustomThemesDir()
  if (isSafeSlug(slug)) {
    const folder = path.join(dir, slug)
    if (path.dirname(path.resolve(folder)) === path.resolve(dir) && fsSync.existsSync(folder)) {
      const css = path.join(folder, 'theme.css')
      return fsSync.existsSync(css) ? css : folder
    }
  }
  return dir
}

/** Delete a custom theme folder. Refuses anything that isn't a bare slug
 *  resolving to a direct child of the themes dir (no path traversal). */
export async function deleteCustomTheme(slug: string): Promise<void> {
  if (!isSafeSlug(slug)) return
  const dir = getCustomThemesDir()
  const folder = path.join(dir, slug)
  if (path.dirname(path.resolve(folder)) !== path.resolve(dir)) return
  await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
}

/** Synchronous existence check used by the reveal handler's mkdir fallback. */
export function customThemesDirExistsSync(): boolean {
  try {
    return fsSync.existsSync(getCustomThemesDir())
  } catch {
    return false
  }
}
