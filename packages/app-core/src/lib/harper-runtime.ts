/**
 * Glue between the store and the Harper session: which dialect and rules to
 * use, where the vault's dictionary lives, when to load and when to let go.
 *
 * The editor extension only ever asks `harperEditorConfig()` for a session.
 * That call loads Harper on first use, then reconciles the live session with
 * the store (dialect, rule overrides, the vault's words and ignored
 * suggestions) whenever they drifted, so it does not matter which changed
 * first. Turning the setting off disposes the worker; turning it on again
 * starts from scratch, and an enabled setting warms the session at idle after
 * boot so the first note does not wait for a 15 MB compile.
 */
import { EMPTY_HARPER_VAULT_STATE, type HarperVaultState } from '@shared/harper-settings'
import { useStore } from '../store'
import type { HarperEditorConfig } from './cm-harper'
import { disposeHarper, loadHarper, type HarperLint, type HarperSession } from './harper-lint'

interface Applied {
  dialect: string
  lintConfig: string
}

let applied: Applied | null = null
/** The store's vault state as of the last import or our own last write. A
 *  store value equal to this is either already in the session or an echo of
 *  what the session exported, so it is never imported again; anything else
 *  came from outside (a vault switch, Cloud sync, another device) and is. */
let seenVaultState: string | null = null
let reconciling: Promise<void> | null = null

/** Whether this host ships Harper. The setting, commands and editor
 *  extension all stand down when it does not, so a shared-source bump never
 *  shows a phone a checker it cannot run. */
export function harperSupported(): boolean {
  try {
    return window.zen.getCapabilities().supportsHarper === true
  } catch {
    return false
  }
}

function currentVaultState(): HarperVaultState {
  return useStore.getState().vaultSettings.harper ?? EMPTY_HARPER_VAULT_STATE
}

/** JSON of the vault state the session already reflects; EditorPane uses it
 *  to tell an outside change (worth a re-lint) from the echo of a `zg`. */
export function harperSeenVaultState(): string | null {
  return seenVaultState
}

async function session(): Promise<HarperSession | null> {
  const state = useStore.getState()
  if (!state.harperEnabled || !harperSupported()) return null
  let loaded: HarperSession
  try {
    loaded = await loadHarper({
      dialect: state.harperDialect,
      lintConfig: state.harperLintConfig,
      state: currentVaultState()
    })
  } catch (error) {
    console.error('[zen:harper] failed to load Harper', error)
    return null
  }
  await reconcile(loaded)
  return loaded
}

/** Bring the session in line with the store. Serialized so two callers never
 *  race their `configure` and `importState` calls against each other. */
async function reconcile(loaded: HarperSession): Promise<void> {
  if (reconciling) await reconciling
  const state = useStore.getState()
  const next: Applied = { dialect: state.harperDialect, lintConfig: JSON.stringify(state.harperLintConfig) }
  const vaultState = currentVaultState()
  const vaultJson = JSON.stringify(vaultState)
  const configChanged = !applied || applied.dialect !== next.dialect || applied.lintConfig !== next.lintConfig
  const vaultChanged = seenVaultState === null || seenVaultState !== vaultJson
  if (!configChanged && !vaultChanged) return
  reconciling = (async () => {
    if (configChanged) {
      await loaded.configure({ dialect: state.harperDialect, lintConfig: state.harperLintConfig })
      applied = next
    }
    if (vaultChanged) {
      // The session was created from the store's state, so the very first
      // pass only records what it already holds.
      if (seenVaultState !== null) await loaded.importState(vaultState)
      seenVaultState = vaultJson
    }
  })()
  try {
    await reconciling
  } finally {
    reconciling = null
  }
}

async function persist(loaded: HarperSession): Promise<void> {
  const next = await loaded.exportState()
  await useStore.getState().saveHarperVaultState(next)
  // Whatever the store now holds is what the session just exported.
  seenVaultState = JSON.stringify(currentVaultState())
}

export function harperEditorConfig(): HarperEditorConfig {
  return {
    session,
    addWord: async (word: string) => {
      const loaded = await session()
      if (!loaded) return
      await loaded.addWord(word)
      await persist(loaded)
    },
    ignore: async (text: string, lint: HarperLint) => {
      const loaded = await session()
      if (!loaded) return
      await loaded.ignore(text, lint)
      await persist(loaded)
    }
  }
}

/**
 * Watch the setting for the app's lifetime: dispose the worker when Harper is
 * turned off, and warm it at idle when it is on at boot. Returns the cleanup.
 */
export function installHarperRuntime(): () => void {
  if (!harperSupported()) return () => undefined
  let warmupTimer: number | null = null
  let idleId: number | null = null
  const cancelWarmup = (): void => {
    if (warmupTimer !== null) window.clearTimeout(warmupTimer)
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId)
    }
    warmupTimer = null
    idleId = null
  }
  const warmup = (): void => {
    cancelWarmup()
    warmupTimer = window.setTimeout(() => {
      warmupTimer = null
      const run = (): void => {
        idleId = null
        void session()
      }
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(run, { timeout: 2_000 })
      } else {
        run()
      }
    }, 1_500)
  }

  if (useStore.getState().harperEnabled) warmup()
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.harperEnabled === previous.harperEnabled) return
    if (state.harperEnabled) {
      warmup()
    } else {
      cancelWarmup()
      applied = null
      seenVaultState = null
      disposeHarper()
    }
  })
  return () => {
    cancelWarmup()
    unsubscribe()
  }
}
