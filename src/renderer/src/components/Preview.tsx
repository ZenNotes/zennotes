import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { renderMarkdown } from '../lib/markdown'
import { useStore } from '../store'
import { resolveAuto, THEMES } from '../lib/themes'
import { resolveWikilinkTarget } from '../lib/wikilinks'
import { toggleTaskAtIndex } from '../lib/tasklists'
import {
  enhanceLocalAssetNodes,
  resolveAssetVaultRelativePath
} from '../lib/local-assets'
import { enhancePreviewHeadingFolds } from '../lib/preview-heading-fold'
import { NoteHoverPreview } from './NoteHoverPreview'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

// ---------------------------------------------------------------------------
// Mermaid: lazy singleton + theme-aware render
// ---------------------------------------------------------------------------

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

/** Read a `--z-*` CSS variable (stored as `"R G B"` triplet) as a hex
 *  color string. Mermaid's themeVariables expect real color values, not
 *  raw triplets. Falls back to a neutral grey if the var is missing. */
function readThemeColor(name: string, fallback = '#888888'): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  if (!raw) return fallback
  const parts = raw.split(/[\s,]+/).map((n) => Number(n))
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`
}

interface MermaidThemeConfig {
  theme: 'base'
  themeVariables: Record<string, string>
  darkMode: boolean
}

/** Build a complete Mermaid themeVariables map from the current `--z-*`
 *  CSS custom properties on `<html>`. We use mermaid's `base` theme and
 *  drive every color from the app theme so the diagram naturally matches
 *  whichever of the 16+ app themes is active. */
function buildMermaidTheme(mode: 'light' | 'dark'): MermaidThemeConfig {
  const bg = readThemeColor('--z-bg')
  const bg1 = readThemeColor('--z-bg-1')
  const bg2 = readThemeColor('--z-bg-2')
  const bg3 = readThemeColor('--z-bg-3')
  const bgSofter = readThemeColor('--z-bg-softer', bg1)
  const fg = readThemeColor('--z-fg')
  const fg1 = readThemeColor('--z-fg-1', fg)
  const grey = readThemeColor('--z-grey-1')
  const accent = readThemeColor('--z-accent', '#c35e0a')
  const red = readThemeColor('--z-red', '#c14a4a')
  const green = readThemeColor('--z-green', '#6c782e')
  const yellow = readThemeColor('--z-yellow', '#b47109')
  const blue = readThemeColor('--z-blue', '#45707a')
  const purple = readThemeColor('--z-purple', '#945e80')
  const aqua = readThemeColor('--z-aqua', '#4c7a5d')

  return {
    theme: 'base',
    darkMode: mode === 'dark',
    themeVariables: {
      // Typography
      fontFamily: 'inherit',
      fontSize: '14px',

      // Core palette — mermaid derives most diagrams from these.
      background: bg,
      primaryColor: bg2,
      primaryTextColor: fg1,
      primaryBorderColor: bg3,
      secondaryColor: bg1,
      secondaryTextColor: fg,
      secondaryBorderColor: bg3,
      tertiaryColor: bgSofter,
      tertiaryTextColor: fg,
      tertiaryBorderColor: bg3,

      // Flow nodes + edges
      mainBkg: bg2,
      nodeBorder: bg3,
      nodeTextColor: fg1,
      lineColor: grey,
      arrowheadColor: grey,
      edgeLabelBackground: bg,

      // Cluster / subgraph
      clusterBkg: bgSofter,
      clusterBorder: bg3,
      titleColor: fg1,

      // Sequence diagrams
      actorBkg: bg2,
      actorBorder: bg3,
      actorTextColor: fg1,
      actorLineColor: grey,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: bg2,
      labelBoxBorderColor: bg3,
      labelTextColor: fg1,
      loopTextColor: fg,
      noteBkgColor: bgSofter,
      noteBorderColor: bg3,
      noteTextColor: fg1,
      activationBkgColor: bg3,
      activationBorderColor: grey,
      sequenceNumberColor: bg,

      // State / class diagrams
      labelColor: fg1,
      altBackground: bgSofter,
      transitionColor: grey,
      transitionLabelColor: fg,
      stateLabelColor: fg1,
      stateBkg: bg2,
      compositeBackground: bgSofter,
      compositeBorder: bg3,
      compositeTitleBackground: bg1,
      specialStateColor: accent,
      innerEndBackground: fg1,

      // ER diagrams
      attributeBackgroundColorOdd: bg,
      attributeBackgroundColorEven: bgSofter,

      // Gantt
      taskBkgColor: accent,
      taskTextColor: bg,
      taskTextOutsideColor: fg1,
      taskTextLightColor: bg,
      taskTextDarkColor: fg1,
      taskTextClickableColor: accent,
      activeTaskBkgColor: accent,
      activeTaskBorderColor: accent,
      doneTaskBkgColor: bg3,
      doneTaskBorderColor: grey,
      gridColor: bg3,
      sectionBkgColor: bg1,
      sectionBkgColor2: bgSofter,
      altSectionBkgColor: bgSofter,

      // XY chart
      xyChart: JSON.stringify({
        backgroundColor: bg,
        titleColor: fg1,
        xAxisLabelColor: fg,
        xAxisTitleColor: fg1,
        xAxisTickColor: grey,
        xAxisLineColor: grey,
        yAxisLabelColor: fg,
        yAxisTitleColor: fg1,
        yAxisTickColor: grey,
        yAxisLineColor: grey,
        plotColorPalette: [accent, blue, green, purple, yellow, red, aqua]
          .join(', ')
      }),

      // Git graph
      git0: accent,
      git1: blue,
      git2: green,
      git3: purple,
      git4: yellow,
      git5: red,
      git6: aqua,
      git7: fg,
      gitBranchLabel0: bg,
      gitBranchLabel1: bg,
      gitBranchLabel2: bg,
      gitBranchLabel3: bg,
      gitBranchLabel4: fg1,
      gitBranchLabel5: bg,
      gitBranchLabel6: bg,
      gitBranchLabel7: bg,

      // Pie
      pie1: accent,
      pie2: blue,
      pie3: green,
      pie4: purple,
      pie5: yellow,
      pie6: red,
      pie7: aqua,
      pie8: fg1,
      pie9: grey,
      pie10: bg3,
      pieTitleTextColor: fg1,
      pieSectionTextColor: bg,
      pieLegendTextColor: fg1,
      pieStrokeColor: bg,
      pieOuterStrokeColor: grey,

      // Signals / errors
      errorBkgColor: red,
      errorTextColor: bg
    }
  }
}

export function Preview({
  markdown,
  notePath,
  onRequestEdit
}: {
  markdown: string
  notePath: string
  onRequestEdit?: (() => void) | null
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const vault = useStore((s) => s.vault)
  const notes = useStore((s) => s.notes)
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  // Track the OS-level preference so `mode: 'auto'` themes still pick
  // the right mermaid palette when the system toggles between light/dark.
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  )
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent): void => setPrefersDark(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  const effectiveMode: 'light' | 'dark' = useMemo(() => {
    const resolvedId =
      themeMode === 'auto' ? resolveAuto(themeFamily, prefersDark) : themeId
    return THEMES.find((t) => t.id === resolvedId)?.mode ?? 'light'
  }, [themeId, themeFamily, themeMode, prefersDark])
  const selectNote = useStore((s) => s.selectNote)
  const setView = useStore((s) => s.setView)
  const updateActiveBody = useStore((s) => s.updateActiveBody)
  const persistActive = useStore((s) => s.persistActive)
  const pinAssetReference = useStore((s) => s.pinAssetReference)
  const pinAssetReferenceForNote = useStore((s) => s.pinAssetReferenceForNote)
  const pinnedRefPath = useStore((s) => s.pinnedRefPath)
  const pinnedRefKind = useStore((s) => s.pinnedRefKind)
  const pinnedRefVisible = useStore((s) => s.pinnedRefVisible)
  const togglePinnedRefVisible = useStore((s) => s.togglePinnedRefVisible)
  const pinnedAssetPath = pinnedRefKind === 'asset' ? pinnedRefPath : null
  const [hovered, setHovered] = useState<{ note: NoteMeta; rect: DOMRect } | null>(null)
  const [assetMenu, setAssetMenu] = useState<
    { x: number; y: number; url: string; vaultRel: string | null; href: string } | null
  >(null)

  const html = useMemo(() => renderMarkdown(markdown), [markdown])

  // After render: mark broken wikilinks, wire clicks, render mermaid.
  useEffect(() => {
    const root = ref.current
    if (!root) return

    // Resolve wikilinks against the current vault.
    root.querySelectorAll<HTMLAnchorElement>('a.wikilink').forEach((a) => {
      const target = a.getAttribute('data-wikilink') || ''
      const resolved = resolveWikilinkTarget(notes, target)
      if (resolved) {
        a.classList.remove('broken')
        a.dataset.resolvedPath = resolved.path
      } else {
        a.classList.add('broken')
        delete a.dataset.resolvedPath
      }
    })

    enhanceLocalAssetNodes(root, {
      vaultRoot: vault?.root,
      notePath,
      onRequestEdit,
      pinnedAssetPath,
      onActivatePinnedRef: () => {
        if (!pinnedRefVisible) togglePinnedRefVisible()
      }
    })

    enhancePreviewHeadingFolds(root)

    root.querySelectorAll<HTMLInputElement>('li.task-list-item input[type="checkbox"]').forEach(
      (input, idx) => {
        input.disabled = false
        input.dataset.taskIndex = String(idx)
        input.setAttribute('role', 'checkbox')
        input.classList.add('cursor-pointer')
      }
    )

    const onClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (!anchor) return
      if (anchor.classList.contains('wikilink')) {
        e.preventDefault()
        const path = anchor.dataset.resolvedPath
        if (path) void selectNote(path)
        return
      }
      if (anchor.classList.contains('hashtag')) {
        e.preventDefault()
        const tag = anchor.getAttribute('data-tag')
        if (tag) void useStore.getState().openTagView(tag)
        return
      }
      const localAssetUrl = anchor.dataset.localAssetUrl
      if (localAssetUrl) {
        e.preventDefault()
        window.open(localAssetUrl, '_blank')
        return
      }
      // External links: let Electron's window-open handler send them to the OS browser.
      const href = anchor.getAttribute('href') || ''
      if (/^(https?:|file:)/i.test(href)) {
        e.preventDefault()
        window.open(href, '_blank')
      }
    }
    const onMouseOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a.wikilink') as HTMLAnchorElement | null
      if (!anchor) return
      const resolvedPath = anchor.dataset.resolvedPath
      if (!resolvedPath) return
      const note = notes.find((item) => item.path === resolvedPath)
      if (!note) return
      setHovered({ note, rect: anchor.getBoundingClientRect() })
    }
    const onMouseMove = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a.wikilink') as HTMLAnchorElement | null
      if (!anchor) {
        setHovered(null)
        return
      }
      const resolvedPath = anchor.dataset.resolvedPath
      if (!resolvedPath) return
      const note = notes.find((item) => item.path === resolvedPath)
      if (!note) return
      setHovered({ note, rect: anchor.getBoundingClientRect() })
    }
    const onMouseOut = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('a.wikilink')) setHovered(null)
    }
    const onChange = (e: Event): void => {
      const input = e.target as HTMLInputElement | null
      if (!input || input.type !== 'checkbox') return
      const taskIndex = Number.parseInt(input.dataset.taskIndex ?? '-1', 10)
      if (!Number.isFinite(taskIndex) || taskIndex < 0) return
      const nextMarkdown = toggleTaskAtIndex(markdown, taskIndex, input.checked)
      if (nextMarkdown === markdown) return
      updateActiveBody(nextMarkdown)
      void persistActive()
    }
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      // Find the closest embedded-asset host (figure/anchor) that we
      // tagged in `enhanceLocalAssetNodes` or the CM PDF widget.
      const host = target.closest<HTMLElement>(
        '[data-local-asset-kind][data-local-asset-url]'
      )
      if (!host) return
      if (host.dataset.localAssetKind !== 'pdf') return
      const url = host.dataset.localAssetUrl || ''
      const href = host.dataset.localAssetHref || host.getAttribute('href') || ''
      if (!url) return
      e.preventDefault()
      const vaultRel = vault?.root
        ? resolveAssetVaultRelativePath(vault.root, notePath, href || url)
        : null
      setAssetMenu({ x: e.clientX, y: e.clientY, url, vaultRel, href })
    }

    root.addEventListener('click', onClick)
    root.addEventListener('mouseover', onMouseOver)
    root.addEventListener('mousemove', onMouseMove)
    root.addEventListener('mouseout', onMouseOut)
    root.addEventListener('change', onChange)
    root.addEventListener('contextmenu', onContextMenu)

    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('mouseover', onMouseOver)
      root.removeEventListener('mousemove', onMouseMove)
      root.removeEventListener('mouseout', onMouseOut)
      root.removeEventListener('change', onChange)
      root.removeEventListener('contextmenu', onContextMenu)
    }
  }, [
    html,
    markdown,
    notePath,
    notes,
    onRequestEdit,
    persistActive,
    selectNote,
    setView,
    updateActiveBody,
    vault?.root,
    pinnedAssetPath,
    pinnedRefVisible,
    togglePinnedRefVisible
  ])

  // Theme-aware mermaid rendering. Runs independently of the DOM-wiring
  // effect above so it can re-render diagrams when the user switches
  // themes without re-attaching every click/hover listener. Each block
  // keeps its source in `data-mermaid-source` (set by the rehype plugin)
  // so we can re-parse it even after the first render replaced the div's
  // innerHTML with an SVG.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))
    if (blocks.length === 0) return
    let cancelled = false
    void loadMermaid().then(async (mermaid) => {
      if (cancelled) return
      const cfg = buildMermaidTheme(effectiveMode)
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          ...cfg
        })
      } catch {
        /* initialize is tolerant across versions — ignore */
      }
      for (let i = 0; i < blocks.length; i++) {
        if (cancelled) return
        const el = blocks[i]
        const source =
          el.getAttribute('data-mermaid-source') ?? el.textContent ?? ''
        if (!source.trim()) continue
        // Persist the source in case the attribute was lost somehow — a
        // later theme-change render needs to read it back.
        el.setAttribute('data-mermaid-source', source)
        const id = `zen-mermaid-${Date.now()}-${i}`
        try {
          const { svg } = await mermaid.render(id, source)
          if (cancelled) return
          el.innerHTML = svg
        } catch (err) {
          if (cancelled) return
          el.innerHTML = `<pre class="whitespace-pre-wrap text-xs text-[color:rgb(var(--z-red))]">Mermaid error: ${
            (err as Error).message
          }</pre>`
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [html, effectiveMode])

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return []
    return [
      {
        label: 'Open as Reference (This Note)',
        disabled: !assetMenu.vaultRel,
        onSelect: async () => {
          if (assetMenu.vaultRel) {
            pinAssetReferenceForNote(notePath, assetMenu.vaultRel)
          }
        }
      },
      {
        label: 'Open as Reference (Global)',
        disabled: !assetMenu.vaultRel,
        onSelect: async () => {
          if (assetMenu.vaultRel) pinAssetReference(assetMenu.vaultRel)
        }
      },
      {
        label: 'Open in New Window',
        onSelect: async () => {
          window.open(assetMenu.url, '_blank')
        }
      }
    ]
  }, [assetMenu, notePath, pinAssetReference, pinAssetReferenceForNote])
  const closeAssetMenu = useCallback(() => setAssetMenu(null), [])

  return (
    <>
      <article
        data-preview-content
        ref={ref}
        className="prose-zen py-8"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {hovered && <NoteHoverPreview note={hovered.note} anchorRect={hovered.rect} />}
      {assetMenu && (
        <ContextMenu
          x={assetMenu.x}
          y={assetMenu.y}
          items={assetMenuItems}
          onClose={closeAssetMenu}
        />
      )}
    </>
  )
}
