import { useEffect, useState } from 'react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ExcalidrawIcon, ImageIcon, ColumnsIcon, LinkIcon, ExternalIcon } from './icons'
import { useStore } from '../store'
import { getExcalidrawPreview } from '../lib/excalidraw-preview'
import { dataUrlBytes, dataUrlMimeType } from '../lib/data-url'

interface MenuState {
  x: number
  y: number
  path: string
}

/** Copy the drawing's rendered PNG to the system clipboard. */
async function copyDrawingImage(path: string): Promise<void> {
  try {
    const dataUrl = await getExcalidrawPreview(path)
    if (!dataUrl) return
    const type = dataUrlMimeType(dataUrl, 'image/png')
    const blob = new Blob([dataUrlBytes(dataUrl)], { type })
    await navigator.clipboard.write([new ClipboardItem({ [type]: blob })])
  } catch (err) {
    console.error('copy drawing image failed', path, err)
  }
}

/**
 * Right-click menu for embedded Excalidraw drawings, shared by the reading view
 * and the editor live-preview widget. Both surfaces dispatch a
 * `zen:excalidraw-embed-menu` event (with the drawing path + cursor position)
 * instead of falling through to the editor's plain text context menu. (#360)
 */
export function ExcalidrawEmbedMenuHost(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<MenuState>).detail
      if (detail?.path) setMenu({ x: detail.x, y: detail.y, path: detail.path })
    }
    window.addEventListener('zen:excalidraw-embed-menu', handler)
    return () => window.removeEventListener('zen:excalidraw-embed-menu', handler)
  }, [])

  if (!menu) return null

  const items: ContextMenuItem[] = [
    {
      label: 'Open drawing',
      icon: <ExcalidrawIcon />,
      onSelect: () => void useStore.getState().openNoteInTab(menu.path)
    },
    {
      label: 'Open in split',
      icon: <ColumnsIcon />,
      onSelect: () => {
        const s = useStore.getState()
        void s.splitPaneWithTab({ targetPaneId: s.activePaneId, edge: 'right', path: menu.path })
      }
    },
    { kind: 'separator' },
    {
      label: 'Copy image',
      icon: <ImageIcon />,
      onSelect: () => void copyDrawingImage(menu.path)
    },
    {
      label: 'Copy embed',
      icon: <LinkIcon />,
      onSelect: () => {
        // Copy the Obsidian-style embed for the drawing's filename, so it can be
        // pasted into another note (resolveExcalidrawEmbedPath matches by name).
        const name = menu.path.split('/').pop() ?? menu.path
        window.zen.clipboardWriteText(`![[${name}]]`)
      }
    },
    { kind: 'separator' },
    {
      label: 'Reveal in File Manager',
      icon: <ExternalIcon />,
      onSelect: () => void window.zen.revealNote(menu.path)
    }
  ]

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
}
