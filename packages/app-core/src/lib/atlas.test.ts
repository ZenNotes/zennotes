// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import {
  atlasHoldsKeyboard,
  atlasNodeRadius,
  atlasRegionDirection,
  buildAtlasGraph,
  collectAtlasPositions,
  layoutAtlas,
  type AtlasGraph,
  type AtlasPositions
} from './atlas'
import { SELF_KEYED_SURFACES } from './self-keyed-surfaces'

function keyboardEvent(
  options: Partial<KeyboardEvent> & { key: string; code: string; altGraph?: boolean }
): KeyboardEvent {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    getModifierState: (name: string) => name === 'AltGraph' && options.altGraph === true,
    ...options
  } as KeyboardEvent
}

describe('atlasRegionDirection (#657)', () => {
  it('claims Atlas before global Vim buffer prefixes consume its brackets', () => {
    const atlas = document.createElement('div')
    atlas.setAttribute('data-atlas-view', '')
    const canvas = document.createElement('canvas')
    atlas.append(canvas)

    expect(canvas.closest(SELF_KEYED_SURFACES)).toBe(atlas)
  })

  it('recognizes ordinary previous and next region keys', () => {
    expect(atlasRegionDirection(keyboardEvent({ key: '[', code: 'BracketLeft' }))).toBe(-1)
    expect(atlasRegionDirection(keyboardEvent({ key: ']', code: 'BracketRight' }))).toBe(1)
  })

  it('falls back to the physical bracket key for a dead Wayland event', () => {
    expect(atlasRegionDirection(keyboardEvent({ key: 'Dead', code: 'BracketLeft' }))).toBe(-1)
    expect(atlasRegionDirection(keyboardEvent({ key: 'Process', code: 'BracketRight' }))).toBe(1)
  })

  it('accepts brackets typed with AltGr on layouts that require it', () => {
    expect(
      atlasRegionDirection(
        keyboardEvent({
          key: '[',
          code: 'Digit8',
          ctrlKey: true,
          altKey: true,
          altGraph: true
        })
      )
    ).toBe(-1)
    expect(
      atlasRegionDirection(
        keyboardEvent({ key: ']', code: 'Digit9', ctrlKey: true, altKey: true })
      )
    ).toBe(1)
  })

  it('does not turn other modified or shifted keys into region navigation', () => {
    expect(
      atlasRegionDirection(keyboardEvent({ key: '[', code: 'BracketLeft', ctrlKey: true }))
    ).toBe(0)
    expect(
      atlasRegionDirection(keyboardEvent({ key: '{', code: 'BracketLeft', shiftKey: true }))
    ).toBe(0)
  })
})

describe('atlasHoldsKeyboard (#670)', () => {
  it('owns the keyboard straight after opening, before any click lands', () => {
    // openAtlasView blurs to <body> and marks the panel; no DOM focus yet.
    expect(atlasHoldsKeyboard('atlas', true)).toBe(true)
    expect(atlasHoldsKeyboard(null, true)).toBe(true)
  })

  it('yields once another panel has claimed the keyboard', () => {
    expect(atlasHoldsKeyboard('sidebar', true)).toBe(false)
    expect(atlasHoldsKeyboard('editor', true)).toBe(false)
  })

  it('never owns the keyboard while its tab is inactive', () => {
    expect(atlasHoldsKeyboard('atlas', false)).toBe(false)
    expect(atlasHoldsKeyboard(null, false)).toBe(false)
  })
})

function note(path: string, links: string[] = [], createdAt = 0): NoteMeta {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
  return {
    path,
    title,
    folder: 'inbox',
    tags: [],
    createdAt,
    updatedAt: createdAt,
    wikilinks: links
  } as unknown as NoteMeta
}

// A small vault with a hub, the shape of #861's: folders as regions and a few
// links across them.
function vault(): NoteMeta[] {
  const notes = [note('Zettelkasten/Zettelkasten.md')]
  const folders = ['Topics', 'Projects', 'Areas', 'Ressources', 'Indexes']
  for (let f = 0; f < folders.length; f++)
    for (let i = 0; i < 10; i++) {
      const links = i === 0 ? ['Zettelkasten'] : [`${folders[f]} ${i - 1}`]
      notes.push(note(`${folders[f]}/${folders[f]} ${i}.md`, links, f * 10 + i))
    }
  return notes
}

function laidOut(notes: NoteMeta[], previous: AtlasPositions | null = null): AtlasGraph {
  const graph = buildAtlasGraph(notes)
  layoutAtlas(graph, previous)
  return graph
}

// Edge-to-edge room between two notes' dots in the flat map or the sky.
function gap(graph: AtlasGraph, a: string, b: string, dims: 2 | 3): number {
  const na = graph.nodes.find((n) => n.path === a)!
  const nb = graph.nodes.find((n) => n.path === b)!
  const d =
    dims === 2 ? Math.hypot(na.x2 - nb.x2, na.y2 - nb.y2) : Math.hypot(na.x - nb.x, na.y - nb.y, na.z - nb.z)
  return d - atlasNodeRadius(na.degree) - atlasNodeRadius(nb.degree)
}

function tightest(graph: AtlasGraph, paths: string[], dims: 2 | 3): number {
  let least = Infinity
  for (const a of paths)
    for (const b of graph.nodes)
      if (b.path !== a) least = Math.min(least, gap(graph, a, b.path, dims))
  return least
}

describe('layoutAtlas keeps notes apart (#861)', () => {
  const later = [
    note('Projects/Slip Box Setup.md', ['Zettelkasten'], 1000),
    note('Areas/Knowledge Work.md', ['Zettelkasten'], 1001),
    note('Ressources/Luhmann Archive.md', ['Zettelkasten'], 1002),
    note('Indexes/Method Index.md', ['Zettelkasten'], 1003),
    note('Topics/Zettelkasten Method.md', ['Zettelkasten'], 1004),
    note('Zettelkasten/Index Cards.md', ['Zettelkasten'], 1005),
    note('Projects/Pasta al Limone.md', ['Topics 4'], 1006),
    note('Projects/Apfelkuchen.md', ['Pasta al Limone'], 1007)
  ]
  const laterPaths = later.map((n) => n.path)

  it('places notes written after the map was drawn beside what they link to, never on a note', () => {
    const first = collectAtlasPositions(laidOut(vault()))
    const graph = laidOut([...vault(), ...later], first)
    for (const dims of [2, 3] as const) {
      expect(tightest(graph, laterPaths, dims)).toBeGreaterThan(0)
      for (const n of later) {
        const target = graph.nodes.find((m) => m.title === n.wikilinks[0])!
        const room = gap(graph, n.path, target.path, dims)
        // Clear of its link, and still beside it.
        expect(room).toBeGreaterThan(0)
        expect(room).toBeLessThan(150)
      }
    }
    // Nothing that was already on the map moved.
    for (const [path, at] of Object.entries(first)) {
      expect(collectAtlasPositions(graph)[path]).toEqual(at)
    }
  })

  it('finds room for many notes written at once around one hub', () => {
    const base = vault()
    const crowd = Array.from({ length: 30 }, (_, i) =>
      note(`Zettelkasten/Card ${i}.md`, ['Zettelkasten'], 2000 + i)
    )
    const graph = laidOut([...base, ...crowd], collectAtlasPositions(laidOut(base)))
    for (const dims of [2, 3] as const) {
      expect(tightest(graph, crowd.map((n) => n.path), dims)).toBeGreaterThan(0)
    }
  })

  it('moves a note the old placement stacked on its link, and nothing else', () => {
    const first = laidOut(vault())
    const hub = first.nodes.find((n) => n.path === 'Zettelkasten/Zettelkasten.md')!
    const clumped: AtlasPositions = collectAtlasPositions(first)
    // What 2.56 cached for these notes: the hub's position, give or take 11.
    later.slice(0, 6).forEach((n, i) => {
      const dx = ((i * 7) % 11) - 5
      const dy = ((i * 5) % 9) - 4
      clumped[n.path] = { x: hub.x + dx, y: hub.y - dy, z: hub.z + dy, x2: hub.x2 + dx, y2: hub.y2 + dy }
    })
    const graph = laidOut([...vault(), ...later.slice(0, 6)], clumped)
    for (const dims of [2, 3] as const) {
      for (const path of laterPaths.slice(0, 6)) {
        expect(gap(graph, path, hub.path, dims)).toBeGreaterThan(0)
      }
      expect(tightest(graph, laterPaths.slice(0, 6), dims)).toBeGreaterThan(0)
    }
    const now = collectAtlasPositions(graph)
    for (const n of vault()) expect(now[n.path]).toEqual(clumped[n.path])
  })

  it('settles to itself: opening the map again moves nothing', () => {
    const fresh = laidOut(vault())
    expect(collectAtlasPositions(laidOut(vault(), collectAtlasPositions(fresh)))).toEqual(
      collectAtlasPositions(fresh)
    )
    const grown = laidOut([...vault(), ...later], collectAtlasPositions(fresh))
    expect(collectAtlasPositions(laidOut([...vault(), ...later], collectAtlasPositions(grown)))).toEqual(
      collectAtlasPositions(grown)
    )
  })

  it('is deterministic: the same notes and cache give the same map', () => {
    const cache = collectAtlasPositions(laidOut(vault()))
    expect(collectAtlasPositions(laidOut([...vault(), ...later], cache))).toEqual(
      collectAtlasPositions(laidOut([...vault(), ...later], cache))
    )
  })
})
