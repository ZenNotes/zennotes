import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { PortableVaultFiles } from './host'
import { MemoryVaultFileSystem } from './memory-fs'
import { PortableVault } from './vault-fs'
import { isUntouchedInboxWelcome, sha256OfText } from './welcome-note'

// A folder opened before its notes arrived (#1023): this app makes `inbox/` on
// first open, and nothing may keep the notes that land beside it out of view.
function fixture(files: string[], dirs: string[] = []) {
  const fs = new MemoryVaultFileSystem()
  for (const file of files) fs.put(file, '')
  for (const dir of dirs) fs.directories.add(dir)
  const vault = new PortableVault('Fixture', fs)
  return { fs, vault }
}
const layout = async (vault: PortableVault) => (await vault.getVaultSettings()).primaryNotesLocation

test('an empty inbox does not hold back folders that arrived beside it', async () => {
  assert.equal(await layout(fixture(['Trips/Rome.md', 'Work/Plan.md'], ['inbox', 'quick', 'archive', 'trash']).vault), 'root')
})

test('an empty inbox does not hold back a loose note at the root', async () => {
  assert.equal(await layout(fixture(['Loose.md'], ['inbox']).vault), 'root')
})

test('dotfiles inside the inbox are not notes', async () => {
  assert.equal(await layout(fixture(['inbox/.DS_Store', 'Trips/Rome.md'], ['inbox']).vault), 'root')
})

test('an inbox with anything in it stays inbox mode, loose folders or not', async () => {
  assert.equal(await layout(fixture(['inbox/Welcome.md', 'Daily/2026-11-04.md']).vault), 'inbox')
})

test('an empty vault and a media-only vault stay inbox mode', async () => {
  assert.equal(await layout(fixture([], ['inbox']).vault), 'inbox')
  assert.equal(await layout(fixture(['VID_1.mp4'], ['inbox']).vault), 'inbox')
})

test('the banner sees notes an inbox-mode vault.json hides when the inbox is empty', async () => {
  const { vault } = fixture(['Trips/Rome.md'], ['inbox'])
  Object.assign(vault, { settingsCache: { ...(await vault.getVaultSettings()), primaryNotesLocation: 'inbox' } })
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner speaks up when an inbox with a note hides folders beside it', async () => {
  const { vault } = fixture(['inbox/First.md', 'Trips/Rome.md'])
  assert.equal(await layout(vault), 'inbox')
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner stays quiet with nothing loose at the root', async () => {
  const { vault } = fixture(['inbox/First.md', 'VID_1.mp4'], ['quick', 'archive', 'trash'])
  assert.equal(await vault.rootContentHiddenByInboxMode(), false)
})

test('a resume that settles the layout re-reads it', async () => {
  const { fs, vault } = fixture([], ['inbox'])
  assert.equal(await layout(vault), 'inbox')
  fs.put('Trips/Rome.md', '')
  Object.assign(vault, { listNotes: async () => [] })
  await vault.rescan()
  assert.equal(await layout(vault), 'root')
})

// The inbox as an empty folder among the notes, once the vault reads root mode.
// A scripted file system, not a disk: every read answers `vaultJson`, writes
// keep nothing, and each mkdir and removal is recorded in the order it ran.
function layoutFixture(vaultJson: string | null, inboxEntries: string[] = []) {
  const made: string[] = []
  const removed: string[] = []
  const fs: Partial<PortableVaultFiles> = {
    rootLabel: '/fixture',
    readdir: async (dir: string) =>
      dir === 'inbox'
        ? inboxEntries.map((name) => ({ name, type: 'file' as const, size: 0, mtime: 0 }))
        : dir === ''
          ? [{ name: 'inbox', type: 'directory' as const, size: 0, mtime: 0 }]
          : [],
    statVerified: async (rel: string) => (rel === 'inbox/.DS_Store' && inboxEntries.includes('.DS_Store') ? 'file' : null),
    deleteFile: async (rel: string) => { removed.push(rel) },
    readTextOrNull: async () => vaultJson,
    writeText: async () => {},
    mkdir: async (dir: string) => { made.push(dir) },
    rmdirIfEmpty: async (dir: string) => { removed.push(dir) },
    rmdir: async () => { throw new Error('never the recursive rmdir') }
  }
  const vault = new PortableVault('Fixture', fs as PortableVaultFiles)
  return { vault, made, removed }
}
const stated = (primary: string, extra: object = {}) => JSON.stringify({ primaryNotesLocation: primary, ...extra })

test('a folder that states no layout gets no inbox on open', async () => {
  const { vault, made } = layoutFixture(null)
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['quick', 'archive', 'trash'])
})

test('a vault that states inbox mode still gets its inbox on open', async () => {
  const { vault, made } = layoutFixture(stated('inbox'))
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['inbox', 'quick', 'archive', 'trash'])
})

test('going to root mode takes an empty inbox with it', async () => {
  const { vault, removed } = layoutFixture(stated('inbox'))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, ['inbox'])
})

test('going to root mode leaves an inbox holding anything, a dotfile included', async () => {
  for (const entries of [['Welcome.md'], ['.obsidian']]) {
    const { vault, removed } = layoutFixture(stated('inbox'), entries)
    await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
    assert.deepEqual(removed, [])
  }
})

test("going to root mode reads past Finder's .DS_Store, as the desktop does", async () => {
  const { vault, removed } = layoutFixture(stated('inbox'), ['.DS_Store'])
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, ['inbox/.DS_Store', 'inbox'])
})

test('a vault already in root mode keeps a folder of its own named inbox', async () => {
  const { vault, removed } = layoutFixture(stated('root'))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, [])
})

test('going to root mode leaves a folder the inbox was remapped to', async () => {
  const { vault, removed } = layoutFixture(stated('inbox', { systemFolderPaths: { inbox: '01 - Entry' } }))
  await vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.deepEqual(removed, [])
})

// ---------------------------------------------------------------------------
// Android cases (zennotesandroid src/bridge/vault-layout-inference.test.ts):
// the desktop's untouched Welcome in a phone-opened vault, and the moves
// that set it aside while it is looked at.
// ---------------------------------------------------------------------------

/** The Welcome desktop seeds today (ZenNotes vault.ts WELCOME_NOTE), the text
 *  of Android's fixtures/desktop-welcome.md. */
const DESKTOP_WELCOME = [
  '# Welcome to ZenNotes',
  '',
  'ZenNotes is a **file-based** markdown notes app made for focus and deep work. Every note is a plain `.md` file in your vault, yours to keep, sync, and version however you like.',
  '',
  '## What you get',
  '',
  '- **GitHub-flavored markdown**: tables, task lists, footnotes, strikethrough',
  '- **Wiki links**: jump between notes with [[double brackets]]',
  '- **Tags**: write a hashtag like `#project` in any note and it appears in the sidebar',
  '- **Math**: inline like $e^{i\\pi}+1=0$ or as blocks',
  '- **Callouts**: Obsidian-style `> [!note]` blocks',
  '- **Mermaid diagrams**: code-fenced ```mermaid blocks render inline',
  '- **Full-text search**: press `Space s t` in Vim mode, or run **Search Text in Vault** from the command palette',
  '',
  '## Try it',
  '',
  '- [ ] Write your first note',
  '- [ ] Link to [[another note]]',
  '',
  '> [!tip]',
  '> Press the + button in the sidebar to create a new note. Your changes save automatically.',
  '',
  '```js',
  '// Syntax-highlighted code blocks just work',
  'function hello(name) {',
  '  return `Hello, ${name}!`',
  '}',
  '```',
  '',
  'Enjoy the quiet.',
  ''
].join('\n')

/** The in-memory disk, with every mkdir recorded, a hook after each rename
 *  (an edit landing while the Welcome is set aside) and a recursive rmdir
 *  that must never run. */
class SettlingFs extends MemoryVaultFileSystem {
  readonly made: string[] = []
  afterRename?: (to: string) => void

  override async mkdir(path: string): Promise<void> {
    this.made.push(path)
    await super.mkdir(path)
  }

  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to)
    this.afterRename?.(to)
  }

  override async rmdir(): Promise<void> {
    throw new Error('never the recursive rmdir')
  }
}

/** A file per string, an empty folder per null; undefined entries (from
 *  spreading fixtures of different shapes) are not there. */
function memoryVault(entries: Record<string, string | null | undefined>) {
  const fs = new SettlingFs()
  for (const [path, body] of Object.entries(entries)) {
    if (body === undefined) continue
    if (body !== null) {
      fs.put(path, body)
      continue
    }
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) fs.directories.add(parts.slice(0, i).join('/'))
  }
  const vault = new PortableVault('Fixture', fs)
  return { vault, fs, files: fs.files, dirs: fs.directories }
}
const VAULT_JSON = '.zennotes/vault.json'
const toRoot = async (vault: PortableVault) =>
  vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })

describe('Android cases', () => {
  test('the fixture is the Welcome desktop seeds today, which the list must hold', async () => {
    assert.equal(isUntouchedInboxWelcome('Welcome.md', await sha256OfText(DESKTOP_WELCOME)), true)
    assert.equal(isUntouchedInboxWelcome('Welcome.md', await sha256OfText(`${DESKTOP_WELCOME}x`)), false)
  })

  test('an inbox holding only an untouched desktop Welcome reads as empty for the layout', async () => {
    assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Trips/Rome.md': '# Rome\n' }).vault), 'root')
    assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n`, 'Trips/Rome.md': '# Rome\n' }).vault), 'inbox')
    assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'inbox/Mine.md': '# Mine\n', 'Trips/Rome.md': '# Rome\n' }).vault), 'inbox')
  })

  test("a desktop's untouched Welcome goes, with its creation date, beside other notes", async () => {
    const { vault, fs, files, dirs } = memoryVault({
      'inbox/Welcome.md': DESKTOP_WELCOME,
      '.zennotes/note-metadata/inbox/Welcome.md.metadata.json': '{}',
      'Trips/Rome.md': '# Rome\n'
    })
    assert.equal(await vault.settleSeededInbox(), true)
    assert.equal(dirs.has('inbox'), false)
    assert.equal(files.has('.zennotes/note-metadata/inbox/Welcome.md.metadata.json'), false)
    assert.equal(fs.text('Trips/Rome.md'), '# Rome\n')
  })

  test('a rescan settles a vault that filled up after it opened', async () => {
    const { vault, fs, dirs } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.equal(dirs.has('inbox'), true, 'alone, the Welcome stays')
    fs.put('Loose.md', '# Loose\n')
    Object.assign(vault, { listNotes: async () => [] })
    await vault.rescan()
    assert.equal(dirs.has('inbox'), false)
  })

  test('an automatic look never removes an empty inbox: it may be a capture tool\'s', async () => {
    const { vault, dirs } = memoryVault({ inbox: null, 'Loose.md': '# Loose\n' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.equal(dirs.has('inbox'), true)
  })

  test('keeps an edited Welcome, a commented one, and one beside another note', async () => {
    for (const extra of [
      { 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n` },
      { 'inbox/Welcome.md': DESKTOP_WELCOME, '.zennotes/comments/inbox/Welcome.md.comments.json': '{}' },
      { 'inbox/Welcome.md': DESKTOP_WELCOME, 'inbox/Mine.md': '# Mine\n' }
    ]) {
      const { vault, files } = memoryVault({ ...extra, 'Loose.md': '# Loose\n' })
      assert.equal(await vault.settleSeededInbox(), false)
      assert.equal(files.has('inbox/Welcome.md'), true)
    }
  })

  test('keeps an edit that lands while the Welcome is being looked at', async () => {
    const { vault, fs } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
    fs.afterRename = (to) => { if (to.includes('.Welcome.settling-')) fs.put(to, `${DESKTOP_WELCOME}typed\n`) }
    assert.equal(await vault.settleSeededInbox(), false)
    assert.equal(fs.text('inbox/Welcome.md'), `${DESKTOP_WELCOME}typed\n`)
  })

  test('keeps a Welcome saved while the seed is out of the way, and the folder with it', async () => {
    const { vault, fs, files, dirs } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
    fs.afterRename = (to) => {
      if (!to.includes('.Welcome.settling-')) return
      fs.put(to, `${DESKTOP_WELCOME}typed\n`)
      fs.put('inbox/Welcome.md', '# Newer\n')
    }
    assert.equal(await vault.settleSeededInbox(), false)
    assert.equal(fs.text('inbox/Welcome.md'), '# Newer\n')
    assert.ok([...files.keys()].some((path) => /^inbox\/Welcome .+\.md$/.test(path)))
    assert.equal(dirs.has('inbox'), true)
  })

  test('does nothing in a vault that states inbox mode, a remapped inbox or a capitalized one', async () => {
    for (const entries of [
      { [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME },
      { [VAULT_JSON]: stated('root', { systemFolderPaths: { inbox: '01 - Entry' } }), 'inbox/Welcome.md': DESKTOP_WELCOME },
      { 'Inbox/Welcome.md': DESKTOP_WELCOME }
    ]) {
      const { vault, files } = memoryVault({ ...entries, 'Loose.md': '# Loose\n' })
      assert.equal(await vault.settleSeededInbox(), false)
      assert.ok(files.has('inbox/Welcome.md') || files.has('Inbox/Welcome.md'))
    }
  })

  test('going to root mode keeps the Welcome until there is something else to look at', async () => {
    const { vault, fs, files } = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME })
    await toRoot(vault)
    assert.equal(files.has('inbox/Welcome.md'), true)
    fs.put('Loose.md', '# Loose\n')
    assert.equal(await vault.settleSeededInbox(), true)
    assert.equal(files.has('inbox/Welcome.md'), false)
  })

  test('going to root mode takes a seed-only inbox, and keeps one with an edited Welcome', async () => {
    const seeded = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
    await toRoot(seeded.vault)
    assert.equal(seeded.dirs.has('inbox'), false)
    const edited = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n`, 'Loose.md': '# Loose\n' })
    await toRoot(edited.vault)
    assert.equal(edited.files.has('inbox/Welcome.md'), true)
  })

  // The rest repeat cases the scripted file system above runs, on a disk
  // where the folders really go (or stay).
  test('going to root mode takes an empty inbox, and what Finder left in it, with it', async () => {
    for (const extra of [{ inbox: null }, { 'inbox/.DS_Store': 'x' }]) {
      const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox'), ...extra })
      await toRoot(vault)
      assert.equal(dirs.has('inbox'), false)
    }
  })

  test('going to root mode leaves an inbox holding a note, or another dotfile', async () => {
    for (const extra of [{ 'inbox/Mine.md': '# Mine\n' }, { 'inbox/.hidden': 'x' }]) {
      const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox'), ...extra })
      await toRoot(vault)
      assert.equal(dirs.has('inbox'), true)
    }
  })

  test('a folder that states no layout gets no inbox on open', async () => {
    const { vault, fs } = memoryVault({})
    await vault.ensureVaultLayout()
    assert.deepEqual(fs.made, ['quick', 'archive', 'trash'])
  })

  test('a vault that states inbox mode still gets its inbox on open', async () => {
    const { vault, fs } = memoryVault({ [VAULT_JSON]: stated('inbox') })
    await vault.ensureVaultLayout()
    assert.deepEqual(fs.made, ['inbox', 'quick', 'archive', 'trash'])
  })

  test('a vault already in root mode keeps a folder of its own named inbox', async () => {
    const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('root'), inbox: null })
    await toRoot(vault)
    assert.equal(dirs.has('inbox'), true)
  })

  test('going to root mode leaves a folder the inbox was remapped to', async () => {
    const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox', { systemFolderPaths: { inbox: '01 - Entry' } }), '01 - Entry': null })
    await toRoot(vault)
    assert.equal(dirs.has('01 - Entry'), true)
  })
})
