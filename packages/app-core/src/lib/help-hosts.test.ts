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
    const named = (list: Array<{ title: string }>): string[] => list.map((entry) => entry.title)
    expect(named(manual.quickStart)).toEqual(named(HELP_QUICK_START))
    expect(named(manual.howTo)).toEqual(named(HELP_HOW_TO_GUIDES))
    expect(named(manual.concepts)).toEqual(named(HELP_CORE_CONCEPTS))
    expect(manual.shortcuts.map((s) => s.items.map((i) => i.action))).toEqual(
      HELP_SHORTCUT_SECTIONS.map((s) => s.items.map((i) => i.action))
    )
    expect(manual.vim.map((c) => c.command)).toEqual(HELP_VIM_COMMANDS.map((c) => c.command))
    expect(manual.settings.map((s) => s.items.map((i) => i.label))).toEqual(
      HELP_SETTINGS.map((s) => s.items.map((i) => i.label))
    )
    expect(named(manual.cli)).toEqual(named(HELP_CLI))
    // An entry written as one string reads exactly as written.
    const plain = HELP_QUICK_START.find((card) => card.title === 'Pick a vault you control')!
    expect(manual.quickStart.find((card) => card.title === plain.title)?.body).toBe(plain.body)
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

describe('host-gated words inside a general entry', () => {
  const card = (host: HelpHost, title: string): string => {
    const manual = helpForHost(host)
    return [...manual.quickStart, ...manual.howTo, ...manual.concepts].find((c) => c.title === title)!.body
  }
  const key = (host: HelpHost, action: string): string =>
    helpForHost(host).shortcuts.flatMap((s) => s.items).find((i) => i.action === action)!.detail
  const ex = (host: HelpHost, command: string): string =>
    helpForHost(host).vim.find((c) => c.command === command)!.detail
  const setting = (host: HelpHost, label: string): string =>
    helpForHost(host).settings.flatMap((s) => s.items).find((i) => i.label === label)!.detail

  // The wording each host must not see, from the 2.83.0 tablet walks: the tray,
  // the quick capture window, a window frame, app zoom, Quick Look and Finder,
  // and (on a phone or tablet) floating windows and the Unsplash tab.
  const DESKTOP_WORDS = ['tray', 'quick capture window', 'window bounds', 'window frame', 'zoomIn', 'Quick Look', 'Reveal in Finder', 'revealing it in Finder']
  const TOUCH_WORDS = [...DESKTOP_WORDS, 'floating window', 'Floating Window', 'floating-window', 'OS window', 'Unsplash tab']

  it.each([
    ['iPad', IPAD, TOUCH_WORDS],
    ['Android', ANDROID, TOUCH_WORDS],
    ['the web client', WEB, DESKTOP_WORDS]
  ])('leaves the desktop app out of what %s reads', (_name, host, words) => {
    const manual = helpForHost(host)
    const entries: Array<[string, string]> = [
      ...[...manual.quickStart, ...manual.howTo, ...manual.concepts, ...manual.cli].map(
        (c): [string, string] => [c.title, c.body]
      ),
      ...manual.shortcuts.flatMap((s) => s.items.map((i): [string, string] => [i.action, i.detail])),
      ...manual.vim.map((c): [string, string] => [c.command, c.detail]),
      ...manual.settings.flatMap((s) => s.items.map((i): [string, string] => [i.label, i.detail]))
    ]
    for (const [name, body] of entries) {
      for (const word of words) expect(body, `${name}: ${word}`).not.toContain(word)
    }
  })

  it('keeps every one of those words on the desktop app', () => {
    expect(card(DESKTOP, 'Remind me before a task is due')).toContain(
      'Reminders fire from the desktop app while it runs, the window hidden in the tray included. ZenNotes quit misses them'
    )
    expect(card(DESKTOP, 'Tabs and splits are first-class')).toContain(
      'Pin Tab, Pin as Reference, Open in Floating Window, and Reveal in Finder stay accessible'
    )
    expect(card(DESKTOP, 'Keep supporting material nearby')).toMatch(/^Tabs, splits, floating windows, the reference pane/)
    expect(key(DESKTOP, 'Close active tab')).toContain('in a floating window or the quick capture window it closes that window')
    expect(ex(DESKTOP, ':unbind action.id')).toContain('`:unbind global.zoomIn` takes Zoom in off its key')
    expect(setting(DESKTOP, 'Unbind a key')).toContain('`"global.zoomIn" = ""`')
  })

  it('says where reminders fire, without the tray or a desktop setting, off the desktop app', () => {
    for (const host of [IPAD, WEB]) {
      const body = card(host, 'Remind me before a task is due')
      expect(body).toContain('the desktop app shows a notification')
      expect(body).toContain('Reminders fire from the desktop app while it runs. A recurring task')
      expect(body).not.toContain('Settings → Tasks')
    }
  })

  it('names the tab actions each host has', () => {
    const menu = (host: HelpHost): string => key(host, 'Open active tab menu')
    expect(menu(DESKTOP)).toContain('Split Down, Pin as Reference, Open in Floating Window, and Reveal in Finder.')
    expect(menu(WEB)).toContain('Split Down, Pin as Reference, and Open in Floating Window.')
    expect(menu(IPAD)).toContain('Split Down, and Pin as Reference.')
    expect(card(IPAD, 'Keep supporting notes visible')).toBe(
      'Pin a note or PDF as a reference when you want it attached to the current writing context inside ZenNotes.'
    )
  })

  it('unbinds an action every host has in the examples off the desktop app', () => {
    for (const host of [IPAD, ANDROID, WEB]) {
      expect(ex(host, ':unbind action.id')).toContain('`:unbind global.toggleWordWrap` takes Toggle word wrap off its key')
      expect(setting(host, 'Unbind a key')).toContain('`"global.toggleWordWrap" = ""`')
    }
  })

  it('offers Backspace for the sidebar trash on a phone or tablet keyboard', () => {
    expect(card(IPAD, 'Trash notes from the sidebar')).toMatch(
      /^With the sidebar focused \(Focus Sidebar in the command palette\), `Mod\+Backspace`/
    )
    expect(card(IPAD, 'Trash notes from the sidebar')).toContain('the Delete or Backspace key does the same')
    expect(key(ANDROID, 'Move to Trash, Vim on or off')).toContain('and Delete or Backspace here')
    expect(card(DESKTOP, 'Trash notes from the sidebar')).toMatch(/^With the sidebar focused, `Mod\+Backspace`/)
    expect(card(DESKTOP, 'Trash notes from the sidebar')).toContain('; the Delete key does the same')
    expect(card(WEB, 'Trash notes from the sidebar')).not.toContain('Backspace key')
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

  it.each([
    ['iPad', 'ios'],
    ['an Android tablet', 'android']
  ])('shows keys for a hardware keyboard on %s, not a desktop system', async (_name, hostKind) => {
    installHost({ runtime: 'web', hostKind })
    await renderHelp()
    const rendered = host.textContent ?? ''
    expect(rendered).toContain('Keys are shown for a hardware keyboard, as you have them bound.')
    expect(rendered).not.toContain('Keys are shown for Linux')
    expect(rendered).not.toContain('Keys are shown for macOS')
  })

  it('names the system on the desktop app', async () => {
    installHost({ runtime: 'desktop', hostKind: 'desktop' })
    await renderHelp()
    expect(host.textContent ?? '').toContain('Keys are shown for macOS, as you have them bound.')
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
