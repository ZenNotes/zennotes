import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { readNoteCover } from '@shared/note-cover'
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
  setCoverTarget
} from '../lib/note-cover-actions'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

/** Vault images listed before a search narrows them. */
const VAULT_IMAGE_LIMIT = 48

type Choice =
  | { kind: 'builtin'; key: string; label: string; detail?: string; thumb: string; cover: BuiltinCover }
  | { kind: 'vault'; key: string; label: string; detail: string; thumb: string | null; path: string }
  | { kind: 'link'; key: string; label: string; detail: string; thumb: string; url: string }

interface Section {
  title: string
  choices: Choice[]
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
 */
export function NoteCoverPicker({ notePath }: { notePath: string }): JSX.Element {
  const setPickerPath = useStore((s) => s.setNoteCoverPickerPath)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const assetFiles = useStore((s) => s.assetFiles)
  const hasCover = useStore((s) => {
    const body = s.noteContents[notePath]?.body
    return body != null && readNoteCover(body) !== null
  })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  const sections = useMemo<Section[]>(() => {
    const trimmed = query.trim()
    const out: Section[] = []
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
  }, [assetFiles, query, vaultRoot])

  const choices = useMemo(() => sections.flatMap((s) => s.choices), [sections])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

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

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (isPaletteNextKey(e)) {
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
            placeholder="Search covers, or paste an https link…"
            aria-label="Search covers"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-paper-300/70 px-4 py-2.5">
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            Upload image…
          </Button>
          <Button onClick={() => void run(() => setCoverFromClipboard(notePath))} disabled={busy}>
            Paste from clipboard
          </Button>
          {hasCover && (
            <Button variant="ghost" onClick={() => void run(() => removeCover(notePath))} disabled={busy}>
              Remove cover
            </Button>
          )}
          <span className="ml-auto text-xs text-ink-400">or drop or paste an image here</span>
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
        <div ref={gridRef} className="max-h-[56vh] overflow-y-auto px-4 pb-4">
          {sections.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-400">No covers match.</div>
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
                        <span className="block h-16 w-full overflow-hidden bg-paper-200">
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
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓←→</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> set cover
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </Modal>
  )
}
