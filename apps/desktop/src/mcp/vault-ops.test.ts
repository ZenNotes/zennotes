import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseOpenNoteDeepLink } from '../main/deep-links'
import {
  createNote,
  insertAtLineInBody,
  listNotes,
  renameNote,
  replaceInBody,
  scanAllTasks,
  searchText,
  toggleTaskInBody
} from './vault-ops'

// Every note-shaped MCP result carries `link`, the zennotes:// deep link a
// model renders as a markdown link so the user can click from chat straight
// into the app (#509). These tests pin the field at each source: the shared
// meta reader, the text-search hit, the task scanner, and a mutation receipt.

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-ops-'))
  await mkdir(path.join(root, 'inbox', 'GitHub'), { recursive: true })
  await writeFile(
    path.join(root, 'inbox', 'GitHub', 'Rename -master- branch (howto).md'),
    '# Rename\n\nrename the default branch\n\n- [ ] actually do it\n'
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('mcp note links (#509)', () => {
  it('list_notes metadata carries a link that round-trips to the same path', async () => {
    const notes = await listNotes(root)
    const note = notes.find((n) => n.title.startsWith('Rename'))
    expect(note).toBeDefined()
    expect(note!.link).toBe(
      'zennotes://open?path=inbox/GitHub/Rename%20-master-%20branch%20%28howto%29.md'
    )
    expect(parseOpenNoteDeepLink(note!.link)).toEqual({ target: 'tab', path: note!.path })
  })

  it('text search hits carry the link of the matched note', async () => {
    const hits = await searchText(root, 'default branch', 10)
    expect(hits).toHaveLength(1)
    expect(parseOpenNoteDeepLink(hits[0].link)).toEqual({ target: 'tab', path: hits[0].path })
  })

  it('tasks carry the link of their source note', async () => {
    const tasks = await scanAllTasks(root)
    expect(tasks).toHaveLength(1)
    expect(parseOpenNoteDeepLink(tasks[0].link)).toEqual({
      target: 'tab',
      path: tasks[0].sourcePath
    })
  })

  it('mutation receipts carry the link of the note they produced', async () => {
    const meta = await createNote(root, 'inbox', 'From Chat (draft)')
    expect(meta.link).toContain('zennotes://open?path=')
    expect(parseOpenNoteDeepLink(meta.link)).toEqual({ target: 'tab', path: meta.path })
  })
})

// The MCP scanner hand-rolls its own task-line parser (it cannot import the
// app-core one), so the state chars are a copy that drifts silently. This pins
// them against shared-domain: a state the app understands must never make a
// task invisible to a model reading the same vault.
describe('mcp task states', () => {
  it('scans every state char, flagging in progress and cancelled', async () => {
    await writeFile(
      path.join(root, 'inbox', 'States.md'),
      '# States\n\n- [ ] open\n- [/] started\n- [x] done\n- [-] scrapped\n- [>] gone\n'
    )
    const tasks = await scanAllTasks(root)
    const byContent = new Map(tasks.map((t) => [t.content, t]))
    expect([...byContent.keys()].sort()).toEqual(
      ['actually do it', 'done', 'gone', 'open', 'scrapped', 'started'].sort()
    )
    expect(byContent.get('started')?.inProgress).toBe(true)
    expect(byContent.get('started')?.checked).toBe(false)
    expect(byContent.get('scrapped')?.cancelled).toBe(true)
    expect(byContent.get('open')?.inProgress).toBe(false)
    expect(byContent.get('done')?.checked).toBe(true)
  })

  it('toggle follows the app rules: [/] checks off, records stay (#599)', () => {
    const body = '- [ ] open\n- [/] started\n- [x] done\n- [-] scrapped\n- [>] gone\n'
    expect(toggleTaskInBody(body, 0)).toContain('- [x] open')
    expect(toggleTaskInBody(body, 1)).toContain('- [x] started')
    expect(toggleTaskInBody(body, 2)).toContain('- [ ] done')
    expect(toggleTaskInBody(body, 3)).toContain('- [-] scrapped')
    expect(toggleTaskInBody(body, 4)).toContain('- [>] gone')
  })
})

describe('remapped system folders (#398)', () => {
  it('classifies a remapped trash directory as trash and keeps its tasks out', async () => {
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ systemFolderPaths: { trash: '99 - Deleted' } })
    )
    await mkdir(path.join(root, '99 - Deleted'), { recursive: true })
    await writeFile(
      path.join(root, '99 - Deleted', 'Gone.md'),
      '# Gone\n\n- [ ] should never surface as a live task\n'
    )

    const notes = await listNotes(root)
    const gone = notes.find((n) => n.path.startsWith('99 - Deleted/'))
    expect(gone?.folder).toBe('trash')

    const tasks = await scanAllTasks(root)
    expect(tasks.some((t) => t.sourcePath.startsWith('99 - Deleted/'))).toBe(false)
    expect(tasks.some((t) => t.sourcePath.includes('Rename'))).toBe(true)
  })

  it('rejects traversal and colliding overrides like the shared normalizer', async () => {
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ systemFolderPaths: { trash: '../outside', inbox: 'archive' } })
    )
    const notes = await listNotes(root)
    // Both overrides are invalid, so the defaults hold: the seeded inbox note
    // still classifies as inbox.
    expect(notes.some((n) => n.folder === 'inbox')).toBe(true)
  })

  // A swap resolves without any collision, so the collision loop let it
  // through and every folder then read as its opposite.
  it('rejects a full inbox/archive swap', async () => {
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ systemFolderPaths: { inbox: 'archive', archive: 'inbox' } })
    )
    const notes = await listNotes(root)
    expect(notes.find((n) => n.title.startsWith('Rename'))?.folder).toBe('inbox')
  })

  // The literal default name is no longer the system folder once that folder
  // has moved: `trash/` is then an ordinary user folder inside the inbox.
  it('treats a leftover literal trash/ as a user folder when trash is remapped', async () => {
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'vault.json'),
      JSON.stringify({ systemFolderPaths: { trash: '99 - Deleted' } })
    )
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Kept.md'), '# Kept\n')

    const notes = await listNotes(root)
    expect(notes.find((n) => n.path === 'trash/Kept.md')?.folder).toBe('inbox')
  })
})

// The renderer syncs a note's leading `# Heading` to its filename on rename
// (#455). A rename through MCP writes the same file, so the setting has to
// mean the same thing there, or half the rename paths quietly ignore it.
describe('rename_note heading sync (#455)', () => {
  let configDir: string
  const previousConfigDir = process.env.ZENNOTES_CONFIG_DIR

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-config-'))
    process.env.ZENNOTES_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.ZENNOTES_CONFIG_DIR
    else process.env.ZENNOTES_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  const writeConfig = async (on: boolean): Promise<void> => {
    await writeFile(
      path.join(configDir, 'config.toml'),
      `[editor]\nsync_title_heading_on_rename = ${on}\n`
    )
  }

  it('rewrites the leading heading when the setting is on', async () => {
    await writeConfig(true)
    const meta = await renameNote(root, 'inbox/GitHub/Rename -master- branch (howto).md', 'Branches')
    expect(meta.path).toBe('inbox/GitHub/Branches.md')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toContain('# Branches\n')
  })

  it('leaves the body byte-identical when the setting is off', async () => {
    await writeConfig(false)
    const meta = await renameNote(root, 'inbox/GitHub/Rename -master- branch (howto).md', 'Branches')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toContain('# Rename\n')
  })

  it('defaults to on when no portable config file exists', async () => {
    const meta = await renameNote(root, 'inbox/GitHub/Rename -master- branch (howto).md', 'Branches')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toContain('# Branches\n')
  })

  it('never invents a heading for a note that has none', async () => {
    await writeConfig(true)
    await writeFile(path.join(root, 'inbox', 'Plain.md'), 'just prose, no heading\n')
    const meta = await renameNote(root, 'inbox/Plain.md', 'Renamed')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toBe('just prose, no heading\n')
  })

  it('leaves an Obsidian drawing alone (its H1 is structure, not a title)', async () => {
    await writeConfig(true)
    const body = '# Excalidraw Data\n\n## Text Elements\n'
    await writeFile(path.join(root, 'inbox', 'Sketch.excalidraw.md'), body)
    const meta = await renameNote(root, 'inbox/Sketch.excalidraw.md', 'Diagram')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toBe(body)
  })

  it('leaves a drawing saved as a plain .md alone too', async () => {
    await writeConfig(true)
    const body = '---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n'
    await writeFile(path.join(root, 'inbox', 'Board.md'), body)
    const meta = await renameNote(root, 'inbox/Board.md', 'Canvas')
    expect(await readFile(path.join(root, meta.path), 'utf8')).toBe(body)
  })
})

describe('pure body edits shared with the remote backend (#688)', () => {
  it('replaceInBody replaces the first or every occurrence and counts them', () => {
    expect(replaceInBody('a b a', 'a', 'x')).toEqual({ body: 'x b a', replacements: 1 })
    expect(replaceInBody('a b a', 'a', 'x', 'all')).toEqual({ body: 'x b x', replacements: 2 })
    expect(replaceInBody('a b a', 'z', 'x')).toEqual({ body: 'a b a', replacements: 0 })
    expect(() => replaceInBody('a', '', 'x')).toThrow('find is required')
  })

  it('insertAtLineInBody inserts before a zero-based line, clamped, CRLF normalised', () => {
    expect(insertAtLineInBody('one\ntwo', 1, 'mid')).toBe('one\nmid\ntwo')
    expect(insertAtLineInBody('one\r\ntwo', 99, 'end\nmore')).toBe('one\ntwo\nend\nmore')
    expect(insertAtLineInBody('one', -5, 'top')).toBe('top\none')
  })
})
