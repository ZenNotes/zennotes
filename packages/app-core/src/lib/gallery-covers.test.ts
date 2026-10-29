import { describe, expect, it, vi } from 'vitest'
import { GalleryCoverCache, runLimited } from './gallery-covers'

const WITH_COVER = '---\nbanner: "![[assets/lisbon.jpg]]"\nbanner_y: 0.25\n---\n# Lisbon\n'
const WITHOUT_COVER = '# Plain note\n'

describe('GalleryCoverCache', () => {
  it('reads a note once and keeps its cover against that version', async () => {
    const cache = new GalleryCoverCache()
    const read = vi.fn(async () => WITH_COVER)
    const note = { path: 'inbox/a.md', updatedAt: 1 }
    expect(cache.peek(note)).toBeUndefined()
    const cover = await cache.load(note, read)
    expect(cover).toMatchObject({ target: { kind: 'vault', href: 'assets/lisbon.jpg' }, y: 0.25 })
    expect(cache.peek(note)).toEqual(cover)
    await cache.load(note, read)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('knows a note without a cover as null, not as unread', async () => {
    const cache = new GalleryCoverCache()
    const note = { path: 'inbox/b.md', updatedAt: 1 }
    await cache.load(note, async () => WITHOUT_COVER)
    expect(cache.peek(note)).toBeNull()
  })

  it('reads a note again once it changes', async () => {
    const cache = new GalleryCoverCache()
    const read = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValueOnce(WITHOUT_COVER)
      .mockResolvedValueOnce(WITH_COVER)
    await cache.load({ path: 'inbox/a.md', updatedAt: 1 }, read)
    const edited = { path: 'inbox/a.md', updatedAt: 2 }
    expect(cache.peek(edited)).toBeUndefined()
    expect(await cache.load(edited, read)).not.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('shares one read between cards asking at once', async () => {
    const cache = new GalleryCoverCache()
    let release!: (body: string) => void
    const read = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const note = { path: 'inbox/a.md', updatedAt: 1 }
    const first = cache.load(note, read)
    const second = cache.load(note, read)
    release(WITH_COVER)
    expect(await first).toEqual(await second)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('treats a note it cannot read as having no cover', async () => {
    const cache = new GalleryCoverCache()
    const note = { path: 'inbox/gone.md', updatedAt: 1 }
    expect(await cache.load(note, async () => Promise.reject(new Error('ENOENT')))).toBeNull()
    expect(cache.peek(note)).toBeNull()
  })

  it('starts empty for another workspace, and drops a read that lands after the switch', async () => {
    const cache = new GalleryCoverCache()
    cache.setScope('local:/vault-a')
    const note = { path: 'inbox/a.md', updatedAt: 1 }
    await cache.load(note, async () => WITH_COVER)
    cache.setScope('remote:https://server')
    expect(cache.peek(note)).toBeUndefined()

    let release!: (body: string) => void
    const late = cache.load(note, () => new Promise<string>((resolve) => (release = resolve)))
    cache.setScope('local:/vault-b')
    release(WITH_COVER)
    await late
    expect(cache.peek(note)).toBeUndefined()
  })

  it('forgets the oldest covers past its limit', async () => {
    const cache = new GalleryCoverCache(2)
    for (const path of ['a.md', 'b.md', 'c.md']) {
      await cache.load({ path, updatedAt: 1 }, async () => WITHOUT_COVER)
    }
    expect(cache.size).toBe(2)
    expect(cache.peek({ path: 'a.md', updatedAt: 1 })).toBeUndefined()
    expect(cache.peek({ path: 'c.md', updatedAt: 1 })).toBeNull()
  })
})

describe('runLimited', () => {
  it('never runs more than the limit at once, and runs every item', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 1))
      running -= 1
      done.push(n)
    })
    expect(peak).toBe(3)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('takes no new items once cancelled', async () => {
    const started: number[] = []
    let cancelled = false
    await runLimited(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n)
        if (n === 2) cancelled = true
      },
      () => cancelled
    )
    expect(started).toEqual([1, 2])
  })

  it('keeps going past an item that throws', async () => {
    const done: number[] = []
    await runLimited([1, 2, 3], 1, async (n) => {
      if (n === 2) throw new Error('boom')
      done.push(n)
    })
    expect(done).toEqual([1, 3])
  })
})
