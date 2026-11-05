// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HELP_CLI,
  HELP_CORE_CONCEPTS,
  HELP_HOW_TO_GUIDES,
  HELP_QUICK_START,
  HELP_SETTINGS,
  HELP_SHORTCUT_SECTIONS,
  HELP_VIM_COMMANDS,
  helpForHost,
  type HelpHost
} from './help'

const DESKTOP: HelpHost = { runtime: 'desktop', hostKind: 'desktop' }
const WEB: HelpHost = { runtime: 'web', hostKind: 'browser', supportsWorkflows: false }
const IPAD: HelpHost = { runtime: 'web', hostKind: 'ios' }
const ANDROID: HelpHost = { runtime: 'web', hostKind: 'android' }

const text = (host: HelpHost): string => JSON.stringify(helpForHost(host))
const titles = (host: HelpHost): string[] => {
  const manual = helpForHost(host)
  return [...manual.quickStart, ...manual.howTo, ...manual.concepts, ...manual.cli].map(
    (card) => card.title
  )
}

describe('the manual on each host', () => {
  it('is the whole manual on the desktop app, in the same order', () => {
    const manual = helpForHost(DESKTOP)
    expect(manual.quickStart).toEqual(HELP_QUICK_START)
    expect(manual.howTo).toEqual(HELP_HOW_TO_GUIDES)
    expect(manual.concepts).toEqual(HELP_CORE_CONCEPTS)
    expect(manual.shortcuts).toEqual(HELP_SHORTCUT_SECTIONS)
    expect(manual.vim).toEqual(HELP_VIM_COMMANDS)
    expect(manual.settings).toEqual(HELP_SETTINGS)
    expect(manual.cli).toEqual(HELP_CLI)
  })

  it('names a legacy desktop host without a host kind the same way', () => {
    expect(helpForHost({ runtime: 'desktop' })).toEqual(helpForHost(DESKTOP))
  })

  it.each([
    ['iPad', IPAD],
    ['Android', ANDROID]
  ])('leaves out what does not exist on %s', (_name, host) => {
    const shown = titles(host)
    for (const gone of [
      'Bring your Notion workspace over',
      'Bring your Obsidian vault over',
      'Open a vault in your file manager',
      'Preview a note in Finder with Quick Look',
      'Search from Raycast on macOS',
      'Capture from anywhere with the floating window',
      'Check for updates and install them',
      'What the CLI is for',
      'Automate repetitive edits with Workflows'
    ]) {
      expect(shown).not.toContain(gone)
    }
    const manual = helpForHost(host)
    expect(manual.cli).toEqual([])
    expect(manual.shortcuts.map((s) => s.title)).not.toContain('Quick capture window')
    expect(manual.shortcuts.flatMap((s) => s.items).map((i) => i.action)).not.toContain('Import notes')
    expect(manual.shortcuts.flatMap((s) => s.items).map((i) => i.action)).not.toContain('Open vault folder')
    expect(manual.vim.map((c) => c.summary)).not.toContain('Leader open vault folder')
    expect(manual.settings.map((s) => s.title)).not.toContain('CLI')
    for (const word of ['Raycast', 'Import Notes', 'File Explorer']) {
      expect(text(host)).not.toContain(word)
    }
    // What works there stays.
    expect(shown).toContain('Pick a vault you control')
    expect(shown).toContain('Tabs and splits are first-class')
  })

  // Every entry tagged for the desktop app, or for a computer, by where it sits.
  const tagged = (only: 'desktop' | 'computer'): string[] => [
    ...[...HELP_QUICK_START, ...HELP_HOW_TO_GUIDES, ...HELP_CORE_CONCEPTS, ...HELP_CLI]
      .filter((card) => card.only === only)
      .map((card) => `card:${card.title}`),
    ...HELP_SHORTCUT_SECTIONS.flatMap((section) =>
      section.only === only
        ? [`section:${section.title}`]
        : section.items.filter((item) => item.only === only).map((item) => `key:${item.action}`)
    ),
    ...HELP_VIM_COMMANDS.filter((command) => command.only === only).map(
      (command) => `ex:${command.summary}`
    ),
    ...HELP_SETTINGS.flatMap((section) =>
      section.only === only
        ? [`settings:${section.title}`]
        : section.items.filter((item) => item.only === only).map((item) => `setting:${item.label}`)
    )
  ]
  const shownEntries = (host: HelpHost): string[] => {
    const manual = helpForHost(host)
    return [
      ...[...manual.quickStart, ...manual.howTo, ...manual.concepts, ...manual.cli].map(
        (card) => `card:${card.title}`
      ),
      ...manual.shortcuts.flatMap((section) => [
        `section:${section.title}`,
        ...section.items.map((item) => `key:${item.action}`)
      ]),
      ...manual.vim.map((command) => `ex:${command.summary}`),
      ...manual.settings.flatMap((section) => [
        `settings:${section.title}`,
        ...section.items.map((item) => `setting:${item.label}`)
      ])
    ]
  }

  // Found on the 2.83.0 iPad and Pixel Tablet walks: these said "Desktop only", or
  // named a window, a global hotkey or app zoom, and still showed.
  const DESKTOP_ONLY = [
    'key:Open file',
    'key:Zoom in',
    'key:Zoom out',
    'key:Reset zoom',
    'key:Open quick capture window',
    'key:Quick capture window',
    'ex:Leader quick capture',
    'ex:Show what this version brought',
    'setting:Task reminders',
    'setting:Reminder time',
    'setting:Shares location (macOS)',
    'setting:Count this copy anonymously',
    'setting:What’s New'
  ]
  // Unsplash search lives in the desktop app and the web client; neither phone
  // shell has it. Docker and PDF export are for a computer too.
  const COMPUTER_ONLY = [
    'card:Use an Unsplash photo as a cover',
    'key:Cover from Unsplash',
    'card:Run the self-hosted web version with Docker',
    'key:Export note as PDF'
  ]

  it.each([
    ['iPad', IPAD],
    ['Android', ANDROID]
  ])('shows nothing tagged for the desktop app or a computer on %s', (_name, host) => {
    const shown = shownEntries(host)
    for (const entry of [...DESKTOP_ONLY, ...COMPUTER_ONLY]) expect(shown).not.toContain(entry)
    for (const entry of [...tagged('desktop'), ...tagged('computer')]) {
      expect(shown).not.toContain(entry)
    }
    expect(text(host)).not.toContain('Desktop only')
  })

  it('keeps every one of them on the desktop app', () => {
    const shown = shownEntries(DESKTOP)
    for (const entry of [...DESKTOP_ONLY, ...COMPUTER_ONLY]) expect(shown).toContain(entry)
  })

  it('keeps Unsplash, Docker and PDF export on the web client, and leaves app zoom out', () => {
    const shown = shownEntries(WEB)
    for (const entry of COMPUTER_ONLY) expect(shown).toContain(entry)
    for (const entry of DESKTOP_ONLY) expect(shown).not.toContain(entry)
  })

  it('keeps the terminal on the web client, without what only the desktop app installs', () => {
    const shown = titles(WEB)
    expect(shown).toContain('Point it at a self-hosted server')
    expect(shown).toContain('The CLI is the bridge to launchers')
    expect(shown).not.toContain('Install it once from Settings')
    expect(shown).not.toContain('Bring your Notion workspace over')
    expect(shown).not.toContain('Preview a note in Finder with Quick Look')
  })

  it('shows workflows on a web client whose server runs them', () => {
    expect(titles(WEB)).not.toContain('Automate repetitive edits with Workflows')
    expect(titles({ ...WEB, supportsWorkflows: true })).toContain(
      'Automate repetitive edits with Workflows'
    )
    expect(helpForHost({ ...WEB, supportsWorkflows: true }).settings.map((s) => s.title)).toContain(
      'Workflows'
    )
  })
})

describe('HelpView on a tablet', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const installHost = (appInfo: { runtime: string; hostKind: string }): void => {
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        platformSync: () => 'darwin',
        getAppInfo: () => appInfo,
        // What the phone shells report, so a gate on a capability alone would
        // not hide anything here.
        getCapabilities: () => ({
          supportsWorkflows: false,
          supportsLocalFilesystemPickers: true,
          supportsRemoteWorkspace: true,
          supportsCloudSync: true,
          supportsCliInstall: false
        })
      }
    })
  }
  beforeEach(() => {
    installHost({ runtime: 'web', hostKind: 'ios' })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  const renderHelp = async (): Promise<string> => {
    vi.resetModules()
    const { HelpView } = await import('../components/HelpView')
    await act(async () => root.render(createElement(HelpView)))
    return host.querySelector('#help-commands')?.textContent ?? ''
  }

  it('renders without the desktop topics, and keeps no link to an empty section', async () => {
    await renderHelp()
    const rendered = host.textContent ?? ''
    expect(rendered).toContain('Pick a vault you control')
    expect(rendered).not.toContain('Bring your Notion workspace over')
    expect(rendered).not.toContain('Preview a note in Finder')
    expect(rendered).not.toContain('What the CLI is for')
    expect(host.querySelector('#help-cli')).toBeNull()
  })

  // The command reference lists a host's commands whatever is open, by the
  // palette's own `host` rule: no tray, updater, zoom or floating window on a
  // phone or tablet, while a command that only wants a note stays listed.
  const DESKTOP_COMMANDS = [
    'Check for Updates…',
    'Hide Window to Tray',
    'Quit ZenNotes',
    'Zoom In',
    'Zoom Out',
    'Reset Zoom',
    'Open in Floating Window',
    'Export Note as PDF…',
    'Export Note as Word Document…',
    'Reveal Note in File Manager',
    'What’s New in ZenNotes',
    'Open File…',
    'Add Cover from Unsplash…',
    'Set Unsplash Access Key…'
  ]

  it.each([
    ['iPad', 'ios'],
    ['an Android tablet', 'android']
  ])('lists no desktop command on %s', async (_name, hostKind) => {
    installHost({ runtime: 'web', hostKind })
    const reference = await renderHelp()
    for (const title of DESKTOP_COMMANDS) expect(reference).not.toContain(title)
    expect(reference).toContain('Fold Heading or List Item at Cursor')
    expect(reference).toContain('Toggle Checkbox')
    expect(reference).toContain('Open Settings')
  })

  it('lists every command on the desktop app, the tray included while it is off', async () => {
    installHost({ runtime: 'desktop', hostKind: 'desktop' })
    const reference = await renderHelp()
    for (const title of [
      'Check for Updates…',
      'Hide Window to Tray',
      'Zoom In',
      'Open in Floating Window',
      'Export Note as PDF…',
      'What’s New in ZenNotes',
      'Open File…',
      'Fold Heading or List Item at Cursor'
    ]) {
      expect(reference).toContain(title)
    }
  })
})
