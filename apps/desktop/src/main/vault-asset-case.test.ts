import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSettings } from '@shared/ipc'
import {
  assetBelongsToFolderView,
  assetFolderSubpath,
  folderForVaultRelativePath,
  noteBelongsToFolderView,
  noteFolderSubpath
} from '@renderer/lib/vault-layout'
import { listAssets, listNotes } from './vault'

// End-to-end reproduction of #186 wiring the REAL main-process vault walk to the
// REAL renderer classifier. The bug: on a case-insensitive filesystem an inbox
// folder stored as `Inbox/` (capital) makes `listNotes` emit lowercase
// `inbox/…` paths (built from `folderRoot()`), while `listAssets` walks real
// directory entries and emits `Inbox/…`. The renderer then classified the
// capital asset paths to `null` and hid every image/PDF.

const tempDirs: string[] = []

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-186-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const inboxSettings = { primaryNotesLocation: 'inbox' } as VaultSettings

describe('#186 — capitalized Inbox folder keeps its images/PDFs visible', () => {
  it('classifies real listAssets output for a capital Inbox/ into the inbox view', async () => {
    const root = await makeTempVault()
    // A folder physically named "Inbox" (capital) — exactly the reporter's vault.
    await mkdir(path.join(root, 'Inbox'), { recursive: true })
    await writeFile(path.join(root, 'Inbox', 'note.md'), '# hi', 'utf8')
    await writeFile(path.join(root, 'Inbox', 'photo.png'), 'x', 'utf8')
    await writeFile(path.join(root, 'Inbox', 'doc.pdf'), 'x', 'utf8')

    const assets = await listAssets(root)
    const photo = assets.find((a) => a.name === 'photo.png')
    const pdf = assets.find((a) => a.name === 'doc.pdf')

    // listAssets preserves the on-disk casing ("Inbox/…"), which is the crux.
    expect(photo?.path).toBe('Inbox/photo.png')
    expect(pdf?.path).toBe('Inbox/doc.pdf')

    // The fix: the renderer now folds that capital path into the inbox view at
    // the top level (subpath ''), instead of returning null and hiding it.
    expect(folderForVaultRelativePath(photo!.path, inboxSettings)).toBe('inbox')
    expect(folderForVaultRelativePath(pdf!.path, inboxSettings)).toBe('inbox')
    expect(assetFolderSubpath(photo!, inboxSettings)).toBe('')
  })

  it('puts a nested capital asset in the same subpath tree as its sibling note', async () => {
    const root = await makeTempVault()
    await mkdir(path.join(root, 'Inbox', 'Projects'), { recursive: true })
    await writeFile(path.join(root, 'Inbox', 'Projects', 'plan.md'), '# plan', 'utf8')
    await writeFile(path.join(root, 'Inbox', 'Projects', 'diagram.png'), 'x', 'utf8')

    const assets = await listAssets(root)
    const diagram = assets.find((a) => a.name === 'diagram.png')

    // Both note and asset paths come back with the on-disk capital casing,
    // because `realpath` (used for symlink-loop detection in the walk) resolves
    // `inbox` → `Inbox` on a case-insensitive filesystem.
    expect(diagram?.path).toBe('Inbox/Projects/diagram.png')
    expect(folderForVaultRelativePath(diagram!.path, inboxSettings)).toBe('inbox')
    expect(assetFolderSubpath(diagram!, inboxSettings)).toBe('Projects')
    expect(assetBelongsToFolderView(diagram!, 'inbox', 'Projects', inboxSettings)).toBe(true)

    // On a case-insensitive FS, prove the note half: it shows (folder assigned
    // by the walk) AND resolves to the SAME "Projects" subpath as its image, so
    // they group together in the file browser instead of splitting apart.
    const caseInsensitive = await stat(path.join(root, 'inbox'))
      .then(() => true)
      .catch(() => false)
    if (caseInsensitive) {
      const notes = await listNotes(root)
      const plan = notes.find((n) => n.title === 'plan')
      expect(plan?.folder).toBe('inbox')
      expect(plan?.path).toBe('Inbox/Projects/plan.md')
      expect(noteFolderSubpath(plan!, inboxSettings)).toBe('Projects')
      expect(noteBelongsToFolderView(plan!, 'inbox', 'Projects', inboxSettings)).toBe(true)
      // The asset and its sibling note resolve to one and the same node.
      expect(noteFolderSubpath(plan!, inboxSettings)).toBe(
        assetFolderSubpath(diagram!, inboxSettings)
      )
    }
  })
})
