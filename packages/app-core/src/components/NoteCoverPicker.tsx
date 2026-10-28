import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { readNoteCover } from '@shared/note-cover'
import { UNSPLASH_DEVELOPERS_URL, UNSPLASH_HOME_URL, unsplashReferralUrl } from '@shared/unsplash'
import type { UnsplashKeyStore, UnsplashPhoto } from '@zennotes/bridge-contract/unsplash'
import { useStore } from '../store'
import { rankItems } from '../lib/fuzzy-score'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { isImeComposing } from '../lib/ime'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { isClipboardImageFile, pastedImageFilesFromClipboard } from '../lib/editor-paste-images'
import { GRADIENT_COVERS, PHOTO_COVERS, type BuiltinCover } from '../lib/note-cover-gallery'
import {
  isVaultImagePath,
  removeCover,
  setCoverFromBuiltin,
  setCoverFromClipboard,
  setCoverFromFile,
  setCoverFromUnsplash,
  setCoverTarget
} from '../lib/note-cover-actions'
import { unsplashSearchAvailable, useUnsplashSearch, type UnsplashSearchState } from '../lib/unsplash-search'
import {
  openUnsplashKeySettings,
  refreshUnsplashKeyStatus,
  unsplashKeySupported,
  unsplashRateLimitSentence,
  useUnsplashKeyStatus
} from '../lib/unsplash-key'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

/** Vault images listed before a search narrows them. */
const VAULT_IMAGE_LIMIT = 48

type Choice =
  | { kind: 'builtin'; key: string; label: string; detail?: string; thumb: string; cover: BuiltinCover }
  | { kind: 'vault'; key: string; label: string; detail: string; thumb: string | null; path: string }
  | { kind: 'link'; key: string; label: string; detail: string; thumb: string; url: string }
  | { kind: 'unsplash'; key: string; label: string; detail: string; thumb: string; photo: UnsplashPhoto }

interface Section {
  title: string
  choices: Choice[]
}

type PickerTab = 'covers' | 'unsplash'

/** Tiles in a row at the picker's width: reaching the last row of Unsplash
 *  results asks for the next page. */
const UNSPLASH_ROW = 4

/** What the Unsplash tab says instead of tiles, or null when it has tiles. */
export function unsplashMessage(state: UnsplashSearchState, count: number): string | null {
  switch (state.status) {
    case 'idle':
      return 'Search free photos from Unsplash, with your own access key.'
    case 'loading':
      return 'Searching Unsplash…'
    case 'failed':
      switch (state.reason) {
        case 'offline':
          return 'Unsplash could not be reached. Check your connection; the Covers tab works offline.'
        case 'invalid-key':
          return 'Unsplash did not accept your access key. It may have been revoked, or part of it was lost when it was pasted.'
        case 'rate-limited':
          if (state.retryAt) {
            const at = new Date(state.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            return `Unsplash search is pausing until ${at}: ZenNotes sends at most 40 requests a minute. The Covers tab still works.`
          }
          return `${unsplashRateLimitSentence(state.limit)} The Covers tab still works.`
        case 'no-key':
          return 'Unsplash search needs an access key of your own.'
        default:
          return 'Unsplash search is not available right now. The Covers tab still works.'
      }
    case 'ready':
      return count === 0 ? `No Unsplash photos match “${state.query}”.` : null
  }
}

/** Something the Unsplash tab offers in place of photos (Open Settings, the
 *  developers page, Change key). The field keeps focus: ↑/↓ choose, Enter
 *  runs it. */
interface PanelAction {
  id: string
  label: string
  /** The footer's word for Enter while this action is chosen. */
  hint: string
  run: () => void
}

function openWebPage(url: string): void {
  // Desktop main hands a window.open to the default browser; the web client
  // opens a tab.
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * The cover picker (`Space l c`, `:cover`, "Change cover"). One search field
 * over everything a cover can come from: an https link typed into it, the
 * built-in gradients and photographs, and the images already in the vault.
 * Uploading is a button, and an image pasted or dropped anywhere in the
 * picker becomes the cover too.
 *
 * The field keeps focus the whole time, like every palette here: ↑/↓ (and
 * Ctrl+N/P, Ctrl+J/K) move a row at a time through the tiles, ←/→ step
 * through them while the field is empty, Enter picks, Escape closes.
 *
 * Unsplash is a second tab (Tab switches, keeping the text), not another
 * section: a section would send every search typed here to the network,
 * vault image names included, and spend the hourly budget every ZenNotes
 * user shares on people who never wanted a photo. On the tab, searching is
 * the user's own choice each time.
 */
export function NoteCoverPicker({ notePath }: { notePath: string }): JSX.Element {
  const setPickerPath = useStore((s) => s.setNoteCoverPickerPath)
  const start = useStore((s) => s.noteCoverPickerStart)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const assetFiles = useStore((s) => s.assetFiles)
  const hasCover = useStore((s) => {
    const body = s.noteContents[notePath]?.body
    return body != null && readNoteCover(body) !== null
  })
  const unsplashAvailable = unsplashSearchAvailable()
  const [tab, setTab] = useState<PickerTab>(() =>
    start?.tab === 'unsplash' && unsplashAvailable ? 'unsplash' : 'covers'
  )
  const [query, setQuery] = useState(() => start?.query ?? '')
  const [active, setActive] = useState(0)
  // The tab searches with the person's own key. Until one is set it shows how
  // to get one, and sends nothing; the status is known before anything is.
  const keyStatus = useUnsplashKeyStatus()
  const keySupported = unsplashKeySupported()
  const needsKey = keySupported && keyStatus?.set === false
  const keyReady = !keySupported || keyStatus?.set === true
  const { state: unsplash, loadMore } = useUnsplashSearch(query, tab === 'unsplash' && keyReady)
  const [panelActive, setPanelActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  const sections = useMemo<Section[]>(() => {
    const trimmed = query.trim()
    const out: Section[] = []
    if (tab === 'unsplash') {
      if (unsplash.status !== 'ready' || unsplash.photos.length === 0) return out
      out.push({
        title: 'Unsplash',
        choices: unsplash.photos.map((photo) => ({
          kind: 'unsplash',
          key: `unsplash:${photo.id}`,
          label: photo.photographer.name,
          detail: `${photo.alt ? `${photo.alt}\n` : ''}Photo by ${photo.photographer.name} on Unsplash`,
          thumb: photo.thumbUrl,
          photo
        }))
      })
      return out
    }
    if (/^https:\/\/\S+$/i.test(trimmed)) {
      out.push({
        title: 'Link',
        choices: [{ kind: 'link', key: 'link', label: 'Use this link', detail: trimmed, thumb: trimmed, url: trimmed }]
      })
      return out
    }
    const rankBuiltins = (covers: BuiltinCover[]): BuiltinCover[] =>
      rankItems(covers, trimmed, [
        { get: (c) => c.title, weight: 1 },
        { get: (c) => c.credit ?? '', weight: 0.6 }
      ])
    const builtin = (cover: BuiltinCover): Choice => ({
      kind: 'builtin',
      key: cover.id,
      label: cover.title,
      detail: cover.credit,
      thumb: cover.thumbUrl,
      cover
    })
    const gradients = rankBuiltins(GRADIENT_COVERS).map(builtin)
    const photos = rankBuiltins(PHOTO_COVERS).map(builtin)
    const images = assetFiles
      .filter((asset) => isVaultImagePath(asset.path))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const ranked = trimmed
      ? rankItems(images, trimmed, [
          { get: (a) => a.name, weight: 1 },
          { get: (a) => a.path, weight: 0.7 }
        ])
      : images.slice(0, VAULT_IMAGE_LIMIT)
    const vault: Choice[] = ranked.map((asset) => ({
      kind: 'vault',
      key: `vault:${asset.path}`,
      label: asset.name,
      detail: asset.path,
      thumb: vaultRoot ? window.zen.resolveVaultAssetUrl(vaultRoot, asset.path) : null,
      path: asset.path
    }))
    if (gradients.length) out.push({ title: 'Gradients', choices: gradients })
    if (photos.length) out.push({ title: 'Gallery', choices: photos })
    if (vault.length) out.push({ title: 'Images in this vault', choices: vault })
    return out
  }, [assetFiles, query, tab, unsplash, vaultRoot])

  const choices = useMemo(() => sections.flatMap((s) => s.choices), [sections])
  const unsplashQuery = unsplash.status === 'idle' ? '' : unsplash.query
  const failure = unsplash.status === 'failed' ? unsplash.reason : null

  // A search that finds no key (cleared in another window) or a refused one
  // asks the host again, so the tab shows the setup panel when it should.
  useEffect(() => {
    if (failure === 'no-key' || failure === 'invalid-key') void refreshUnsplashKeyStatus()
  }, [failure])

  const openKeySettings = (): void => {
    // Settings takes the keyboard; the editor does not get it back first.
    setPickerPath(null)
    openUnsplashKeySettings()
  }
  const panelActions: PanelAction[] =
    tab !== 'unsplash' || choices.length > 0
      ? []
      : needsKey || failure === 'no-key'
        ? [
            { id: 'settings', label: 'Open Settings', hint: 'open settings', run: openKeySettings },
            {
              id: 'developers',
              label: 'unsplash.com/developers',
              hint: 'open unsplash.com',
              run: () => openWebPage(UNSPLASH_DEVELOPERS_URL)
            }
          ]
        : failure === 'invalid-key'
          ? [{ id: 'settings', label: 'Change key', hint: 'change key', run: openKeySettings }]
          : []
  const panelActionsKey = panelActions.map((a) => a.id).join(' ')
  useEffect(() => setPanelActive(0), [panelActionsKey])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // A new search or tab starts at the first tile; a page of results added to
  // the same search leaves the selection where it is.
  useEffect(() => setActive(0), [query, tab, unsplashQuery])

  // Nearing the end of the Unsplash results asks for the next page.
  useEffect(() => {
    if (tab === 'unsplash' && choices.length > 0 && active >= choices.length - UNSPLASH_ROW) loadMore()
  }, [active, choices.length, loadMore, tab])

  useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-cover-choice-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const close = (): void => {
    setPickerPath(null)
    focusEditorNormalMode()
  }

  const run = async (task: () => Promise<boolean>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await task()) close()
    } finally {
      setBusy(false)
    }
  }

  const choose = (choice: Choice | undefined): void => {
    if (!choice) return
    if (choice.kind === 'builtin') void run(() => setCoverFromBuiltin(notePath, choice.cover))
    else if (choice.kind === 'vault') void run(() => setCoverTarget(notePath, { kind: 'vault', href: choice.path }))
    else if (choice.kind === 'unsplash') void run(() => setCoverFromUnsplash(notePath, choice.photo))
    else void run(() => setCoverTarget(notePath, { kind: 'url', url: choice.url }))
  }

  const pickFile = (file: File | undefined): void => {
    if (file) void run(() => setCoverFromFile(notePath, file))
  }

  /** The tile in the next row up or down, nearest the current one's column.
   *  Read off the layout, since sections break the grid into uneven rows. */
  const moveRow = (direction: 1 | -1): void => {
    const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-cover-choice-idx]') ?? [])
    const current = tiles[active]?.getBoundingClientRect()
    if (!current) return
    const centre = current.left + current.width / 2
    const beyond = tiles
      .map((tile, index) => ({ index, rect: tile.getBoundingClientRect() }))
      .filter(({ rect }) => (direction > 0 ? rect.top >= current.bottom - 2 : rect.bottom <= current.top + 2))
    if (beyond.length === 0) return
    const rowTop = direction > 0
      ? Math.min(...beyond.map(({ rect }) => rect.top))
      : Math.max(...beyond.map(({ rect }) => rect.top))
    const row = beyond.filter(({ rect }) => Math.abs(rect.top - rowTop) < 4)
    row.sort(
      (a, b) =>
        Math.abs(a.rect.left + a.rect.width / 2 - centre) - Math.abs(b.rect.left + b.rect.width / 2 - centre)
    )
    setActive(row[0]!.index)
  }

  const switchTab = (): void => setTab((t) => (t === 'covers' ? 'unsplash' : 'covers'))

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (e.key === 'Tab' && unsplashAvailable && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Two tabs, so Shift+Tab goes to the other one as well.
      e.preventDefault()
      e.stopPropagation()
      switchTab()
    } else if (panelActions.length > 0 && (isPaletteNextKey(e) || isPalettePreviousKey(e))) {
      e.preventDefault()
      e.stopPropagation()
      const step = isPaletteNextKey(e) ? 1 : -1
      setPanelActive((a) => Math.min(panelActions.length - 1, Math.max(0, a + step)))
    } else if (panelActions.length > 0 && e.key === 'Enter') {
      e.preventDefault()
      panelActions[Math.min(panelActive, panelActions.length - 1)]?.run()
    } else if (isPaletteNextKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      moveRow(1)
    } else if (isPalettePreviousKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      moveRow(-1)
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && query === '') {
      e.preventDefault()
      const step = e.key === 'ArrowRight' ? 1 : -1
      setActive((a) => Math.min(choices.length - 1, Math.max(0, a + step)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(choices[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // A pasted image becomes the cover from anywhere in the picker, not only
  // the field: Mod+V right after opening it is the quickest route there is.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const files = pastedImageFilesFromClipboard(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      pickFile(files[0])
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  })

  let index = 0
  return (
    <Modal size="xl" layer="palette" onClose={close} closeOnEsc={false} data={{ 'data-note-cover-picker': '' }}>
      <div
        onKeyDown={(e) => {
          // The field handles its own keys; this catches Escape on a button.
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          close()
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropActive(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
        }}
        onDrop={(e) => {
          setDropActive(false)
          const file = Array.from(e.dataTransfer.files ?? []).find(isClipboardImageFile)
          if (!file) return
          e.preventDefault()
          e.stopPropagation()
          pickFile(file)
        }}
        className={dropActive ? 'ring-2 ring-inset ring-accent' : ''}
      >
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder={tab === 'unsplash' ? 'Search Unsplash photos…' : 'Search covers, or paste an https link…'}
            aria-label={tab === 'unsplash' ? 'Search Unsplash photos' : 'Search covers'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-paper-300/70 px-4 py-2.5">
          {unsplashAvailable && (
            <div role="tablist" aria-label="Cover sources" className="mr-1 flex gap-1 border-r border-paper-300/70 pr-3">
              {(['covers', 'unsplash'] as const).map((id) => (
                <Button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  data-cover-picker-tab={id}
                  tabIndex={-1}
                  variant={tab === id ? 'secondary' : 'ghost'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setTab(id)
                    inputRef.current?.focus()
                  }}
                >
                  {id === 'covers' ? 'Covers' : 'Unsplash'}
                </Button>
              ))}
            </div>
          )}
          {tab === 'covers' && (
            <>
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                Upload image…
              </Button>
              <Button onClick={() => void run(() => setCoverFromClipboard(notePath))} disabled={busy}>
                Paste from clipboard
              </Button>
            </>
          )}
          {hasCover && (
            <Button variant="ghost" onClick={() => void run(() => removeCover(notePath))} disabled={busy}>
              Remove cover
            </Button>
          )}
          <span className="ml-auto text-xs text-ink-400">
            {tab === 'unsplash' ? 'Photos stay on Unsplash and load from there' : 'or drop or paste an image here'}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            tabIndex={-1}
            onChange={(e) => {
              pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
        <div
          ref={gridRef}
          className="max-h-[56vh] overflow-y-auto px-4 pb-4"
          onScroll={(e) => {
            const el = e.currentTarget
            if (tab === 'unsplash' && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore()
          }}
        >
          {sections.length === 0 && tab === 'unsplash' && (needsKey || failure === 'no-key') ? (
            <UnsplashKeySetupPanel
              store={keyStatus?.store}
              actions={panelActions}
              active={panelActive}
              onHover={setPanelActive}
            />
          ) : sections.length === 0 ? (
            <div data-cover-picker-message="" className="px-6 py-8 text-center text-sm text-ink-400">
              {tab === 'unsplash'
                ? keyStatus == null && keySupported
                  ? null
                  : unsplashMessage(unsplash, choices.length)
                : 'No covers match.'}
              {panelActions.length > 0 && (
                <PanelActionButtons actions={panelActions} active={panelActive} onHover={setPanelActive} />
              )}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.title}>
                <div className="pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  {section.title}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {section.choices.map((choice) => {
                    const i = index++
                    const selected = i === active
                    return (
                      <button
                        key={choice.key}
                        type="button"
                        data-cover-choice-idx={i}
                        title={choice.detail ? `${choice.label}\n${choice.detail}` : choice.label}
                        disabled={busy}
                        onClick={() => choose(choice)}
                        onMouseMove={() => setActive(i)}
                        className={[
                          'group flex min-w-0 flex-col overflow-hidden rounded-lg text-left ring-1 transition-shadow',
                          selected ? 'ring-2 ring-accent' : 'ring-paper-300 hover:ring-paper-400'
                        ].join(' ')}
                      >
                        <span
                          className="block h-16 w-full overflow-hidden bg-paper-200"
                          style={choice.kind === 'unsplash' && choice.photo.color ? { backgroundColor: choice.photo.color } : undefined}
                        >
                          {choice.thumb && (
                            <img src={choice.thumb} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
                          )}
                        </span>
                        <span className="truncate px-2 py-1.5 text-xs text-ink-700">{choice.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
          {tab === 'unsplash' && <UnsplashCreditLine choice={choices[active]} />}
          {unsplashAvailable && (
            <span>
              <kbd className="rounded bg-paper-200 px-1">tab</kbd> {tab === 'covers' ? 'Unsplash' : 'covers'}
            </span>
          )}
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓←→</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd>{' '}
            {panelActions.length > 0
              ? panelActions[Math.min(panelActive, panelActions.length - 1)]?.hint
              : 'set cover'}
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </Modal>
  )
}

/** The Unsplash tab without a key: what the key is for and how to get one,
 *  with Open Settings (the field) and the page where an app is made. */
function UnsplashKeySetupPanel({
  store,
  actions,
  active,
  onHover
}: {
  store: UnsplashKeyStore | undefined
  actions: PanelAction[]
  active: number
  onHover: (index: number) => void
}): JSX.Element {
  return (
    <div data-cover-picker-setup="" className="mx-auto max-w-xl px-6 py-7 text-sm leading-6 text-ink-600">
      <p className="font-medium text-ink-900">Unsplash search needs an access key of your own</p>
      <p className="mt-1 text-ink-500">
        ZenNotes searches Unsplash with a free key you create, so your searches go from{' '}
        {store === 'browser' ? 'this browser' : 'this computer'} straight to Unsplash. It takes a minute:
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5">
        <li>At unsplash.com/developers, open Your apps and create a New Application (a free Unsplash account is all it needs).</li>
        <li>Copy its Access Key. The Secret Key is not needed.</li>
        <li>Paste it into Settings → Typography → Covers → Unsplash access key.</li>
      </ol>
      <PanelActionButtons actions={actions} active={active} onHover={onHover} />
      <p className="mt-3 text-xs text-ink-400">
        A new Unsplash app allows 50 requests an hour, plenty for picking covers. The Covers tab needs no key.
      </p>
    </div>
  )
}

function PanelActionButtons({
  actions,
  active,
  onHover
}: {
  actions: PanelAction[]
  active: number
  onHover: (index: number) => void
}): JSX.Element {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {actions.map((action, i) => (
        <Button
          key={action.id}
          data-cover-picker-action={action.id}
          aria-current={i === active ? 'true' : undefined}
          // The field keeps focus, as with the tiles: ↑/↓ choose, Enter runs.
          tabIndex={-1}
          variant={i === 0 ? 'primary' : 'secondary'}
          className={i === active ? 'ring-2 ring-accent' : ''}
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => onHover(i)}
          onClick={action.run}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

/** The footer's credit for the selected photo, both links the way Unsplash
 *  asks: the photographer's profile and Unsplash, with the referral tags. */
function UnsplashCreditLine({ choice }: { choice: Choice | undefined }): JSX.Element {
  const home = unsplashReferralUrl(UNSPLASH_HOME_URL)
  const unsplashLink = (
    <a href={home} target="_blank" rel="noreferrer" className="text-ink-700 hover:underline">
      Unsplash
    </a>
  )
  return (
    <span data-cover-picker-credit="" className="mr-auto min-w-0 truncate">
      {choice?.kind === 'unsplash' ? (
        <>
          Photo by{' '}
          <a
            href={unsplashReferralUrl(choice.photo.photographer.profileUrl)}
            target="_blank"
            rel="noreferrer"
            className="text-ink-700 hover:underline"
          >
            {choice.photo.photographer.name}
          </a>{' '}
          on {unsplashLink}
        </>
      ) : (
        <>Photos from {unsplashLink}</>
      )}
    </span>
  )
}
