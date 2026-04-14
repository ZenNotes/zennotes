/**
 * Cmd+Shift+P command palette with a nested sub-mode for theme
 * selection. When the user picks "Themes…" the palette stays open but
 * swaps its list to show every theme variant. Arrowing / hovering
 * over a row applies the theme immediately (live preview); Enter
 * commits, Escape reverts to whatever was active when the picker
 * opened and closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { buildCommands, type Command } from '../lib/commands'
import { rankItems } from '../lib/fuzzy-score'
import { THEMES, type ThemeFamily, type ThemeMode, type ThemeOption } from '../lib/themes'

type Mode = 'main' | 'theme'

interface ThemeSnapshot {
  id: string
  family: ThemeFamily
  mode: ThemeMode
}

export function CommandPalette(): JSX.Element {
  const setOpen = useStore((s) => s.setCommandPaletteOpen)
  const setTheme = useStore((s) => s.setTheme)

  const [mode, setMode] = useState<Mode>('main')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Original theme snapshot captured when entering the theme picker.
  // Used to revert if the user cancels with Escape or clicks outside.
  const originalThemeRef = useRef<ThemeSnapshot | null>(null)
  const committedRef = useRef(false)

  const allCommands = useMemo(() => buildCommands(), [])

  const commandResults = useMemo<Command[]>(
    () =>
      rankItems(allCommands, query, [
        { get: (c) => c.title, weight: 1 },
        { get: (c) => c.keywords, weight: 0.7 },
        { get: (c) => c.category, weight: 0.5 }
      ]),
    [allCommands, query]
  )

  const themeResults = useMemo<ThemeOption[]>(
    () =>
      rankItems(THEMES, query, [
        { get: (t) => t.label, weight: 1 },
        { get: (t) => t.family, weight: 0.9 },
        { get: (t) => t.variant, weight: 0.6 }
      ]),
    [query]
  )

  const resultsLength = mode === 'main' ? commandResults.length : themeResults.length

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  // Selection sync:
  //  - Main mode: start at the top of the results on every query change.
  //  - Theme mode: keep the currently-applied theme highlighted as the
  //    filter narrows. If it's filtered out, leave active at -1 (no
  //    row highlighted, no preview churn) until the user arrows.
  useEffect(() => {
    if (mode !== 'theme') {
      setActive(0)
      return
    }
    const currentId = useStore.getState().themeId
    const idx = themeResults.findIndex((t) => t.id === currentId)
    setActive(idx)
  }, [query, mode, themeResults])

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  /* -------- Theme preview on active change -------- */
  useEffect(() => {
    if (mode !== 'theme') return
    if (active < 0) return
    const theme = themeResults[active]
    if (!theme) return
    // No-op preview when the highlighted theme is already active —
    // prevents re-running `setTheme` each time the filter narrows and
    // we re-sync the cursor onto the currently-applied theme.
    const s = useStore.getState()
    if (s.themeId === theme.id) return
    setTheme({ id: theme.id, family: theme.family, mode: theme.mode })
  }, [active, mode, themeResults, setTheme])

  /* -------- Lifecycle: enter / leave theme mode -------- */
  const enterThemeMode = (): void => {
    const s = useStore.getState()
    originalThemeRef.current = {
      id: s.themeId,
      family: s.themeFamily,
      mode: s.themeMode
    }
    committedRef.current = false
    setMode('theme')
    setQuery('')
    // The query/mode/themeResults useEffect below locks `active` onto
    // the currently-applied theme, so no setActive needed here.
  }

  const revertTheme = (): void => {
    const snap = originalThemeRef.current
    if (!snap) return
    setTheme(snap)
  }

  /* -------- Close handling -------- */
  const closePalette = (opts: { commit?: boolean } = {}): void => {
    if (mode === 'theme' && !opts.commit && !committedRef.current) {
      revertTheme()
    }
    setOpen(false)
  }

  /* -------- Actions -------- */
  const runCommand = async (cmd: Command): Promise<void> => {
    if (cmd.id === 'ui.themes') {
      enterThemeMode()
      inputRef.current?.focus()
      return
    }
    setOpen(false)
    try {
      await cmd.run()
    } catch (err) {
      console.error('command failed', cmd.id, err)
    }
  }

  const commitTheme = (theme: ThemeOption): void => {
    setTheme({ id: theme.id, family: theme.family, mode: theme.mode })
    committedRef.current = true
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-sm"
      onClick={() => closePalette()}
    >
      <div
        className="w-[min(640px,92vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'theme' && (
          <div className="flex items-center gap-2 border-b border-paper-300/70 bg-paper-200/40 px-4 py-2 text-[11px] text-ink-500">
            <button
              type="button"
              onClick={() => {
                revertTheme()
                setMode('main')
                setQuery('')
                setActive(0)
                inputRef.current?.focus()
              }}
              className="rounded px-1 py-0.5 text-ink-600 transition-colors hover:bg-paper-200 hover:text-ink-900"
              aria-label="Back to commands"
              title="Back to commands"
            >
              ‹ Back
            </button>
            <span className="uppercase tracking-wide">Theme preview — ↵ to keep, esc to revert</span>
          </div>
        )}
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder={mode === 'main' ? 'Type a command…' : 'Pick a color theme'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(resultsLength - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (mode === 'main') {
                  const cmd = commandResults[active]
                  if (cmd) void runCommand(cmd)
                } else {
                  const theme = themeResults[active]
                  if (theme) commitTheme(theme)
                }
              } else if (e.key === 'Escape') {
                e.preventDefault()
                if (mode === 'theme') {
                  revertTheme()
                  setMode('main')
                  setQuery('')
                  setActive(0)
                  return
                }
                closePalette()
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div
          ref={listRef}
          className="max-h-[56vh] overflow-x-hidden overflow-y-auto py-1"
        >
          {resultsLength === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">
              {mode === 'main' ? 'No matching commands.' : 'No matching themes.'}
            </div>
          ) : mode === 'main' ? (
            commandResults.map((cmd, i) => (
              <button
                key={cmd.id}
                data-cmd-idx={i}
                onClick={() => void runCommand(cmd)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-400">
                  {cmd.category}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {cmd.title}
                </span>
                {cmd.shortcut && (
                  <span className="shrink-0 rounded bg-paper-200/80 px-1.5 py-0.5 text-[11px] text-ink-500">
                    {cmd.shortcut}
                  </span>
                )}
              </button>
            ))
          ) : (
            themeResults.map((theme, i) => {
              const isOriginal = theme.id === originalThemeRef.current?.id
              const familyTitle =
                theme.family.charAt(0).toUpperCase() + theme.family.slice(1)
              return (
                <button
                  key={theme.id}
                  data-cmd-idx={i}
                  onClick={() => commitTheme(theme)}
                  onMouseMove={() => setActive(i)}
                  className={[
                    'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                    i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                  ].join(' ')}
                >
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-400">
                    {familyTitle}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                    {theme.label}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-400">
                    {theme.mode}
                  </span>
                  {isOriginal && (
                    <span
                      aria-label="Active before preview"
                      className="shrink-0 text-[11px] text-accent"
                    >
                      current
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-[11px] text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd>{' '}
            {mode === 'main' ? 'run' : 'keep theme'}
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd>{' '}
            {mode === 'main' ? 'close' : 'revert'}
          </span>
        </div>
      </div>
    </div>
  )
}
