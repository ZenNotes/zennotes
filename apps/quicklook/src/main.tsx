import React from 'react'
import ReactDOM from 'react-dom/client'
import type { AssetMeta, ImportedAssetKind, NoteContent, VaultInfo } from '@shared/ipc'
import { applyTypographyVariables } from '@renderer/lib/typography-variables'
import { Button } from '@renderer/components/ui/Button'
import { ReadOnlyNoteCover } from '@renderer/components/ReadOnlyNoteCover'
// The full app stylesheet (prose, themes, KaTeX, highlight, diagram chrome),
// as the share viewer and the PDF export window ship it.
import '@renderer/styles/index.css'
import { readQuickLookPayload, type QuickLookPayload } from './payload'
import { installQuickLookBridge } from './shim'
import { quickLookTheme, readQuickLookPrefs, type QuickLookPrefs } from './prefs'
import { createQuickLookKeys, type QuickLookAction } from './keys'
import { isOutsideLink, postToHost } from './host'
import { quickLookCover, type QuickLookCover } from './cover'

const payload = readQuickLookPayload()
if (payload) {
  // The bridge must exist before any app-core module that reads window.zen.
  installQuickLookBridge(payload)
  void boot(payload).catch((error) => {
    console.error('Quick Look preview could not render this note.', error)
    postToHost({ action: 'ready' })
  })
} else {
  postToHost({ action: 'ready' })
}

async function boot(data: QuickLookPayload): Promise<void> {
  const prefs = readQuickLookPrefs(data.config)
  applyAppearance(prefs)

  const [{ useStore }, { LazyPreview }] = await Promise.all([
    import('@renderer/store'),
    import('@renderer/components/LazyPreview')
  ])

  const now = Date.now()
  const note: NoteContent = {
    path: data.notePath,
    title: data.title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: now,
    updatedAt: now,
    size: data.markdown.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: Object.keys(data.assets).length > 0,
    excerpt: '',
    body: data.markdown
  }
  // The references double as the asset paths, so app-core's resolver lands on
  // exactly the keys the extension resolved (the share viewer does the same).
  const assetFiles: AssetMeta[] = Object.keys(data.assets).map((ref, index) => ({
    path: ref,
    name: ref.split('/').pop() ?? ref,
    kind: assetKindOf(ref),
    siblingOrder: index,
    size: 0,
    updatedAt: 0
  }))
  useStore.setState({
    vault: { root: '/quicklook', name: 'Quick Look' } satisfies VaultInfo,
    notes: [],
    assetFiles,
    assetFilesListed: true,
    selectedPath: note.path,
    activeNote: note,
    mathRenderer: 'katex'
  } as never)

  const root = document.getElementById('zen-quicklook-root')
  if (!root) return
  root.addEventListener('click', followOrHold, true)
  root.addEventListener('change', (event) => event.stopPropagation(), true)
  root.addEventListener('contextmenu', (event) => event.stopPropagation(), true)
  listenForKeys(prefs.vimMode)

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <QuickLookPage title={data.title} vimMode={prefs.vimMode} cover={quickLookCover(data, prefs)}>
        <LazyPreview markdown={note.body} notePath={note.path} onRendered={onRendered} />
      </QuickLookPage>
    </React.StrictMode>
  )
}

function QuickLookPage({
  title,
  vimMode,
  cover,
  children
}: {
  title: string
  vimMode: boolean
  cover: QuickLookCover | null
  children: React.ReactNode
}): React.ReactElement {
  return (
    <>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-paper-300 bg-paper-50 px-4 py-2">
        <span className="min-w-0 truncate text-sm text-ink-500">{title}</span>
        <Button variant="primary" size="sm" data-quicklook-open onClick={() => postToHost({ action: 'open' })}>
          Open in ZenNotes
          <KeyHint label="↵" />
          {vimMode ? <KeyHint label="o" /> : null}
        </Button>
      </header>
      {cover ? <ReadOnlyNoteCover url={cover.url} y={cover.y} /> : null}
      <article className="zen-quicklook-note">{children}</article>
    </>
  )
}

function KeyHint({ label }: { label: string }): React.ReactElement {
  return <kbd className="rounded border border-paper-300 px-1 font-sans text-xs opacity-70">{label}</kbd>
}

let readySent = false
function onRendered(): void {
  const root = document.getElementById('zen-quicklook-root')
  // Wikilinks, tags and task checkboxes act on a vault in the app; here they
  // are plain text, as on a public share.
  for (const anchor of root?.querySelectorAll<HTMLAnchorElement>('a.wikilink, a.hashtag') ?? []) {
    anchor.removeAttribute('href')
  }
  for (const checkbox of root?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []) {
    checkbox.disabled = true
  }
  if (readySent) return
  readySent = true
  // Quick Look shows the panel when the extension says the page is ready, so
  // it opens on the rendered note rather than on an empty page.
  requestAnimationFrame(() => postToHost({ action: 'ready' }))
}

/** Outside links open in the browser through the extension; anything that
 *  would navigate the preview itself is held, except a jump within the note. */
function followOrHold(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('input[type="checkbox"], .zen-task-state-in-progress[data-task-index]')) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  const anchor = target?.closest<HTMLAnchorElement>('a')
  if (!anchor || anchor.closest('[data-quicklook-open]')) return
  const href = anchor.getAttribute('href') ?? ''
  if (href.startsWith('#')) return
  event.preventDefault()
  event.stopPropagation()
  if (isOutsideLink(href)) postToHost({ action: 'openLink', url: href.trim() })
}

function listenForKeys(vimMode: boolean): void {
  const handle = createQuickLookKeys(vimMode)
  window.addEventListener('keydown', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
    const action = handle(event)
    if (!action) return
    event.preventDefault()
    perform(action)
  })
}

function perform(action: QuickLookAction): void {
  const line = 40
  const half = Math.round(window.innerHeight / 2)
  switch (action) {
    case 'open':
      postToHost({ action: 'open' })
      return
    case 'lineDown':
      window.scrollBy({ top: line })
      return
    case 'lineUp':
      window.scrollBy({ top: -line })
      return
    case 'halfDown':
      window.scrollBy({ top: half })
      return
    case 'halfUp':
      window.scrollBy({ top: -half })
      return
    case 'top':
      window.scrollTo({ top: 0 })
      return
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight })
  }
}

/** The user's ZenNotes theme and typography; auto mode follows the system. */
function applyAppearance(prefs: QuickLookPrefs): void {
  const html = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = (): void => {
    const theme = quickLookTheme(prefs, media.matches)
    html.dataset.theme = theme.id
    html.dataset.themeMode = theme.mode
    html.setAttribute('data-opaque', '')
    html.style.colorScheme = theme.mode
  }
  applyTheme()
  media.addEventListener('change', applyTheme)
  applyTypographyVariables(html, {
    editorFontSize: prefs.editorFontSize,
    mathFontScale: prefs.mathFontScale,
    editorLineHeight: prefs.editorLineHeight,
    previewMaxWidth: prefs.previewMaxWidth,
    contentAlign: prefs.contentAlign,
    completedTaskStyle: prefs.completedTaskStyle,
    mathRenderer: 'katex',
    interfaceFont: prefs.interfaceFont,
    textFont: prefs.textFont,
    monoFont: prefs.monoFont
  })

  const style = document.createElement('style')
  style.textContent = `
    /* The app stylesheet treats the document as a fixed-viewport app shell
       (height: 100%, overflow: hidden, user-select: none). A preview is a
       scrolling document, as the share viewer and PDF export make it. */
    html, body {
      height: auto !important;
      min-height: 100vh;
      margin: 0;
      overflow: visible !important;
      user-select: text !important;
      background: rgb(var(--z-bg));
    }
    .zen-quicklook-note { padding: 8px 0 48px; }
    .zen-quicklook-note .prose-zen a.wikilink,
    .zen-quicklook-note .prose-zen a.wikilink.broken,
    .zen-quicklook-note .prose-zen a.hashtag {
      color: rgb(var(--z-grey-1));
      border-bottom: 1px dashed rgb(var(--z-grey-dim));
      text-decoration: none;
      pointer-events: none;
      cursor: default;
    }
    .zen-quicklook-note .prose-zen input[type="checkbox"] { pointer-events: none; }
  `
  document.head.appendChild(style)
}

function assetKindOf(ref: string): ImportedAssetKind {
  const ext = ref.toLowerCase().split('.').pop() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'apng', 'svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav'].includes(ext)) return 'audio'
  if (['mp4', 'm4v', 'mov', 'ogv', 'webm'].includes(ext)) return 'video'
  return 'file'
}
