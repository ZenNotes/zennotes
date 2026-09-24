import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarperVaultState } from '@shared/harper-settings'

/**
 * The runtime's glue is exercised against an in-memory stand-in for the
 * Harper session, so these tests run in milliseconds and can hold the
 * "compile" open for as long as the scenario needs. The real session is
 * covered by harper-lint.test.ts.
 */
const harper = vi.hoisted(() => {
  const words = new Set<string>()
  const ignored = new Set<string>()
  let release: (() => void) | null = null
  let loading: Promise<void> | null = null
  const fakeSession = {
    lint: vi.fn(async () => []),
    addWord: vi.fn(async (word: string) => {
      words.add(word)
    }),
    ignore: vi.fn(async () => undefined),
    exportState: vi.fn(
      async (): Promise<HarperVaultState> => ({ words: [...words], ignoredLints: [...ignored] })
    ),
    configure: vi.fn(async () => undefined),
    importState: vi.fn(async (state: HarperVaultState) => {
      words.clear()
      ignored.clear()
      for (const word of state.words) words.add(word)
      for (const hash of state.ignoredLints) ignored.add(hash)
    })
  }
  return {
    session: fakeSession,
    words: () => [...words],
    ignored: () => [...ignored],
    /** The linter underneath dropped everything, as a rebuilt one does. */
    forget: () => {
      words.clear()
      ignored.clear()
    },
    /** Let the pending `loadHarper` resolve. */
    release: () => release?.(),
    reset: () => {
      words.clear()
      ignored.clear()
      release = null
      loading = null
      for (const fn of Object.values(fakeSession)) fn.mockClear()
    },
    loadHarper: vi.fn((options: { state: HarperVaultState }) => {
      if (!loading) {
        // Built from the first caller's options, like the real one, and held
        // open until the test releases it, like a 15 MB compile.
        for (const word of options.state.words) words.add(word)
        for (const hash of options.state.ignoredLints) ignored.add(hash)
        loading = new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return loading.then(() => fakeSession)
    }),
    harperLoaded: () => loading !== null,
    disposeHarper: vi.fn(() => {
      loading = null
    })
  }
})

const store = vi.hoisted(() => {
  const state = {
    harperEnabled: true,
    harperDialect: 'american',
    harperLintConfig: {},
    vaultSettings: { harper: undefined as HarperVaultState | undefined },
    saveHarperVaultState: vi.fn(async (next: HarperVaultState) => {
      state.vaultSettings = { harper: next }
    })
  }
  return { state }
})

vi.mock('../store', () => ({
  useStore: { getState: () => store.state, subscribe: vi.fn(() => () => undefined) }
}))

vi.mock('./harper-lint', () => ({
  loadHarper: harper.loadHarper,
  harperLoaded: harper.harperLoaded,
  disposeHarper: harper.disposeHarper
}))

const VAULT: HarperVaultState = { words: ['Zennotez', 'Flurbish'], ignoredLints: ['12'] }

async function runtime(): Promise<typeof import('./harper-runtime')> {
  // `applied` and `seenVaultState` are module state; every test starts fresh.
  vi.resetModules()
  return import('./harper-runtime')
}

describe('Harper runtime (#829)', () => {
  beforeEach(() => {
    harper.reset()
    store.state.harperEnabled = true
    store.state.harperDialect = 'american'
    store.state.harperLintConfig = {}
    store.state.vaultSettings = { harper: undefined }
    store.state.saveHarperVaultState.mockClear()
    vi.stubGlobal('window', { zen: { getCapabilities: () => ({ supportsHarper: true }) } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('imports the words the vault loads while the session is still compiling', async () => {
    const { harperEditorConfig } = await runtime()
    const config = harperEditorConfig()
    // The warm-up runs before `store.init()` has read vault.json, so the
    // session is built from empty settings.
    const pending = config.session()
    expect(harper.loadHarper).toHaveBeenCalledWith(
      expect.objectContaining({ state: { words: [], ignoredLints: [] } })
    )
    // The vault lands while the compile is in flight.
    store.state.vaultSettings = { harper: VAULT }
    harper.release()
    expect(await pending).not.toBeNull()

    expect(harper.words()).toEqual(VAULT.words)
    expect(harper.ignored()).toEqual(VAULT.ignoredLints)
    // A `zg` on a third word writes all three, not the one the session knew.
    await config.addWord('Glorpish')
    expect(store.state.saveHarperVaultState).toHaveBeenLastCalledWith({
      words: ['Zennotez', 'Flurbish', 'Glorpish'],
      ignoredLints: ['12']
    })
  })

  it('never writes a shorter list than the vault holds, and teaches the session the difference', async () => {
    store.state.vaultSettings = { harper: VAULT }
    const { harperEditorConfig } = await runtime()
    const config = harperEditorConfig()
    const pending = config.session()
    harper.release()
    expect(await pending).not.toBeNull()
    expect(harper.words()).toEqual(VAULT.words)

    harper.forget()
    await config.addWord('Glorpish')
    expect(store.state.saveHarperVaultState).toHaveBeenLastCalledWith({
      words: ['Zennotez', 'Flurbish', 'Glorpish'],
      ignoredLints: ['12']
    })
    expect(harper.words()).toEqual(['Zennotez', 'Flurbish', 'Glorpish'])
    expect(harper.ignored()).toEqual(['12'])
  })

  it('imports a change from outside once, and never the echo of its own write', async () => {
    store.state.vaultSettings = { harper: VAULT }
    const { harperEditorConfig, harperSeenVaultState } = await runtime()
    const config = harperEditorConfig()
    const pending = config.session()
    harper.release()
    await pending
    // Built from the vault's state: nothing to import on the first pass, or
    // on any later pass while the store stands still.
    expect(harper.session.importState).not.toHaveBeenCalled()
    await config.session()
    expect(harper.session.importState).not.toHaveBeenCalled()

    await config.addWord('Glorpish')
    expect(harperSeenVaultState()).toBe(JSON.stringify(store.state.vaultSettings.harper))
    await config.session()
    expect(harper.session.importState).not.toHaveBeenCalled()

    // Another window (or device) added a word: the store moves, and the
    // session follows.
    const outside: HarperVaultState = {
      words: ['Zennotez', 'Flurbish', 'Glorpish', 'Kanata'],
      ignoredLints: ['12', '9722060015410969502']
    }
    store.state.vaultSettings = { harper: outside }
    await config.session()
    expect(harper.session.importState).toHaveBeenCalledTimes(1)
    expect(harper.session.importState).toHaveBeenCalledWith(outside)
    expect(harper.words()).toEqual(outside.words)
    await config.session()
    expect(harper.session.importState).toHaveBeenCalledTimes(1)
  })

  it('starts over cleanly when the load fails', async () => {
    store.state.vaultSettings = { harper: VAULT }
    const { harperEditorConfig, harperSeenVaultState } = await runtime()
    const config = harperEditorConfig()
    harper.loadHarper.mockRejectedValueOnce(new Error('wasm refused'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await config.session()).toBeNull()
    error.mockRestore()
    expect(harperSeenVaultState()).toBeNull()

    const pending = config.session()
    harper.release()
    expect(await pending).not.toBeNull()
    expect(harper.words()).toEqual(VAULT.words)
  })
})
