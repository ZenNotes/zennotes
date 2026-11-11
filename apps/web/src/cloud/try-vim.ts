/**
 * Try mode starts with Vim mode off (Adib, 2026-11-11): most people trying
 * ZenNotes in a browser have never used Vim keys. The app's own default (on)
 * and a Cloud vault's are unchanged.
 *
 * Preferences are one per browser (`zen:prefs:v2`), so Try writes its default
 * only when nothing was chosen yet and leaves a mark saying so. A Cloud vault
 * opened later in the same browser removes that default again, unless the
 * person changed Vim mode in between, which makes it their own choice.
 */
const PREFS_KEY = 'zen:prefs:v2'
export const TRY_VIM_DEFAULT_KEY = 'zn-browser:try-vim-default'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function readPrefs(storage: StorageLike): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** True when it set Vim mode off. */
export function applyTryVimDefault(storage: StorageLike = localStorage): boolean {
  try {
    const prefs = readPrefs(storage)
    if (typeof prefs?.vimMode === 'boolean') return false
    // A first visit keeps its onboarding: preferences that exist without
    // hasCompletedOnboarding read as a returning visitor's.
    const next = { ...(prefs ?? { hasCompletedOnboarding: false }), vimMode: false }
    storage.setItem(PREFS_KEY, JSON.stringify(next))
    storage.setItem(TRY_VIM_DEFAULT_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** A Cloud vault: true when it gave the app its own default back. */
export function dropTryVimDefault(storage: StorageLike = localStorage): boolean {
  try {
    if (storage.getItem(TRY_VIM_DEFAULT_KEY) !== '1') return false
    const prefs = readPrefs(storage)
    if (prefs?.vimMode !== false) {
      storage.removeItem(TRY_VIM_DEFAULT_KEY)
      return false
    }
    const { vimMode: _default, ...rest } = prefs
    void _default
    storage.setItem(PREFS_KEY, JSON.stringify(rest))
    storage.removeItem(TRY_VIM_DEFAULT_KEY)
    return true
  } catch {
    return false
  }
}

/** The person changed Vim mode in Try: from now on it is their choice. */
export function vimModeChosenInTry(storage: StorageLike = localStorage): void {
  try {
    storage.removeItem(TRY_VIM_DEFAULT_KEY)
  } catch {
    // Blocked storage keeps nothing either way.
  }
}
