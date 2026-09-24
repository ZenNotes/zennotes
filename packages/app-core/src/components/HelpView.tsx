import { useDeferredValue, useMemo, useState } from 'react'
import { useStore } from '../store'
import { buildCommands, type Command } from '../lib/commands'
import {
  getKeymapDisplay,
  UNBOUND_LABEL,
  type KeymapId,
  type KeymapOverrides
} from '../lib/keymaps'
import {
  HELP_CLI,
  HELP_CORE_CONCEPTS,
  HELP_HOW_TO_GUIDES,
  HELP_QUICK_START,
  HELP_SETTINGS,
  HELP_SHORTCUT_SECTIONS,
  HELP_VIM_COMMANDS
} from '../lib/help'
import { parseHelpKeys } from '../lib/help-keys'
import { SearchIcon } from './icons'
import { Button } from './ui/Button'

interface CommandGroup {
  category: string
  commands: Command[]
}

// The manual names an unbound action as such where the palette leaves the
// key out: someone looking up "how do I open the outline" should learn that
// the key was removed, not meet an empty cell.
function shortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return getKeymapDisplay(overrides, id) || UNBOUND_LABEL
}

/** The steps of one chord; a single unbound step makes the chord unbound. */
function chord(...steps: string[]): string {
  return steps.includes(UNBOUND_LABEL) ? UNBOUND_LABEL : steps.join(' ')
}

/** Alternatives shown side by side; the unbound ones drop out. */
function alternatives(keys: string[]): string {
  return keys.filter((key) => key !== UNBOUND_LABEL).join(' / ') || UNBOUND_LABEL
}

function leaderShortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return chord(shortcut(overrides, 'vim.leaderPrefix'), shortcut(overrides, id))
}

function paneShortcut(overrides: KeymapOverrides, id: KeymapId): string {
  return chord(shortcut(overrides, 'vim.panePrefix'), shortcut(overrides, id))
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
    if (action === 'New note from template') return shortcut(overrides, 'global.newNoteFromTemplate')
    if (action === 'Insert template into current note') return shortcut(overrides, 'global.insertTemplate')
    if (action === 'Open Settings') return shortcut(overrides, 'global.openSettings')
    if (action === 'Toggle sidebar') return shortcut(overrides, 'global.toggleSidebar')
    if (action === 'Toggle connections') return shortcut(overrides, 'global.toggleConnections')
    if (action === 'Toggle Zen mode') return shortcut(overrides, 'global.toggleZenMode')
    if (action === 'Close active tab') return shortcut(overrides, 'global.closeActiveTab')
    if (action === 'Export note as PDF') return shortcut(overrides, 'global.exportNotePdf')
    if (action === 'Zoom in') return shortcut(overrides, 'global.zoomIn')
    if (action === 'Zoom out') return shortcut(overrides, 'global.zoomOut')
    if (action === 'Reset zoom') return shortcut(overrides, 'global.zoomReset')
    if (action === 'Toggle word wrap') return shortcut(overrides, 'global.toggleWordWrap')
  }

  if (sectionId === 'panel-motion') {
    if (action === 'Move focus') {
      return alternatives([
        paneShortcut(overrides, 'vim.paneFocusLeft'),
        paneShortcut(overrides, 'vim.paneFocusDown'),
        paneShortcut(overrides, 'vim.paneFocusUp'),
        paneShortcut(overrides, 'vim.paneFocusRight')
      ])
    }
    if (action === 'Split right') return paneShortcut(overrides, 'vim.paneSplitRight')
    if (action === 'Split down') return paneShortcut(overrides, 'vim.paneSplitDown')
    if (action === 'Open buffers') return leaderShortcut(overrides, 'vim.leaderOpenBuffers')
    if (action === 'Search notes') return leaderShortcut(overrides, 'vim.leaderSearchNotes')
    if (action === 'Search vault text') {
      return chord(
        leaderShortcut(overrides, 'vim.leaderSearchGroup'),
        shortcut(overrides, 'vim.leaderSearchVaultText')
      )
    }
    if (action === 'Toggle left sidebar') return leaderShortcut(overrides, 'vim.leaderToggleSidebar')
    if (action === 'Note outline') return leaderShortcut(overrides, 'vim.leaderNoteOutline')
    if (action === 'Switch vault') return leaderShortcut(overrides, 'vim.leaderSwitchVault')
    if (action === 'Open workflows') return leaderShortcut(overrides, 'vim.leaderWorkflows')
    if (action === 'Review Cloud conflicts') {
      return leaderShortcut(overrides, 'vim.leaderCloudConflicts')
    }
    if (action === 'Show leader hints') {
      const leader = shortcut(overrides, 'vim.leaderPrefix')
      return leader === UNBOUND_LABEL ? leader : `${leader}, then pause`
    }
    if (action === 'Toggle outline panel') return shortcut(overrides, 'global.toggleOutlinePanel')
    if (action === 'Fold / unfold heading') {
      return alternatives([shortcut(overrides, 'vim.foldCurrent'), shortcut(overrides, 'vim.unfoldCurrent')])
    }
    if (action === 'Fold / unfold all') {
      return alternatives([shortcut(overrides, 'vim.foldAll'), shortcut(overrides, 'vim.unfoldAll')])
    }
    if (action === 'Go back') return shortcut(overrides, 'vim.historyBack')
    if (action === 'Go forward') return shortcut(overrides, 'vim.historyForward')
    if (action === 'Hint mode') return leaderShortcut(overrides, 'vim.hintMode')
  }

  if (sectionId === 'lists-and-sidebar') {
    if (action === 'Move selection') {
      return alternatives([shortcut(overrides, 'nav.moveDown'), shortcut(overrides, 'nav.moveUp')])
    }
    if (action === 'Jump to top or bottom') {
      return alternatives([shortcut(overrides, 'nav.jumpTop'), shortcut(overrides, 'nav.jumpBottom')])
    }
    if (action === 'Open item') return alternatives(['Enter', shortcut(overrides, 'nav.openSideItem')])
    if (action === 'Collapse or move left') return shortcut(overrides, 'nav.back')
    if (action === 'Toggle folder') return shortcut(overrides, 'nav.toggleFolder')
    if (action === 'Search notes') return shortcut(overrides, 'nav.filter')
    if (action === 'Open context menu') return shortcut(overrides, 'nav.contextMenu')
  }

  if (sectionId === 'preview-and-connections') {
    if (action === 'Scroll preview') {
      return alternatives([shortcut(overrides, 'nav.moveDown'), shortcut(overrides, 'nav.moveUp')])
    }
    if (action === 'Half-page scroll') {
      return alternatives([shortcut(overrides, 'nav.halfPageDown'), shortcut(overrides, 'nav.halfPageUp')])
    }
    if (action === 'Jump to top or bottom') {
      return alternatives([shortcut(overrides, 'nav.jumpTop'), shortcut(overrides, 'nav.jumpBottom')])
    }
    if (action === 'Search notes') return shortcut(overrides, 'nav.filter')
    if (action === 'Peek backlink') return shortcut(overrides, 'nav.peekPreview')
    if (action === 'Back out') return alternatives([shortcut(overrides, 'nav.back'), 'Esc'])
  }

  return null
}

function resolveVimCommandLabel(command: string, overrides: KeymapOverrides): string {
  if (command === 'gd') return shortcut(overrides, 'vim.goToDefinition')
  if (command === 'gD') return shortcut(overrides, 'vim.createNoteFromLink')
  if (command === '<Space> l f') {
    return chord(
      leaderShortcut(overrides, 'vim.leaderNoteActions'),
      shortcut(overrides, 'vim.leaderFormatNote')
    )
  }
  if (command === '<Space> (pause)') {
    const leader = shortcut(overrides, 'vim.leaderPrefix')
    return leader === UNBOUND_LABEL ? leader : `${leader} (pause)`
  }
  if (command === '<Space> o') return leaderShortcut(overrides, 'vim.leaderOpenBuffers')
  if (command === '<Space> f') return leaderShortcut(overrides, 'vim.leaderSearchNotes')
  if (command === '<Space> s t') {
    return chord(
      leaderShortcut(overrides, 'vim.leaderSearchGroup'),
      shortcut(overrides, 'vim.leaderSearchVaultText')
    )
  }
  if (command === '<Space> e') return leaderShortcut(overrides, 'vim.leaderToggleSidebar')
  if (command === '<Space> p') return leaderShortcut(overrides, 'vim.leaderNoteOutline')
  if (command === '<Space> v') return leaderShortcut(overrides, 'vim.leaderSwitchVault')
  return command
}

const HELP_SECTION_LINKS = [
  { id: 'help-start', label: 'Start Here' },
  { id: 'help-howto', label: 'How-To' },
  { id: 'help-concepts', label: 'Concepts' },
  { id: 'help-shortcuts', label: 'Shortcuts' },
  { id: 'help-vim', label: 'Vim & Ex' },
  { id: 'help-commands', label: 'Commands' },
  { id: 'help-cli', label: 'CLI' },
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
  'App',
  'CLI'
]

function commandExAlias(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '_')
}

function matchesQuery(query: string, ...parts: Array<string | undefined>): boolean {
  if (!query) return true
  return parts.some((part) => part?.toLowerCase().includes(query))
}

export function HelpView(): JSX.Element {
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const runtimePlatform = window.zen.platformSync()
  const mac = runtimePlatform === 'darwin'
  const platformLabel =
    runtimePlatform === 'darwin'
      ? 'macOS'
      : runtimePlatform === 'win32'
        ? 'Windows'
        : 'Linux'

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

  const cliCards = useMemo(
    () =>
      HELP_CLI.filter((card) => matchesQuery(deferredQuery, card.title, card.body)),
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
    cliCards.length > 0 ||
    settingsSections.length > 0

  // Only the sections that survive the filter get a link, so the nav never
  // offers a jump to nothing.
  const visibleSections = new Set<string>(
    [
      quickStart.length > 0 && 'help-start',
      howToGuides.length > 0 && 'help-howto',
      coreConcepts.length > 0 && 'help-concepts',
      shortcutSections.length > 0 && 'help-shortcuts',
      vimCommands.length > 0 && 'help-vim',
      commandGroups.length > 0 && 'help-commands',
      cliCards.length > 0 && 'help-cli',
      settingsSections.length > 0 && 'help-settings'
    ].filter((id): id is string => !!id)
  )

  return (
    <div
      data-preview-scroll
      tabIndex={0}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
    >
      <div data-preview-content className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
        <header id="help-overview">
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink-900">Help</h1>
          <p className="mt-2 max-w-prose text-base leading-7 text-ink-500">
            The ZenNotes manual: start with the basics, then look up any shortcut, command, or
            setting.
          </p>
          <label className="mt-6 flex items-center gap-2.5 rounded-xl border border-paper-300 bg-paper-100 px-3.5 py-2.5 focus-within:border-accent/60">
            <SearchIcon width={16} height={16} className="shrink-0 text-ink-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the manual"
              aria-label="Search the manual"
              className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
            />
            {query && (
              <Button variant="ghost" onClick={() => setQuery('')}>
                Clear
              </Button>
            )}
          </label>
        </header>

        {visibleSections.size > 0 && (
          <nav
            aria-label="Manual sections"
            className="sticky top-0 z-10 -mx-6 mt-4 flex flex-wrap gap-1 border-b border-paper-300/60 bg-paper-100/95 px-4 py-2 backdrop-blur"
          >
            {HELP_SECTION_LINKS.filter((link) => visibleSections.has(link.id)).map((link) => (
              <Button
                key={link.id}
                variant="ghost"
                onClick={() =>
                  document.getElementById(link.id)?.scrollIntoView({
                    block: 'start',
                    behavior: 'smooth'
                  })
                }
              >
                {link.label}
              </Button>
            ))}
          </nav>
        )}

        {!hasMatches && (
          <p className="py-16 text-center text-sm text-ink-500">
            Nothing in the manual matches “{query.trim()}”.
          </p>
        )}

        {quickStart.length > 0 && (
          <SectionShell
            id="help-start"
            title="Start Here"
            subtitle="A short path to getting productive without learning the whole app first."
          >
            <ArticleList cards={quickStart} />
          </SectionShell>
        )}

        {howToGuides.length > 0 && (
          <SectionShell
            id="help-howto"
            title="How-To Guides"
            subtitle="Recipes for the jobs people repeat most often."
          >
            <ArticleList cards={howToGuides} />
          </SectionShell>
        )}

        {coreConcepts.length > 0 && (
          <SectionShell
            id="help-concepts"
            title="Concepts"
            subtitle="How the app, your files, and your workflows fit together."
          >
            <ArticleList cards={coreConcepts} />
          </SectionShell>
        )}

        {shortcutSections.length > 0 && (
          <SectionShell
            id="help-shortcuts"
            title="Keyboard Shortcuts"
            subtitle={`Keys are shown for ${platformLabel}, as you have them bound. Vim keys like Ctrl-w are the same on every system.`}
          >
            <div className="space-y-10">
              {shortcutSections.map((section) => (
                <div key={section.id}>
                  <h3 className="text-base font-semibold text-ink-900">{section.title}</h3>
                  {section.description && (
                    <p className="mt-1 max-w-prose text-sm leading-6 text-ink-500">
                      {renderRichText(section.description, 'text-xs')}
                    </p>
                  )}
                  <ReferenceList>
                    {section.items.map((item) => (
                      <ReferenceRow
                        key={`${section.id}-${item.action}`}
                        title={item.action}
                        keys={<KeyList value={item.keys} mac={mac} />}
                        detail={item.detail}
                      />
                    ))}
                  </ReferenceList>
                </div>
              ))}
            </div>
          </SectionShell>
        )}

        {vimCommands.length > 0 && (
          <SectionShell
            id="help-vim"
            title="Vim & Ex"
            subtitle="Ex commands, short aliases, and keyboard-first editor behavior."
          >
            <ReferenceList>
              {vimCommands.map((item) => (
                <ReferenceRow
                  key={item.command}
                  title={item.summary}
                  keys={<KeyList value={item.command} mac={mac} />}
                  detail={item.detail}
                />
              ))}
            </ReferenceList>
            <h3 className="mt-10 text-base font-semibold text-ink-900">Good to know</h3>
            <ReferenceList>
              {[
                {
                  title: 'Palette commands are also ex commands',
                  body: 'Every command palette entry is registered on the Vim `:` line using its command id with punctuation normalized to underscores, like `:app_settings` or `:note_new_quick`.'
                },
                {
                  title: 'Tasks and Tags have local ex prompts',
                  body:
                    shortcut(keymapOverrides, 'nav.localEx') === UNBOUND_LABEL
                      ? 'Inside Tasks or Tags, the local command line (nav.localEx) has no key right now; give it one under Settings, Keymaps to reach view-specific actions like close, split, refresh, and retagging.'
                      : `Inside Tasks or Tags, press \`${shortcut(keymapOverrides, 'nav.localEx')}\` to open the local command line for view-specific actions like close, split, refresh, and retagging.`
                },
                {
                  title: 'Link following is context-aware',
                  body:
                    shortcut(keymapOverrides, 'vim.goToDefinition') === UNBOUND_LABEL
                      ? 'Following the link at the cursor (vim.goToDefinition) has no key right now; give it one under Settings, Keymaps. It opens existing notes, external links, or PDFs, and missing wikilinks can create new notes directly from the ex-aware workflow.'
                      : `\`${shortcut(keymapOverrides, 'vim.goToDefinition')}\` opens existing notes, external links, or PDFs. Missing wikilinks can create new notes directly from the ex-aware workflow.`
                }
              ].map((tip) => (
                <ReferenceRow key={tip.title} title={tip.title} detail={tip.body} />
              ))}
            </ReferenceList>
          </SectionShell>
        )}

        {commandGroups.length > 0 && (
          <SectionShell
            id="help-commands"
            title="Command Palette"
            subtitle={`Everything you can run from ${shortcut(keymapOverrides, 'global.commandPalette')}. Each command also runs on the Vim : line, under the name shown on the right.`}
            action={
              <Button variant="ghost" onClick={() => setCommandPaletteOpen(true)}>
                Open palette
              </Button>
            }
          >
            <div className="space-y-10">
              {commandGroups.map((group) => (
                <div key={group.category}>
                  <h3 className="flex items-baseline gap-2 text-base font-semibold text-ink-900">
                    {group.category}
                    <span className="text-sm font-normal text-ink-400">
                      {group.commands.length}
                    </span>
                  </h3>
                  <ul className="mt-3 divide-y divide-paper-300/50 border-t border-paper-300/50">
                    {group.commands.map((command) => (
                      <li
                        key={command.id}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
                      >
                        <span className="text-sm text-ink-900">{command.title}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          {command.shortcut && <Keycap value={command.shortcut} />}
                          <code className="font-mono text-xs text-ink-400">
                            :{commandExAlias(command.id)}
                          </code>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </SectionShell>
        )}

        {cliCards.length > 0 && (
          <SectionShell
            id="help-cli"
            title="Command-Line Tool (zen)"
            subtitle="Capture, search, and edit your vault from any terminal. Install it once from Settings → CLI."
          >
            <ArticleList cards={cliCards} />
          </SectionShell>
        )}

        {settingsSections.length > 0 && (
          <SectionShell
            id="help-settings"
            title="Settings"
            subtitle="What each setting does, grouped the way the Settings window groups them."
            action={
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                Open Settings
              </Button>
            }
          >
            <div className="space-y-10">
              {settingsSections.map((section) => (
                <div key={section.title}>
                  <h3 className="text-base font-semibold text-ink-900">{section.title}</h3>
                  <ReferenceList>
                    {section.items.map((item) => (
                      <ReferenceRow
                        key={`${section.title}-${item.label}`}
                        title={item.label}
                        detail={item.detail}
                      />
                    ))}
                  </ReferenceList>
                </div>
              ))}
            </div>
          </SectionShell>
        )}
      </div>
    </div>
  )
}

/**
 * One manual section. Sections are set apart by space alone, not boxes or
 * rules: the manual reads as one document, and a card around every paragraph
 * was most of what made it feel cluttered. The scroll margin clears the
 * sticky section nav even when it wraps onto a second row.
 */
function SectionShell({
  id,
  title,
  subtitle,
  action,
  children
}: {
  id?: string
  title: string
  subtitle: string
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section id={id} className="mt-16 scroll-mt-24 first-of-type:mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-ink-900">{title}</h2>
        {action}
      </div>
      <p className="mt-2 max-w-prose text-sm leading-6 text-ink-500">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </section>
  )
}

// Renders a help string with Markdown-style backtick code spans. Short spans
// become inline code; long or multi-line spans become a code block so shell
// commands stay readable instead of wrapping through prose. `codeSize` keeps
// inline code a step below the text around it.
function renderRichText(text: string, codeSize: 'text-xs' | 'text-sm'): React.ReactNode {
  return text.split(/(`[^`]+`)/g).map((seg, i) => {
    if (seg.length > 1 && seg.startsWith('`') && seg.endsWith('`')) {
      const code = seg.slice(1, -1)
      if (code.includes('\n') || code.length > 60) {
        return (
          <code
            key={i}
            className="my-3 block overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-paper-300/60 bg-paper-200/60 px-3 py-2 font-mono text-xs leading-6 text-ink-800"
          >
            {code}
          </code>
        )
      }
      return (
        <code
          key={i}
          className={`rounded border border-paper-300/60 bg-paper-200/60 px-1 py-px font-mono text-ink-800 ${codeSize}`}
        >
          {code}
        </code>
      )
    }
    return seg
  })
}

/** Guides and concepts: a title and a paragraph, kept to a readable measure. */
function ArticleList({ cards }: { cards: { title: string; body: string }[] }): JSX.Element {
  return (
    <div className="space-y-8">
      {cards.map((card) => (
        <article key={card.title}>
          <h3 className="text-base font-semibold text-ink-900">{card.title}</h3>
          <div className="mt-2 max-w-prose text-base leading-7 text-ink-700">
            {renderRichText(card.body, 'text-sm')}
          </div>
        </article>
      ))}
    </div>
  )
}

function ReferenceList({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <dl className="mt-4 divide-y divide-paper-300/50 border-t border-paper-300/50">{children}</dl>
  )
}

/**
 * A reference entry: what it does, its keys at the end of the same line, and
 * the detail underneath. Leading with the action keeps a long detail from
 * leaving an empty column under the key, and the keys drop below the title
 * on their own when the pane is too narrow for both.
 */
function ReferenceRow({
  title,
  keys,
  detail
}: {
  title: string
  keys?: React.ReactNode
  detail?: string
}): JSX.Element {
  return (
    <div className="py-3">
      <dt className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
        <span className="text-sm font-medium text-ink-900">{title}</span>
        {keys}
      </dt>
      {detail && (
        <dd className="mt-1 max-w-prose text-sm leading-6 text-ink-600">
          {renderRichText(detail, 'text-xs')}
        </dd>
      )}
    </div>
  )
}

/** A row's keys: one keycap per key, and anything else in plain text. */
function KeyList({ value, mac }: { value: string; mac: boolean }): JSX.Element {
  if (value === UNBOUND_LABEL) {
    return <span className="text-xs text-ink-400">{value}</span>
  }
  const { parts, context } = parseHelpKeys(value, mac)
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
      {parts.map((part, index) =>
        part.kind === 'key' ? (
          <Keycap key={index} value={part.text} />
        ) : (
          <span key={index} className="text-xs text-ink-400">
            {part.text}
          </span>
        )
      )}
      {context && <span className="text-xs text-ink-500">{context}</span>}
    </span>
  )
}

function Keycap({ value }: { value: string }): JSX.Element {
  return (
    <span className="inline-block max-w-full break-words rounded-md border border-paper-300 bg-paper-200/60 px-1.5 py-0.5 font-mono text-xs leading-5 text-ink-800">
      {value}
    </span>
  )
}
