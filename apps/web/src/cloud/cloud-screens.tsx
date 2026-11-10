/**
 * The screens ZenNotes in the browser shows around ZenNotes Cloud, before the
 * app has a vault to open: sign in, finishing a sign-in, choosing a Cloud
 * vault, a browser that was removed from the account, and switching
 * accounts. Same rules as screens.tsx: app-core's Button and design tokens,
 * the main action focused, Enter takes it, and with Vim mode on a letter
 * does too (never with Vim mode off).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Card, show, useLetterKey, vimModeFromPrefs } from './screens'

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

function SignInScreen({ message, onSignIn }: { message: string | null; onSignIn: () => Promise<void> }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const { busy, error, act } = useAction(onSignIn)
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
        <KeyHint>s signs in, t opens Try mode</KeyHint>
      </div>
    </Card>
  )
}

export function showSignIn(root: HTMLElement, onSignIn: () => Promise<void>, message: string | null = null): void {
  show(root, <SignInScreen message={message} onSignIn={onSignIn} />)
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

function SignInFailedScreen({ message, onRetry }: { message: string; onRetry: () => Promise<void> }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const { busy, error, act } = useAction(onRetry)
  useEffect(() => {
    button.current?.focus()
  }, [])
  useLetterKey('s', act, vimModeFromPrefs())
  return (
    <Card title="The sign-in did not finish">
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-600">{message}</p>
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

export function showSignInFailed(root: HTMLElement, message: string, onRetry: () => Promise<void>): void {
  show(root, <SignInFailedScreen message={message} onRetry={onRetry} />)
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
        const first = found.findIndex((vault) => !vault.encrypted)
        setCursor(first < 0 ? 0 : first)
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
                disabled={vault.encrypted || busy !== null}
                onFocus={() => setCursor(index)}
                onClick={() => run(vault.id, () => onOpen(vault))}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 text-left text-sm text-ink-900 hover:bg-paper-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="min-w-0 truncate font-medium">{vault.name}</span>
                <span className="flex-none text-xs text-ink-500">
                  {busy === vault.id
                    ? 'Opening…'
                    : vault.encrypted
                      ? 'Encrypted: use the app for now'
                      : vault.here
                        ? 'In this browser'
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
// Removed, switched
// ---------------------------------------------------------------------------

function RemovedScreen({ reason, onSignIn }: { reason: 'revoked' | 'account-switch'; onSignIn: () => Promise<void> }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const { busy, error, act } = useAction(onSignIn)
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

export function showRemoved(root: HTMLElement, reason: 'revoked' | 'account-switch', onSignIn: () => Promise<void>): void {
  show(root, <RemovedScreen reason={reason} onSignIn={onSignIn} />)
}

function AccountSwitchScreen({
  previousEmail,
  nextEmail,
  unsyncedVaults,
  onReplace,
  onCancel
}: {
  previousEmail: string
  nextEmail: string
  unsyncedVaults: string[]
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
        This browser keeps one account’s notes at a time. Signing in as {nextEmail} removes the notes of{' '}
        {previousEmail} from this browser. {unsyncedVaults.length === 1 ? 'The vault' : 'These vaults'}{' '}
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
    onReplace: () => Promise<void>
    onCancel: () => Promise<void>
  }
): void {
  show(root, <AccountSwitchScreen {...props} />)
}
