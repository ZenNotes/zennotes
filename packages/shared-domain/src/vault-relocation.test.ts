import { describe, expect, it } from 'vitest'
import { relocateVaultEntries, type VaultRelocationIO } from './vault-relocation'

function fixture() {
  const files = new Map([['notes/One.md', 'Exact café 日本語.  \n'], ['comments/One.json', '{unknown fields stay intact}']])
  const io: VaultRelocationIO = {
    stat: async path => files.has(path) ? 'file' : null,
    mkdir: async () => {},
    rename: async (from, to) => {
      if (!files.has(from) || files.has(to)) throw new Error('Collision or missing source')
      files.set(to, files.get(from)!); files.delete(from)
    }
  }
  const entries = [{ from: 'notes/One.md', to: 'notes/Two.md', required: true }, { from: 'comments/One.json', to: 'comments/Two.json' }]
  return { files, io, entries, original: new Map(files) }
}
describe('portable vault relocation', () => {
  it('moves exact content and sidecar bytes together', async () => {
    const s = fixture(); await relocateVaultEntries(s.io, s.entries)
    expect([...s.files]).toEqual([['notes/Two.md', s.original.get('notes/One.md')], ['comments/Two.json', s.original.get('comments/One.json')]])
  })
  it('preflights orphan destination comments before moving content', async () => {
    const s = fixture(); s.files.set('comments/Two.json', 'Do not overwrite')
    await expect(relocateVaultEntries(s.io, s.entries)).rejects.toThrow('Destination already exists')
    expect(s.files.get('notes/One.md')).toBe(s.original.get('notes/One.md'))
    expect(s.files.get('comments/Two.json')).toBe('Do not overwrite')
  })
  it('restores the note when its sidecar move fails', async () => {
    const s = fixture(), rename = s.io.rename
    s.io.rename = async (from, to) => { if (from === 'comments/One.json') throw new Error('Provider refused'); await rename(from, to) }
    await expect(relocateVaultEntries(s.io, s.entries)).rejects.toThrow('Provider refused')
    expect(s.files).toEqual(s.original)
  })
  it('rolls both moves back when metadata cannot be committed', async () => {
    const s = fixture()
    await expect(relocateVaultEntries(s.io, s.entries, async () => { throw new Error('Settings failed') })).rejects.toThrow('Settings failed')
    expect(s.files).toEqual(s.original)
  })
  it('preserves a competing file at the old path and reports an uncertain rollback', async () => {
    const s = fixture()
    await expect(relocateVaultEntries(s.io, s.entries, async () => {
      s.files.set('notes/One.md', 'Created by another client'); throw new Error('Commit failed')
    })).rejects.toThrow('FOLDER_STATE_UNCERTAIN')
    expect(s.files.get('notes/One.md')).toBe('Created by another client')
    expect(s.files.get('notes/Two.md')).toBe(s.original.get('notes/One.md'))
  })
  it('does not treat a provider error as absence and rejects traversal', async () => {
    const s = fixture(); s.io.stat = async () => { throw new Error('Permission denied') }
    await expect(relocateVaultEntries(s.io, s.entries)).rejects.toThrow('Permission denied')
    expect(s.files).toEqual(s.original)
    await expect(relocateVaultEntries(s.io, [{ from: '../outside', to: 'note.md' }])).rejects.toThrow('vault-relative')
  })
})
