import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { isImeComposing } from '../lib/ime'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from '../lib/vault-layout'
import { resolveTypstPreambleFolder } from '../lib/typst-preamble'
import { countVaultTags } from '../lib/tags'
import {
  addTag,
  buildDestinationChoices,
  checkNoteName,
  destinationLabel,
  filterDestinationChoices,
  findNameCollision,
  normalizeTag,
  parseDestinationText,
  rankTagChoices,
  type AreaLabels,
  type NoteDestination,
  type SearchCreateDraft
} from '../lib/search-create'
import { Button } from './ui/Button'

export interface SearchCreateTarget {
  destination: NoteDestination
  title: string
  tags: string[]
}

type Field = 'name' | 'folder' | 'tags'

type TagRow = { kind: 'existing'; tag: string; count: number } | { kind: 'new'; tag: string }

const INPUT_CLASS =
  'w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent'
const ROW_CLASS = 'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left'

/** Plain Enter, with none of the modifiers the form reads as another command. */
function isPlainEnter(e: ReactKeyboardEvent<HTMLElement>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
}

/**
 * The second step of creating a note from search (#826): the name, the
 * folder and the tags, each open to change before anything is written. The
 * name arrives prefilled and selected, so the fast path is still Enter. Below
 * the fields, the focused field's choices show as palette rows: folders while
 * Folder has focus, tags while Tags has focus.
 */
export function SearchCreateForm({
  draft,
  onBack,
  onCreate,
  onOpenExisting
}: {
  draft: SearchCreateDraft
  onBack: () => void
  onCreate: (target: SearchCreateTarget) => void
  onOpenExisting: (note: NoteMeta) => void
}): JSX.Element {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const vault = useStore((s) => s.vault)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const activeNote = useStore((s) => s.activeNote)

  const [name, setName] = useState(draft.name)
  const [folderText, setFolderText] = useState(draft.folderText)
  const [tags, setTags] = useState<string[]>(draft.tags)
  const [tagText, setTagText] = useState('')
  const [focused, setFocused] = useState<Field | null>(null)
  // -1 keeps the typed value; 0..n highlights a row, which Enter then picks.
  const [folderActive, setFolderActive] = useState(-1)
  const [tagActive, setTagActive] = useState(-1)
  // The Folder field can arrive prefilled from a typed path. Landing in it
  // lists every folder (the user came to look, or to change it); the list
  // narrows only once they type.
  const [folderTyped, setFolderTyped] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const tagsRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  const labels: AreaLabels = useMemo(() => {
    const resolved = resolveSystemFolderLabels(systemFolderLabels)
    return {
      inbox: isPrimaryNotesAtRoot(vaultSettings) ? (vault?.name ?? 'Vault') : resolved.inbox,
      quick: resolved.quick,
      archive: resolved.archive,
      trash: resolved.trash
    }
  }, [systemFolderLabels, vault?.name, vaultSettings])

  const choices = useMemo(() => buildDestinationChoices(folders, labels), [folders, labels])
  const tagCounts = useMemo(
    () =>
      countVaultTags(
        notes,
        activeNote ? { path: activeNote.path, body: activeNote.body } : null,
        resolveTypstPreambleFolder(vaultSettings?.typstPreambles?.folder)
      ),
    [notes, activeNote, vaultSettings?.typstPreambles?.folder]
  )

  const nameCheck = checkNoteName(name)
  const destination = parseDestinationText(folderText)
  const typedTag = tagText.trim()
  const typedTagError =
    typedTag && !normalizeTag(typedTag)
      ? 'Tags start with a letter and use letters, digits, _ - or /.'
      : null
  const collision =
    nameCheck.title && destination.destination
      ? findNameCollision(nameCheck.title, destination.destination, notes, vaultSettings)
      : null
  const error = nameCheck.error ?? destination.error ?? typedTagError
  const canCreate = !error && !collision?.sameFolder

  const folderRows = useMemo(
    () =>
      focused === 'folder' ? filterDestinationChoices(choices, folderTyped ? folderText : '') : [],
    [choices, focused, folderText, folderTyped]
  )
  const tagRows = useMemo<TagRow[]>(() => {
    if (focused !== 'tags') return []
    const rows: TagRow[] = rankTagChoices(tagText, tagCounts, tags).map((entry) => ({
      kind: 'existing',
      ...entry
    }))
    const fresh = normalizeTag(tagText)
    const known = (tag: string): boolean =>
      [...tagCounts.keys(), ...tags].some((t) => t.toLowerCase() === tag.toLowerCase())
    if (fresh && !known(fresh)) rows.push({ kind: 'new', tag: fresh })
    return rows
  }, [focused, tagCounts, tagText, tags])

  const activeRow = focused === 'folder' ? folderActive : focused === 'tags' ? tagActive : -1
  useEffect(() => {
    if (activeRow < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-search-form-idx="${activeRow}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeRow])

  const create = (): void => {
    if (!canCreate || !nameCheck.title || !destination.destination) return
    // Text still sitting in the Tags field counts: the user typed it and then
    // reached for Create, not for Enter.
    onCreate({
      destination: destination.destination,
      title: nameCheck.title,
      tags: addTag(tags, tagText, tagCounts)
    })
  }

  const pickFolder = (value: string): void => {
    setFolderText(value)
    setFolderActive(-1)
    tagsRef.current?.focus()
  }

  const commitTag = (raw: string): void => {
    setTags((prev) => addTag(prev, raw, tagCounts))
    setTagText('')
    setTagActive(-1)
  }

  const pickTagRow = (row: TagRow): void => commitTag(row.tag)

  const move = (
    rows: number,
    setActive: (update: (prev: number) => number) => void,
    delta: number
  ): void => {
    if (rows === 0) return
    // Cycle through [typed value (-1), row 0 … n-1] and wrap around.
    setActive((prev) => {
      const next = prev + delta
      if (next < -1) return rows - 1
      if (next >= rows) return -1
      return next
    })
  }

  // Escape and the modified Enters belong to the whole form, whichever field
  // has focus. Stopping propagation keeps the window-level Escape handler
  // from closing the palette: here Escape means "back to the results".
  const onFormKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isImeComposing(e)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onBack()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      if (collision) onOpenExisting(collision.note)
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      create()
    }
  }

  const onFolderKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (isPaletteNextKey(e)) {
      e.preventDefault()
      move(folderRows.length, setFolderActive, 1)
    } else if (isPalettePreviousKey(e)) {
      e.preventDefault()
      move(folderRows.length, setFolderActive, -1)
    } else if (isPlainEnter(e)) {
      e.preventDefault()
      const row = folderActive >= 0 ? folderRows[folderActive] : undefined
      if (row) pickFolder(row.value)
      else create()
    }
  }

  const onTagsKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (isPaletteNextKey(e)) {
      e.preventDefault()
      move(tagRows.length, setTagActive, 1)
    } else if (isPalettePreviousKey(e)) {
      e.preventDefault()
      move(tagRows.length, setTagActive, -1)
    } else if (isPlainEnter(e)) {
      e.preventDefault()
      const row = tagActive >= 0 ? tagRows[tagActive] : undefined
      if (row) pickTagRow(row)
      else if (typedTag) {
        if (normalizeTag(typedTag)) commitTag(typedTag)
      } else create()
    } else if (e.key === ' ' || e.key === ',') {
      // A tag never contains either, so both finish the one being typed.
      e.preventDefault()
      if (normalizeTag(typedTag)) commitTag(typedTag)
    } else if (e.key === 'Backspace' && tagText === '' && tags.length > 0) {
      e.preventDefault()
      setTags((prev) => prev.slice(0, -1))
    }
  }

  const describe = (dest: NoteDestination): string => destinationLabel(dest, labels)
  const collisionWhere = collision
    ? describe({
        folder: collision.note.folder,
        subpath: noteFolderSubpath(collision.note, vaultSettings)
      })
    : ''

  return (
    <div onKeyDown={onFormKeyDown} data-search-create-form="">
      <div className="border-b border-paper-300/70 px-4 py-3">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold text-ink-900">New note</span>
          <span className="truncate text-xs text-ink-400">
            {destination.destination ? `in ${describe(destination.destination)}` : ''}
          </span>
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label htmlFor="search-create-name" className="form-label">
            Name
          </label>
          <input
            id="search-create-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => setFocused('name')}
            onBlur={() => setFocused((f) => (f === 'name' ? null : f))}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return
              if (isPlainEnter(e)) {
                e.preventDefault()
                create()
              }
            }}
            placeholder="Note name"
            className={INPUT_CLASS}
          />
          <label htmlFor="search-create-folder" className="form-label">
            Folder
          </label>
          <input
            id="search-create-folder"
            value={folderText}
            onChange={(e) => {
              setFolderText(e.target.value)
              setFolderTyped(true)
              // Preselect the first match while typing, so Enter picks it
              // without an arrow key first; the typed value stays one
              // ArrowUp away, for a folder that does not exist yet. (#467)
              setFolderActive(e.target.value.trim() ? 0 : -1)
            }}
            onFocus={() => {
              setFocused('folder')
              setFolderActive(-1)
              setFolderTyped(false)
            }}
            onBlur={() => setFocused((f) => (f === 'folder' ? null : f))}
            onKeyDown={onFolderKeyDown}
            placeholder={`${labels.inbox}  ·  type a folder like projects/ideas, or pick one below`}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <label htmlFor="search-create-tags" className="form-label">
            Tags
          </label>
          <div
            className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-paper-300 bg-paper-50 px-2 py-1 focus-within:border-accent"
            onMouseDown={(e) => {
              // The box is the field: clicking its padding or a chip lands
              // in the input rather than dropping focus on the wrapper.
              if (e.target !== tagsRef.current) {
                e.preventDefault()
                tagsRef.current?.focus()
              }
            }}
          >
            {tags.map((tag) => (
              <span
                key={tag}
                data-search-create-tag={tag}
                className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent ring-1 ring-accent/30"
              >
                #{tag}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                  className="rounded-full leading-none text-accent/70 hover:text-accent"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id="search-create-tags"
              ref={tagsRef}
              value={tagText}
              onChange={(e) => {
                setTagText(e.target.value)
                setTagActive(e.target.value.trim() ? 0 : -1)
              }}
              onFocus={() => {
                setFocused('tags')
                setTagActive(-1)
              }}
              onBlur={() => {
                setFocused((f) => (f === 'tags' ? null : f))
                if (normalizeTag(typedTag)) commitTag(typedTag)
              }}
              onKeyDown={onTagsKeyDown}
              placeholder={tags.length === 0 ? 'Add tags  ·  space or , after each' : ''}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-24 flex-1 bg-transparent py-0.5 text-sm text-ink-900 outline-none placeholder:text-ink-400"
            />
          </div>
        </div>
        <div
          data-search-create-status={error ? 'error' : collision ? 'collision' : 'ok'}
          className={[
            'mt-2 flex min-h-5 items-center gap-2 text-xs',
            error || collision?.sameFolder
              ? 'text-danger'
              : collision
                ? 'text-warning'
                : 'text-ink-500'
          ].join(' ')}
        >
          {error ? (
            <span>{error}</span>
          ) : collision ? (
            <>
              <span className="min-w-0 flex-1">
                {collision.sameFolder
                  ? `"${collision.note.title}" already exists in ${collisionWhere}. Change the name, or open it.`
                  : `A note named "${collision.note.title}" already exists in ${collisionWhere}.`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                // Same reason as the footer: a blur here commits the typed tag
                // as a chip, and a chips row that wraps moves this button.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onOpenExisting(collision.note)}
              >
                Open it{' '}
                <kbd data-keyboard-hints="" className="rounded bg-paper-200 px-1 text-ink-500">
                  Shift+↵
                </kbd>
              </Button>
            </>
          ) : (
            <span>
              {destination.destination && nameCheck.title
                ? `Creates "${nameCheck.title}" in ${describe(destination.destination)}${
                    tags.length > 0 ? ` with ${tags.map((tag) => `#${tag}`).join(' ')}` : ''
                  }`
                : ''}
            </span>
          )}
        </div>
      </div>
      {(folderRows.length > 0 || tagRows.length > 0) && (
        <div
          ref={listRef}
          className="max-h-[40vh] overflow-x-hidden overflow-y-auto py-1"
          // Rows take the click without stealing focus from the field, so
          // the list they belong to does not vanish under the pointer.
          onMouseDown={(e) => e.preventDefault()}
        >
          {focused === 'folder' &&
            folderRows.map((row, i) => (
              <button
                key={row.value || '/'}
                type="button"
                tabIndex={-1}
                data-search-form-idx={i}
                data-search-form-folder={row.value}
                onClick={() => pickFolder(row.value)}
                onMouseMove={() => setFolderActive(i)}
                className={[ROW_CLASS, i === folderActive ? 'bg-paper-200' : 'hover:bg-paper-200/70'].join(
                  ' '
                )}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{row.label}</span>
                <span className="shrink-0 text-xs text-ink-400">{row.value || 'root'}</span>
              </button>
            ))}
          {focused === 'tags' &&
            tagRows.map((row, i) => (
              <button
                key={`${row.kind}:${row.tag}`}
                type="button"
                tabIndex={-1}
                data-search-form-idx={i}
                data-search-form-tag={row.tag}
                onClick={() => pickTagRow(row)}
                onMouseMove={() => setTagActive(i)}
                className={[ROW_CLASS, i === tagActive ? 'bg-paper-200' : 'hover:bg-paper-200/70'].join(
                  ' '
                )}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {row.kind === 'new' ? (
                    <>
                      <span className="text-ink-500">Add </span>
                      <span className="font-medium">#{row.tag}</span>
                    </>
                  ) : (
                    `#${row.tag}`
                  )}
                </span>
                <span className="shrink-0 text-xs text-ink-400">
                  {row.kind === 'new'
                    ? 'new tag'
                    : `${row.count} ${row.count === 1 ? 'note' : 'notes'}`}
                </span>
              </button>
            ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
        {/* `data-keyboard-hints` marks the hardware-keyboard hints here and on
            the Open it chip above: the phone shells hide them by that hook,
            because this footer also holds Back and Create, so the rule that
            hides every other palette footer cannot be allowed to match it
            (#842). A tablet with a keyboard keeps them. */}
        <div data-keyboard-hints="" className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> pick
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> create
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> back
          </span>
        </div>
        <div
          className="flex items-center gap-2"
          // The buttons act on click and never need focus. Taking it on
          // mousedown would blur the field, unmount the folder or tag list
          // under the fields and move this footer before mouseup, so the
          // click never fired: the first Create with a tag still typed was
          // lost. `create()` counts that text, the way Enter does.
          onMouseDown={(e) => e.preventDefault()}
        >
          <Button variant="secondary" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" size="sm" disabled={!canCreate} onClick={create}>
            Create
          </Button>
        </div>
      </div>
    </div>
  )
}
