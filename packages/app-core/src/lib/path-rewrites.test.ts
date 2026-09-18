import { describe, expect, it } from 'vitest'
import {
  PATH_REWRITE_LOG_LIMIT,
  appendPathRewrite,
  latestPathRewriteSeq,
  pathAfterRewrites,
  pathInScope,
  type PathRewrite
} from './path-rewrites'

const V = '/vault'
const log = (...entries: Array<[string, string | null]>): PathRewrite[] =>
  entries.reduce<PathRewrite[]>((all, [from, to]) => appendPathRewrite(all, V, from, to), [])

describe('path rewrites', () => {
  it('matches a note exactly and a folder by prefix', () => {
    expect(pathInScope('inbox/A.md', 'inbox/A.md')).toBe(true)
    expect(pathInScope('inbox/A.md', 'inbox/A.md.bak')).toBe(false)
    expect(pathInScope('inbox/Work/', 'inbox/Work/A.md')).toBe(true)
    expect(pathInScope('inbox/Work/', 'inbox/Workshop/A.md')).toBe(false)
  })

  it('follows a renamed note', () => {
    const entries = log(['inbox/A.md', 'inbox/B.md'])
    expect(pathAfterRewrites(entries, V, 'inbox/A.md', 0)).toBe('inbox/B.md')
    expect(pathAfterRewrites(entries, V, 'inbox/Other.md', 0)).toBe('inbox/Other.md')
  })

  it('follows a note whose folder was renamed or moved', () => {
    const entries = log(['inbox/Work/', 'inbox/Projects/Work/'])
    expect(pathAfterRewrites(entries, V, 'inbox/Work/Standup.md', 0)).toBe(
      'inbox/Projects/Work/Standup.md'
    )
  })

  it('applies several rewrites in order', () => {
    const entries = log(['inbox/A.md', 'inbox/B.md'], ['inbox/', 'archive/'], ['archive/B.md', 'archive/C.md'])
    expect(pathAfterRewrites(entries, V, 'inbox/A.md', 0)).toBe('archive/C.md')
  })

  it('reports a deleted note as gone, not as renamed', () => {
    const entries = log(['inbox/A.md', null])
    expect(pathAfterRewrites(entries, V, 'inbox/A.md', 0)).toBeNull()
  })

  // What keeps a stale entry from ever making a real note switch look like a
  // rename: a reader passes the last sequence number it has seen.
  it('ignores what the reader has already seen', () => {
    const entries = log(['inbox/A.md', 'inbox/B.md'])
    const seen = latestPathRewriteSeq(entries)
    expect(pathAfterRewrites(entries, V, 'inbox/A.md', seen)).toBe('inbox/A.md')
  })

  it('keeps vaults apart, since paths are relative and repeat', () => {
    const entries = log(['inbox/A.md', 'inbox/B.md'])
    expect(pathAfterRewrites(entries, '/other-vault', 'inbox/A.md', 0)).toBe('inbox/A.md')
  })

  it('never treats the whole-vault scope as a rename', () => {
    const entries = log(['', 'moved/'])
    expect(pathAfterRewrites(entries, V, 'inbox/A.md', 0)).toBe('inbox/A.md')
  })

  it('stays short, and keeps counting when old entries fall off', () => {
    let entries: PathRewrite[] = []
    for (let n = 0; n < PATH_REWRITE_LOG_LIMIT + 5; n++) {
      entries = appendPathRewrite(entries, V, `inbox/${n}.md`, `inbox/${n + 1}.md`)
    }
    expect(entries).toHaveLength(PATH_REWRITE_LOG_LIMIT)
    expect(latestPathRewriteSeq(entries)).toBe(PATH_REWRITE_LOG_LIMIT + 5)
    expect(latestPathRewriteSeq([])).toBe(0)
  })
})
