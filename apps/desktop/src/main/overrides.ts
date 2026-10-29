/**
 * Loads user CSS overrides from `~/.config/zennotes/overrides/*.css`.
 *
 * A override is a raw `.css` file the user toggles on/off; enabled overrides are
 * injected by the renderer on top of whichever theme is active. We just read
 * the files here and hand them over IPC; the enabled set lives in the portable
 * config (`[overrides]` in config.toml), not here. The directory is watched so
 * edits show up live. Mirrors `custom-themes.ts`.
 */
import { promises as fs } from 'node:fs'
import * as fsSync from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Override } from '@shared/overrides'
import { getConfigDir } from './app-config'

export function getOverridesDir(): string {
  return path.join(getConfigDir(), 'overrides')
}

/** A bare `.css` filename resolving to a direct child of the overrides dir. */
function isSafeName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    !!name &&
    !/[/\\]/.test(name) &&
    !name.includes('..') &&
    name.toLowerCase().endsWith('.css')
  )
}

const EXAMPLE = `/* ZenNotes override: a cookbook. Toggle it on in Settings → Appearance →
 * Overrides, then uncomment a recipe below to use it. As shipped, this file
 * changes nothing: every recipe is commented out.
 *
 * Overrides layer on top of whichever theme is active. Target :root[data-theme]
 * so your rule wins over both a built-in theme's :root[data-theme="…"] block and
 * a custom theme's :root {}.
 *
 * Colors are space-separated RGB triplets:  --z-accent: 255 59 48;  (= #ff3b30)
 */

/* ----- Theme color tokens you can override -------------------------------
 *  Backgrounds   --z-bg (canvas)  --z-bg-softer (sidebar)  --z-bg-1..4 (panels)
 *  Text          --z-fg-1 (body)  --z-fg-2 (secondary)  --z-grey-0..2 (muted)
 *  Accent        --z-accent  --z-accent-soft  --z-accent-muted
 *  Syntax hues   --z-red  --z-green  --z-yellow  --z-blue  --z-purple  --z-aqua
 *  Shadow        --z-shadow
 * ----------------------------------------------------------------------- */

/* Punchier accent on every theme */
/*
:root[data-theme] {
  --z-accent: 255 59 48;
}
*/

/* Dark mode only: a deeper, OLED-friendly background */
/*
:root[data-theme-mode="dark"] {
  --z-bg: 0 0 0;
  --z-bg-softer: 12 12 12;
}
*/

/* Recolor a syntax / diagnostic hue (shows up in code + diagrams) */
/*
:root[data-theme] {
  --z-blue: 130 170 255;
}
*/

/* Any other CSS works too. Use the "Developer tools" button in Settings →
 * Appearance → Overrides to inspect an element, find its class, then style it.
 * Fonts and text size live in Settings → Typography, so set those there. */
`

const README = `# ZenNotes overrides

Drop a \`.css\` file here and toggle it on under
**Settings → Appearance → Overrides**. Enabled overrides are injected on top of
whichever theme is active (built-in or custom), in filename order, so they win
the cascade.

## Override a theme color

Target \`:root[data-theme]\` so your rule beats both a built-in theme's
\`:root[data-theme="…"]\` block and a custom theme's \`:root {}\`:

\`\`\`css
:root[data-theme] {
  --z-accent: 255 59 48;   /* space-separated RGB */
}
\`\`\`

You can also write any other CSS to tweak the UI. Remote URLs are not loaded.

See \`example.css\` here for the full list of \`--z-*\` tokens and a few
ready-to-use recipes.
`

/** Create the overrides dir on first run, seeding an example + README. */
export async function ensureOverridesDir(): Promise<string> {
  const dir = getOverridesDir()
  let existed = true
  try {
    await fs.access(dir)
  } catch {
    existed = false
  }
  await fs.mkdir(dir, { recursive: true })
  if (!existed) {
    await Promise.all([
      fs.writeFile(path.join(dir, 'example.css'), EXAMPLE).catch(() => {}),
      fs.writeFile(path.join(dir, 'README.md'), README).catch(() => {})
    ])
  }
  return dir
}

/** Read every `*.css` in the overrides dir into a Override (raw text). */
export async function listOverrides(): Promise<Override[]> {
  const dir = getOverridesDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const overrides: Override[] = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.css')) continue
    try {
      const css = await fs.readFile(path.join(dir, entry), 'utf8')
      overrides.push({ name: entry, css })
    } catch (err) {
      overrides.push({
        name: entry,
        css: '',
        error: err instanceof Error ? err.message : 'Could not read this override.'
      })
    }
  }
  overrides.sort((a, b) => a.name.localeCompare(b.name))
  return overrides
}

let watcher: ReturnType<typeof chokidar.watch> | null = null

/** Watch the overrides dir and call `onChange` (debounced) with the fresh list. */
export function startWatchingOverrides(onChange: (overrides: Override[]) => void): void {
  const dir = getOverridesDir()
  void watcher?.close()
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void listOverrides().then(onChange)
    }, 200)
  }
  const w = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 0,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  })
  watcher = w
  // With no listener, chokidar's 'error' rejects inside its own scan and the
  // watcher stops reporting edits for the rest of the session.
  w.on('add', fire)
    .on('change', fire)
    .on('unlink', fire)
    .on('error', (error) => console.warn('[zen] the overrides watcher could not watch a path:', error))
}

/** Reveal a specific override file when the name is valid and exists, otherwise
 *  the overrides dir. */
export async function overrideRevealTarget(name?: string): Promise<string> {
  const dir = await ensureOverridesDir()
  if (isSafeName(name)) {
    const file = path.join(dir, name)
    if (path.dirname(path.resolve(file)) === path.resolve(dir) && fsSync.existsSync(file)) {
      return file
    }
  }
  return dir
}

/** Delete a override file. Refuses anything that isn't a bare `.css` name
 *  resolving to a direct child of the overrides dir (no path traversal). */
export async function deleteOverride(name: string): Promise<void> {
  if (!isSafeName(name)) return
  const dir = getOverridesDir()
  const file = path.join(dir, name)
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return
  await fs.rm(file, { force: true }).catch(() => {})
}
