import assert from 'node:assert/strict'
import { test } from 'vitest'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'
import {
  WELCOME_NOTE_BODY,
  WELCOME_NOTE_TABLET_BODY,
  isUntouchedInboxWelcome,
  sha256OfText,
  welcomeNoteBody
} from './welcome-note'

// The desktop's settleSeededInbox (ZenNotes 4e8c13f8), mirrored: an inbox that only
// holds the untouched Welcome says nothing about the layout, and goes once there
// is something else to look at.
const SEED = 'inbox/Welcome to ZenNotes.md'
const COMMENTS = `.zennotes/comments/${SEED}.comments.json`

/** The in-memory disk, with a hook that runs after each rename (an edit landing
 *  between the move and the re-read) and a recursive rmdir that must never run. */
class SeedFs extends MemoryVaultFileSystem {
  afterRename?: (from: string, to: string) => void

  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to)
    this.afterRename?.(from, to)
  }

  override async rmdir(): Promise<void> {
    throw new Error('never the recursive rmdir')
  }
}

function memoryVault(initial: Record<string, string>, dirs: string[] = []) {
  const fs = new SeedFs()
  for (const [rel, body] of Object.entries(initial)) fs.put(rel, body)
  for (const dir of dirs) fs.directories.add(dir)
  const vault = new PortableVault('Memory', fs)
  return { vault, fs, files: fs.files, folders: fs.directories }
}
const stated = (primary?: string) => JSON.stringify(primary ? { primaryNotesLocation: primary } : { favorites: [] })
const layout = async (vault: PortableVault) => (await vault.getVaultSettings()).primaryNotesLocation

test('both seeds are known by their own hashes, each under its own name', async () => {
  assert.equal(isUntouchedInboxWelcome('Welcome to ZenNotes.md', await sha256OfText(WELCOME_NOTE_BODY)), true)
  // The desktop's current seed text (ZenNotes 4e8c13f8 vault.ts WELCOME_NOTE).
  const desktop = '50c264c87b2790dbb685cd9a699118e1d62e84eb5532701e96d5b1ab55373fac'
  assert.equal(isUntouchedInboxWelcome('Welcome.md', desktop), true)
  assert.equal(isUntouchedInboxWelcome('Welcome to ZenNotes.md', desktop), false)
  assert.equal(isUntouchedInboxWelcome('Welcome.md', await sha256OfText(WELCOME_NOTE_BODY)), false)
})

test('an inbox holding only the untouched Welcome reads as empty for the layout', async () => {
  const { vault } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '# Rome' })
  assert.equal(await layout(vault), 'root')
})

test('a Welcome someone edited or commented on still says inbox mode', async () => {
  assert.equal(await layout(memoryVault({ [SEED]: `${WELCOME_NOTE_BODY}mine`, 'Trips/Rome.md': '' }).vault), 'inbox')
  assert.equal(await layout(memoryVault({ [SEED]: WELCOME_NOTE_BODY, [COMMENTS]: '[]', 'Trips/Rome.md': '' }).vault), 'inbox')
})

test('a fresh vault with only its Welcome stays inbox mode', async () => {
  const { vault, files } = memoryVault({ [SEED]: WELCOME_NOTE_BODY }, ['quick', 'archive', 'trash'])
  assert.equal(await layout(vault), 'inbox')
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(files.has(SEED))
})

test('folders copied in beside the seed take the Welcome and the inbox away', async () => {
  const { vault, fs, files, folders } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'inbox/.DS_Store': '', 'Trips/Rome.md': '# Rome' })
  assert.equal(await vault.settleSeededInbox(), true)
  assert.equal(files.has(SEED), false)
  assert.equal(files.has('inbox/.DS_Store'), false)
  assert.equal(folders.has('inbox'), false)
  assert.equal(fs.text('Trips/Rome.md'), '# Rome')
  assert.equal(await layout(vault), 'root')
})

test("a Welcome is only a seed under its own app's name", async () => {
  const { vault, folders } = memoryVault({ 'inbox/Welcome.md': WELCOME_NOTE_BODY, 'Notes/A.md': '' })
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(folders.has('inbox'))
})

test('an edited Welcome, a comment thread or a second note keeps the inbox', async () => {
  const cases: Record<string, string>[] = [
    { [SEED]: `${WELCOME_NOTE_BODY}\nmine` },
    { [SEED]: WELCOME_NOTE_BODY, [COMMENTS]: '[]' },
    { [SEED]: WELCOME_NOTE_BODY, 'inbox/Second.md': '' }
  ]
  for (const extra of cases) {
    const { vault, files, folders } = memoryVault({ ...extra, 'Trips/Rome.md': '' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.ok(files.has(SEED))
    assert.ok(folders.has('inbox'))
  }
})

test('an empty inbox is never removed on the automatic path', async () => {
  const { vault, folders } = memoryVault({ 'Trips/Rome.md': '' }, ['inbox'])
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(folders.has('inbox'))
})

test('a vault.json that states inbox mode, or exists without saying, keeps the inbox', async () => {
  for (const json of [stated('inbox'), stated()]) {
    const { vault, files } = memoryVault({ '.zennotes/vault.json': json, [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.ok(files.has(SEED))
  }
  const { vault, files } = memoryVault({ '.zennotes/vault.json': stated('root'), [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  assert.equal(await vault.settleSeededInbox(), true)
  assert.equal(files.has(SEED), false)
})

test('an edit carried by the rename goes back, and the inbox stays', async () => {
  const { vault, fs, files, folders } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  fs.afterRename = (from, to) => {
    if (from === SEED) fs.put(to, `${WELCOME_NOTE_BODY}\nsaved just now`)
    fs.afterRename = undefined
  }
  assert.equal(await vault.settleSeededInbox(), false)
  assert.equal(fs.text(SEED), `${WELCOME_NOTE_BODY}\nsaved just now`)
  assert.ok(folders.has('inbox'))
  assert.deepEqual([...files.keys()].filter((rel) => rel.includes('settling')), [])
})

test('switching to root mode takes the seed only beside something else', async () => {
  const lone = memoryVault({ '.zennotes/vault.json': stated('inbox'), [SEED]: WELCOME_NOTE_BODY })
  await lone.vault.setVaultSettings({ ...(await lone.vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.ok(lone.files.has(SEED), 'a vault switched before anything is in it keeps its Welcome')

  const beside = memoryVault({ '.zennotes/vault.json': stated('inbox'), [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  await beside.vault.setVaultSettings({ ...(await beside.vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.equal(beside.files.has(SEED), false)
  assert.equal(beside.folders.has('inbox'), false)
})

test('a folder the inbox was remapped to is never touched', async () => {
  const json = JSON.stringify({ primaryNotesLocation: 'root', systemFolderPaths: { inbox: '01 - Entry' } })
  const { vault, files } = memoryVault({ '.zennotes/vault.json': json, '01 - Entry/Welcome to ZenNotes.md': WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(files.has('01 - Entry/Welcome to ZenNotes.md'))
})

test('the tablet Welcome counts as untouched, and names no circle', async () => {
  assert.equal(isUntouchedInboxWelcome('Welcome to ZenNotes.md', await sha256OfText(WELCOME_NOTE_TABLET_BODY)), true)
  assert.doesNotMatch(WELCOME_NOTE_TABLET_BODY, /circle/i)
  assert.equal(welcomeNoteBody(true), WELCOME_NOTE_BODY)
  assert.equal(welcomeNoteBody(false), WELCOME_NOTE_TABLET_BODY)
})
