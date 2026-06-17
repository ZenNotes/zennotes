import { describe, it, expect } from 'vitest'
import { reconcile, isNeverSync, type FileState, type BaseEntry, type SyncAction } from './reconcile'

function L(entries: Record<string, string>): Map<string, FileState> {
  return new Map(Object.entries(entries).map(([p, h]) => [p, { hash: h, size: h.length }]))
}
function B(entries: Record<string, string>): Map<string, BaseEntry> {
  return new Map(Object.entries(entries).map(([p, h]) => [p, { contentHash: h, size: h.length }]))
}
/** Run reconcile on a single path and return the one action (or undefined). */
function one(
  local: Record<string, string>,
  remote: Record<string, string>,
  base: Record<string, string>
): SyncAction | undefined {
  const actions = reconcile(L(local), L(remote), B(base))
  expect(actions.length).toBeLessThanOrEqual(1)
  return actions[0]
}

describe('reconcile — decision table', () => {
  it('unchanged on both sides → no action', () => {
    expect(one({ 'a.md': 'x' }, { 'a.md': 'x' }, { 'a.md': 'x' })).toBeUndefined()
  })
  it('edited locally only → push', () => {
    expect(one({ 'a.md': 'x2' }, { 'a.md': 'x' }, { 'a.md': 'x' })).toEqual({ kind: 'push', path: 'a.md' })
  })
  it('edited remotely only → pull', () => {
    expect(one({ 'a.md': 'x' }, { 'a.md': 'x2' }, { 'a.md': 'x' })).toEqual({ kind: 'pull', path: 'a.md' })
  })
  it('both edited to identical bytes → converge', () => {
    expect(one({ 'a.md': 'y' }, { 'a.md': 'y' }, { 'a.md': 'x' })).toEqual({ kind: 'converge', path: 'a.md' })
  })
  it('both edited differently → conflict(both-edited)', () => {
    expect(one({ 'a.md': 'L' }, { 'a.md': 'R' }, { 'a.md': 'x' })).toEqual({
      kind: 'conflict',
      path: 'a.md',
      reason: 'both-edited'
    })
  })
  it('deleted locally, remote unchanged → deleteRemote', () => {
    expect(one({}, { 'a.md': 'x' }, { 'a.md': 'x' })).toEqual({ kind: 'deleteRemote', path: 'a.md' })
  })
  it('deleted remotely, local unchanged → deleteLocal', () => {
    expect(one({ 'a.md': 'x' }, {}, { 'a.md': 'x' })).toEqual({ kind: 'deleteLocal', path: 'a.md' })
  })
  it('deleted locally but edited remotely → conflict(delete-vs-edit)', () => {
    expect(one({}, { 'a.md': 'x2' }, { 'a.md': 'x' })).toEqual({
      kind: 'conflict',
      path: 'a.md',
      reason: 'delete-vs-edit'
    })
  })
  it('edited locally but deleted remotely → conflict(edit-vs-delete)', () => {
    expect(one({ 'a.md': 'x2' }, {}, { 'a.md': 'x' })).toEqual({
      kind: 'conflict',
      path: 'a.md',
      reason: 'edit-vs-delete'
    })
  })
  it('new local, no base → push', () => {
    expect(one({ 'a.md': 'x' }, {}, {})).toEqual({ kind: 'push', path: 'a.md' })
  })
  it('new remote, no base → pull', () => {
    expect(one({}, { 'a.md': 'x' }, {})).toEqual({ kind: 'pull', path: 'a.md' })
  })
  it('first sync, same path identical bytes → converge', () => {
    expect(one({ 'a.md': 'x' }, { 'a.md': 'x' }, {})).toEqual({ kind: 'converge', path: 'a.md' })
  })
  it('first sync, same path different bytes → conflict(first-sync-clash)', () => {
    expect(one({ 'a.md': 'L' }, { 'a.md': 'R' }, {})).toEqual({
      kind: 'conflict',
      path: 'a.md',
      reason: 'first-sync-clash'
    })
  })
  it('deleted on both sides → forget the base entry', () => {
    expect(one({}, {}, { 'a.md': 'x' })).toEqual({ kind: 'forget', path: 'a.md' })
  })
})

describe('reconcile — NEVER_SYNC + union', () => {
  it('never syncs sync-state.json / note-meta-cache', () => {
    expect(isNeverSync('.zennotes/sync-state.json')).toBe(true)
    expect(isNeverSync('.zennotes/note-meta-cache-v1.json')).toBe(true)
    expect(isNeverSync('inbox/note.md')).toBe(false)
    const actions = reconcile(L({ '.zennotes/sync-state.json': 'a' }), L({}), B({}))
    expect(actions).toEqual([])
  })
  it('first-sync union merge across both sides', () => {
    const actions = reconcile(
      L({ 'inbox/A.md': 'a', 'inbox/Shared.md': 'L' }),
      L({ 'inbox/B.md': 'b', 'inbox/Shared.md': 'R' }),
      B({})
    )
    const byPath = new Map(actions.map((x) => [x.path, x]))
    expect(byPath.get('inbox/A.md')).toEqual({ kind: 'push', path: 'inbox/A.md' })
    expect(byPath.get('inbox/B.md')).toEqual({ kind: 'pull', path: 'inbox/B.md' })
    expect(byPath.get('inbox/Shared.md')).toEqual({
      kind: 'conflict',
      path: 'inbox/Shared.md',
      reason: 'first-sync-clash'
    })
  })
})
