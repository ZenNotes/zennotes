// Workflow file I/O for local vaults. Workflows are plain `.md` files under
// `.zennotes/workflows/`. Like `templates.ts`, this module is deliberately
// parse-free: it hands back raw bytes and never interprets the format. The
// grammar lives in `@shared/workflows/parse`, so the format has exactly one
// home and the main process never has to be redeployed to learn a new node.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WorkflowFile, WriteWorkflowInput } from '@zennotes/bridge-contract/workflows'
import { WORKFLOWS_REL_DIR } from '@shared/workflows-view'
import { writeFileAtomic } from './vault'

function workflowsDir(root: string): string {
  return path.join(root, '.zennotes', 'workflows')
}

function sourcePathForName(name: string): string {
  return `${WORKFLOWS_REL_DIR}/${name}`
}

// The filename stem is the workflow id: it is what `call` steps reference and
// what keybindings resolve against, so it has to survive a round-trip through
// the filesystem unchanged.
function workflowIdForName(name: string): string {
  return name.replace(/\.md$/i, '')
}

// The longest stem we will write, matching `custom-themes.ts`. Leaves room for
// `.md` plus the atomic-write `.<pid>.<ts>.tmp` suffix inside NAME_MAX (255),
// so pasting a paragraph as a workflow name truncates instead of failing the
// save with ENAMETOOLONG.
const MAX_SLUG_LENGTH = 64

/**
 * A filename stem that cannot leave the workflows directory: lowercase letters,
 * digits and single dashes. Mirrors `safeSlug` in `templates.ts` and `slugify`
 * in `custom-themes.ts`.
 *
 * Defensive on purpose. The slug is derived from the workflow's `name`, which
 * is whatever the user typed into the frontmatter, so `My Books!`, `../../evil`
 * and `/etc/passwd` all arrive here. Dropping every separator (rather than
 * rejecting) means the save still succeeds, which is the right call for a field
 * the user is editing live.
 */
function safeSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    // After the slice, so truncating onto a dash cannot leave a trailing one.
    .replace(/^-+|-+$/g, '')
  return cleaned || 'workflow'
}

/**
 * Resolve a vault-relative sourcePath to an absolute path, rejecting anything
 * outside the flat workflows directory (no traversal, no subdirectories).
 *
 * Exported because every future workflow read/write has to pass through the
 * same gate; a second copy of this check is a second chance to get it wrong.
 */
export function resolveWorkflowPath(root: string, sourcePath: string): string {
  const dir = workflowsDir(root)
  const abs = path.resolve(root, sourcePath)
  const rel = path.relative(dir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error(`Refusing workflow path outside workflows dir: ${sourcePath}`)
  }
  if (!abs.toLowerCase().endsWith('.md')) {
    throw new Error(`Workflow path must be a .md file: ${sourcePath}`)
  }
  return abs
}

/**
 * Every workflow file in the vault, raw. A missing directory is the normal
 * case (most vaults never author a workflow), so it reads as an empty list
 * rather than an error the renderer would have to special-case.
 */
export async function listWorkflowFiles(root: string): Promise<WorkflowFile[]> {
  const dir = workflowsDir(root)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return [] // no workflows dir yet
  }
  const files: WorkflowFile[] = []
  for (const name of entries) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue
    const sourcePath = sourcePathForName(name)
    try {
      const raw = await fs.readFile(resolveWorkflowPath(root, sourcePath), 'utf8')
      files.push({ id: workflowIdForName(name), sourcePath, raw })
    } catch (err) {
      console.warn(`[workflows] skipping unreadable workflow ${name}:`, err)
    }
  }
  // By id, because that is the order the palette and the workflow list show,
  // and readdir order is filesystem-dependent.
  files.sort((a, b) => a.id.localeCompare(b.id))
  return files
}

/**
 * Create or overwrite a workflow file, returning it exactly as
 * `listWorkflowFiles` would report it, so the renderer can splice the result
 * straight into its list without a re-read.
 *
 * Overwrites rather than de-duplicating, which is where this parts ways with
 * `writeCustomTemplate`: the filename stem *is* the workflow id that `call`
 * steps and keybindings resolve against, so saving the same workflow twice has
 * to land on the same file instead of quietly forking into `reading-log-2`.
 *
 * Parse-free like the rest of this module: `raw` is written byte for byte and
 * the frontmatter is never inspected.
 */
export async function writeWorkflowFile(
  root: string,
  input: WriteWorkflowInput
): Promise<WorkflowFile> {
  const name = `${safeSlug(input.slug)}.md`
  const sourcePath = sourcePathForName(name)
  // Through the same gate as list and delete even though `safeSlug` has already
  // made an escape impossible: one guard on every path that touches disk means
  // there is only one place this can be got wrong.
  const abs = resolveWorkflowPath(root, sourcePath)
  // Resolved before anything is written so a malicious `previousSourcePath`
  // is rejected up front rather than halfway through a rename.
  const prevAbs = input.previousSourcePath
    ? resolveWorkflowPath(root, input.previousSourcePath)
    : null

  // Most vaults never author a workflow, so this directory usually does not
  // exist yet; the first save has to create it. Explicit rather than leaning on
  // whatever `writeFileAtomic` happens to do, since that is its business.
  await fs.mkdir(workflowsDir(root), { recursive: true })
  // Temp file + fsync + rename. A crash mid-save must not truncate a workflow
  // the user already had, and the vault watcher must never observe half a file.
  await writeFileAtomic(abs, input.raw)

  // A rename during an edit. The old file goes only after the new one is
  // durably in place, so a failed write leaves the original as the surviving
  // copy instead of destroying both. On a case-insensitive filesystem two
  // differently-cased paths can name the SAME file the write just landed on,
  // so compare file identity, never path spelling: a spelling compare deleted
  // the workflow that was just saved.
  if (prevAbs && prevAbs !== abs) {
    let sameFile = false
    try {
      const [prevStat, newStat] = await Promise.all([fs.stat(prevAbs), fs.stat(abs)])
      sameFile = prevStat.dev === newStat.dev && prevStat.ino === newStat.ino
    } catch {
      // Either side unstattable: the remove below treats a missing file as done.
    }
    if (!sameFile) await fs.rm(prevAbs, { force: true })
  }

  return { id: workflowIdForName(name), sourcePath, raw: input.raw }
}

/**
 * Delete a workflow file. An already-missing file is success: the caller asked
 * for it to be gone, and that is the state it is in.
 */
export async function deleteWorkflowFile(root: string, sourcePath: string): Promise<void> {
  await fs.rm(resolveWorkflowPath(root, sourcePath), { force: true })
}

/* -------------------------------------------------------------------------- */
/*  Sharing: the file leaves and comes back as a file                         */
/* -------------------------------------------------------------------------- */

/**
 * The most a workflow file may weigh, in bytes.
 *
 * The largest preset in the product is well under 2 KB, so this is three orders
 * of magnitude of headroom and still small enough that a file picked by mistake
 * (a video, a database dump) is refused in one stat instead of being read into
 * memory and then parsed. Import is the one path here that reads a file nobody
 * in this app wrote, so it is the one path that has to assume the worst.
 */
export const MAX_IMPORT_BYTES = 512 * 1024

/**
 * A filename for a native save dialog: no separators, no traversal, `.md`.
 *
 * The suggestion comes from the renderer, which derived it from a workflow id,
 * which came from a filename the user may have typed. It is only a default in a
 * dialog the user then confirms, but a default that walks out of the folder the
 * dialog opened in is still a surprise worth refusing.
 */
export function safeExportFilename(name: string): string {
  const cleaned = name
    .replace(/\.md$/i, '')
    .replace(/[/\\]+/g, '-')
    // Reserved on Windows, and noise in a filename everywhere else. Control
    // characters go with them: a name is allowed to be odd, not unprintable.
    .replace(/[<>:"|?*\x00-\x1f]+/g, '-')
    // Whitespace joins into the same separator, so a spaced name reads as a
    // slug rather than losing its words.
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, 64)
    // Last, so truncating onto a separator cannot leave one behind, and so the
    // `..` a traversal attempt left as text goes with it rather than heading a
    // filename with a run of dots.
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${cleaned || 'workflow'}.md`
}

/**
 * Read a file the user picked, as a workflow candidate.
 *
 * Returns bytes and a stem, and nothing else: whether this is a workflow at all
 * is the review's question, in the renderer, and answering it here would be a
 * second parser to keep in step with the first. Refuses a file too large to be
 * one before reading it, so a wrong pick costs a stat rather than a gigabyte.
 */
export async function readWorkflowImportFile(
  abs: string
): Promise<{ name: string; raw: string }> {
  // One handle for the stat AND the read, so the size that was checked is the
  // size of the very file being read: a path-stat followed by a path-read
  // leaves a window where the file can be swapped or grown. The byte cap is
  // re-checked on what actually arrived, which closes the tail of that window
  // (a file appended to after the fstat) for the cost of one comparison.
  const handle = await fs.open(abs, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error('That is not a file.')
    }
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new Error(
        `That file is ${Math.round(stat.size / 1024)} KB, which is far larger than any workflow.`
      )
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_IMPORT_BYTES) {
      throw new Error(
        `That file is ${Math.round(bytes.byteLength / 1024)} KB, which is far larger than any workflow.`
      )
    }
    return { name: path.basename(abs).replace(/\.md$/i, ''), raw: bytes.toString('utf8') }
  } finally {
    await handle.close()
  }
}
