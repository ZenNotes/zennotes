// Custom-template file I/O for local vaults. Templates are plain `.md` files
// under `.zennotes/templates/`. This module is intentionally parse-free: it
// only reads/writes raw bytes and returns them. All frontmatter parsing lives
// in the renderer (`@shared/template-files`), so the format has one home.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CustomTemplateFile, WriteTemplateInput } from '@zennotes/bridge-contract/templates'

const TEMPLATES_REL_DIR = '.zennotes/templates'

function templatesDir(root: string): string {
  return path.join(root, '.zennotes', 'templates')
}

function sourcePathForName(name: string): string {
  return `${TEMPLATES_REL_DIR}/${name}`
}

function filenameStem(sourcePath: string): string {
  const file = sourcePath.split('/').pop() ?? sourcePath
  return file.replace(/\.md$/i, '')
}

// A safe filename stem: lowercase letters, digits, dashes; no separators.
function safeSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return cleaned || 'template'
}

// Resolve a vault-relative sourcePath to an absolute path, rejecting anything
// outside the flat templates directory (no traversal, no subdirectories).
function resolveTemplatePath(root: string, sourcePath: string): string {
  const dir = templatesDir(root)
  const abs = path.resolve(root, sourcePath)
  const rel = path.relative(dir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error(`Refusing template path outside templates dir: ${sourcePath}`)
  }
  if (!abs.toLowerCase().endsWith('.md')) {
    throw new Error(`Template path must be a .md file: ${sourcePath}`)
  }
  return abs
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

// Pick a free slug. When editing the same file (slug unchanged) we overwrite;
// otherwise we de-duplicate against existing files (adr → adr-2 → adr-3 …).
async function uniqueSlug(
  dir: string,
  base: string,
  previousSourcePath?: string
): Promise<string> {
  const prevStem = previousSourcePath ? filenameStem(previousSourcePath) : null
  let candidate = base
  let n = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (candidate === prevStem) return candidate
    if (!(await fileExists(path.join(dir, `${candidate}.md`)))) return candidate
    candidate = `${base}-${n++}`
  }
}

export async function listCustomTemplates(root: string): Promise<CustomTemplateFile[]> {
  const dir = templatesDir(root)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return [] // no templates dir yet
  }
  const files: CustomTemplateFile[] = []
  for (const name of entries) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8')
      files.push({ sourcePath: sourcePathForName(name), raw })
    } catch (err) {
      console.warn(`[templates] skipping unreadable template ${name}:`, err)
    }
  }
  files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
  return files
}

export async function readCustomTemplate(root: string, sourcePath: string): Promise<string> {
  return await fs.readFile(resolveTemplatePath(root, sourcePath), 'utf8')
}

export async function writeCustomTemplate(
  root: string,
  input: WriteTemplateInput
): Promise<CustomTemplateFile> {
  const dir = templatesDir(root)
  await fs.mkdir(dir, { recursive: true })
  const slug = await uniqueSlug(dir, safeSlug(input.slug), input.previousSourcePath)
  const abs = path.join(dir, `${slug}.md`)
  await fs.writeFile(abs, input.raw, 'utf8')
  // Renaming during an edit: remove the prior file if the slug changed.
  if (input.previousSourcePath) {
    const prevAbs = resolveTemplatePath(root, input.previousSourcePath)
    if (prevAbs !== abs) await fs.rm(prevAbs, { force: true })
  }
  return { sourcePath: sourcePathForName(`${slug}.md`), raw: input.raw }
}

export async function deleteCustomTemplate(root: string, sourcePath: string): Promise<void> {
  await fs.rm(resolveTemplatePath(root, sourcePath), { force: true })
}
