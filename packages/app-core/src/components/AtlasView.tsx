// Atlas: the vault as a map of notes and links. Canvas-rendered (no per-note
// DOM, per the sidebar-virtualization lesson), theme-driven via CSS variables,
// with a 2D map and a 3D sky behind one toggle. Design: docs/ideas/atlas.md.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, isAtlasViewActive } from '../store'
import {
  applyExtraLinkEdges,
  atlasHoldsKeyboard,
  atlasRegionDirection,
  buildAtlasGraph,
  collectAtlasPositions,
  layoutAtlas,
  type AtlasGraph,
  type AtlasPositions
} from '../lib/atlas'
import { isAppOverlayOpen } from '../lib/overlay-open'
import { extractMarkdownLinkHrefs } from '../lib/wikilinks'
import { resolveInternalNoteHref } from '../lib/internal-links'

type Lens = 1 | 2 | 3 | 4
const LENS_NAMES: Record<Lens, string> = { 1: 'structure', 2: 'heat', 3: 'orphans', 4: 'bridges' }
const F = 900
const HINTKEYS = 'asdfghjkl'

interface ThemeColors {
  bg: string
  fg: string
  muted: string
  dim: string
  accent: string
  accentTriplet: string
  regionHues: string[]
}

// Themes style Atlas through CSS variables. A custom theme can override the
// region palette with --z-atlas-region-1 .. --z-atlas-region-8 (space-separated
// RGB triplets like every other token); otherwise the syntax hues are used.
function readThemeColors(): ThemeColors {
  const cs = getComputedStyle(document.documentElement)
  const triplet = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim()
    return v.length > 0 ? v : fallback
  }
  const rgb = (t: string): string => `rgb(${t})`
  const regionHues: string[] = []
  for (let i = 1; i <= 8; i++) {
    const v = cs.getPropertyValue(`--z-atlas-region-${i}`).trim()
    if (v.length > 0) regionHues.push(rgb(v))
  }
  if (regionHues.length === 0) {
    for (const name of [
      '--z-accent',
      '--z-blue',
      '--z-purple',
      '--z-aqua',
      '--z-green',
      '--z-yellow',
      '--z-red',
      '--z-accent-soft'
    ]) {
      const v = cs.getPropertyValue(name).trim()
      if (v.length > 0) regionHues.push(rgb(v))
    }
  }
  return {
    bg: rgb(triplet('--z-atlas-bg', triplet('--z-bg', '40 40 40'))),
    fg: rgb(triplet('--z-fg', '235 219 178')),
    muted: rgb(triplet('--z-grey-1', '146 131 116')),
    dim: rgb(triplet('--z-grey-dim', '124 111 100')),
    accent: rgb(triplet('--z-accent', '215 153 33')),
    accentTriplet: triplet('--z-accent', '215 153 33'),
    regionHues: regionHues.length > 0 ? regionHues : ['rgb(215 153 33)']
  }
}

interface Cam {
  yaw: number
  pitch: number
  dist: number
  cx: number
  cy: number
  cz: number
  yawT: number
  pitchT: number
  distT: number
  cxT: number
  cyT: number
  czT: number
}

export function AtlasView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const vaultRoot = useStore((s) => s.vault?.root ?? '')
  const vimMode = useStore((s) => s.vimMode)
  const selectNote = useStore((s) => s.selectNote)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const isActive = useStore(isAtlasViewActive)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const [mode3d, setMode3d] = useState(false)
  const [lens, setLens] = useState<Lens>(1)
  const [edgeMode, setEdgeMode] = useState(0) // 0 quiet · 1 all · 2 off
  const [filterQ, setFilterQ] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [status, setStatus] = useState('')
  const filterRef = useRef<HTMLInputElement | null>(null)

  const graph: AtlasGraph = useMemo(() => {
    const g = buildAtlasGraph(notes)
    let previous: AtlasPositions | null = null
    const cacheKey = `zen-atlas-pos:${vaultRoot}`
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) previous = JSON.parse(raw) as AtlasPositions
    } catch {
      previous = null
    }
    layoutAtlas(g, previous)
    try {
      localStorage.setItem(cacheKey, JSON.stringify(collectAtlasPositions(g)))
    } catch {
      // Cache is an optimization; a full deterministic relayout is the fallback.
    }
    return g
  }, [notes, vaultRoot])

  // Everything mutable at 60fps lives in refs; React state is for chrome only.
  const world = useRef({
    cam: {
      yaw: 0,
      pitch: 0,
      dist: 2600,
      cx: 0,
      cy: 0,
      cz: 0,
      yawT: 0,
      pitchT: 0,
      distT: 2600,
      cxT: 0,
      cyT: 0,
      czT: 0
    } as Cam,
    focusPath: null as string | null,
    hoverPath: null as string | null,
    hint: null as null | { labels: Map<number, string>; typed: string },
    display: [] as Array<{ dx: number; dy: number; dz: number; alpha: number }>,
    betweenness: null as Float64Array | null,
    lastFrame: 0,
    interacted: 0
  })
  const stateRef = useRef({ mode3d, lens, edgeMode, filterQ, vimMode, graph })
  stateRef.current = { mode3d, lens, edgeMode, filterQ, vimMode, graph }

  useEffect(() => {
    world.current.display = graph.nodes.map((n) => ({ dx: 0, dy: 0, dz: 0, alpha: 0 }))
    graph.nodes.forEach((n, i) => {
      const d = world.current.display[i]
      d.dx = stateRef.current.mode3d ? n.x : n.x2
      d.dy = stateRef.current.mode3d ? n.y : n.y2
      d.dz = stateRef.current.mode3d ? n.z : 0
    })
    world.current.betweenness = null
    fitAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  useEffect(() => {
    if (!isActive) return
    useStore.getState().setFocusedPanel('atlas')
    const el = document.activeElement as HTMLElement | null
    el?.blur?.()
  }, [isActive])

  // The map is a flat plane: it must be viewed level or panning slides on
  // skewed axes. The sky keeps (and remembers) its oblique angle.
  const savedView = useRef({ yaw: 0.6, pitch: 0.3 })
  useEffect(() => {
    const cam = world.current.cam
    if (mode3d) {
      cam.yawT = savedView.current.yaw
      cam.pitchT = savedView.current.pitch
    } else {
      savedView.current = { yaw: cam.yawT, pitch: cam.pitchT }
      cam.yawT = Math.round(cam.yaw / (Math.PI * 2)) * Math.PI * 2
      cam.pitchT = 0
    }
  }, [mode3d])

  // Obsidian parity, kept view-local: markdown-style note links become edges
  // too, scanned lazily from bodies AFTER first paint through the existing
  // read-only bridge, cached per note mtime so the full scan runs once.
  const [, setEdgeVersion] = useState(0)
  useEffect(() => {
    if (graph.nodes.length === 0) return
    let cancelled = false
    const cacheKey = `zen-atlas-mdlinks:${vaultRoot}`
    const run = async (): Promise<void> => {
      let cache: Record<string, { u: number; t: string[] }> = {}
      try {
        cache = JSON.parse(localStorage.getItem(cacheKey) ?? '{}')
      } catch {
        cache = {}
      }
      const pairs: Array<[string, string]> = []
      const pending = graph.nodes.filter((n) => cache[n.path]?.u !== n.updatedAt)
      for (let i = 0; i < pending.length; i += 40) {
        if (cancelled) return
        await Promise.all(
          pending.slice(i, i + 40).map(async (n) => {
            try {
              const body = (await window.zen.readNote(n.path)).body
              const targets: string[] = []
              for (const href of extractMarkdownLinkHrefs(body)) {
                const resolved = resolveInternalNoteHref(n.path, href, notes)
                if (resolved) targets.push(resolved.path)
              }
              cache[n.path] = { u: n.updatedAt, t: targets }
            } catch {
              cache[n.path] = { u: n.updatedAt, t: [] }
            }
          })
        )
        await new Promise((r) => setTimeout(r, 0))
      }
      for (const n of graph.nodes) {
        for (const t of cache[n.path]?.t ?? []) pairs.push([n.path, t])
      }
      if (cancelled) return
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cache))
      } catch {
        // cache is an optimization only
      }
      if (applyExtraLinkEdges(graph, pairs) > 0) {
        world.current.betweenness = null
        setEdgeVersion((v) => v + 1)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  const colorsRef = useRef<ThemeColors>(readThemeColors())
  useEffect(() => {
    const observer = new MutationObserver(() => {
      colorsRef.current = readThemeColors()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-mode']
    })
    return () => observer.disconnect()
  }, [])

  function target(n: { x: number; y: number; z: number; x2: number; y2: number }): [number, number, number] {
    return stateRef.current.mode3d ? [n.x, n.y, n.z] : [n.x2, n.y2, 0]
  }
  function bounds(): { cx: number; cy: number; cz: number; R: number } {
    const g = stateRef.current.graph
    if (g.nodes.length === 0) return { cx: 0, cy: 0, cz: 0, R: 400 }
    const pts = g.nodes.map((n) => target(n))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const zs = pts.map((p) => p[2])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2
    const R = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz))) + 140
    return { cx, cy, cz, R }
  }
  function fitAll(): void {
    const c = canvasRef.current
    const w = c?.clientWidth || 1200
    const h = c?.clientHeight || 800
    const B = bounds()
    const cam = world.current.cam
    cam.cxT = B.cx
    cam.cyT = B.cy
    cam.czT = B.cz
    cam.distT = Math.max(B.R * 1.15, Math.min(B.R * 2.4, (B.R * F) / (Math.min(w, h) * 0.62)))
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      const st = stateRef.current
      const w = world.current
      const g = st.graph
      const vw = canvas.clientWidth
      const vh = canvas.clientHeight
      if (vw < 40 || vh < 40) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(vw * dpr)) {
        canvas.width = Math.round(vw * dpr)
        canvas.height = Math.round(vh * dpr)
      }
      const dt = Math.min(500, now - (w.lastFrame || now))
      w.lastFrame = now
      const k = 1 - Math.exp(-dt / 150)
      const cam = w.cam
      if (st.mode3d && now - w.interacted > 4000) cam.yawT += dt * 0.000045
      cam.yaw += (cam.yawT - cam.yaw) * k
      cam.pitch += (cam.pitchT - cam.pitch) * k
      cam.dist += (cam.distT - cam.dist) * k
      cam.cx += (cam.cxT - cam.cx) * k
      cam.cy += (cam.cyT - cam.cy) * k
      cam.cz += (cam.czT - cam.cz) * k
      const cosY = Math.cos(cam.yaw)
      const sinY = Math.sin(cam.yaw)
      const cosP = Math.cos(cam.pitch)
      const sinP = Math.sin(cam.pitch)
      const project = (x: number, y: number, z: number): null | { sx: number; sy: number; s: number; fog: number; depth: number } => {
        const px = x - cam.cx
        const py = y - cam.cy
        const pz = z - cam.cz
        const xr = px * cosY - pz * sinY
        const z1 = px * sinY + pz * cosY
        const yr = py * cosP - z1 * sinP
        const zr = py * sinP + z1 * cosP
        const depth = zr + cam.dist
        if (depth < 60) return null
        const s = F / depth
        const rel = depth / cam.dist
        return {
          sx: vw / 2 + xr * s,
          sy: vh / 2 + yr * s,
          s,
          fog: Math.max(0.15, Math.min(1, 1.55 - rel * 0.55)),
          depth
        }
      }
      const col = colorsRef.current
      const q = st.filterQ.toLowerCase()
      const emphasis = (i: number): { a: number; glow: number } => {
        const n = g.nodes[i]
        let a = 1
        let glow = 0
        if (q.length > 0) {
          const match = n.title.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q))
          if (!match) return { a: 0.06, glow: 0 }
          glow = 0.3
        }
        if (st.lens === 2) {
          const heat = Math.max(0, 1 - (Date.now() - n.updatedAt) / (240 * 86400000))
          a = 0.25 + 0.75 * heat
          glow = heat
        }
        if (st.lens === 3) {
          if (n.degree === 0) glow = 0.8
          else a = Math.min(a, 0.13)
        }
        if (st.lens === 4 && w.betweenness) {
          const max = w.betweenness[g.nodes.length] || 1
          const b = w.betweenness[i] / max
          a = 0.18 + 0.82 * Math.sqrt(b)
          glow = Math.pow(b, 0.6)
        }
        return { a, glow }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = col.bg
      ctx.fillRect(0, 0, vw, vh)
      const projected: Array<ReturnType<typeof project>> = []
      g.nodes.forEach((n, i) => {
        const d = w.display[i]
        if (!d) return
        const [tx, ty, tz] = target(n)
        d.dx += (tx - d.dx) * k
        d.dy += (ty - d.dy) * k
        d.dz += (tz - d.dz) * k
        const em = emphasis(i)
        d.alpha += (em.a - d.alpha) * k
        projected[i] = project(d.dx, d.dy, d.dz)
      })
      // halos give clusters their nebula ground
      const order = g.nodes
        .map((_, i) => i)
        .filter((i) => projected[i] && w.display[i].alpha > 0.02)
        .sort((a, b) => projected[b]!.depth - projected[a]!.depth)
      for (const i of order) {
        const p = projected[i]!
        const n = g.nodes[i]
        const r = (24 + Math.sqrt(n.degree) * 8) * p.s
        if (r < 3 || p.sx < -r || p.sy < -r || p.sx > vw + r || p.sy > vh + r) continue
        const hue = col.regionHues[n.region % col.regionHues.length]
        const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r)
        grad.addColorStop(0, hue.replace('rgb(', 'rgba(').replace(')', ' / 0.14)'))
        grad.addColorStop(1, hue.replace('rgb(', 'rgba(').replace(')', ' / 0)'))
        ctx.globalAlpha = 0.9 * w.display[i].alpha * p.fog
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(p.sx, p.sy, r, 0, 7)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      // links
      if (st.edgeMode !== 2) {
        for (const [a, b] of g.edges) {
          const pa = projected[a]
          const pb = projected[b]
          if (!pa || !pb) continue
          const active =
            g.nodes[a].path === w.hoverPath ||
            g.nodes[b].path === w.hoverPath ||
            g.nodes[a].path === w.focusPath ||
            g.nodes[b].path === w.focusPath
          const fog = Math.min(pa.fog, pb.fog)
          const al =
            Math.min(w.display[a].alpha, w.display[b].alpha) * (st.edgeMode === 1 ? 0.5 : 0.22) * fog
          if (al < 0.02 && !active) continue
          ctx.strokeStyle = active ? col.muted : col.dim
          ctx.globalAlpha = active ? 0.75 : al
          ctx.lineWidth = Math.max(0.4, (pa.s + pb.s) * (active ? 0.55 : 0.4))
          ctx.beginPath()
          ctx.moveTo(pa.sx, pa.sy)
          ctx.lineTo(pb.sx, pb.sy)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
      // region names
      const zl = F / cam.dist
      const regionAlpha = Math.max(0, Math.min(1, (1.6 - zl) / 1.0))
      if (regionAlpha > 0.02 && g.regions.length > 1) {
        ctx.textAlign = 'center'
        g.regions.forEach((reg, ri) => {
          if (reg.count === 0) return
          const p = st.mode3d ? project(reg.cx, reg.cy, reg.cz) : project(reg.cx2, reg.cy2, 0)
          if (!p) return
          ctx.font = `500 ${Math.max(10, Math.min(19, 15 * p.s))}px Iowan Old Style, Palatino, Georgia, serif`
          ctx.fillStyle = col.regionHues[ri % col.regionHues.length]
          ctx.globalAlpha = regionAlpha * 0.8 * p.fog
          ctx.fillText(reg.label.toUpperCase().split('').join(' '), p.sx, p.sy - 20 * p.s)
        })
        ctx.globalAlpha = 1
      }
      // nodes
      for (const i of order) {
        const p = projected[i]!
        if (p.sx < -60 || p.sy < -60 || p.sx > vw + 60 || p.sy > vh + 60) continue
        const n = g.nodes[i]
        const d = w.display[i]
        const em = emphasis(i)
        const hue = col.regionHues[n.region % col.regionHues.length]
        const base = Math.max(1.4, (3.4 + Math.sqrt(n.degree) * 2.1) * p.s)
        if (em.glow > 0.05) {
          const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, base * 4.2)
          const glowHue = st.lens === 2 ? col.accent : hue
          grad.addColorStop(0, glowHue.replace('rgb(', 'rgba(').replace(')', ' / 0.32)'))
          grad.addColorStop(1, glowHue.replace('rgb(', 'rgba(').replace(')', ' / 0)'))
          ctx.globalAlpha = em.glow * d.alpha * p.fog
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(p.sx, p.sy, base * 4.2, 0, 7)
          ctx.fill()
        }
        ctx.globalAlpha = d.alpha * p.fog
        ctx.fillStyle = hue
        ctx.beginPath()
        ctx.arc(p.sx, p.sy, base, 0, 7)
        ctx.fill()
        if (n.path === w.focusPath || n.path === w.hoverPath) {
          ctx.strokeStyle = n.path === w.focusPath ? col.accent : col.fg
          ctx.lineWidth = n.path === w.focusPath ? 1.7 : 1.1
          ctx.globalAlpha = 0.95
          ctx.beginPath()
          ctx.arc(p.sx, p.sy, base + 4, 0, 7)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      // labels by zoom band, with collision skip
      const showAll = zl > 1.1
      if (zl > 0.5) {
        const placed: Array<{ x: number; y: number, wd: number }> = []
        ctx.textAlign = 'left'
        const byDeg = [...order].sort((a, b) => g.nodes[b].degree - g.nodes[a].degree)
        for (const i of byDeg) {
          const p = projected[i]!
          const n = g.nodes[i]
          const d = w.display[i]
          if (d.alpha < 0.25 || p.fog < 0.4) continue
          const isHub = n.degree >= 6
          const forced = n.path === w.focusPath || n.path === w.hoverPath
          if (!showAll && !isHub && !forced) continue
          if (p.sx < -40 || p.sy < -20 || p.sx > vw + 40 || p.sy > vh + 20) continue
          ctx.font = `${isHub || forced ? '600' : '400'} ${(forced ? 12 : isHub ? 11.5 : 10.5).toFixed(1)}px ui-sans-serif, system-ui, sans-serif`
          const tw = ctx.measureText(n.title).width
          const lx = p.sx + 8
          const ly = p.sy + 4
          let collide = false
          for (const pl of placed)
            if (Math.abs(pl.y - ly) < 13 && lx < pl.x + pl.wd && lx + tw > pl.x) {
              collide = true
              break
            }
          if (collide && !forced) continue
          placed.push({ x: lx, y: ly, wd: tw })
          const la = Math.min(1, d.alpha) * Math.max(0.8, p.fog)
          ctx.globalAlpha = la * 0.62
          ctx.fillStyle = col.bg
          ctx.beginPath()
          ctx.roundRect(lx - 3, ly - 10, tw + 6, 13, 3)
          ctx.fill()
          ctx.fillStyle = forced || isHub ? col.fg : col.muted
          ctx.globalAlpha = la
          ctx.fillText(n.title, lx, ly)
        }
        ctx.globalAlpha = 1
      }
      // hint labels
      if (w.hint) {
        ctx.textAlign = 'center'
        ctx.font = '700 11px ui-monospace, Menlo, monospace'
        for (const [i, code] of w.hint.labels) {
          if (w.hint.typed && !code.startsWith(w.hint.typed)) continue
          const p = projected[i]
          if (!p) continue
          ctx.fillStyle = col.accent
          ctx.globalAlpha = 0.96
          ctx.beginPath()
          ctx.roundRect(p.sx - 12, p.sy - 26, 24, 16, 4)
          ctx.fill()
          ctx.fillStyle = col.bg
          ctx.fillText(code, p.sx, p.sy - 14)
        }
        ctx.globalAlpha = 1
      }
      ;(canvas as unknown as { _proj?: typeof projected })._proj = projected
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Bridges lens needs betweenness; computed once per graph, on demand.
  useEffect(() => {
    if (lens !== 4 || world.current.betweenness || graph.nodes.length === 0) return
    const t = setTimeout(() => {
      const nCount = graph.nodes.length
      const adj: number[][] = graph.nodes.map(() => [])
      graph.edges.forEach(([a, b]) => {
        adj[a].push(b)
        adj[b].push(a)
      })
      const between = new Float64Array(nCount + 1)
      for (let s = 0; s < nCount; s++) {
        const stack: number[] = []
        const pred: number[][] = graph.nodes.map(() => [])
        const sigma = new Float64Array(nCount)
        const dist = new Int32Array(nCount).fill(-1)
        const delta = new Float64Array(nCount)
        sigma[s] = 1
        dist[s] = 0
        const queue = [s]
        while (queue.length > 0) {
          const v = queue.shift()!
          stack.push(v)
          for (const m of adj[v]) {
            if (dist[m] < 0) {
              dist[m] = dist[v] + 1
              queue.push(m)
            }
            if (dist[m] === dist[v] + 1) {
              sigma[m] += sigma[v]
              pred[m].push(v)
            }
          }
        }
        while (stack.length > 0) {
          const m = stack.pop()!
          for (const v of pred[m]) delta[v] += (sigma[v] / sigma[m]) * (1 + delta[m])
          if (m !== s) between[m] += delta[m]
        }
      }
      between[nCount] = Math.max(1, ...Array.from(between.slice(0, nCount)))
      world.current.betweenness = between
    }, 10)
    return () => clearTimeout(t)
  }, [lens, graph])

  function hitTest(sx: number, sy: number): number {
    const canvas = canvasRef.current as unknown as { _proj?: Array<null | { sx: number; sy: number; s: number; depth: number }> } | null
    const proj = canvas?._proj
    if (!proj) return -1
    let best = -1
    let bd = Infinity
    stateRef.current.graph.nodes.forEach((n, i) => {
      const p = proj[i]
      if (!p || world.current.display[i].alpha < 0.1) return
      const r = Math.max(1.4, (3.4 + Math.sqrt(n.degree) * 2.1) * p.s) + 6
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2
      if (d < r * r && p.depth < bd) {
        bd = p.depth
        best = i
      }
    })
    return best
  }

  function touch(): void {
    world.current.interacted = performance.now()
  }
  function enterHint(): void {
    const canvas = canvasRef.current as unknown as { _proj?: Array<null | { sx: number; sy: number }> } | null
    const proj = canvas?._proj
    const c = canvasRef.current
    if (!proj || !c) return
    const vw = c.clientWidth
    const vh = c.clientHeight
    const visible = stateRef.current.graph.nodes
      .map((_, i) => i)
      .filter((i) => {
        const p = proj[i]
        return p && world.current.display[i].alpha > 0.2 && p.sx > 10 && p.sy > 40 && p.sx < vw - 10 && p.sy < vh - 40
      })
      .sort((a, b) => {
        const pa = proj[a]!
        const pb = proj[b]!
        return (
          (pa.sx - vw / 2) ** 2 + (pa.sy - vh / 2) ** 2 - ((pb.sx - vw / 2) ** 2 + (pb.sy - vh / 2) ** 2)
        )
      })
      .slice(0, 81)
    const labels = new Map<number, string>()
    visible.forEach((i, idx) => labels.set(i, HINTKEYS[Math.floor(idx / 9)] + HINTKEYS[idx % 9]))
    world.current.hint = { labels, typed: '' }
  }
  function centerOnNode(i: number): void {
    const n = stateRef.current.graph.nodes[i]
    const cam = world.current.cam
    const [x, y, z] = target(n)
    cam.cxT = x
    cam.cyT = y
    cam.czT = z
    world.current.focusPath = n.path
    touch()
  }
  function jumpRegion(dir: number): void {
    const g = stateRef.current.graph
    if (g.regions.length === 0) return
    const focusNode = g.nodes.find((n) => n.path === world.current.focusPath)
    const cur = focusNode ? focusNode.region : 0
    const next = (cur + dir + g.regions.length) % g.regions.length
    const reg = g.regions[next]
    const cam = world.current.cam
    const c = canvasRef.current
    const minSide = Math.min(c?.clientWidth || 1200, c?.clientHeight || 800)
    if (stateRef.current.mode3d) {
      cam.cxT = reg.cx
      cam.cyT = reg.cy
      cam.czT = reg.cz
    } else {
      cam.cxT = reg.cx2
      cam.cyT = reg.cy2
      cam.czT = 0
    }
    cam.distT = Math.max(F * 0.5, (reg.r * F) / (minSide * 0.33))
    const hub = g.nodes.find((n) => n.region === next)
    if (hub) world.current.focusPath = hub.path
    setStatus(reg.label)
    touch()
  }
  function openFocused(): void {
    const path = world.current.focusPath
    if (path) void selectNote(path)
  }

  // Keyboard: capture phase so it beats VimNav; single letters are Vim-only
  // per the house rule (arrows, Enter and Escape stay universal).
  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent): void => {
      if (isAppOverlayOpen()) return
      if (document.querySelector('[data-vim-hint-overlay]')) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
      if (!atlasHoldsKeyboard(useStore.getState().focusedPanel, true)) return
      const regionDirection = atlasRegionDirection(e)
      if ((e.metaKey || e.ctrlKey || e.altKey) && regionDirection === 0) return
      const st = stateRef.current
      const w = world.current
      const cam = w.cam
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      if (w.hint) {
        consume()
        if (e.key === 'Escape') {
          w.hint = null
          return
        }
        if (/^[a-z]$/.test(e.key)) {
          w.hint.typed += e.key
          const matches = [...w.hint.labels.entries()].filter(([, c]) => c.startsWith(w.hint!.typed))
          if (matches.length === 1 && matches[0][1] === w.hint.typed) {
            const i = matches[0][0]
            w.hint = null
            centerOnNode(i)
          } else if (matches.length === 0) w.hint = null
        }
        return
      }
      const vim = st.vimMode
      const pan = (60 * cam.dist) / F
      const universal = (): boolean => {
        switch (e.key) {
          case 'ArrowLeft':
            if (st.mode3d) cam.yawT -= 0.14
            else cam.cxT -= pan
            return true
          case 'ArrowRight':
            if (st.mode3d) cam.yawT += 0.14
            else cam.cxT += pan
            return true
          case 'ArrowUp':
            if (st.mode3d) cam.pitchT = Math.min(1.25, cam.pitchT + 0.1)
            else cam.cyT -= pan
            return true
          case 'ArrowDown':
            if (st.mode3d) cam.pitchT = Math.max(-1.25, cam.pitchT - 0.1)
            else cam.cyT += pan
            return true
          case 'Enter':
            openFocused()
            return true
          case 'Escape':
            if (filterOpen || st.filterQ) {
              setFilterOpen(false)
              setFilterQ('')
            } else if (st.lens !== 1) setLens(1)
            else w.focusPath = null
            return true
          default:
            return false
        }
      }
      if (universal()) {
        touch()
        consume()
        return
      }
      if (!vim) return
      if (regionDirection !== 0) {
        jumpRegion(regionDirection)
        touch()
        consume()
        return
      }
      switch (e.key) {
        case 'h':
          if (st.mode3d) cam.yawT -= 0.14
          else cam.cxT -= pan
          break
        case 'l':
          if (st.mode3d) cam.yawT += 0.14
          else cam.cxT += pan
          break
        case 'k':
          if (st.mode3d) cam.pitchT = Math.min(1.25, cam.pitchT + 0.1)
          else cam.cyT -= pan
          break
        case 'j':
          if (st.mode3d) cam.pitchT = Math.max(-1.25, cam.pitchT - 0.1)
          else cam.cyT += pan
          break
        case '+':
        case '=':
          if (st.mode3d) {
            const cosY = Math.cos(cam.yaw)
            const sinY = Math.sin(cam.yaw)
            const cosP = Math.cos(cam.pitch)
            const sinP = Math.sin(cam.pitch)
            const travel = cam.distT * 0.18
            cam.cxT += sinY * cosP * travel
            cam.cyT += sinP * travel
            cam.czT += cosY * cosP * travel
          } else cam.distT = Math.max(F * 0.3, cam.distT / 1.22)
          break
        case '-':
          cam.distT = cam.distT * 1.22
          break
        case 'f':
          enterHint()
          break
        case '/':
          setFilterOpen(true)
          setTimeout(() => filterRef.current?.focus(), 30)
          break
        case 'v':
          setMode3d((m) => !m)
          break
        case 'c':
          setEdgeMode((m) => (m + 1) % 3)
          break
        case '0':
          fitAll()
          break
        case '1':
        case '2':
        case '3':
        case '4':
          setLens(Number(e.key) as Lens)
          break
        default:
          return
      }
      touch()
      consume()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, filterOpen])

  // Opening the map hands it the keyboard (focusedPanel = 'atlas') while DOM
  // focus still sits on <body>. The global Vim layer keys part of its yield
  // off the focused element, so `[` and `]` were swallowed as buffer-sequence
  // prefixes until a click landed inside the map (#670). Take real focus
  // whenever the map owns the keyboard, so every focus-based check agrees
  // with the store; never steal it from a text field.
  useEffect(() => {
    if (!isActive || focusedPanel !== 'atlas') return
    const root = rootRef.current
    if (!root) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) {
      if (root.contains(active)) return
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) return
    }
    root.focus({ preventScroll: true })
  }, [isActive, focusedPanel])

  // Mouse: drag orbits in 3D and pans in 2D; wheel flies; click focuses/opens.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let drag: { x: number; y: number } | null = null
    let moved = false
    const down = (e: MouseEvent): void => {
      drag = { x: e.clientX, y: e.clientY }
      moved = false
      touch()
    }
    const move = (e: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const cam = world.current.cam
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        drag = { x: e.clientX, y: e.clientY }
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        if (stateRef.current.mode3d && !e.shiftKey) {
          cam.yawT += dx * 0.005
          cam.yaw = cam.yawT
          cam.pitchT = Math.max(-1.25, Math.min(1.25, cam.pitchT + dy * 0.004))
          cam.pitch = cam.pitchT
        } else {
          const s = F / cam.dist
          const cosY = Math.cos(cam.yaw)
          const sinY = Math.sin(cam.yaw)
          const cosP = Math.cos(cam.pitch)
          const sinP = Math.sin(cam.pitch)
          cam.cxT -= (cosY * dx + sinY * sinP * dy) / s
          cam.cyT -= (cosP * dy) / s
          cam.czT -= (-sinY * dx + cosY * sinP * dy) / s
          cam.cx = cam.cxT
          cam.cy = cam.cyT
          cam.cz = cam.czT
        }
        touch()
      } else {
        const i = hitTest(sx, sy)
        world.current.hoverPath = i >= 0 ? stateRef.current.graph.nodes[i].path : null
        canvas.style.cursor = i >= 0 ? 'pointer' : 'grab'
      }
    }
    const up = (e: MouseEvent): void => {
      if (drag && !moved) {
        const rect = canvas.getBoundingClientRect()
        const i = hitTest(e.clientX - rect.left, e.clientY - rect.top)
        if (i >= 0) {
          const path = stateRef.current.graph.nodes[i].path
          if (world.current.focusPath === path) void selectNote(path)
          else world.current.focusPath = path
        } else world.current.focusPath = null
      }
      drag = null
    }
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      touch()
      const cam = world.current.cam
      const f = Math.exp(e.deltaY * 0.0014)
      if (stateRef.current.mode3d && f < 1) {
        // Fly forward through the sky toward the cursor instead of shrinking
        // the orbit: the camera target rides the view ray, so you pass between
        // clusters rather than watching them scale.
        const rect = canvas.getBoundingClientRect()
        const vx0 = e.clientX - rect.left - rect.width / 2
        const vy0 = e.clientY - rect.top - rect.height / 2
        const len = Math.hypot(vx0, vy0, F)
        const vx = vx0 / len
        const vy = vy0 / len
        const vz = F / len
        const cosY = Math.cos(cam.yaw)
        const sinY = Math.sin(cam.yaw)
        const cosP = Math.cos(cam.pitch)
        const sinP = Math.sin(cam.pitch)
        const y1 = vy * cosP + vz * sinP
        const z1 = -vy * sinP + vz * cosP
        const dir = [vx * cosY + z1 * sinY, y1, -vx * sinY + z1 * cosY]
        const travel = cam.distT * (1 - f)
        cam.cxT += dir[0] * travel
        cam.cyT += dir[1] * travel
        cam.czT += dir[2] * travel
      } else {
        cam.distT = Math.max(F * 0.3, cam.distT * f)
      }
    }
    canvas.addEventListener('mousedown', down)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      canvas.removeEventListener('mousedown', down)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      canvas.removeEventListener('wheel', wheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chip =
    'cursor-pointer rounded-full border border-paper-300 bg-paper-100 px-2.5 py-1 font-mono text-[11px] text-ink-600 hover:text-ink-800'
  return (
    <div
      ref={rootRef}
      data-atlas-view
      // The map draws its own focus feedback; the browser's focus ring around
      // the whole pane was the "white border" reported alongside #670.
      className="relative flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900 outline-none"
      onMouseDownCapture={() => setFocusedPanel('atlas')}
      onFocusCapture={() => setFocusedPanel('atlas')}
      tabIndex={0}
    >
      <canvas ref={canvasRef} className="min-h-0 flex-1" style={{ width: '100%', height: '100%' }} />
      <div className="pointer-events-none absolute left-4 top-3 select-none">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-700">Atlas</div>
        <div className="text-[11px] text-ink-500">
          {graph.nodes.length} notes · {graph.regions.filter((r) => r.count > 0).length} regions ·{' '}
          {graph.edges.length} links{status ? ` · ${status}` : ''}
        </div>
      </div>
      {filterOpen && (
        <div className="absolute right-4 top-3 flex items-center gap-2 rounded-lg border border-paper-300 bg-paper-50 px-3 py-1.5">
          <span className="font-mono text-xs text-accent">/</span>
          <input
            ref={filterRef}
            value={filterQ}
            onChange={(e) => setFilterQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setFilterQ('')
                setFilterOpen(false)
              }
              if (e.key === 'Enter') filterRef.current?.blur()
            }}
            placeholder="filter notes and tags"
            className="w-44 bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-paper-300 bg-paper-50/90 px-4 py-2 text-ink-400 backdrop-blur">
        <button type="button" className={chip} onClick={() => setLens((lens % 4) + 1 as Lens)}>
          lens: {LENS_NAMES[lens]}
        </button>
        <button type="button" className={chip} onClick={() => setMode3d((m) => !m)}>
          view: {mode3d ? 'sky' : 'map'}
        </button>
        <button type="button" className={chip} onClick={() => setEdgeMode((m) => (m + 1) % 3)}>
          links: {['quiet', 'all', 'off'][edgeMode]}
        </button>
        <button
          type="button"
          className={chip}
          onClick={() => {
            setFilterOpen(true)
            setTimeout(() => filterRef.current?.focus(), 30)
          }}
        >
          filter
        </button>
        <button type="button" className={chip} onClick={() => fitAll()}>
          fit
        </button>
        {vimMode && (
          <span className="ml-auto hidden font-mono text-[11px] text-ink-400 sm:inline">
            f jump · hjkl move · + - zoom · v 2d/3d · [ ] regions · 1..4 lens · Enter open
          </span>
        )}
      </div>
    </div>
  )
}
