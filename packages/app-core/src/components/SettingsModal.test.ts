// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'

const mocks = vi.hoisted(() => {
  const state = new Proxy(
    {
      autoCalendarPanel: true,
      calendarShowWeekNumbers: true,
      calendarWeekStart: 'monday',
      customTemplates: [],
      darkSidebar: false,
      editorFontSize: 16,
      editorLineHeight: 1.6,
      fzfBinaryPath: null,
      hideBuiltinTemplates: false,
      interfaceFont: null,
      keymapOverrides: {},
      lineNumberMode: 'off',
      monoFont: null,
      previewMaxWidth: 760,
      quickNoteTitlePrefix: null,
      remoteWorkspaceInfo: null,
      remoteWorkspaceProfiles: [],
      ripgrepBinaryPath: null,
      setSettingsOpen: vi.fn(),
      setVaultSettings: vi.fn(),
      showSidebarChevrons: true,
      systemFolderLabels: {},
      textFont: null,
      themeFamily: 'apple',
      themeId: 'apple-light',
      themeMode: 'light',
      vault: { root: '/tmp/zennotes-test-vault', name: 'Test Vault' },
      vaultSettings: {
        primaryNotesLocation: 'inbox',
        dailyNotes: { enabled: true, directory: 'Daily Not' },
        weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
        folderIcons: {}
      },
      vaultTextSearchBackend: 'auto',
      vimInsertEscape: '',
      vimMode: false,
      whichKeyHintMode: 'timed',
      whichKeyHintTimeoutMs: 1200,
      whichKeyHints: true,
      workspaceMode: 'local'
    },
    {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target]
        return vi.fn()
      }
    }
  )

  return {
    state,
    setSettingsOpen: state.setSettingsOpen,
    setVaultSettings: state.setVaultSettings
  }
})

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('../lib/system-fonts', () => ({
  hasSystemFontAccess: () => false,
  listSystemFonts: vi.fn().mockResolvedValue([])
}))

vi.mock('../lib/app-update-state', () => ({
  useAppUpdateState: () => ({ phase: 'idle', message: 'Manual check' })
}))

vi.mock('@zennotes/bridge-contract/bridge', () => ({
  getZenBridge: () => ({
    getAppInfo: () => ({
      runtime: 'desktop',
      version: '2.4.0',
      description: 'ZenNotes',
      homepage: 'https://github.com/ZenNotes/zennotes/releases/latest'
    }),
    getCapabilities: () => ({
      supportsCustomTemplates: true,
      supportsRemoteWorkspace: false
    })
  })
}))

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function blurInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

describe('SettingsModal date note directories', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        getVaultTextSearchCapabilities: vi.fn().mockResolvedValue({ ripgrep: false, fzf: false }),
        checkForAppUpdates: vi.fn().mockResolvedValue({ phase: 'idle', message: 'Manual check' })
      }
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('does not restore the default daily directory while the field is being cleared', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const search = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.placeholder === 'Search settings…'
    )
    expect(search).toBeTruthy()

    await act(async () => {
      changeInput(search!, 'daily notes directory')
    })

    const dailyDirectory = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.value === 'Daily Not'
    )
    expect(dailyDirectory).toBeTruthy()

    await act(async () => {
      changeInput(dailyDirectory!, '')
    })

    expect(mocks.setVaultSettings).not.toHaveBeenCalled()
  })

  it('saves the daily directory when the edit is committed', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const search = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.placeholder === 'Search settings…'
    )
    expect(search).toBeTruthy()

    await act(async () => {
      changeInput(search!, 'daily notes directory')
    })

    const dailyDirectory = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.value === 'Daily Not'
    )
    expect(dailyDirectory).toBeTruthy()

    await act(async () => {
      changeInput(dailyDirectory!, 'inbox/Journal')
    })

    expect(mocks.setVaultSettings).not.toHaveBeenCalled()

    await act(async () => {
      blurInput(dailyDirectory!)
    })

    expect(mocks.setVaultSettings).toHaveBeenCalledWith({
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: true, directory: 'inbox/Journal' },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {}
    })
  })
})
