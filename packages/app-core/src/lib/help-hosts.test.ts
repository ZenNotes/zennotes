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
  beforeEach(() => {
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        platformSync: () => 'darwin',
        getAppInfo: () => ({ runtime: 'web', hostKind: 'ios' }),
        getCapabilities: () => ({ supportsWorkflows: false })
      }
    })
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

  it('renders without the desktop topics, and keeps no link to an empty section', async () => {
    const { HelpView } = await import('../components/HelpView')
    await act(async () => root.render(createElement(HelpView)))
    const rendered = host.textContent ?? ''
    expect(rendered).toContain('Pick a vault you control')
    expect(rendered).not.toContain('Bring your Notion workspace over')
    expect(rendered).not.toContain('Preview a note in Finder')
    expect(rendered).not.toContain('What the CLI is for')
    expect(host.querySelector('#help-cli')).toBeNull()
  })
})
