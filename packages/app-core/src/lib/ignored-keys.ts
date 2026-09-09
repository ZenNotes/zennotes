/**
 * Keys the app never sees (#732). Keyboard remappers with tap-hold layers
 * (Kanata, QMK, ZMK) often emit a harmless extra key with every keystroke,
 * on Linux typically the Katakana/Hiragana key, which Chromium reports as
 * `KanaMode`. Editors that map only the keys they know ignore it; here every
 * stray keydown reset a pending sequence (`jk` to leave insert mode, `dd`,
 * a leader chord, hint mode). The user lists such keys once, and a single
 * window-level capture guard swallows them before the editor, the panels
 * or any shortcut handler can react, which is what "ignore" has to mean when
 * the listeners live on a dozen elements.
 */

export const MAX_IGNORED_KEYS = 24
export const MAX_IGNORED_KEY_LENGTH = 40

/** Validate an untrusted list (config.toml, localStorage): trimmed, unique
 *  ignoring case, capped. */
export function normalizeIgnoredKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const token = entry.trim().slice(0, MAX_IGNORED_KEY_LENGTH)
    if (!token || seen.has(token.toLowerCase())) continue
    seen.add(token.toLowerCase())
    out.push(token)
    if (out.length >= MAX_IGNORED_KEYS) break
  }
  return out
}

/**
 * The name a user records for a key: its DOM `key` when it names the key
 * (`KanaMode`, `F24`, `Lang1`), else its physical `code`, so a key the
 * layout reports as Unidentified can still be listed by position.
 */
export function ignoredKeyTokenFromEvent(event: KeyboardEvent): string {
  const key = (event.key ?? '').trim()
  if (key && key !== 'Unidentified' && key !== 'Dead' && key !== 'Process') return key
  return (event.code ?? '').trim()
}

/** True when the event's `key` or `code` is on the list (case-insensitive). */
export function isIgnoredKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  ignored: readonly string[]
): boolean {
  if (ignored.length === 0) return false
  const key = (event.key ?? '').toLowerCase()
  const code = (event.code ?? '').toLowerCase()
  for (const entry of ignored) {
    const wanted = entry.toLowerCase()
    if (wanted && (wanted === key || wanted === code)) return true
  }
  return false
}

// While the Settings recorder waits for the key to add, the guard stands
// aside: the whole point of that moment is to see the key.
let recorderActive = false

export function setIgnoredKeysRecorderActive(active: boolean): void {
  recorderActive = active
}

let installed: (() => void) | null = null

/**
 * Install the guard once on `window` in the capture phase, so it runs before
 * any element listener (CodeMirror's, VimNav's, the panels'). Both keydown
 * and keyup are swallowed: a handler that tracks a held key must not see
 * half of the pair. Returns the uninstaller; a second call is a no-op.
 */
export function installIgnoredKeysGuard(getIgnored: () => readonly string[]): () => void {
  if (installed) return installed
  if (typeof window === 'undefined') return () => {}
  const guard = (event: KeyboardEvent): void => {
    if (recorderActive) return
    if (!isIgnoredKeyEvent(event, getIgnored())) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  window.addEventListener('keydown', guard, true)
  window.addEventListener('keyup', guard, true)
  window.addEventListener('keypress', guard, true)
  installed = () => {
    window.removeEventListener('keydown', guard, true)
    window.removeEventListener('keyup', guard, true)
    window.removeEventListener('keypress', guard, true)
    installed = null
  }
  return installed
}
