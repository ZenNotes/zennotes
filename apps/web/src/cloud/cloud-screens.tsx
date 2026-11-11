/**
 * The screens ZenNotes in the browser shows around ZenNotes Cloud, before the
 * app has a vault to open: sign in, finishing a sign-in, choosing a Cloud
 * vault, a browser that was removed from the account, and switching
 * accounts. Same rules as screens.tsx: app-core's Button and design tokens,
 * the main action focused, Enter takes it, and with Vim mode on a letter
 * does too (never with Vim mode off).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Button } from '@renderer/components/ui/Button'
import type { CloudEncryptionSecretInput } from '@zennotes/bridge-contract/cloud-sync'
import { CLOUD_BROWSER_UNLOCK_NOTICE } from '@zennotes/shared-domain/cloud-e2ee-passphrase'
import { applySavedTheme, Card, show, useLetterKey, vimModeFromPrefs } from './screens'
import { WEB_NOT_AVAILABLE_TITLE } from './cloud-account'

function useAction(run: () => Promise<void>): { busy: boolean; error: string | null; act: () => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(() => {
    if (busy) return
    setBusy(true)
    setError(null)
    void run().then(
      () => setBusy(false),
      (cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
  }, [busy, run])
  return { busy, error, act }
}

function ErrorLine({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null
  return (
    <p role="alert" className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-danger">
      {message}
    </p>
  )
}

function KeyHint({ children }: { children: React.ReactNode }): JSX.Element | null {
  return vimModeFromPrefs() ? <span className="text-xs text-ink-500">{children}</span> : null
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/** Signs in; true asks for a shared computer's sign-in. */
export type SignIn = (shared: boolean) => Promise<void>

/** The box's state, with `c` toggling it while Vim mode is on. */
function useSharedChoice(initial: boolean): { shared: boolean; toggle: () => void; set: (on: boolean) => void } {
  const [shared, set] = useState(initial)
  const toggle = useCallback(() => set((current) => !current), [])
  useLetterKey('c', toggle, vimModeFromPrefs())
  return { shared, toggle, set }
}

function SharedComputerOption({ shared, onChange }: { shared: boolean; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <label className="mt-4 flex items-start gap-2 text-sm text-ink-800" htmlFor="zn-shared-computer">
      <input
        id="zn-shared-computer"
        type="checkbox"
        checked={shared}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4"
      />
      <span>
        This is a shared computer
        {shared ? (
          <span data-shared-computer-promise="" className="block text-xs leading-5 text-ink-500">
            Signing out removes your notes from this browser. If you close the window instead, they are removed the
            next time ZenNotes opens here, and the sign-in ends within 12 hours.
          </span>
        ) : null}
      </span>
    </label>
  )
}

function SignInScreen({
  message,
  onSignIn,
  initialShared
}: {
  message: string | null
  onSignIn: SignIn
  initialShared: boolean
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const choice = useSharedChoice(initialShared)
  const { busy, error, act } = useAction(useCallback(() => onSignIn(choice.shared), [onSignIn, choice.shared]))
  const vim = vimModeFromPrefs()
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('s', act, vim)
  useLetterKey('t', () => location.assign('/try'), vim)
  return (
    <Card title="Open your notes from ZenNotes Cloud">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        Sign in to open your ZenNotes Cloud vaults here. This browser becomes one of your devices, and you can
        remove it from your account on zennotes.org at any time.
      </p>
      {message ? <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{message}</p> : null}
      <SharedComputerOption shared={choice.shared} onChange={choice.set} />
      <ErrorLine message={error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button ref={button} variant="primary" size="md" disabled={busy} onClick={act}>
          {busy ? 'Opening zennotes.org…' : 'Sign in to ZenNotes Cloud'}
        </Button>
        <Button variant="ghost" size="md" onClick={() => location.assign('/try')}>
          Try it without an account
        </Button>
      </div>
      <div className="mt-3">
        <KeyHint>s signs in, t opens Try mode, c ticks the box</KeyHint>
      </div>
    </Card>
  )
}

export function showSignIn(root: HTMLElement, onSignIn: SignIn, message: string | null = null, initialShared = false): void {
  show(root, <SignInScreen message={message} onSignIn={onSignIn} initialShared={initialShared} />)
}

function SigningInScreen(): JSX.Element {
  return (
    <Card title="Signing you in…">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">ZenNotes is finishing the sign-in with ZenNotes Cloud.</p>
    </Card>
  )
}

export function showSigningIn(root: HTMLElement): void {
  show(root, <SigningInScreen />)
}

function SignInFailedScreen({
  message,
  onRetry,
  initialShared
}: {
  message: string
  onRetry: SignIn
  initialShared: boolean
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const choice = useSharedChoice(initialShared)
  const { busy, error, act } = useAction(useCallback(() => onRetry(choice.shared), [onRetry, choice.shared]))
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('s', act, vimModeFromPrefs())
  return (
    <Card title="The sign-in did not finish">
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-600">{message}</p>
      <SharedComputerOption shared={choice.shared} onChange={choice.set} />
      <ErrorLine message={error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button ref={button} variant="primary" size="md" disabled={busy} onClick={act}>
          {busy ? 'Opening zennotes.org…' : 'Sign in again'}
        </Button>
        <KeyHint>or press s</KeyHint>
      </div>
    </Card>
  )
}

export function showSignInFailed(root: HTMLElement, message: string, onRetry: SignIn, initialShared = false): void {
  show(root, <SignInFailedScreen message={message} onRetry={onRetry} initialShared={initialShared} />)
}

function SignedInElsewhereScreen(): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('c', () => location.assign('/'), vimModeFromPrefs())
  return (
    <Card title="You signed in in another tab">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        The sign-in finished in the tab the email link opened. You can close this one, or continue here.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" onClick={() => location.assign('/')}>
          Continue here
        </Button>
        <KeyHint>or press c</KeyHint>
      </div>
    </Card>
  )
}

export function showSignedInElsewhere(root: HTMLElement): void {
  show(root, <SignedInElsewhereScreen />)
}

// ---------------------------------------------------------------------------
// Choosing a Cloud vault
// ---------------------------------------------------------------------------

export interface PickableCloudVault {
  id: string
  name: string
  encrypted: boolean
  /** Encrypted and this browser holds no key: the name is a placeholder. */
  locked: boolean
  /** Already in this browser. */
  here: boolean
}

function VaultPickerScreen({
  email,
  load,
  onOpen,
  onCreate,
  onSignOut
}: {
  email: string
  load: () => Promise<PickableCloudVault[]>
  onOpen: (vault: PickableCloudVault) => Promise<void>
  onCreate: (name: string) => Promise<void>
  onSignOut: () => Promise<void>
}): JSX.Element {
  const [vaults, setVaults] = useState<PickableCloudVault[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('My Notes')
  const [cursor, setCursor] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const vim = vimModeFromPrefs()

  useEffect(() => {
    let live = true
    load().then(
      (found) => {
        if (!live) return
        setVaults(found)
        setCursor(0)
      },
      (cause: unknown) => live && setLoadError(cause instanceof Error ? cause.message : String(cause))
    )
    return () => {
      live = false
    }
  }, [load])

  useEffect(() => {
    const button = list.current?.querySelectorAll<HTMLButtonElement>('button[data-cloud-vault-id]')[cursor]
    button?.focus()
  }, [cursor, vaults])

  const run = (label: string, action: () => Promise<void>): void => {
    if (busy) return
    setBusy(label)
    setError(null)
    void action().then(
      () => setBusy(null),
      (cause: unknown) => {
        setBusy(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
  }

  useEffect(() => {
    if (!vim || !vaults?.length) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (event.key === 'j') {
        event.preventDefault()
        setCursor((at) => Math.min(at + 1, vaults.length - 1))
      } else if (event.key === 'k') {
        event.preventDefault()
        setCursor((at) => Math.max(at - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vim, vaults])

  return (
    <Card title="Choose a vault to open here">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        Signed in as <span className="font-medium text-ink-900">{email}</span>. Notes download first; large
        attachments download when you open them.
      </p>
      {loadError ? <ErrorLine message={loadError} /> : null}
      {!vaults && !loadError ? <p className="mt-4 text-sm text-ink-500">Loading your vaults…</p> : null}
      {vaults && vaults.length > 0 ? (
        <ul ref={list} className="mt-4 space-y-1" aria-label="Your ZenNotes Cloud vaults">
          {vaults.map((vault, index) => (
            <li key={vault.id}>
              <button
                type="button"
                data-cloud-vault-id={vault.id}
                disabled={busy !== null}
                onFocus={() => setCursor(index)}
                onClick={() => run(vault.id, () => onOpen(vault))}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 text-left text-sm text-ink-900 hover:bg-paper-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="min-w-0 truncate font-medium">{vault.name}</span>
                <span className="flex-none text-xs text-ink-500">
                  {busy === vault.id
                    ? 'Opening…'
                    : vault.locked
                      ? 'Encrypted: unlock to open'
                      : vault.here
                        ? 'In this browser'
                        : vault.encrypted
                          ? 'Encrypted'
                          : 'Open'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {vaults && vaults.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-ink-600">There are no vaults in your ZenNotes Cloud yet.</p>
      ) : null}
      <form
        className="mt-5 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const name = newName.trim()
          if (name) run('create', () => onCreate(name))
        }}
      >
        <label className="sr-only" htmlFor="zn-new-cloud-vault">
          New vault name
        </label>
        <input
          id="zn-new-cloud-vault"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-1.5 text-sm text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <Button type="submit" variant="secondary" size="md" disabled={busy !== null || !newName.trim()}>
          {busy === 'create' ? 'Creating…' : 'Create a vault'}
        </Button>
      </form>
      <ErrorLine message={error} />
      <div className="mt-4 flex items-center justify-between gap-3">
        <KeyHint>j and k move, Enter opens</KeyHint>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run('sign-out', onSignOut)}>
          {busy === 'sign-out' ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </Card>
  )
}

export function showVaultPicker(
  root: HTMLElement,
  props: {
    email: string
    load: () => Promise<PickableCloudVault[]>
    onOpen: (vault: PickableCloudVault) => Promise<void>
    onCreate: (name: string) => Promise<void>
    onSignOut: () => Promise<void>
  }
): void {
  show(root, <VaultPickerScreen {...props} />)
}

// ---------------------------------------------------------------------------
// Unlocking an encrypted vault
// ---------------------------------------------------------------------------

export interface UnlockScreenProps {
  /** The vault being opened, when its real name is known. */
  vaultName: string | null
  email: string
  /** The security page's section, while the first-unlock notice is due. */
  noticeUrl: string | null
  lockOnClose: boolean
  /** A shared computer: the key is never stored, so there is no choice. */
  sharedComputer: boolean
  /** Rejects with the words to show; the person stays here to try again. */
  onUnlock: (secret: CloudEncryptionSecretInput, lockOnClose: boolean) => Promise<void>
  onOtherVaults: () => void
  onSignOut: () => Promise<void>
}

function UnlockScreen({ vaultName, email, noticeUrl, lockOnClose: initialLock, sharedComputer, onUnlock, onOtherVaults, onSignOut }: UnlockScreenProps): JSX.Element {
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase')
  const [passphrase, setPassphrase] = useState('')
  const [words, setWords] = useState('')
  const [lockOnClose, setLockOnClose] = useState(initialLock)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passphraseField = useRef<HTMLInputElement>(null)
  const wordsField = useRef<HTMLTextAreaElement>(null)
  const signOut = useAction(onSignOut)
  const vim = vimModeFromPrefs()
  const value = mode === 'passphrase' ? passphrase : words.trim()

  const focusField = useCallback(() => {
    const field = mode === 'passphrase' ? passphraseField.current : wordsField.current
    field?.focus()
    field?.select()
  }, [mode])

  useEffect(() => {
    focusField()
  }, [focusField])

  const submit = (): void => {
    if (!value || busy) return
    setBusy(true)
    setError(null)
    void onUnlock(mode === 'passphrase' ? { passphrase } : { recoveryWords: words }, lockOnClose).then(
      () => setBusy(false),
      (cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
        // Back in the field, what was typed selected, to retype at once.
        setTimeout(focusField, 0)
      }
    )
  }

  const toggleMode = useCallback(() => setMode((current) => (current === 'passphrase' ? 'recovery' : 'passphrase')), [])
  const toggleLock = useCallback(() => setLockOnClose((current) => !current), [])
  useLetterKey('r', toggleMode, vim)
  useLetterKey('l', toggleLock, vim && !sharedComputer)
  useLetterKey('i', focusField, vim)
  useLetterKey('b', onOtherVaults, vim)
  const leaveField = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (vim && event.key === 'Escape') (event.target as HTMLElement).blur()
  }

  return (
    <Card title={vaultName ? `Unlock “${vaultName}”` : 'Unlock your encrypted vaults'}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        Signed in as <span className="font-medium text-ink-900">{email}</span>. Your passphrase never leaves this
        browser.
      </p>
      {noticeUrl ? (
        <p data-browser-trust-notice="" className="mt-3 text-sm leading-relaxed text-ink-600">
          {CLOUD_BROWSER_UNLOCK_NOTICE}{' '}
          <a className="font-medium text-accent underline" href={noticeUrl} target="_blank" rel="noreferrer">
            What this means
          </a>
        </p>
      ) : null}
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {mode === 'passphrase' ? (
          <div>
            <label className="text-sm font-medium text-ink-800" htmlFor="zn-unlock-passphrase">
              Encryption passphrase
            </label>
            <input
              id="zn-unlock-passphrase"
              ref={passphraseField}
              type="password"
              value={passphrase}
              autoComplete="current-password"
              spellCheck={false}
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={leaveField}
              className="mt-1.5 w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
        ) : (
          <div>
            <label className="text-sm font-medium text-ink-800" htmlFor="zn-unlock-recovery">
              Recovery key (24 words)
            </label>
            <textarea
              id="zn-unlock-recovery"
              ref={wordsField}
              value={words}
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setWords(event.target.value)}
              onKeyDown={(event) => {
                leaveField(event)
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submit()
                }
              }}
              className="mt-1.5 w-full resize-none rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-sm text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
        )}
        {sharedComputer ? null : (
          <label className="flex items-start gap-2 text-sm text-ink-800" htmlFor="zn-unlock-lock-on-close">
            <input
              id="zn-unlock-lock-on-close"
              type="checkbox"
              checked={lockOnClose}
              onChange={(event) => setLockOnClose(event.target.checked)}
              onKeyDown={leaveField}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Lock when I close this tab
              <span className="block text-xs leading-5 text-ink-500">
                Forgets the key. Notes already here stay in this browser’s storage.
              </span>
            </span>
          </label>
        )}
        <ErrorLine message={error} />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" size="md" disabled={!value || busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          <Button type="button" variant="ghost" size="md" disabled={busy} onClick={toggleMode}>
            {mode === 'passphrase' ? 'Use recovery key instead' : 'Use passphrase instead'}
          </Button>
        </div>
      </form>
      <ErrorLine message={signOut.error} />
      <div className="mt-4 flex items-center justify-between gap-3">
        <KeyHint>Esc leaves the field, then r recovery{sharedComputer ? '' : ', l lock'}, b vaults, i back</KeyHint>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onOtherVaults}>
            Other vaults
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || signOut.busy} onClick={signOut.act}>
            {signOut.busy ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function showUnlock(root: HTMLElement, props: UnlockScreenProps): void {
  show(root, <UnlockScreen {...props} />)
}

// ---------------------------------------------------------------------------
// Removed, switched
// ---------------------------------------------------------------------------

function RemovedScreen({ reason, onSignIn }: { reason: 'revoked' | 'account-switch'; onSignIn: SignIn }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const choice = useSharedChoice(false)
  const { busy, error, act } = useAction(useCallback(() => onSignIn(choice.shared), [onSignIn, choice.shared]))
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('s', act, vimModeFromPrefs())
  return (
    <Card title={reason === 'revoked' ? 'This browser was removed from your account' : 'Another account signed in'}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        {reason === 'revoked'
          ? 'This browser was removed from your ZenNotes Cloud account, so its copy of your notes was removed too. Your notes are still in ZenNotes Cloud and on your other devices.'
          : 'Another ZenNotes Cloud account signed in to this browser in another tab, so the notes of the previous account were removed from it.'}
      </p>
      <SharedComputerOption shared={choice.shared} onChange={choice.set} />
      <ErrorLine message={error} />
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" disabled={busy} onClick={act}>
          {busy ? 'Opening zennotes.org…' : 'Sign in again'}
        </Button>
        <KeyHint>or press s</KeyHint>
      </div>
    </Card>
  )
}

export function showRemoved(root: HTMLElement, reason: 'revoked' | 'account-switch', onSignIn: SignIn): void {
  show(root, <RemovedScreen reason={reason} onSignIn={onSignIn} />)
}

/** Cloud removed this browser, and its copy could not be removed after a few
 *  tries (removal-retry.ts). A reload tries again; nothing opens meanwhile. */
function RemovalStuckScreen(): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('r', () => location.reload(), vimModeFromPrefs())
  return (
    <Card title="This browser was removed from your account">
      <p data-removal-stuck="" className="mt-2 text-sm leading-relaxed text-ink-600">
        ZenNotes could not remove its copy of your notes from this browser. Reload to try again, or clear this
        site&rsquo;s data in your browser&rsquo;s settings.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" onClick={() => location.reload()}>
          Reload
        </Button>
        <KeyHint>or press r</KeyHint>
      </div>
    </Card>
  )
}

/** Over the running app when `root` is null, as showNotAvailable does. */
export function showRemovalStuck(root: HTMLElement | null): void {
  if (root) {
    show(root, <RemovalStuckScreen />)
    return
  }
  applySavedTheme()
  const overlay = document.createElement('div')
  overlay.setAttribute('data-prompt-modal', '')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100'
  document.body.appendChild(overlay)
  ReactDOM.createRoot(overlay).render(
    <React.StrictMode>
      <RemovalStuckScreen />
    </React.StrictMode>
  )
}

// ---------------------------------------------------------------------------
// Not available for this account
// ---------------------------------------------------------------------------

function NotAvailableScreen({
  keptHere,
  onOpenHere,
  onSignIn
}: {
  /** The notes stay in this browser (not on a shared computer). */
  keptHere: boolean
  onOpenHere: (() => void) | null
  onSignIn: SignIn
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const signIn = useAction(useCallback(() => onSignIn(false), [onSignIn]))
  useEffect(() => {
    button.current?.focus()
  }, [])
  const vim = vimModeFromPrefs()
  useLetterKey('o', () => onOpenHere?.(), vim && !!onOpenHere)
  useLetterKey('s', signIn.act, vim)
  return (
    <Card title={WEB_NOT_AVAILABLE_TITLE}>
      <p data-web-not-available="" className="mt-2 text-sm leading-relaxed text-ink-600">
        {keptHere
          ? 'Your notes are still in this browser and in ZenNotes Cloud. Changes made here sync again once ZenNotes in your browser is back for your account. Use the apps until then.'
          : 'Your notes are safe in ZenNotes Cloud. Use the apps until ZenNotes in your browser is back for your account.'}
      </p>
      <ErrorLine message={signIn.error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {onOpenHere ? (
          <Button ref={button} variant="primary" size="md" onClick={onOpenHere}>
            Open my notes here
          </Button>
        ) : null}
        <Button ref={onOpenHere ? undefined : button} variant={onOpenHere ? 'ghost' : 'primary'} size="md" disabled={signIn.busy} onClick={signIn.act}>
          {signIn.busy ? 'Opening zennotes.org…' : 'Sign in again'}
        </Button>
        <KeyHint>{onOpenHere ? 'o opens them, s signs in' : 'or press s'}</KeyHint>
      </div>
    </Card>
  )
}

/** On top of a running app (its own root stays mounted) or in a host screen's
 *  place. The overlay owns the keyboard while it is up. */
export function showNotAvailable(
  root: HTMLElement | null,
  props: { keptHere: boolean; onOpenHere: (() => void) | null; onSignIn: SignIn }
): () => void {
  if (root) {
    show(root, <NotAvailableScreen {...props} />)
    return () => {}
  }
  applySavedTheme()
  const overlay = document.createElement('div')
  overlay.setAttribute('data-prompt-modal', '')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100'
  document.body.appendChild(overlay)
  const overlayRoot = ReactDOM.createRoot(overlay)
  overlayRoot.render(
    <React.StrictMode>
      <NotAvailableScreen {...props} />
    </React.StrictMode>
  )
  return () => {
    overlayRoot.unmount()
    overlay.remove()
  }
}

// ---------------------------------------------------------------------------
// Shared computers
// ---------------------------------------------------------------------------

export type SharedEndedReason = 'signed-out' | 'signed-out-offline' | 'expired'

function SharedEndedScreen({
  reason,
  onSignIn
}: {
  reason: SharedEndedReason
  onSignIn: SignIn
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const choice = useSharedChoice(true)
  const { busy, error, act } = useAction(useCallback(() => onSignIn(choice.shared), [onSignIn, choice.shared]))
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('s', act, vimModeFromPrefs())
  return (
    <Card title={reason === 'expired' ? 'Your sign-in ended' : 'You signed out'}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        Your notes were removed from this browser.
        {reason === 'signed-out-offline'
          ? ' ZenNotes could not reach Cloud, so this sign-in ends by itself within 12 hours.'
          : ''}
      </p>
      <SharedComputerOption shared={choice.shared} onChange={choice.set} />
      <ErrorLine message={error} />
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" disabled={busy} onClick={act}>
          {busy ? 'Opening zennotes.org…' : 'Sign in again'}
        </Button>
        <KeyHint>or press s</KeyHint>
      </div>
    </Card>
  )
}

export function showSharedEnded(root: HTMLElement, reason: SharedEndedReason, onSignIn: SignIn): void {
  show(root, <SharedEndedScreen reason={reason} onSignIn={onSignIn} />)
}

function SharedOpenElsewhereScreen(): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('c', () => location.reload(), vimModeFromPrefs())
  return (
    <Card title="ZenNotes is open in another tab">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        On a shared computer your sign-in stays in the tab you signed in from. Go back to that tab to keep working.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button ref={button} variant="primary" size="md" onClick={() => location.reload()}>
          Check again
        </Button>
        <KeyHint>or press c</KeyHint>
      </div>
    </Card>
  )
}

export function showSharedOpenElsewhere(root: HTMLElement): void {
  show(root, <SharedOpenElsewhereScreen />)
}

function SharedDiscardScreen({
  vaults,
  onDiscard,
  onStay
}: {
  vaults: string[]
  onDiscard: () => Promise<void>
  onStay: () => void
}): JSX.Element {
  const stay = useRef<HTMLButtonElement>(null)
  const discard = useAction(onDiscard)
  useEffect(() => {
    stay.current?.focus()
  }, [])
  return (
    <Card title="Sign out without these changes?">
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        <span className="font-medium text-ink-900">{vaults.join(', ')}</span>{' '}
        {vaults.length === 1 ? 'has' : 'have'} changes that never reached ZenNotes Cloud. Signing out removes them.
      </p>
      <ErrorLine message={discard.error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button ref={stay} variant="primary" size="md" disabled={discard.busy} onClick={onStay}>
          Stay signed in
        </Button>
        <Button variant="danger" size="md" disabled={discard.busy} onClick={discard.act}>
          {discard.busy ? 'Removing…' : 'Remove them and sign out'}
        </Button>
      </div>
    </Card>
  )
}

export function showSharedDiscard(
  root: HTMLElement,
  props: { vaults: string[]; onDiscard: () => Promise<void>; onStay: () => void }
): void {
  show(root, <SharedDiscardScreen {...props} />)
}

function AccountSwitchScreen({
  previousEmail,
  nextEmail,
  unsyncedVaults,
  sharedComputer,
  onReplace,
  onCancel
}: {
  previousEmail: string
  nextEmail: string
  unsyncedVaults: string[]
  sharedComputer: boolean
  onReplace: () => Promise<void>
  onCancel: () => Promise<void>
}): JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  const replace = useAction(onReplace)
  const back = useAction(onCancel)
  useEffect(() => {
    cancel.current?.focus()
  }, [])
  return (
    <Card title={`Sign in as ${nextEmail}?`}>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        {sharedComputer
          ? 'A sign-in on a shared computer starts empty, so the notes already in this browser are removed.'
          : `This browser keeps one account’s notes at a time. Signing in as ${nextEmail} removes the notes of ${previousEmail} from this browser.`}{' '}
        {unsyncedVaults.length === 1 ? 'The vault' : 'These vaults'}{' '}
        <span className="font-medium text-ink-900">{unsyncedVaults.join(', ')}</span>{' '}
        {unsyncedVaults.length === 1 ? 'has' : 'have'} changes that never reached ZenNotes Cloud, and they would be
        lost.
      </p>
      <ErrorLine message={replace.error ?? back.error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button ref={cancel} variant="primary" size="md" disabled={replace.busy || back.busy} onClick={back.act}>
          {back.busy ? 'Signing out…' : `Keep them and sign ${nextEmail} out`}
        </Button>
        <Button variant="danger" size="md" disabled={replace.busy || back.busy} onClick={replace.act}>
          {replace.busy ? 'Removing…' : 'Remove them and continue'}
        </Button>
      </div>
    </Card>
  )
}

export function showAccountSwitch(
  root: HTMLElement,
  props: {
    previousEmail: string
    nextEmail: string
    unsyncedVaults: string[]
    sharedComputer: boolean
    onReplace: () => Promise<void>
    onCancel: () => Promise<void>
  }
): void {
  show(root, <AccountSwitchScreen {...props} />)
}
