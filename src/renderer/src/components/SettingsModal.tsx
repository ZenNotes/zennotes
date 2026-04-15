import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import type { LineNumberMode, WhichKeyHintMode } from '../store'
import { THEMES, type ThemeFamily, type ThemeMode } from '../lib/themes'
import { hasSystemFontAccess, listSystemFonts } from '../lib/system-fonts'

export function SettingsModal(): JSX.Element {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const vimMode = useStore((s) => s.vimMode)
  const setVimMode = useStore((s) => s.setVimMode)
  const whichKeyHints = useStore((s) => s.whichKeyHints)
  const setWhichKeyHints = useStore((s) => s.setWhichKeyHints)
  const whichKeyHintMode = useStore((s) => s.whichKeyHintMode)
  const setWhichKeyHintMode = useStore((s) => s.setWhichKeyHintMode)
  const whichKeyHintTimeoutMs = useStore((s) => s.whichKeyHintTimeoutMs)
  const setWhichKeyHintTimeoutMs = useStore((s) => s.setWhichKeyHintTimeoutMs)
  const livePreview = useStore((s) => s.livePreview)
  const setLivePreview = useStore((s) => s.setLivePreview)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const setTabsEnabled = useStore((s) => s.setTabsEnabled)
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle)
  const setQuickNoteDateTitle = useStore((s) => s.setQuickNoteDateTitle)
  const wordWrap = useStore((s) => s.wordWrap)
  const setWordWrap = useStore((s) => s.setWordWrap)
  const editorMaxWidth = useStore((s) => s.editorMaxWidth)
  const setEditorMaxWidth = useStore((s) => s.setEditorMaxWidth)
  const pdfEmbedInEditMode = useStore((s) => s.pdfEmbedInEditMode)
  const setPdfEmbedInEditMode = useStore((s) => s.setPdfEmbedInEditMode)
  const contentAlign = useStore((s) => s.contentAlign)
  const setContentAlign = useStore((s) => s.setContentAlign)
  const vault = useStore((s) => s.vault)
  const openVaultPicker = useStore((s) => s.openVaultPicker)
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const setTheme = useStore((s) => s.setTheme)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const setEditorFontSize = useStore((s) => s.setEditorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const setEditorLineHeight = useStore((s) => s.setEditorLineHeight)
  const previewMaxWidth = useStore((s) => s.previewMaxWidth)
  const setPreviewMaxWidth = useStore((s) => s.setPreviewMaxWidth)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const setLineNumberMode = useStore((s) => s.setLineNumberMode)
  const interfaceFont = useStore((s) => s.interfaceFont)
  const setInterfaceFont = useStore((s) => s.setInterfaceFont)
  const textFont = useStore((s) => s.textFont)
  const setTextFont = useStore((s) => s.setTextFont)
  const monoFont = useStore((s) => s.monoFont)
  const setMonoFont = useStore((s) => s.setMonoFont)
  const darkSidebar = useStore((s) => s.darkSidebar)
  const setDarkSidebar = useStore((s) => s.setDarkSidebar)

  // Lazy-load the system font list on mount. Retried on every mount
  // when the list comes back empty (IPC failure / no fonts yet).
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    void listSystemFonts().then((fonts) => {
      if (!cancelled) setSystemFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Family list — Apple is the default, followed by the other families.
  const familyOptions = useMemo<{ id: ThemeFamily; label: string }[]>(
    () => [
      { id: 'apple', label: 'Apple' },
      { id: 'gruvbox', label: 'Gruvbox Material' },
      { id: 'catppuccin', label: 'Catppuccin' },
      { id: 'github', label: 'GitHub' },
      { id: 'solarized', label: 'Solarized' },
      { id: 'one', label: 'One' },
      { id: 'nord', label: 'Nord' },
      { id: 'tokyo-night', label: 'Tokyo Night' }
    ],
    []
  )

  // Variants to show in the variant picker.
  //  - Gruvbox ships paired light/dark variants per contrast level, so
  //    we scope to the effective mode (hard+light / hard+dark / …).
  //  - Apple has only two variants (light / dark), which the Mode
  //    selector already handles — the variant picker stays hidden.
  //  - Catppuccin and GitHub each ship variants that ARE the theme
  //    choice (Latte, Frappé, Macchiato, Mocha / Dark, Dark Dimmed,
  //    Dark HC, Light, Light HC, …). Show them all regardless of mode
  //    so users can pick any variant and have the mode auto-align.
  const visibleVariants = useMemo(() => {
    if (themeFamily === 'gruvbox') {
      const effectiveMode =
        themeMode === 'auto'
          ? THEMES.find((t) => t.id === themeId)?.mode ?? 'light'
          : themeMode
      return THEMES.filter(
        (t) => t.family === 'gruvbox' && t.mode === effectiveMode
      )
    }
    // Families with only a light/dark pair don't need a variant picker —
    // the Mode selector above already handles the toggle.
    const simpleFamilies: ThemeFamily[] = [
      'apple',
      'solarized',
      'one',
      'nord',
      'tokyo-night'
    ]
    if (simpleFamilies.includes(themeFamily)) return []
    return THEMES.filter((t) => t.family === themeFamily)
  }, [themeFamily, themeMode, themeId])

  const pickFamily = (family: ThemeFamily): void => {
    // When family changes, keep the mode the same and pick the canonical
    // first variant in that family (medium for gruvbox, default for
    // catppuccin/github).
    const effectiveMode =
      themeMode === 'auto'
        ? THEMES.find((t) => t.id === themeId)?.mode ?? 'light'
        : themeMode
    const preferred: Record<ThemeFamily, { light: string; dark: string }> = {
      apple: { light: 'apple-light', dark: 'apple-dark' },
      gruvbox: { light: 'light-medium', dark: 'dark-medium' },
      catppuccin: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
      github: { light: 'github-light', dark: 'github-dark' },
      solarized: { light: 'solarized-light', dark: 'solarized-dark' },
      one: { light: 'one-light', dark: 'one-dark' },
      nord: { light: 'nord-light', dark: 'nord-dark' },
      'tokyo-night': { light: 'tokyo-night-day', dark: 'tokyo-night-storm' }
    }
    const targetId = preferred[family][effectiveMode]
    setTheme({ id: targetId, family, mode: themeMode })
  }

  const pickMode = (mode: ThemeMode): void => {
    if (mode === 'auto') {
      setTheme({ id: themeId, family: themeFamily, mode: 'auto' })
      return
    }
    // Flip to the mode-equivalent variant in the same family. For
    // Gruvbox we also try to preserve the user's chosen contrast.
    const currentVariant = THEMES.find((t) => t.id === themeId)?.variant
    const candidate =
      THEMES.find(
        (t) =>
          t.family === themeFamily &&
          t.mode === mode &&
          t.variant === currentVariant
      ) ?? THEMES.find((t) => t.family === themeFamily && t.mode === mode)
    if (candidate) setTheme({ id: candidate.id, family: themeFamily, mode })
  }

  const pickVariant = (id: string): void => {
    const t = THEMES.find((x) => x.id === id)
    if (!t) return
    // Always snap mode to the variant's native mode so the picker's
    // explicit selection wins over the mode toggle.
    setTheme({ id: t.id, family: t.family, mode: t.mode })
  }

  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-md"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        ref={ref}
        className="w-[min(560px,92vw)] overflow-hidden rounded-2xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-paper-300/60 px-6 py-4">
          <h2 className="font-serif text-lg font-semibold text-ink-900">Settings</h2>
          <p className="text-xs text-ink-500">Preferences are saved on this device.</p>
        </div>

        <div className="max-h-[65vh] overflow-y-auto">
          <div className="flex flex-col divide-y divide-paper-300/50">
            <Section title="Appearance">
              <div className="flex flex-col gap-4 px-6 py-4">
                <div>
                  <div className="mb-2 text-xs font-medium text-ink-500">Theme</div>
                  <div className="grid grid-cols-2 gap-2">
                    {familyOptions.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => pickFamily(f.id)}
                        className={[
                          'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                          themeFamily === f.id
                            ? 'border-accent/60 bg-accent/10 text-ink-900'
                            : 'border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200/70'
                        ].join(' ')}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-medium text-ink-500">Mode</div>
                  <div className="inline-flex rounded-md bg-paper-200/70 p-0.5">
                    {(['light', 'dark', 'auto'] as ThemeMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => pickMode(m)}
                        className={[
                          'rounded px-3 py-1 text-xs capitalize transition-colors',
                          themeMode === m
                            ? 'bg-paper-50 text-ink-900 shadow-sm'
                            : 'text-ink-600 hover:text-ink-900'
                        ].join(' ')}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                {visibleVariants.length > 1 && (
                  <div>
                    <div className="mb-2 text-xs font-medium text-ink-500">
                      {themeFamily === 'gruvbox'
                        ? 'Contrast'
                        : themeFamily === 'catppuccin'
                          ? 'Flavor'
                          : 'Variant'}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {visibleVariants.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => pickVariant(v.id)}
                          className={[
                            'rounded-md border px-3 py-1.5 text-xs transition-colors',
                            themeId === v.id
                              ? 'border-accent/60 bg-accent/10 text-ink-900'
                              : 'border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200/70'
                          ].join(' ')}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <Section title="Editor">
              <ToggleRow
                label="Vim mode"
                description="First-class Vim motions in the markdown editor."
                value={vimMode}
                onChange={setVimMode}
              />
              <ToggleRow
                label="Leader key hints"
                description="Show a which-key style guide after pressing Space so the next available leader actions stay visible."
                value={whichKeyHints}
                onChange={setWhichKeyHints}
              />
              {whichKeyHints && (
                <>
                  <SegmentedRow
                    label="Leader hint behavior"
                    description="Timed auto-hides after a short delay. Sticky keeps the leader overlay open until you press Space again or Esc."
                    value={whichKeyHintMode}
                    options={[
                      { value: 'timed', label: 'Timed' },
                      { value: 'sticky', label: 'Sticky' }
                    ]}
                    onChange={(next) => setWhichKeyHintMode(next as WhichKeyHintMode)}
                  />
                  {whichKeyHintMode === 'timed' && (
                    <SliderRow
                      label="Leader hint duration"
                      description="How long the leader overlay stays visible, and how long the pending leader sequence stays armed after pressing Space."
                      value={whichKeyHintTimeoutMs}
                      min={400}
                      max={3000}
                      step={100}
                      format={(v) => `${(v / 1000).toFixed(1)}s`}
                      onChange={setWhichKeyHintTimeoutMs}
                    />
                  )}
                </>
              )}
              <ToggleRow
                label="Live preview"
                description="Hide markdown syntax on lines you're not editing. Turn off to always see raw #, **, [[…]], etc."
                value={livePreview}
                onChange={setLivePreview}
              />
              <ToggleRow
                label="Note tabs"
                description="Open notes in tabs and allow note-drag split view. Turn off to keep the current single-note behavior."
                value={tabsEnabled}
                onChange={setTabsEnabled}
              />
              <ToggleRow
                label="Word wrap"
                description="Wrap long lines to the editor width. Turn off to scroll horizontally instead — same toggle as a coding editor."
                value={wordWrap}
                onChange={setWordWrap}
              />
              <SegmentedRow
                label="PDFs in edit mode"
                description="How embedded PDFs render while you're writing. 'Compact' keeps the editor focused — read the PDF in the reference pane. 'Full' inlines the PDF iframe under your cursor."
                value={pdfEmbedInEditMode}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'full', label: 'Full' }
                ]}
                onChange={(next) => setPdfEmbedInEditMode(next)}
              />
              <ToggleRow
                label="Date-titled Quick Notes"
                description="New Quick Notes are named YYYY-MM-DD instead of a timestamp. A second note on the same day becomes “YYYY-MM-DD (2)”, then (3), and so on."
                value={quickNoteDateTitle}
                onChange={setQuickNoteDateTitle}
              />
            </Section>

            <Section title="Font">
              <FontRow
                label="Interface font"
                description="Used for the sidebar, menus, and window chrome."
                value={interfaceFont}
                options={systemFonts}
                onChange={setInterfaceFont}
              />
              <FontRow
                label="Text font"
                description="Used for editing and reading views."
                value={textFont}
                options={systemFonts}
                onChange={setTextFont}
              />
              <FontRow
                label="Monospace font"
                description="Used for code blocks, inline code, and frontmatter."
                value={monoFont}
                options={systemFonts}
                onChange={setMonoFont}
              />
              <SliderRow
                label="Font size"
                description="Editor and preview text size."
                value={editorFontSize}
                min={12}
                max={32}
                step={1}
                unit="px"
                onChange={setEditorFontSize}
              />
              <SliderRow
                label="Line height"
                description="Vertical spacing between lines."
                value={editorLineHeight}
                min={1.2}
                max={2.4}
                step={0.05}
                onChange={setEditorLineHeight}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label="Reading width"
                description="Maximum width for preview and split-preview content."
                value={previewMaxWidth}
                min={640}
                max={1400}
                step={20}
                unit="px"
                onChange={setPreviewMaxWidth}
              />
              <SliderRow
                label="Editor width"
                description="Caps and centers the editor's content column. Useful when the window is maximized so lines don't stretch edge-to-edge."
                value={editorMaxWidth}
                min={640}
                max={1600}
                step={20}
                unit="px"
                onChange={setEditorMaxWidth}
              />
              <SegmentedRow
                label="Content alignment"
                description="Center note content within the column (Apple Notes style) or left-align it to the pane edge."
                value={contentAlign}
                options={[
                  { value: 'center', label: 'Center' },
                  { value: 'left', label: 'Left' }
                ]}
                onChange={(next) => setContentAlign(next)}
              />
              <SegmentedRow
                label="Line numbers"
                description="Show editor gutter numbers. Relative uses Vim-style numbering with the current line shown normally."
                value={lineNumberMode}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'absolute', label: 'Absolute' },
                  { value: 'relative', label: 'Relative' }
                ]}
                onChange={(next) => setLineNumberMode(next)}
              />
            </Section>

            <Section title="Appearance · Advanced">
              <ToggleRow
                label="Dark sidebar"
                description="Tint the sidebar one step darker than the main canvas so the chrome reads as a separate surface."
                value={darkSidebar}
                onChange={setDarkSidebar}
              />
            </Section>

            <Section title="Vault">
              <div className="flex items-center justify-between gap-4 px-6 py-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-900">Vault location</div>
                  <div className="truncate text-xs text-ink-500">
                    {vault?.root ?? 'No vault selected'}
                  </div>
                </div>
                <button
                  onClick={() => void openVaultPicker()}
                  className="shrink-0 rounded-md border border-paper-300 bg-paper-50 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
                >
                  Change…
                </button>
              </div>
            </Section>
          </div>
        </div>

        <div className="flex justify-end border-t border-paper-300/60 px-6 py-3">
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-paper-50 hover:bg-ink-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section>
      <div className="px-6 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-500">
        {title}
      </div>
      <div>{children}</div>
    </section>
  )
}

function FontRow({
  label,
  description,
  value,
  options,
  onChange
}: {
  label: string
  description?: string
  value: string | null
  options: string[]
  onChange: (next: string | null) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(
    null
  )

  // Reset the search box whenever the popover opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }, [open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      const portalRoot = document.getElementById('zen-font-portal')
      if (portalRoot?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Position the popover below the button; reposition on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const el = buttonRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom + 4, width: Math.max(260, r.width) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? options.filter((o) => o.toLowerCase().includes(q))
      : options
    return base.slice(0, 120)
  }, [query, options])

  // Virtual item list: entry 0 is the "Default" reset, then every filtered
  // font. A single index tracks which row is keyboard-highlighted.
  // `null` represents the default / reset row.
  const items: Array<string | null> = useMemo(() => [null, ...filtered], [filtered])

  // Clamp the active index whenever the filter narrows/widens.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  // Scroll the keyboard-selected row into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const commit = (next: string | null): void => {
    onChange(next)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (i + 1 >= items.length ? items.length - 1 : i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[activeIdx]
      commit(item ?? null)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIdx(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIdx(items.length - 1)
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-[220px] shrink-0 items-center justify-between gap-2 rounded-md border border-paper-300 bg-paper-50 px-3 py-1.5 text-left text-sm text-ink-900 transition-colors hover:bg-paper-100"
      >
        <span
          className="truncate"
          style={{ fontFamily: value ? `"${value}", ui-monospace, monospace` : undefined }}
        >
          {value ?? 'Default'}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-ink-500"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            id="zen-font-portal"
            className="fixed z-[80] flex max-h-[320px] flex-col overflow-hidden rounded-xl border border-paper-300 bg-paper-100 shadow-float"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            <div className="border-b border-paper-300/60 p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Search fonts…"
                className="w-full rounded-md bg-paper-200 px-2 py-1.5 text-sm text-ink-900 outline-none placeholder:text-ink-400"
              />
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              <button
                type="button"
                data-idx={0}
                onClick={() => commit(null)}
                onMouseMove={() => setActiveIdx(0)}
                className={[
                  'flex w-full items-center px-3 py-1.5 text-left text-sm',
                  activeIdx === 0
                    ? 'bg-paper-200 text-ink-900'
                    : value === null
                      ? 'text-ink-900'
                      : 'text-ink-700'
                ].join(' ')}
              >
                Default
              </button>
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-ink-400">
                  {options.length === 0
                    ? 'No fonts available'
                    : 'No fonts match your search'}
                </div>
              ) : (
                filtered.map((f, i) => {
                  const idx = i + 1
                  const isActive = activeIdx === idx
                  return (
                    <button
                      key={f}
                      type="button"
                      data-idx={idx}
                      onClick={() => commit(f)}
                      onMouseMove={() => setActiveIdx(idx)}
                      className={[
                        'flex w-full items-center px-3 py-1.5 text-left text-sm',
                        isActive
                          ? 'bg-paper-200 text-ink-900'
                          : value === f
                            ? 'text-ink-900'
                            : 'text-ink-800'
                      ].join(' ')}
                      style={{ fontFamily: `"${f}", ui-monospace, monospace` }}
                    >
                      {f}
                    </button>
                  )
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit && !format ? unit : '')
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="zen-slider h-1 w-[140px] cursor-pointer appearance-none rounded-full"
        />
        <div className="min-w-[48px] text-right text-sm tabular-nums text-ink-800">
          {display}
        </div>
      </div>
    </div>
  )
}

function NumberRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onChange: (next: number) => void
}): JSX.Element {
  const display = (format ? format(value) : String(value)) + (unit ?? '')
  const clamp = (n: number): number => Math.min(max, Math.max(min, n))
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(clamp(+(value - step).toFixed(2)))}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200"
        >
          −
        </button>
        <div className="min-w-[56px] text-center text-sm tabular-nums text-ink-800">
          {display}
        </div>
        <button
          type="button"
          onClick={() => onChange(clamp(+(value + step).toFixed(2)))}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-paper-300 bg-paper-50 text-ink-700 hover:bg-paper-200"
        >
          +
        </button>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  value,
  onChange
}: {
  label: string
  description?: string
  value: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={[
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          value ? 'bg-accent' : 'bg-paper-300'
        ].join(' ')}
      >
        <span
          className={[
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-4' : 'translate-x-0.5'
          ].join(' ')}
        />
      </button>
    </label>
  )
}

function SegmentedRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange
}: {
  label: string
  description?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{label}</div>
        {description && <div className="text-xs text-ink-500">{description}</div>}
      </div>
      <div className="inline-flex shrink-0 rounded-md bg-paper-200/70 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              'rounded px-3 py-1 text-xs transition-colors',
              value === option.value
                ? 'bg-paper-50 text-ink-900 shadow-sm'
                : 'text-ink-600 hover:text-ink-900'
            ].join(' ')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
