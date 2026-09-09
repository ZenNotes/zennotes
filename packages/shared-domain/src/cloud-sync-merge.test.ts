import { describe, expect, it } from 'vitest'
import { mergeCloudSyncText, resolveCloudSyncMerge } from './cloud-sync-merge'

describe('mergeCloudSyncText', () => {
  it('combines independent edits without asking the user', () => {
    const result = mergeCloudSyncText(
      '# Trip\n\nPack a coat.\nBook a hotel.\n',
      '# Autumn trip\n\nPack a coat.\nBook a hotel.\n',
      '# Trip\n\nPack a warm coat.\nBook a hotel.\n'
    )

    expect(result.status).toBe('clean')
    expect(result.text).toBe('# Autumn trip\n\nPack a warm coat.\nBook a hotel.\n')
    expect(result.conflicts).toEqual([])
  })

  it('treats the same edit on both devices as agreed', () => {
    const result = mergeCloudSyncText('One\nTwo\n', 'One\nSecond\n', 'One\nSecond\n')

    expect(result).toMatchObject({ status: 'clean', text: 'One\nSecond\n' })
  })

  it('keeps overlapping edits as a user choice with surrounding context', () => {
    const result = mergeCloudSyncText(
      '# Plan\n\nMeet at 9.\nBring notes.\n',
      '# Plan\n\nMeet at 10.\nBring notes.\n',
      '# Plan\n\nMeet at 11.\nBring notes.\n'
    )

    expect(result.status).toBe('conflict')
    expect(result.conflicts).toEqual([
      {
        id: 'change-1',
        base_text: 'Meet at 9.\n',
        local_text: 'Meet at 10.\n',
        cloud_text: 'Meet at 11.\n'
      }
    ])
    expect(resolveCloudSyncMerge(result, { 'change-1': 'local' })).toBe(
      '# Plan\n\nMeet at 10.\nBring notes.\n'
    )
    expect(resolveCloudSyncMerge(result, { 'change-1': 'cloud' })).toBe(
      '# Plan\n\nMeet at 11.\nBring notes.\n'
    )
    expect(resolveCloudSyncMerge(result, { 'change-1': 'both' })).toBe(
      '# Plan\n\nMeet at 10.\nMeet at 11.\nBring notes.\n'
    )
  })

  it('keeps insertions at different positions without a conflict', () => {
    const result = mergeCloudSyncText('A\nB\nC\n', 'A\nMine\nB\nC\n', 'A\nB\nTheirs\nC\n')

    expect(result).toMatchObject({
      status: 'clean',
      text: 'A\nMine\nB\nTheirs\nC\n'
    })
  })

  it('asks when both devices insert different text at the same position', () => {
    const result = mergeCloudSyncText('A\nB\n', 'A\nMine\nB\n', 'A\nTheirs\nB\n')

    expect(result.status).toBe('conflict')
    expect(result.conflicts[0]).toMatchObject({
      base_text: '',
      local_text: 'Mine\n',
      cloud_text: 'Theirs\n'
    })
  })

  it('preserves CRLF and the absence of a trailing newline', () => {
    const result = mergeCloudSyncText('A\r\nB', 'A local\r\nB', 'A\r\nB cloud')

    expect(result).toMatchObject({
      status: 'clean',
      text: 'A local\r\nB cloud'
    })
  })

  it('adds a line break before text that follows an unterminated last line', () => {
    expect(mergeCloudSyncText('a\nb', 'A\nb', 'a\nb\nc')).toMatchObject({
      status: 'clean',
      text: 'A\nb\nc'
    })
    expect(mergeCloudSyncText('a\nb', 'a\nb\n', 'a\nb\nc')).toMatchObject({
      status: 'clean',
      text: 'a\nb\nc\n'
    })

    const both = mergeCloudSyncText('a\nb', 'a\nb\nc', 'a\nb\nd')
    expect(both.status).toBe('conflict')
    expect(both.text).toBe('a\nb\nc')
    expect(resolveCloudSyncMerge(both, { 'change-1': 'both' })).toBe('a\nb\nc\nd')
  })

  it('keeps a trailing newline change made on only one device', () => {
    expect(mergeCloudSyncText('A\nB', 'A\nB\n', 'A2\nB')).toMatchObject({
      status: 'clean',
      text: 'A2\nB\n'
    })
    expect(mergeCloudSyncText('A\nB\n', 'A\nB', 'A2\nB\n')).toMatchObject({
      status: 'clean',
      text: 'A2\nB'
    })
  })

  it('requires every overlapping change to have a choice', () => {
    const result = mergeCloudSyncText('A\n', 'Mine\n', 'Theirs\n')

    expect(() => resolveCloudSyncMerge(result, {})).toThrow(
      'Choose which version to use for every highlighted change.'
    )
  })

  it('falls back to one safe choice when a large note is highly divergent', () => {
    const base = Array.from({ length: 1_000 }, (_, index) => `base ${index}\n`).join('')
    const local = Array.from({ length: 1_000 }, (_, index) => `local ${index}\n`).join('')
    const cloud = Array.from({ length: 1_000 }, (_, index) => `cloud ${index}\n`).join('')

    const merge = mergeCloudSyncText(base, local, cloud)

    expect(merge.status).toBe('conflict')
    expect(merge.conflicts).toHaveLength(1)
    expect(merge.conflicts[0]).toMatchObject({
      base_text: base,
      local_text: local,
      cloud_text: cloud
    })
  })
})
