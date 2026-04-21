import { useDeferredValue, useMemo, useState } from 'react'
import { useStore } from '../store'
import { buildCommands, type Command } from '../lib/commands'
import { getKeymapDisplay, type KeymapId, type KeymapOverrides } from '../lib/keymaps'
import {
  HELP_CORE_CONCEPTS,
  HELP_HOW_TO_GUIDES,
  HELP_QUICK_START,
  HELP_SETTINGS,
  HELP_SHORTCUT_SECTIONS,
  HELP_VIM_COMMANDS
} from '../lib/help'
import {
  CheckSquareIcon,
  CloseIcon,
  CommandIcon,
  DocumentIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon
} from './icons'

interface CommandGroup {
  category: string
  commands: Command[]
}

function shortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return getKeymapDisplay(overrides, id)
}

function leaderShortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return `${shortcut(overrides, 'vim.leaderPrefix')} ${shortcut(overrides, id)}`
}

function paneShortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return `${shortcut(overrides, 'vim.panePrefix')} ${shortcut(overrides, id)}`
}

function resolveShortcutKeys(
  sectionId: string,
  action: string,
  overrides: KeymapOverrides
): string | null {
  if (sectionId === 'global-shortcuts') {
    if (action === 'Search notes') return shortcut(overrides, 'global.searchNotes')
    if (action === 'Search notes (non-Vim mode)') return shortcut(overrides, 'global.searchNotesNonVim')
    if (action === 'Open commands') return shortcut(overrides, 'global.commandPalette')
    if (action === 'New Quick Note') return shortcut(overrides, 'global.newQuickNote')
    if (action === 'Open Settings') return shortcut(overrides, 'global.openSettings')
    if (action === 'Toggle sidebar') return shortcut(overrides, 'global.toggleSidebar')
    if (action === 'Toggle connections') return shortcut(overrides, 'global.toggleConnections')
    if (action === 'Toggle Zen mode') return shortcut(overrides, 'global.toggleZenMode')
    if (action === 'Close active tab') return shortcut(overrides, 'global.closeActiveTab')
    if (action === 'Zoom in') return 'Mod+='
    if (action === 'Zoom out') return 'Mod+-'
    if (action === 'Reset zoom') return 'Mod+0'
    if (action === 'Toggle word wrap') return shortcut(overrides, 'global.toggleWordWrap')
  }

  if (sectionId === 'panel-motion') {
    if (action === 'Move focus') {
      return [
        paneShortcut(overrides, 'vim.paneFocusLeft'),
        paneShortcut(overrides, 'vim.paneFocusDown'),
        paneShortcut(overrides, 'vim.paneFocusUp'),
        paneShortcut(overrides, 'vim.paneFocusRight')
      ].join(' / ')
    }
    if (action === 'Split right') return paneShortcut(overrides, 'vim.paneSplitRight')
    if (action === 'Split down') return paneShortcut(overrides, 'vim.paneSplitDown')
    if (action === 'Open buffers') return leaderShortcut(overrides, 'vim.leaderOpenBuffers')
    if (action === 'Search notes') return leaderShortcut(overrides, 'vim.leaderSearchNotes')
    if (action === 'Search vault text') return leaderShortcut(overrides, 'vim.leaderSearchVaultText')
    if (action === 'Toggle left sidebar') return leaderShortcut(overrides, 'vim.leaderToggleSidebar')
    if (action === 'Note outline') return leaderShortcut(overrides, 'vim.leaderNoteOutline')
    if (action === 'Show leader hints') return `${shortcut(overrides, 'vim.leaderPrefix')}, then pause`
    if (action === 'Toggle outline panel') return shortcut(overrides, 'global.toggleOutlinePanel')
    if (action === 'Fold / unfold heading') {
      return `${shortcut(overrides, 'vim.foldCurrent')} / ${shortcut(overrides, 'vim.unfoldCurrent')}`
    }
    if (action === 'Fold / unfold all') {
      return `${shortcut(overrides, 'vim.foldAll')} / ${shortcut(overrides, 'vim.unfoldAll')}`
    }
    if (action === 'Go back') return shortcut(overrides, 'vim.historyBack')
    if (action === 'Go forward') return shortcut(overrides, 'vim.historyForward')
    if (action === 'Hint mode') return shortcut(overrides, 'vim.hintMode')
  }

  if (sectionId === 'lists-and-sidebar') {
    if (action === 'Move selection') {
      return `${shortcut(overrides, 'nav.moveDown')} / ${shortcut(overrides, 'nav.moveUp')}`
    }
    if (action === 'Jump to top or bottom') {
      return `${shortcut(overrides, 'nav.jumpTop')} / ${shortcut(overrides, 'nav.jumpBottom')}`
    }
    if (action === 'Open item') return `Enter / ${shortcut(overrides, 'nav.openSideItem')}`
    if (action === 'Collapse or move left') return shortcut(overrides, 'nav.back')
    if (action === 'Toggle folder') return shortcut(overrides, 'nav.toggleFolder')
    if (action === 'Search notes') return shortcut(overrides, 'nav.filter')
    if (action === 'Open context menu') return shortcut(overrides, 'nav.contextMenu')
  }

  if (sectionId === 'preview-and-connections') {
    if (action === 'Scroll preview') {
      return `${shortcut(overrides, 'nav.moveDown')} / ${shortcut(overrides, 'nav.moveUp')}`
    }
    if (action === 'Half-page scroll') {
      return `${shortcut(overrides, 'nav.halfPageDown')} / ${shortcut(overrides, 'nav.halfPageUp')}`
    }
    if (action === 'Jump to top or bottom') {
      return `${shortcut(overrides, 'nav.jumpTop')} / ${shortcut(overrides, 'nav.jumpBottom')}`
    }
    if (action === 'Search notes') return shortcut(overrides, 'nav.filter')
    if (action === 'Peek backlink') return shortcut(overrides, 'nav.peekPreview')
    if (action === 'Back out') return `${shortcut(overrides, 'nav.back')} / Esc`
  }

  return null
}

function resolveVimCommandLabel(command: string, overrides: KeymapOverrides): string {
  if (command === 'gd') return shortcut(overrides, 'vim.goToDefinition')
  if (command === '<Space> l f') {
    return `${leaderShortcut(overrides, 'vim.leaderNoteActions')} ${shortcut(overrides, 'vim.leaderFormatNote')}`
  }
  if (command === '<Space> (pause)') {
    return `${shortcut(overrides, 'vim.leaderPrefix')} (pause)`
  }
  if (command === '<Space> o') return leaderShortcut(overrides, 'vim.leaderOpenBuffers')
  if (command === '<Space> f') return leaderShortcut(overrides, 'vim.leaderSearchNotes')
  if (command === '<Space> s t') return leaderShortcut(overrides, 'vim.leaderSearchVaultText')
  if (command === '<Space> e') return leaderShortcut(overrides, 'vim.leaderToggleSidebar')
  if (command === '<Space> p') return leaderShortcut(overrides, 'vim.leaderNoteOutline')
  return command
}

const HELP_SECTION_LINKS = [
  { id: 'help-start', label: 'Start Here' },
  { id: 'help-howto', label: 'How-To' },
  { id: 'help-concepts', label: 'Concepts' },
  { id: 'help-shortcuts', label: 'Shortcuts' },
  { id: 'help-vim', label: 'Vim + Ex' },
  { id: 'help-commands', label: 'Commands' },
  { id: 'help-settings', label: 'Settings' }
]

const COMMAND_CATEGORY_ORDER = [
  'Note',
  'Tabs',
  'Panes',
  'Go',
  'View',
  'Editor',
  'Reference',
  'UI',
  'Tag',
  'App'
]

function commandExAlias(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '_')
}

function matchesQuery(query: string, ...parts: Array<string | undefined>): boolean {
  if (!query) return true
  return parts.some((part) => part?.toLowerCase().includes(query))
}

export function HelpView(): JSX.Element {
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const runtimePlatform = window.zen.platformSync()
  const platformLabel =
    runtimePlatform === 'darwin'
      ? 'macOS'
      : runtimePlatform === 'win32'
        ? 'Windows'
        : 'Linux'
  const primaryModifierLabel =
    runtimePlatform === 'darwin' ? 'Command (⌘)' : 'Ctrl'

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const allCommands = buildCommands({ includeUnavailable: true })

  const quickStart = useMemo(
    () =>
      HELP_QUICK_START.filter((card) =>
        matchesQuery(deferredQuery, card.title, card.body)
      ),
    [deferredQuery]
  )

  const coreConcepts = useMemo(
    () =>
      HELP_CORE_CONCEPTS.filter((card) =>
        matchesQuery(deferredQuery, card.title, card.body)
      ),
    [deferredQuery]
  )

  const howToGuides = useMemo(
    () =>
      HELP_HOW_TO_GUIDES.filter((card) =>
        matchesQuery(deferredQuery, card.title, card.body)
      ),
    [deferredQuery]
  )

  const shortcutSections = useMemo(
    () =>
      HELP_SHORTCUT_SECTIONS.map((section) => {
        const items = section.items.filter((item) =>
          matchesQuery(
            deferredQuery,
            section.title,
            section.description,
            resolveShortcutKeys(section.id, item.action, keymapOverrides) ?? item.keys,
            item.action,
            item.detail
          )
        )
        if (
          items.length > 0 ||
          matchesQuery(deferredQuery, section.title, section.description)
        ) {
          return {
            ...section,
            items: items.map((item) => ({
              ...item,
              keys: resolveShortcutKeys(section.id, item.action, keymapOverrides) ?? item.keys
            }))
          }
        }
        return null
      }).filter((section): section is (typeof HELP_SHORTCUT_SECTIONS)[number] => !!section),
    [deferredQuery, keymapOverrides]
  )

  const vimCommands = useMemo(
    () =>
      HELP_VIM_COMMANDS.filter((command) =>
        matchesQuery(
          deferredQuery,
          resolveVimCommandLabel(command.command, keymapOverrides),
          command.summary,
          command.detail
        )
      ).map((command) => ({
        ...command,
        command: resolveVimCommandLabel(command.command, keymapOverrides)
      })),
    [deferredQuery, keymapOverrides]
  )

  const settingsSections = useMemo(
    () =>
      HELP_SETTINGS.map((section) => {
        const items = section.items.filter((item) =>
          matchesQuery(deferredQuery, section.title, item.label, item.detail)
        )
        if (items.length > 0 || matchesQuery(deferredQuery, section.title)) {
          return { ...section, items }
        }
        return null
      }).filter((section): section is (typeof HELP_SETTINGS)[number] => !!section),
    [deferredQuery]
  )

  const commandGroups = useMemo(() => {
    const groups = new Map<string, Command[]>()
    for (const command of allCommands) {
      if (
        !matchesQuery(
          deferredQuery,
          command.title,
          command.category,
          command.keywords,
          command.shortcut,
          command.id,
          commandExAlias(command.id)
        )
      ) {
        continue
      }
      const bucket = groups.get(command.category) ?? []
      bucket.push(command)
      groups.set(command.category, bucket)
    }

    const order = [...COMMAND_CATEGORY_ORDER, ...[...groups.keys()].filter((key) => !COMMAND_CATEGORY_ORDER.includes(key))]
    return order
      .map((category) => {
        const commands = groups.get(category)
        if (!commands || commands.length === 0) return null
        return {
          category,
          commands: commands.slice().sort((a, b) => a.title.localeCompare(b.title))
        }
      })
      .filter((group): group is CommandGroup => !!group)
  }, [allCommands, deferredQuery])

  const hasMatches =
    quickStart.length > 0 ||
    howToGuides.length > 0 ||
    coreConcepts.length > 0 ||
    shortcutSections.length > 0 ||
    vimCommands.length > 0 ||
    commandGroups.length > 0 ||
    settingsSections.length > 0

  return (
    <div
      data-preview-scroll
      tabIndex={0}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
    >
      <div
        data-preview-content
        className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6"
      >
        <section
          id="help-overview"
          className="overflow-hidden rounded-[32px] border border-paper-300/70 bg-paper-50/45 shadow-[0_24px_80px_rgba(15,23,42,0.08)]"
        >
          <div className="bg-[radial-gradient(circle_at_top_left,rgba(214,140,82,0.18),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0.02))] px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-3xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-paper-300/70 bg-paper-100/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-ink-500">
                    <DocumentIcon width={14} height={14} />
                    ZenNotes Manual
                  </div>
                  <h1 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
                    Learn the app in layers, not all at once.
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-7 text-ink-600 sm:text-[15px]">
                    Start with the onboarding cards, use the how-to section for common jobs, read
                    the concepts section when you want the app model to make sense, and use the
                    rest of the page as a living reference for shortcuts, commands, and settings.
                  </p>
                  <p className="mt-3 max-w-2xl text-xs leading-6 text-ink-500 sm:text-sm">
                    Shortcut labels on this page are rendered for {platformLabel}. The primary app
                    modifier is {primaryModifierLabel}, while Vim-style motions like{' '}
                    <code className="rounded bg-paper-100/80 px-1.5 py-0.5 font-mono text-[0.95em] text-ink-700">
                      Ctrl-w
                    </code>{' '}
                    and{' '}
                    <code className="rounded bg-paper-100/80 px-1.5 py-0.5 font-mono text-[0.95em] text-ink-700">
                      Ctrl-d
                    </code>{' '}
                    stay literal across OSes.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ActionBtn
                    icon={<SearchIcon width={14} height={14} />}
                    label="Search Notes"
                    onClick={() => setSearchOpen(true)}
                  />
                  <ActionBtn
                    icon={<CommandIcon width={14} height={14} />}
                    label="Commands"
                    onClick={() => setCommandPaletteOpen(true)}
                  />
                  <ActionBtn
                    icon={<SettingsIcon width={14} height={14} />}
                    label="Settings"
                    onClick={() => setSettingsOpen(true)}
                  />
                  <ActionBtn
                    icon={<CloseIcon width={14} height={14} />}
                    label="Close"
                    onClick={() => void closeActiveNote()}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <HeroStat
                  label="Start Here"
                  value={String(HELP_QUICK_START.length)}
                  detail="Onboarding cards for first launch and first notes."
                />
                <HeroStat
                  label="How-To"
                  value={String(HELP_HOW_TO_GUIDES.length)}
                  detail="Common tasks written as practical recipes."
                />
                <HeroStat
                  label="Reference"
                  value={String(allCommands.length + HELP_VIM_COMMANDS.length)}
                  detail="Command palette entries plus curated Vim and ex commands."
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-ink-500">
                    Filter the manual
                  </span>
                  <div className="flex items-center gap-2 rounded-2xl border border-paper-300/80 bg-paper-100/85 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
                    <SearchIcon width={16} height={16} className="shrink-0 text-ink-400" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search shortcuts, ex commands, settings, or commands"
                      className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
                    />
                    {query && (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="rounded-md px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </label>

                <div className="flex flex-wrap gap-2">
                  {HELP_SECTION_LINKS.map((link) => (
                    <button
                      key={link.id}
                      type="button"
                      onClick={() =>
                        document.getElementById(link.id)?.scrollIntoView({
                          block: 'start',
                          behavior: 'smooth'
                        })
                      }
                      className="rounded-full border border-paper-300/80 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                    >
                      {link.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {!hasMatches && (
          <section className="rounded-[28px] border border-paper-300/70 bg-paper-50/45 px-6 py-8 text-center shadow-[0_18px_48px_rgba(15,23,42,0.05)]">
            <h2 className="font-serif text-2xl text-ink-900">No help topics matched.</h2>
            <p className="mt-2 text-sm text-ink-500">
              Clear the filter to see the full manual again.
            </p>
          </section>
        )}

        {hasMatches && (
          <>
            {quickStart.length > 0 && (
              <SectionShell
                id="help-start"
                title="Start Here"
                subtitle="A short tutorial path for getting productive without learning the whole app first."
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  {quickStart.map((card) => (
                    <InfoCard key={card.title} title={card.title} body={card.body} />
                  ))}
                </div>
              </SectionShell>
            )}

            {howToGuides.length > 0 && (
              <SectionShell
                id="help-howto"
                title="How-To Guides"
                subtitle="Task-focused recipes for the jobs people repeat most often."
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  {howToGuides.map((card) => (
                    <InfoCard key={card.title} title={card.title} body={card.body} />
                  ))}
                </div>
              </SectionShell>
            )}

            {coreConcepts.length > 0 && (
              <SectionShell
                id="help-concepts"
                title="Concepts"
                subtitle="Explanations that make the app model, file model, and workflow model easier to reason about."
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  {coreConcepts.map((card) => (
                    <InfoCard key={card.title} title={card.title} body={card.body} />
                  ))}
                </div>
              </SectionShell>
            )}

            {shortcutSections.length > 0 && (
              <SectionShell
                id="help-shortcuts"
                title="Keyboard Shortcuts"
                subtitle={`Documented from the current input model for ${platformLabel}, not guessed.`}
              >
                <div className="grid gap-4 xl:grid-cols-2">
                  {shortcutSections.map((section) => (
                    <div
                      key={section.id}
                      className="rounded-[24px] border border-paper-300/70 bg-paper-50/55 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.04)]"
                    >
                      <h3 className="text-sm font-semibold text-ink-900">{section.title}</h3>
                      <p className="mt-1 text-xs leading-6 text-ink-500">{section.description}</p>
                      <div className="mt-4 flex flex-col gap-3">
                        {section.items.map((item) => (
                          <ShortcutRow
                            key={`${section.id}-${item.action}`}
                            keys={item.keys}
                            action={item.action}
                            detail={item.detail}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </SectionShell>
            )}

            {vimCommands.length > 0 && (
              <SectionShell
                id="help-vim"
                title="Vim And Ex"
                subtitle="Short aliases, curated commands, and keyboard-first editor behavior."
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                  <div className="rounded-[24px] border border-paper-300/70 bg-paper-50/55 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.04)]">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                      <DocumentIcon width={15} height={15} className="text-accent" />
                      Curated ex commands
                    </div>
                    <div className="mt-4 grid gap-3">
                      {vimCommands.map((item) => (
                        <div
                          key={item.command}
                          className="rounded-2xl border border-paper-300/70 bg-paper-100/70 px-4 py-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Keycap value={item.command} />
                            <span className="text-sm font-medium text-ink-900">{item.summary}</span>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-ink-500">{item.detail}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-4">
                    <CalloutCard
                      icon={<CommandIcon width={16} height={16} className="text-accent" />}
                      title="Palette commands are also ex commands"
                      body="Every command palette entry is registered on the Vim `:` line using its command id with punctuation normalized to underscores, like `:app_settings` or `:note_new_quick`."
                    />
                    <CalloutCard
                      icon={<CheckSquareIcon width={16} height={16} className="text-accent" />}
                      title="Tasks and Tags have local ex prompts"
                      body={`Inside Tasks or Tags, press \`${shortcut(keymapOverrides, 'nav.localEx')}\` to open the local command line for view-specific actions like close, split, refresh, and retagging.`}
                    />
                    <CalloutCard
                      icon={<TagIcon width={16} height={16} className="text-accent" />}
                      title="Link following is context-aware"
                      body={`\`${shortcut(keymapOverrides, 'vim.goToDefinition')}\` opens existing notes, external links, or PDFs. Missing wikilinks can create new notes directly from the ex-aware workflow.`}
                    />
                  </div>
                </div>
              </SectionShell>
            )}

            {commandGroups.length > 0 && (
              <SectionShell
                id="help-commands"
                title="Command Palette"
                subtitle={`Everything searchable from ${shortcut(keymapOverrides, 'global.commandPalette')}, including contextual commands.`}
              >
                <div className="space-y-5">
                  {commandGroups.map((group) => (
                    <div key={group.category}>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-ink-900">{group.category}</h3>
                        <span className="text-xs text-ink-400">{group.commands.length}</span>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-2">
                        {group.commands.map((command) => (
                          <div
                            key={command.id}
                            className="rounded-[22px] border border-paper-300/70 bg-paper-50/55 px-4 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.03)]"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-ink-900">{command.title}</div>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {command.shortcut && <Keycap value={command.shortcut} />}
                                  <Keycap value={`:${commandExAlias(command.id)}`} subtle />
                                  {command.when && <Badge label="Contextual" />}
                                </div>
                              </div>
                              <span className="rounded-full bg-paper-100/85 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
                                {command.id}
                              </span>
                            </div>
                            {command.keywords && (
                              <p className="mt-3 text-xs leading-6 text-ink-500">
                                Keywords: {command.keywords}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </SectionShell>
            )}

            {settingsSections.length > 0 && (
              <SectionShell
                id="help-settings"
                title="Settings"
                subtitle="Everything configurable from the Settings modal today."
              >
                <div className="grid gap-4 xl:grid-cols-2">
                  {settingsSections.map((section) => (
                    <div
                      key={section.title}
                      className="rounded-[24px] border border-paper-300/70 bg-paper-50/55 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.04)]"
                    >
                      <h3 className="text-sm font-semibold text-ink-900">{section.title}</h3>
                      <div className="mt-4 space-y-3">
                        {section.items.map((item) => (
                          <div
                            key={`${section.title}-${item.label}`}
                            className="rounded-2xl border border-paper-300/70 bg-paper-100/70 px-4 py-3"
                          >
                            <div className="text-sm font-medium text-ink-900">{item.label}</div>
                            <p className="mt-1 text-sm leading-6 text-ink-500">{item.detail}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </SectionShell>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SectionShell({
  id,
  title,
  subtitle,
  children
}: {
  id?: string
  title: string
  subtitle: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section id={id} className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-ink-900">{title}</h2>
        <p className="mt-1 text-sm leading-7 text-ink-500">{subtitle}</p>
      </div>
      {children}
    </section>
  )
}

function InfoCard({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-[24px] border border-paper-300/70 bg-paper-50/55 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.04)]">
      <h3 className="text-base font-medium text-ink-900">{title}</h3>
      <p className="mt-2 text-sm leading-7 text-ink-500">{body}</p>
    </div>
  )
}

function ShortcutRow({
  keys,
  action,
  detail
}: {
  keys: string
  action: string
  detail: string
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-paper-300/70 bg-paper-100/70 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Keycap value={keys} />
        <span className="text-sm font-medium text-ink-900">{action}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-ink-500">{detail}</p>
    </div>
  )
}

function Keycap({
  value,
  subtle = false
}: {
  value: string
  subtle?: boolean
}): JSX.Element {
  return (
    <span
      className={[
        'inline-flex items-center rounded-lg border px-2 py-1 font-mono text-[11px]',
        subtle
          ? 'border-paper-300/80 bg-paper-50/80 text-ink-500'
          : 'border-paper-300 bg-paper-100 text-ink-800'
      ].join(' ')}
    >
      {value}
    </span>
  )
}

function Badge({ label }: { label: string }): JSX.Element {
  return (
    <span className="rounded-full border border-paper-300/80 bg-paper-50/80 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-500">
      {label}
    </span>
  )
}

function HeroStat({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail: string
}): JSX.Element {
  return (
    <div className="rounded-[22px] border border-paper-300/70 bg-paper-100/75 px-4 py-4 shadow-[0_12px_28px_rgba(15,23,42,0.03)]">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-ink-900">{value}</div>
      <p className="mt-2 text-xs leading-6 text-ink-500">{detail}</p>
    </div>
  )
}

function ActionBtn({
  icon,
  label,
  onClick
}: {
  icon: JSX.Element
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-xl border border-paper-300/80 bg-paper-100/85 px-3 py-2 text-sm font-medium text-ink-800 transition-colors hover:bg-paper-200 hover:text-ink-900"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function CalloutCard({
  icon,
  title,
  body
}: {
  icon: JSX.Element
  title: string
  body: string
}): JSX.Element {
  return (
    <div className="rounded-[24px] border border-paper-300/70 bg-paper-50/55 p-5 shadow-[0_16px_36px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
        {icon}
        {title}
      </div>
      <p className="mt-2 text-sm leading-7 text-ink-500">{body}</p>
    </div>
  )
}
