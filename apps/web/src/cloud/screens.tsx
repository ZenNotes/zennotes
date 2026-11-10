/**
 * The screens the browser host shows instead of the app: no private storage
 * in this window, the vault open in another tab, and a boot that failed.
 * Built from app-core's Button and design tokens, keyboard first: the main
 * action has focus, Enter takes it, and with Vim mode on its letter does too
 * (with Vim mode off no single letter acts, the app-wide rule).
 */
import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Button } from '@renderer/components/ui/Button'
import { DEFAULT_THEME_ID, findTheme, resolveAuto, THEMES, type ThemeFamily } from '@renderer/lib/themes'

const PREFS_KEY = 'zen:prefs:v2'

function readPrefs(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The theme the app would show (app-core's App.tsx applies it once it
 *  runs), so a screen before the app is not a flash of the light default.
 *  Built-in themes only: a custom theme's CSS loads with the app. */
export function applySavedTheme(): void {
  const prefs = readPrefs()
  const savedId = typeof prefs.themeId === 'string' ? prefs.themeId : DEFAULT_THEME_ID
  const themeId = THEMES.some((theme) => theme.id === savedId) ? savedId : DEFAULT_THEME_ID
  const family = (typeof prefs.themeFamily === 'string' ? prefs.themeFamily : findTheme(themeId).family) as ThemeFamily
  const id =
    prefs.themeMode === 'auto'
      ? resolveAuto(family, window.matchMedia('(prefers-color-scheme: dark)').matches, themeId)
      : themeId
  document.documentElement.dataset.theme = id
  document.documentElement.dataset.themeMode = findTheme(id).mode
}

/** The app's own Vim setting, read before the app runs (on by default). */
export function vimModeFromPrefs(): boolean {
  const vimMode = readPrefs().vimMode
  return typeof vimMode === 'boolean' ? vimMode : true
}

export function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <main className="flex h-full items-center justify-center bg-paper-100 p-6 text-ink-900">
      <section
        role="dialog"
        aria-labelledby="zn-host-screen-title"
        className="w-full max-w-md rounded-xl border border-paper-300 bg-paper-50 p-6 shadow-sm"
      >
        <h1 id="zn-host-screen-title" className="text-lg font-semibold text-ink-900">
          {title}
        </h1>
        {children}
      </section>
    </main>
  )
}

export function useLetterKey(letter: string, action: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (event.key === letter) {
        event.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [letter, action, enabled])
}

function NoStorageScreen({ reason }: { reason: 'firefox-private' | 'unsupported' }): JSX.Element {
  return (
    <Card title={reason === 'firefox-private' ? 'Open ZenNotes in a normal window' : 'This browser cannot keep your notes'}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        {reason === 'firefox-private'
          ? 'Firefox private windows have no storage for files, so notes written here would vanish. Open this page in a normal Firefox window to try ZenNotes.'
          : 'ZenNotes keeps your notes in the browser’s private file storage, which this browser does not offer. Try a current version of Chrome, Edge, Firefox or Safari.'}
      </p>
      <p className="mt-4 text-sm leading-relaxed text-ink-600">
        Or get the app for your computer or phone at{' '}
        <a className="font-medium text-accent underline" href="https://zennotes.org/#download">
          zennotes.org
        </a>
        .
      </p>
    </Card>
  )
}

function VaultTakenScreen({
  movedAway,
  onUseHere
}: {
  movedAway: boolean
  onUseHere: () => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const vim = vimModeFromPrefs()
  useEffect(() => {
    button.current?.focus()
  }, [])
  const useHere = React.useCallback(() => {
    if (busy) return
    setBusy(true)
    setError(null)
    void onUseHere().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [busy, onUseHere])
  useLetterKey('u', useHere, vim)
  return (
    <Card title={movedAway ? 'ZenNotes moved to another tab' : 'ZenNotes is open in another tab'}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        One tab edits this vault at a time, so two tabs never save over each other. Use it here to move
        it to this tab; the other tab saves first.
      </p>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" disabled={busy} onClick={useHere}>
          {busy ? 'Moving here…' : 'Use here'}
        </Button>
        {vim ? <span className="text-xs text-ink-500">or press u</span> : null}
      </div>
    </Card>
  )
}

function BootErrorScreen({ message }: { message: string }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
  }, [])
  return (
    <Card title="ZenNotes could not open">
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-600">{message}</p>
      <div className="mt-5">
        <Button ref={button} variant="primary" size="md" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </Card>
  )
}

let screenRoot: ReactDOM.Root | null = null

export function show(root: HTMLElement, element: JSX.Element): void {
  applySavedTheme()
  screenRoot ??= ReactDOM.createRoot(root)
  screenRoot.render(<React.StrictMode>{element}</React.StrictMode>)
}

/** Unmounts whatever screen is up, so the app can render into the root. */
export function clearScreen(): void {
  screenRoot?.unmount()
  screenRoot = null
}

export function showNoStorage(root: HTMLElement, reason: 'firefox-private' | 'unsupported'): void {
  show(root, <NoStorageScreen reason={reason} />)
}

export function showVaultTaken(root: HTMLElement, movedAway: boolean, onUseHere: () => Promise<void>): void {
  show(root, <VaultTakenScreen movedAway={movedAway} onUseHere={onUseHere} />)
}

export function showBootError(root: HTMLElement, message: string): void {
  show(root, <BootErrorScreen message={message} />)
}
