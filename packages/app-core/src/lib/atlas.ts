// Atlas: the vault drawn as a map. Pure graph + layout logic, kept out of the
// component so it is testable and could move to a worker later.
//
// Two hard rules from the design (docs/ideas/atlas.md):
//  - The layout is DETERMINISTIC and FROZEN. Same notes + links = same map.
//  - Notes already on the map never move when new notes arrive; newcomers are
//    placed at the centroid of their linked neighbors (or their region) so the
//    geography stays a place the user knows.
import type { NoteMeta } from '@shared/ipc'
import { resolveWikilinkTarget } from './wikilinks'

export interface AtlasNode {
  path: string
  title: string
  region: number
  tags: readonly string[]
  createdAt: number
  updatedAt: number
  degree: number
  x: number
  y: number
  z: number
  x2: number
  y2: number
}

export interface AtlasRegion {
  key: string
  label: string
  count: number
  cx: number
  cy: number
  cz: number
  cx2: number
  cy2: number
  r: number
}

export interface AtlasGraph {
  nodes: AtlasNode[]
  edges: Array<[number, number]>
  regions: AtlasRegion[]
}

export type AtlasPositions = Record<
  string,
  { x: number; y: number; z: number; x2: number; y2: number }
>

const GOLD = 2.3999632
const SEED = 20260818

function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The region a note belongs to: its top-level folder (clustering can come later). */
export function atlasRegionKey(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * Resolve Atlas region navigation across keyboard layouts and Linux
 * compositor event shapes. Brackets produced through AltGr are typed keys,
 * while dead/process events may need the physical bracket code as a fallback.
 */
export function atlasRegionDirection(event: KeyboardEvent): -1 | 0 | 1 {
  const typed = event.key === '[' ? -1 : event.key === ']' ? 1 : 0
  const altGraph =
    event.getModifierState('AltGraph') ||
    (typed !== 0 && event.ctrlKey && event.altKey)

  if (event.metaKey || ((event.ctrlKey || event.altKey) && !altGraph)) return 0
  if (typed !== 0) return typed
  if (event.ctrlKey || event.altKey) return 0
  if (!['', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return 0
  if (event.code === 'BracketLeft') return -1
  if (event.code === 'BracketRight') return 1
  return 0
}

/**
 * Whether the map owns single-key input right now: its tab is active and no
 * other panel has claimed the keyboard. `focusedPanel` is null right after the
 * tab opens, before any click has landed anywhere, and the map must already
 * answer then; DOM focus is not a reliable witness because opening the map
 * blurs to <body> (#670).
 */
export function atlasHoldsKeyboard(focusedPanel: string | null, atlasActive: boolean): boolean {
  return atlasActive && (focusedPanel == null || focusedPanel === 'atlas')
}

export function buildAtlasGraph(notes: readonly NoteMeta[]): AtlasGraph {
  const usable = notes.filter((n) => n.folder !== 'trash')
  const regionKeys = new Map<string, number>()
  const regionCounts: number[] = []
  const regionLabels: string[] = []
  for (const n of usable) {
    const key = atlasRegionKey(n.path)
    if (!regionKeys.has(key)) {
      regionKeys.set(key, regionLabels.length)
      regionLabels.push(key === '' ? 'Notes' : key)
      regionCounts.push(0)
    }
    regionCounts[regionKeys.get(key)!]++
  }
  const index = new Map<string, number>()
  const nodes: AtlasNode[] = usable.map((n, i) => {
    index.set(n.path, i)
    return {
      path: n.path,
      title: n.title,
      region: regionKeys.get(atlasRegionKey(n.path))!,
      tags: n.tags,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      degree: 0,
      x: 0,
      y: 0,
      z: 0,
      x2: 0,
      y2: 0
    }
  })
  const edgeSet = new Set<string>()
  const edges: Array<[number, number]> = []
  usable.forEach((n, i) => {
    for (const target of n.wikilinks) {
      const resolved = resolveWikilinkTarget(usable, target)
      if (!resolved) continue
      const j = index.get(resolved.path)
      if (j === undefined || j === i) continue
      const key = i < j ? i + ':' + j : j + ':' + i
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push(i < j ? [i, j] : [j, i])
      nodes[i].degree++
      nodes[j].degree++
    }
  })
  const regions: AtlasRegion[] = regionLabels.map((label, ri) => ({
    key: label,
    label,
    count: regionCounts[ri],
    cx: 0,
    cy: 0,
    cz: 0,
    cx2: 0,
    cy2: 0,
    r: 30 * Math.sqrt(regionCounts[ri]) + 36
  }))
  return { nodes, edges, regions }
}

/** Neighbor pairs via a spatial hash so relaxation stays near-linear on big vaults. */
function relax(
  nodes: AtlasNode[],
  edges: Array<[number, number]>,
  dims: 2 | 3,
  iterations: number,
  get: (n: AtlasNode) => [number, number, number],
  set: (n: AtlasNode, x: number, y: number, z: number) => void,
  regionCenter: (n: AtlasNode) => [number, number, number]
): void {
  const CUT = 210
  for (let it = 0; it < iterations; it++) {
    const fx = new Float64Array(nodes.length)
    const fy = new Float64Array(nodes.length)
    const fz = new Float64Array(nodes.length)
    const grid = new Map<string, number[]>()
    nodes.forEach((n, i) => {
      const [x, y, z] = get(n)
      const key =
        Math.floor(x / CUT) + ',' + Math.floor(y / CUT) + ',' + (dims === 3 ? Math.floor(z / CUT) : 0)
      const cell = grid.get(key)
      if (cell) cell.push(i)
      else grid.set(key, [i])
    })
    nodes.forEach((n, i) => {
      const [x, y, z] = get(n)
      const gx = Math.floor(x / CUT)
      const gy = Math.floor(y / CUT)
      const gz = dims === 3 ? Math.floor(z / CUT) : 0
      for (let ax = gx - 1; ax <= gx + 1; ax++)
        for (let ay = gy - 1; ay <= gy + 1; ay++)
          for (let az = dims === 3 ? gz - 1 : 0; az <= (dims === 3 ? gz + 1 : 0); az++) {
            const cell = grid.get(ax + ',' + ay + ',' + az)
            if (!cell) continue
            for (const j of cell) {
              if (j <= i) continue
              const [bx, by, bz] = get(nodes[j])
              const dx = bx - x
              const dy = by - y
              const dz = dims === 3 ? bz - z : 0
              const d2 = dx * dx + dy * dy + dz * dz + 40
              if (d2 > CUT * CUT) continue
              const f = 2400 / d2
              const d = Math.sqrt(d2)
              fx[i] -= (f * dx * 13) / d
              fy[i] -= (f * dy * 13) / d
              fz[i] -= (f * dz * 13) / d
              fx[j] += (f * dx * 13) / d
              fy[j] += (f * dy * 13) / d
              fz[j] += (f * dz * 13) / d
            }
          }
    })
    for (const [a, b] of edges) {
      const [ax, ay, az] = get(nodes[a])
      const [bx, by, bz] = get(nodes[b])
      const dx = bx - ax
      const dy = by - ay
      const dz = dims === 3 ? bz - az : 0
      const d = Math.hypot(dx, dy, dz) || 1
      const same = nodes[a].region === nodes[b].region
      const rest = same ? 90 : 330
      const k = same ? 0.016 : 0.004
      const f = k * (d - rest)
      fx[a] += (f * dx) / d
      fy[a] += (f * dy) / d
      fz[a] += (f * dz) / d
      fx[b] -= (f * dx) / d
      fy[b] -= (f * dy) / d
      fz[b] -= (f * dz) / d
    }
    nodes.forEach((n, i) => {
      const [x, y, z] = get(n)
      const [cx, cy, cz] = regionCenter(n)
      fx[i] += (cx - x) * 0.012
      fy[i] += (cy - y) * 0.012
      fz[i] += (cz - z) * 0.012
      const clamp = (v: number): number => Math.max(-13, Math.min(13, v))
      set(n, x + clamp(fx[i]), y + clamp(fy[i]), dims === 3 ? z + clamp(fz[i]) : 0)
    })
  }
}

/**
 * Lay out the graph in both dimensions. Nodes whose path appears in `previous`
 * keep those positions verbatim; only newcomers are computed. When most of the
 * vault is new (or nothing is cached) the full deterministic layout runs.
 */
export function layoutAtlas(graph: AtlasGraph, previous?: AtlasPositions | null): void {
  const { nodes, edges, regions } = graph
  const rng = mulberry32(SEED)
  const R = regions.length
  regions.forEach((reg, ri) => {
    const yy = R === 1 ? 0 : 1 - (2 * (ri + 0.5)) / R
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy))
    const th = ri * GOLD * 2.1
    reg.cx = Math.cos(th) * rr * 500
    reg.cy = yy * 350
    reg.cz = Math.sin(th) * rr * 500
    const ang = ri * GOLD
    const rad = ri === 0 ? 0 : 300 * Math.sqrt(ri + 0.55)
    reg.cx2 = Math.cos(ang) * rad
    reg.cy2 = Math.sin(ang) * rad * 0.86
  })
  const known = new Set<string>()
  if (previous) {
    for (const n of nodes) {
      const p = previous[n.path]
      if (!p) continue
      n.x = p.x
      n.y = p.y
      n.z = p.z
      n.x2 = p.x2
      n.y2 = p.y2
      known.add(n.path)
    }
  }
  const fresh = nodes.length - known.size
  const fullLayout = known.size === 0 || fresh / Math.max(1, nodes.length) > 0.4
  const perRegionIndex = new Map<number, number>()
  const adjacency = new Map<number, number[]>()
  edges.forEach(([a, b]) => {
    ;(adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push(b)
    ;(adjacency.get(b) ?? adjacency.set(b, []).get(b)!).push(a)
  })
  nodes.forEach((n, i) => {
    const j = perRegionIndex.get(n.region) ?? 0
    perRegionIndex.set(n.region, j + 1)
    if (!fullLayout && known.has(n.path)) return
    const reg = regions[n.region]
    const jitter = (): number => (rng() - 0.5) * 22
    const placedNeighbors = fullLayout
      ? []
      : (adjacency.get(i) ?? []).filter((m) => known.has(nodes[m].path))
    if (!fullLayout && placedNeighbors.length > 0) {
      // A newcomer lands beside what it links to; nothing else moves.
      const sum = placedNeighbors.reduce(
        (s, m) => {
          const nb = nodes[m]
          return [s[0] + nb.x, s[1] + nb.y, s[2] + nb.z, s[3] + nb.x2, s[4] + nb.y2]
        },
        [0, 0, 0, 0, 0]
      )
      const c = placedNeighbors.length
      n.x = sum[0] / c + jitter()
      n.y = sum[1] / c + jitter()
      n.z = sum[2] / c + jitter()
      n.x2 = sum[3] / c + jitter()
      n.y2 = sum[4] / c + jitter()
      return
    }
    const count = Math.max(1, reg.count)
    const yy = 1 - (2 * (j + 0.5)) / count
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy))
    const th = j * GOLD + n.region * 1.7
    const rad = reg.r * 0.85
    n.x = reg.cx + Math.cos(th) * rr * rad + jitter()
    n.y = reg.cy + yy * rad * 0.85 + jitter()
    n.z = reg.cz + Math.sin(th) * rr * rad + jitter()
    const rr2 = reg.r * 0.9 * Math.sqrt((j + 0.6) / count)
    n.x2 = reg.cx2 + Math.cos(th) * rr2 + jitter()
    n.y2 = reg.cy2 + Math.sin(th) * rr2 + jitter()
  })
  if (fullLayout) {
    const iterations = nodes.length > 1500 ? 50 : 120
    relax(
      nodes,
      edges,
      3,
      iterations,
      (n) => [n.x, n.y, n.z],
      (n, x, y, z) => {
        n.x = x
        n.y = y
        n.z = z
      },
      (n) => [regions[n.region].cx, regions[n.region].cy, regions[n.region].cz]
    )
    relax(
      nodes,
      edges,
      2,
      iterations,
      (n) => [n.x2, n.y2, 0],
      (n, x, y) => {
        n.x2 = x
        n.y2 = y
      },
      (n) => [regions[n.region].cx2, regions[n.region].cy2, 0]
    )
  }
  // Label anchors follow the notes, wherever they ended up.
  regions.forEach((reg, ri) => {
    const rn = nodes.filter((n) => n.region === ri)
    if (rn.length === 0) return
    reg.cx = rn.reduce((s, n) => s + n.x, 0) / rn.length
    reg.cy = rn.reduce((s, n) => s + n.y, 0) / rn.length
    reg.cz = rn.reduce((s, n) => s + n.z, 0) / rn.length
    reg.cx2 = rn.reduce((s, n) => s + n.x2, 0) / rn.length
    reg.cy2 = rn.reduce((s, n) => s + n.y2, 0) / rn.length
  })
}

/**
 * Merge extra note-to-note edges (markdown-style links, scanned lazily by the
 * view) into an already-laid-out graph. Additive only: positions stay frozen,
 * duplicates are dropped, degrees grow so node sizes stay honest.
 */
export function applyExtraLinkEdges(
  graph: AtlasGraph,
  pairs: ReadonlyArray<[string, string]>
): number {
  const index = new Map<string, number>()
  graph.nodes.forEach((n, i) => index.set(n.path, i))
  const seen = new Set(graph.edges.map(([a, b]) => a + ':' + b))
  let added = 0
  for (const [pa, pb] of pairs) {
    const a = index.get(pa)
    const b = index.get(pb)
    if (a === undefined || b === undefined || a === b) continue
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (seen.has(lo + ':' + hi)) continue
    seen.add(lo + ':' + hi)
    graph.edges.push([lo, hi])
    graph.nodes[a].degree++
    graph.nodes[b].degree++
    added++
  }
  return added
}

export function collectAtlasPositions(graph: AtlasGraph): AtlasPositions {
  const out: AtlasPositions = {}
  for (const n of graph.nodes) out[n.path] = { x: n.x, y: n.y, z: n.z, x2: n.x2, y2: n.y2 }
  return out
}
