import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { UNSPLASH_DEVELOPERS_URL } from '@shared/unsplash'
import { isImeComposing } from '../lib/ime'
import {
  refreshUnsplashKeyStatus,
  unsplashKeyCheckMessage,
  unsplashKeyPlace,
  unsplashKeyRefusalMessage,
  useUnsplashKeyStatus,
  type UnsplashKeyMessage
} from '../lib/unsplash-key'
import { Button } from './ui/Button'

const TONE_CLASS: Record<UnsplashKeyMessage['tone'], string> = {
  ok: 'text-ink-700',
  warn: 'text-ink-700',
  error: 'text-[color:rgb(var(--z-red))]'
}

/**
 * Settings → Typography → Covers → Unsplash access key. The cover picker's
 * Unsplash tab searches with a key of the person's own; this is where it
 * goes in (Save checks it with one request first), gets tested, and comes
 * out again. The field is write-only: the host keeps the key and this page
 * hears only whether there is one, so a saved key is never drawn back.
 */
export function UnsplashKeySetting({ inputRef }: { inputRef?: RefObject<HTMLInputElement> }): JSX.Element {
  const status = useUnsplashKeyStatus()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<UnsplashKeyMessage | null>(null)
  const ownRef = useRef<HTMLInputElement>(null)
  const fieldRef = inputRef ?? ownRef
  const place = unsplashKeyPlace(status?.store)
  const linux = /linux/i.test(navigator.userAgent)

  // The buttons stay enabled while a request is out (a press then does
  // nothing): a focused button that disabled itself would drop the keyboard
  // to the page.
  const run = async (label: string, task: () => Promise<UnsplashKeyMessage>): Promise<void> => {
    if (busy) return
    setBusy(label)
    try {
      setMessage(await task())
    } catch (err) {
      setMessage({ tone: 'error', text: `Something went wrong: ${(err as Error).message}` })
    } finally {
      await refreshUnsplashKeyStatus()
      setBusy(null)
      // Clear disables Test and Clear, and a save empties the field so Save
      // goes too: when the button that had the keyboard is gone, the field
      // takes it.
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (!active || active === document.body || (active as HTMLButtonElement).disabled) fieldRef.current?.focus()
      })
    }
  }

  const save = (): void => {
    const pasted = draft.trim()
    const saveKey = window.zen.saveUnsplashKey
    if (!pasted || !saveKey) return
    void run('Asking Unsplash…', async () => {
      const outcome = await saveKey(pasted)
      if (!outcome.saved) return unsplashKeyRefusalMessage(outcome.reason, status?.store, linux)
      setDraft('')
      return unsplashKeyCheckMessage(outcome.check, 'save')
    })
  }

  const test = (): void => {
    const testKey = window.zen.testUnsplashKey
    if (testKey) void run('Asking Unsplash…', async () => unsplashKeyCheckMessage(await testKey(), 'test'))
  }

  const clear = (): void => {
    const clearKey = window.zen.clearUnsplashKey
    if (!clearKey) return
    void run('Clearing…', async () => {
      await clearKey()
      return { tone: 'ok', text: 'Cleared. The Unsplash tab asks for a key again.' }
    })
  }

  const statusText: UnsplashKeyMessage =
    status == null
      ? { tone: 'ok', text: 'Checking…' }
      : status.set
        ? { tone: 'ok', text: `A key is saved in ${place}.` }
        : status.canStore
          ? { tone: 'ok', text: 'No key yet.' }
          : unsplashKeyRefusalMessage('cannot-store', status.store, linux)
  const shown = message ?? statusText

  return (
    <div data-settings-search-id="unsplash-access-key" aria-busy={busy !== null} className="space-y-3 px-5 py-4">
      <div>
        <div className="text-sm font-medium text-ink-900">Unsplash access key</div>
        <div className="mt-1 text-xs leading-5 text-ink-500">
          The cover picker’s Unsplash tab searches with a free key of your own. At{' '}
          <a href={UNSPLASH_DEVELOPERS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            unsplash.com/developers
          </a>
          , open Your apps and create a New Application, then copy its Access Key and paste it here. ZenNotes keeps
          it in {place} and sends it only to api.unsplash.com. A new Unsplash app allows 50 requests an hour.
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fieldRef}
          type="password"
          value={draft}
          aria-label="Unsplash access key"
          placeholder={status?.set ? 'Saved. Paste a new key to replace it' : 'Paste your Access Key'}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || isImeComposing(e)) return
            e.preventDefault()
            save()
          }}
          className="min-w-0 flex-1 basis-64 rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/45"
        />
        <Button variant="primary" disabled={!draft.trim()} onClick={save}>
          Save
        </Button>
        <Button disabled={!status?.set} onClick={test}>
          Test
        </Button>
        <Button variant="ghost" disabled={!status?.set} onClick={clear}>
          Clear
        </Button>
      </div>
      <div
        data-unsplash-key-message=""
        role="status"
        aria-live="polite"
        className={`text-xs leading-5 ${TONE_CLASS[shown.tone]}`}
      >
        {busy ?? shown.text}
      </div>
    </div>
  )
}
