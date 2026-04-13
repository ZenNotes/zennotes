import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { renderMarkdown } from '../lib/markdown'
import { useStore } from '../store'
import { resolveWikilinkTarget } from '../lib/wikilinks'
import { toggleTaskAtIndex } from '../lib/tasklists'
import { enhanceLocalAssetNodes } from '../lib/local-assets'
import { NoteHoverPreview } from './NoteHoverPreview'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: 'inherit',
          primaryColor: '#faf7f0',
          primaryTextColor: '#2a2620',
          primaryBorderColor: '#d9d0bd',
          lineColor: '#8a8073',
          secondaryColor: '#fdfbf7',
          tertiaryColor: '#f5f0e6'
        }
      })
      return m.default
    })
  }
  return mermaidPromise
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
  const selectNote = useStore((s) => s.selectNote)
  const setView = useStore((s) => s.setView)
  const updateActiveBody = useStore((s) => s.updateActiveBody)
  const persistActive = useStore((s) => s.persistActive)
  const [hovered, setHovered] = useState<{ note: NoteMeta; rect: DOMRect } | null>(null)

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
      onRequestEdit
    })

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
        if (tag) setView({ kind: 'tag', tag })
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
    root.addEventListener('click', onClick)
    root.addEventListener('mouseover', onMouseOver)
    root.addEventListener('mousemove', onMouseMove)
    root.addEventListener('mouseout', onMouseOut)
    root.addEventListener('change', onChange)

    // Mermaid: render any pending `.mermaid` blocks.
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))
    if (blocks.length > 0) {
      void loadMermaid().then(async (mermaid) => {
        for (let i = 0; i < blocks.length; i++) {
          const el = blocks[i]
          const source = el.textContent || ''
          try {
            const { svg } = await mermaid.render(`zen-mermaid-${Date.now()}-${i}`, source)
            el.innerHTML = svg
          } catch (err) {
            el.innerHTML = `<pre class="text-sm text-red-600">Mermaid error: ${
              (err as Error).message
            }</pre>`
          }
        }
      })
    }

    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('mouseover', onMouseOver)
      root.removeEventListener('mousemove', onMouseMove)
      root.removeEventListener('mouseout', onMouseOut)
      root.removeEventListener('change', onChange)
    }
  }, [html, markdown, notePath, notes, onRequestEdit, persistActive, selectNote, setView, updateActiveBody, vault?.root])

  return (
    <>
      <article
        data-preview-content
        ref={ref}
        className="prose-zen py-8"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {hovered && <NoteHoverPreview note={hovered.note} anchorRect={hovered.rect} />}
    </>
  )
}
