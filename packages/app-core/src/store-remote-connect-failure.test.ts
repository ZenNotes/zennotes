// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'

// A Connect to Remote Vault that the server turns down (#1106). The failure
// used to go to window.alert, and on Windows a native alert hands the window
// back without keyboard focus: the next try's URL field took no typing until
// the app restarted. It also opened on localhost again, so the address had
// to be typed twice.

const REJECTED =
  "Error invoking remote method 'workspace:connect-remote': Error: The ZenNotes server rejected the connection. Check the auth token for https://notes.example.com and try again."

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop', version: 'test' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: true,
        supportsRemoteHeaders: true,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      connectRemoteWorkspace: vi.fn().mockRejectedValue(new Error(REJECTED)),
      disconnectRemoteWorkspace: vi.fn().mockResolvedValue(null),
      ...overrides
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  const { useStore } = await import('./store')
  const prompts = await import('./lib/prompt-requests')
  const auth = await import('./lib/remote-auth-requests')
  const confirms = await import('./lib/confirm-requests')
  useStore.setState({
    vault: { root: '/Users/me/notes', name: 'notes' },
    workspaceMode: 'local',
    vaultSettings: DEFAULT_VAULT_SETTINGS,
    remoteWorkspaceProfiles: []
  } as never)
  const until = async <T>(read: () => T | null): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('the request never came')
  }
  /** Answers the URL step and returns the address it opened on. */
  const answerUrl = async (value: string | null): Promise<string | undefined> => {
    const request = await until(prompts.getPromptRequest)
    const opened = request.options.initialValue
    prompts.settlePromptRequest(request, value)
    return opened
  }
  const answerAuth = async (): Promise<void> => {
    const request = await until(auth.getRemoteAuthRequest)
    auth.settleRemoteAuthRequest(request, {
      authToken: '',
      headers: [
        { name: 'CF-Access-Client-Id', value: 'abc.access' },
        { name: 'CF-Access-Client-Secret', value: 's3cret' }
      ]
    })
  }
  return { useStore, until, answerUrl, answerAuth, confirms }
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})

describe('Connect to Remote Vault when the server says no (#1106)', () => {
  it("tells the user in the app's own dialog, never window.alert, in the server's words", async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { useStore, until, answerUrl, answerAuth, confirms } = await load()

    const run = useStore.getState().connectRemoteWorkspace()
    await answerUrl('https://notes.example.com')
    await answerAuth()
    const notice = await until(confirms.getConfirmRequest)

    expect(notice.options.notice).toBe(true)
    expect(notice.options.title).toBe("Couldn't connect to the server")
    expect(notice.options.description).toBe(
      'The ZenNotes server rejected the connection. Check the auth token for https://notes.example.com and try again.'
    )
    confirms.settleConfirmRequest(notice, true)
    await run
    expect(alert).not.toHaveBeenCalled()
  })

  it('opens the next try on the address that failed, not on localhost', async () => {
    const { useStore, until, answerUrl, answerAuth, confirms } = await load()

    const first = useStore.getState().connectRemoteWorkspace()
    expect(await answerUrl('https://notes.example.com/')).toBe('http://localhost:7878')
    await answerAuth()
    confirms.settleConfirmRequest(await until(confirms.getConfirmRequest), true)
    await first

    const second = useStore.getState().connectRemoteWorkspace()
    expect(await answerUrl(null)).toBe('https://notes.example.com')
    await second
  })

  it('keeps a cancelled try too, since the address was typed', async () => {
    const { useStore, answerUrl, until } = await load()
    const auth = await import('./lib/remote-auth-requests')

    const first = useStore.getState().connectRemoteWorkspace()
    await answerUrl('https://notes.example.com')
    auth.settleRemoteAuthRequest(await until(auth.getRemoteAuthRequest), null)
    await first

    const second = useStore.getState().connectRemoteWorkspace()
    expect(await answerUrl(null)).toBe('https://notes.example.com')
    await second
  })

  it('goes back to the current remote once a server has taken the details', async () => {
    installZen({
      // Connected, then no vault on a server that cannot pick one: main is
      // on the new server now, which is what the next try should offer.
      connectRemoteWorkspace: vi.fn().mockResolvedValue({
        vault: null,
        capabilities: { supportsVaultSelection: false }
      }),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue({ mode: 'remote', baseUrl: 'https://current.example.com' })
    })
    const { useStore, until, answerUrl, answerAuth, confirms } = await load()

    const first = useStore.getState().connectRemoteWorkspace()
    await answerUrl('https://notes.example.com')
    await answerAuth()
    const notice = await until(confirms.getConfirmRequest)
    expect(notice.options.description).toBe('Connected to the server, but no vault folder is selected there yet.')
    confirms.settleConfirmRequest(notice, true)
    await first

    const second = useStore.getState().connectRemoteWorkspace()
    expect(await answerUrl(null)).toBe('https://current.example.com')
    await second
  })
})
