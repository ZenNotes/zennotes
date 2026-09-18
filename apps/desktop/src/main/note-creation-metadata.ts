import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const metadataDirectory = '.zennotes/note-metadata'
const metadataSuffix = '.metadata.json'

export async function noteMetadataPath(
  root: string,
  rel: string,
  directory = false,
): Promise<string> {
  const base = path.resolve(root, metadataDirectory)
  const target = path.resolve(base, rel + (directory ? '' : metadataSuffix))
  if (target === base || !target.startsWith(base + path.sep))
    throw new Error('Path escapes note metadata')
  // Metadata is app-owned. A sidecar link must never redirect a save outside
  // the vault, even when the Markdown itself is intentionally symlinked.
  let current = path.resolve(root)
  for (const part of path.relative(current, target).split(path.sep)) {
    current = path.join(current, part)
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error('Symlinked note metadata is not supported')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return target
}

async function readCreationMetadata(abs: string): Promise<number | null> {
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let value: { version?: unknown; createdAt?: unknown }
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid note creation metadata: ${abs}`)
  }
  if (
    raw.length > 4096 ||
    value?.version !== 1 ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0 ||
    value.createdAt > 8640000000000000
  )
    throw new Error(`Invalid note creation metadata: ${abs}`)
  return value.createdAt
}

export async function readNoteCreatedAt(
  root: string,
  rel: string,
  fallback: number,
): Promise<number> {
  try {
    return (
      (await readCreationMetadata(await noteMetadataPath(root, rel))) ??
      fallback
    )
  } catch {
    // Corrupt optional metadata must not hide the user's Markdown. Saves are
    // stricter, so they cannot silently discard a date that needs repair.
    return fallback
  }
}

export async function prepareNoteCreation(
  root: string,
  rel: string,
): Promise<void> {
  if (
    rel.replaceAll('\\', '/').startsWith('.zennotes/') ||
    !/\.(md|excalidraw)$/i.test(rel)
  )
    return
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root) + path.sep))
    throw new Error('Path escapes vault')
  const metadata = await noteMetadataPath(root, rel)
  // Stat before reading metadata: a concurrent writer publishes the original
  // date before replacing the inode, so observing the new inode is safe.
  const previous = await fs.stat(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!previous) {
    await fs.rm(metadata, { force: true })
    return
  }
  if ((await readCreationMetadata(metadata)) !== null) return
  const createdAt = Math.trunc(previous.birthtimeMs || previous.ctimeMs)
  await fs.mkdir(path.dirname(metadata), { recursive: true })
  const temporary = `${metadata}.${process.pid}.${Date.now()}${String(randomInt(1000000)).padStart(6, '0')}.tmp`
  try {
    const file = await fs.open(temporary, 'wx', previous.mode & 0o777)
    try {
      await file.writeFile(JSON.stringify({ version: 1, createdAt }) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, metadata)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function removeNoteCreation(
  root: string,
  rel: string,
  directory = false,
): Promise<void> {
  await fs.rm(await noteMetadataPath(root, rel, directory), {
    force: true,
    recursive: directory,
  })
}

export async function moveWithCreationMetadata(
  root: string,
  from: string,
  to: string,
  directory = false,
): Promise<void> {
  if (from === to) return
  const source = await noteMetadataPath(
    root,
    path.relative(root, from),
    directory,
  )
  const target = await noteMetadataPath(
    root,
    path.relative(root, to),
    directory,
  )
  const exists = async (abs: string): Promise<boolean> =>
    fs.lstat(abs).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      },
    )
  const hasMetadata = await exists(source)
  if (await exists(target))
    throw new Error(`Destination metadata already exists: ${target}`)
  if (hasMetadata) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
  }
  try {
    await fs.rename(from, to)
  } catch (error) {
    if (hasMetadata) {
      try {
        await fs.rename(target, source)
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          'Note move and metadata rollback failed; reload before editing',
        )
      }
    }
    throw error
  }
}
