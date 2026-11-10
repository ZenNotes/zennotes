import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CloudEncryptionRecoveryPrompt,
  CloudEncryptionSecretInput,
  CloudEncryptionStatus,
} from "@zennotes/bridge-contract/cloud-sync";
import type { BrowserEncryptionPrefs, ZenBridge } from "@zennotes/bridge-contract/bridge";
import { CLOUD_BROWSER_UNLOCK_NOTICE, cloudPassphraseProblem } from "@zennotes/shared-domain/cloud-e2ee-passphrase";
import { confirmApp } from "../lib/confirm-requests";
import type { CloudErrorCopy } from "@zennotes/shared-domain/cloud-error-copy";
import { CloudErrorMessage, cloudErrorCopy } from "./CloudErrorMessage";
import { isImeComposing } from "../lib/ime";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

const INPUT_CLASS =
  "mt-1.5 w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent";

type Dialog = "setup" | "unlock" | "change" | "recovery" | null;

/**
 * End-to-end encryption for the signed-in Cloud account
 * (docs/specs/cloud-e2ee.md). The panel never holds a key: setup, unlock and
 * every change run in the host, and only the recovery words a person must see
 * cross to this screen.
 */
export function CloudEncryptionPanel({
  bridge,
  onStatusChange,
}: {
  bridge: ZenBridge;
  onStatusChange?: (status: CloudEncryptionStatus) => void;
}): JSX.Element | null {
  const [status, setStatus] = useState<CloudEncryptionStatus | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<CloudErrorCopy | null>(null);
  const [browser, setBrowser] = useState<BrowserEncryptionPrefs | null>(null);
  const supported = typeof bridge.getCloudEncryptionStatus === "function";

  const refresh = useCallback(async () => {
    if (!bridge.getCloudEncryptionStatus) return;
    try {
      const next = await bridge.getCloudEncryptionStatus();
      setStatus(next);
      onStatusChange?.(next);
      setError(null);
      if (bridge.getBrowserEncryptionPrefs) setBrowser(await bridge.getBrowserEncryptionPrefs());
    } catch (cause) {
      setError(cloudErrorCopy(cause, "ZenNotes couldn't check end-to-end encryption. Try again in a moment.", bridge));
    }
  }, [bridge, onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!supported || !status?.available) return null;

  const lock = async (): Promise<void> => {
    const confirmed = await confirmApp({
      title: "Lock encryption on this device?",
      description:
        "Encrypted vaults stop syncing on this device until you unlock it again with your passphrase or recovery key.",
      confirmLabel: "Lock this device",
      danger: false,
    });
    if (!confirmed) return;
    try {
      await bridge.lockCloudEncryption?.();
      await refresh();
    } catch (cause) {
      setError(cloudErrorCopy(cause, "ZenNotes couldn't lock encryption on this device. Try again.", bridge));
    }
  };

  const finished = (): void => {
    setDialog(null);
    void refresh();
  };

  // ZenNotes in the browser only: said once, where a passphrase is first asked.
  const notice =
    browser && !browser.noticeSeen ? <BrowserTrustNotice url={browser.securityUrl} /> : undefined;
  const toggleLockOnClose = (): void => {
    if (!browser) return;
    void bridge.setBrowserLockOnClose?.(!browser.lockOnClose).then(setBrowser, (cause: unknown) =>
      setError(cloudErrorCopy(cause, "ZenNotes couldn't change when encryption locks. Try again.", bridge)),
    );
  };

  return (
    <section
      data-settings-search-id="cloud-encryption"
      aria-labelledby="cloud-encryption-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-encryption-heading"
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          End-to-end encryption
          <span className="rounded-full bg-paper-200 px-2 py-0.5 text-xs font-medium normal-case tracking-normal text-ink-500">
            Beta
          </span>
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          {!status.keyset
            ? "Encrypt Cloud vaults on your devices with a passphrase only you know. ZenNotes Cloud stores their notes, attachments, and names in a form it cannot read."
            : status.unlocked
              ? "Encrypted vaults sync on this device. Your passphrase unlocks your other devices, and your recovery key works if you forget it."
              : "Encryption is set up for your account. Unlock it on this device to sync encrypted vaults."}
        </p>
      </div>
      {error && (
        <div role="alert" className="text-sm leading-6 text-danger">
          <CloudErrorMessage message={error.message} detail={error.detail} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!status.keyset && (
          <Button variant="primary" onClick={() => setDialog("setup")}>
            Set up encryption
          </Button>
        )}
        {status.keyset && !status.unlocked && (
          <Button variant="primary" onClick={() => setDialog("unlock")}>
            Unlock this device
          </Button>
        )}
        {status.keyset && status.unlocked && (
          <>
            <Button onClick={() => setDialog("change")}>Change passphrase</Button>
            <Button onClick={() => setDialog("recovery")}>New recovery key</Button>
            <Button onClick={() => void lock()}>Lock this device</Button>
          </>
        )}
      </div>
      {browser && status.keyset && (
        <LockOnCloseSwitch checked={browser.lockOnClose} onToggle={toggleLockOnClose} />
      )}

      {dialog === "setup" && (
        <EncryptionSetupDialog bridge={bridge} notice={notice} onCancel={() => setDialog(null)} onDone={finished} />
      )}
      {dialog === "unlock" && (
        <EncryptionUnlockDialog bridge={bridge} notice={notice} onCancel={() => setDialog(null)} onDone={finished} />
      )}
      {dialog === "change" && (
        <EncryptionChangePassphraseDialog bridge={bridge} onCancel={() => setDialog(null)} onDone={finished} />
      )}
      {dialog === "recovery" && (
        <EncryptionNewRecoveryKeyDialog bridge={bridge} onCancel={() => setDialog(null)} onDone={finished} />
      )}
    </section>
  );
}

function BrowserTrustNotice({ url }: { url: string }): JSX.Element {
  return (
    <p data-browser-trust-notice="">
      {CLOUD_BROWSER_UNLOCK_NOTICE}{" "}
      <a className="font-medium text-accent underline" href={url} target="_blank" rel="noreferrer">
        What this means
      </a>
    </p>
  );
}

function LockOnCloseSwitch({ checked, onToggle }: { checked: boolean; onToggle: () => void }): JSX.Element {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm text-ink-800">
      <input
        id={id}
        type="checkbox"
        data-cloud-lock-on-close=""
        checked={checked}
        onChange={onToggle}
        className="mt-1 h-4 w-4"
      />
      <span>
        Lock when I close this tab
        <span className="block text-xs leading-5 text-ink-500">
          Forgets the key. Notes already here stay in this browser's storage.
        </span>
      </span>
    </label>
  );
}

function EncryptionSetupDialog({
  bridge,
  notice,
  onCancel,
  onDone,
}: {
  bridge: ZenBridge;
  notice?: React.ReactNode;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  const [prompt, setPrompt] = useState<CloudEncryptionRecoveryPrompt | null>(null);
  const [step, setStep] = useState<"passphrase" | "words" | "confirm">("passphrase");

  return (
    <EncryptionDialog titleId={titleId} onClose={onCancel}>
      {step === "passphrase" && (
        <NewPassphraseStep
          titleId={titleId}
          title="Choose an encryption passphrase"
          intro="This passphrase unlocks your encrypted vaults on each device. It is not your account password, and ZenNotes never sees it."
          extra={notice}
          submitLabel="Continue"
          busyLabel="Preparing…"
          onCancel={onCancel}
          onSubmit={async (passphrase) => {
            if (!bridge.prepareCloudEncryptionSetup) throw new Error("This version of ZenNotes can't use end-to-end encryption. Update ZenNotes to the latest version.");
            setPrompt(await bridge.prepareCloudEncryptionSetup(passphrase));
            setStep("words");
          }}
        />
      )}
      {step === "words" && prompt && (
        <RecoveryWordsStep
          titleId={titleId}
          words={prompt.recoveryWords}
          onCancel={onCancel}
          onContinue={() => setStep("confirm")}
        />
      )}
      {step === "confirm" && prompt && (
        <RecoveryConfirmStep
          titleId={titleId}
          words={prompt.recoveryWords}
          submitLabel="Turn on encryption"
          busyLabel="Turning on…"
          onBack={() => setStep("words")}
          onSubmit={async () => {
            await bridge.finishCloudEncryptionSetup?.(prompt.setupId);
            onDone();
          }}
        />
      )}
    </EncryptionDialog>
  );
}

function EncryptionUnlockDialog({
  bridge,
  notice,
  onCancel,
  onDone,
}: {
  bridge: ZenBridge;
  notice?: React.ReactNode;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  return (
    <EncryptionDialog titleId={titleId} onClose={onCancel}>
      <SecretStep
        titleId={titleId}
        title="Unlock encryption on this device"
        intro="Enter the encryption passphrase you chose when you set up encryption, or use your recovery key."
        extra={notice}
        submitLabel="Unlock"
        busyLabel="Unlocking…"
        onCancel={onCancel}
        onSubmit={async (secret) => {
          await bridge.unlockCloudEncryption?.(secret);
          onDone();
        }}
      />
    </EncryptionDialog>
  );
}

function EncryptionChangePassphraseDialog({
  bridge,
  onCancel,
  onDone,
}: {
  bridge: ZenBridge;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  const [current, setCurrent] = useState<CloudEncryptionSecretInput | null>(null);
  return (
    <EncryptionDialog titleId={titleId} onClose={onCancel}>
      {!current ? (
        <SecretStep
          titleId={titleId}
          title="Change encryption passphrase"
          intro="First, enter your current passphrase or your recovery key."
          submitLabel="Continue"
          busyLabel="Continue"
          onCancel={onCancel}
          onSubmit={async (secret) => setCurrent(secret)}
        />
      ) : (
        <NewPassphraseStep
          titleId={titleId}
          title="Choose a new passphrase"
          intro="Your notes are not re-encrypted. The new passphrase replaces the old one on every device the next time it unlocks."
          submitLabel="Change passphrase"
          busyLabel="Changing…"
          onCancel={onCancel}
          onSubmit={async (next) => {
            await bridge.changeCloudEncryptionPassphrase?.(current, next);
            onDone();
          }}
        />
      )}
    </EncryptionDialog>
  );
}

function EncryptionNewRecoveryKeyDialog({
  bridge,
  onCancel,
  onDone,
}: {
  bridge: ZenBridge;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const titleId = useId();
  const [prompt, setPrompt] = useState<CloudEncryptionRecoveryPrompt | null>(null);
  const [step, setStep] = useState<"secret" | "words" | "confirm">("secret");
  return (
    <EncryptionDialog titleId={titleId} onClose={onCancel}>
      {step === "secret" && (
        <SecretStep
          titleId={titleId}
          title="Make a new recovery key"
          intro="Your current recovery key stops working once the new one is saved. Enter your passphrase or your current recovery key to continue."
          submitLabel="Continue"
          busyLabel="Preparing…"
          onCancel={onCancel}
          onSubmit={async (secret) => {
            if (!bridge.prepareNewCloudRecoveryKey) throw new Error("This version of ZenNotes can't replace the recovery key. Update ZenNotes to the latest version.");
            setPrompt(await bridge.prepareNewCloudRecoveryKey(secret));
            setStep("words");
          }}
        />
      )}
      {step === "words" && prompt && (
        <RecoveryWordsStep
          titleId={titleId}
          words={prompt.recoveryWords}
          onCancel={onCancel}
          onContinue={() => setStep("confirm")}
        />
      )}
      {step === "confirm" && prompt && (
        <RecoveryConfirmStep
          titleId={titleId}
          words={prompt.recoveryWords}
          submitLabel="Replace recovery key"
          busyLabel="Replacing…"
          onBack={() => setStep("words")}
          onSubmit={async () => {
            await bridge.finishNewCloudRecoveryKey?.(prompt.setupId);
            onDone();
          }}
        />
      )}
    </EncryptionDialog>
  );
}

function EncryptionDialog({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Modal
      size="md"
      layer="nested"
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      data={{ "data-prompt-modal": "", "data-cloud-encryption-dialog": "" }}
    >
      {/* Settings renders this dialog; keep its keys from reaching Settings'
          own shortcuts behind it, apart from Tab for the focus trap. */}
      <div
        onKeyDown={(event) => {
          if (event.key !== "Tab") event.stopPropagation();
        }}
      >
        {children}
      </div>
    </Modal>
  );
}

/** Runs one async step, showing its error in place and keeping the dialog open. */
function useStep(): {
  busy: boolean;
  error: CloudErrorCopy | null;
  run: (task: () => Promise<void>) => Promise<void>;
  setError: (error: CloudErrorCopy | null) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CloudErrorCopy | null>(null);
  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cloudErrorCopy(cause, "That didn't work. Try again."));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

function NewPassphraseStep({
  titleId,
  title,
  intro,
  extra,
  submitLabel,
  busyLabel,
  onCancel,
  onSubmit,
}: {
  titleId: string;
  title: string;
  intro: string;
  extra?: React.ReactNode;
  submitLabel: string;
  busyLabel: string;
  onCancel: () => void;
  onSubmit: (passphrase: string) => Promise<void>;
}): JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const firstId = useId();
  const repeatId = useId();
  const first = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useStep();
  const problem = passphrase ? cloudPassphraseProblem(passphrase) : null;
  const mismatch = touched && repeat !== "" && repeat !== passphrase;
  const ready = passphrase !== "" && problem === null && repeat === passphrase;

  useEffect(() => first.current?.focus(), []);

  const submit = (): void => {
    setTouched(true);
    if (ready && !busy) void run(() => onSubmit(passphrase));
  };

  return (
    <>
      <Modal.Header titleId={titleId} title={title} />
      <div className="space-y-4 px-5 pt-2 text-sm leading-6 text-ink-600">
        <p>{intro}</p>
        {extra}
        <div>
          <label htmlFor={firstId} className="font-medium text-ink-800">
            Passphrase
          </label>
          <input
            id={firstId}
            ref={first}
            type="password"
            value={passphrase}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => submitOnEnter(event, submit)}
            className={INPUT_CLASS}
          />
          {problem && <p className="mt-1.5 text-ink-500">{problem}</p>}
        </div>
        <div>
          <label htmlFor={repeatId} className="font-medium text-ink-800">
            Type it again
          </label>
          <input
            id={repeatId}
            type="password"
            value={repeat}
            autoComplete="new-password"
            spellCheck={false}
            onBlur={() => setTouched(true)}
            onChange={(event) => setRepeat(event.target.value)}
            onKeyDown={(event) => submitOnEnter(event, submit)}
            className={INPUT_CLASS}
          />
          {mismatch && <p className="mt-1.5 text-danger">The two passphrases do not match.</p>}
        </div>
        <p className="text-ink-500">
          If you lose both this passphrase and your recovery key, your encrypted Cloud copy cannot be
          recovered by anyone, including ZenNotes. The notes on your devices are not affected.
        </p>
        {error && (
          <div role="alert" className="text-danger">
            <CloudErrorMessage message={error.message} detail={error.detail} />
          </div>
        )}
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || busy} onClick={submit}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </Modal.Footer>
    </>
  );
}

function SecretStep({
  titleId,
  title,
  intro,
  extra,
  submitLabel,
  busyLabel,
  onCancel,
  onSubmit,
}: {
  titleId: string;
  title: string;
  intro: string;
  extra?: React.ReactNode;
  submitLabel: string;
  busyLabel: string;
  onCancel: () => void;
  onSubmit: (secret: CloudEncryptionSecretInput) => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [words, setWords] = useState("");
  const fieldId = useId();
  const passphraseField = useRef<HTMLInputElement>(null);
  const wordsField = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useStep();
  const value = mode === "passphrase" ? passphrase : words.trim();

  useEffect(() => {
    if (mode === "passphrase") passphraseField.current?.focus();
    else wordsField.current?.focus();
  }, [mode]);

  const submit = (): void => {
    if (!value || busy) return;
    void run(() => onSubmit(mode === "passphrase" ? { passphrase } : { recoveryWords: words }));
  };

  return (
    <>
      <Modal.Header titleId={titleId} title={title} />
      <div className="space-y-4 px-5 pt-2 text-sm leading-6 text-ink-600">
        <p>{intro}</p>
        {extra}
        {mode === "passphrase" ? (
          <div>
            <label htmlFor={fieldId} className="font-medium text-ink-800">
              Encryption passphrase
            </label>
            <input
              id={fieldId}
              ref={passphraseField}
              type="password"
              value={passphrase}
              autoComplete="current-password"
              spellCheck={false}
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={(event) => submitOnEnter(event, submit)}
              className={INPUT_CLASS}
            />
          </div>
        ) : (
          <div>
            <label htmlFor={fieldId} className="font-medium text-ink-800">
              Recovery key (24 words)
            </label>
            <textarea
              id={fieldId}
              ref={wordsField}
              value={words}
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setWords(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event) || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                submit();
              }}
              className={`${INPUT_CLASS} resize-none font-mono`}
            />
            <p className="mt-1.5 text-ink-500">Spaces, line breaks, and capitals do not matter.</p>
          </div>
        )}
        <button
          type="button"
          className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          onClick={() => setMode(mode === "passphrase" ? "recovery" : "passphrase")}
        >
          {mode === "passphrase" ? "Use recovery key instead" : "Use passphrase instead"}
        </button>
        {error && (
          <div role="alert" className="text-danger">
            <CloudErrorMessage message={error.message} detail={error.detail} />
          </div>
        )}
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!value || busy} onClick={submit}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </Modal.Footer>
    </>
  );
}

function RecoveryWordsStep({
  titleId,
  words,
  onCancel,
  onContinue,
}: {
  titleId: string;
  words: string[];
  onCancel: () => void;
  onContinue: () => void;
}): JSX.Element {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const savedId = useId();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <Modal.Header titleId={titleId} title="Save your recovery key" />
      <div className="space-y-4 px-5 pt-2 text-sm leading-6 text-ink-600">
        <p>
          These 24 words unlock your encrypted vaults if you forget your passphrase. Keep them
          somewhere safe, like a password manager or on paper. Anyone who has them can unlock your
          notes, and ZenNotes cannot show them again.
        </p>
        <ol
          aria-label="Recovery key"
          className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-paper-300/70 bg-paper-50/60 px-4 py-3 font-mono text-sm text-ink-900 sm:grid-cols-3"
        >
          {words.map((word, index) => (
            <li key={index} className="flex gap-2">
              <span className="w-5 text-right text-ink-400">{index + 1}</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-3">
          <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy words"}</Button>
        </div>
        <label htmlFor={savedId} className="flex items-start gap-2 text-ink-800">
          <input
            id={savedId}
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>I saved my recovery key somewhere safe.</span>
        </label>
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!saved} onClick={onContinue}>
          Continue
        </Button>
      </Modal.Footer>
    </>
  );
}

function RecoveryConfirmStep({
  titleId,
  words,
  submitLabel,
  busyLabel,
  onBack,
  onSubmit,
}: {
  titleId: string;
  words: string[];
  submitLabel: string;
  busyLabel: string;
  onBack: () => void;
  onSubmit: () => Promise<void>;
}): JSX.Element {
  // Three positions chosen once per dialog, spread across the list.
  const positions = useMemo(() => pickPositions(words.length), [words]);
  const [answers, setAnswers] = useState<string[]>(() => positions.map(() => ""));
  const first = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const { busy, error, run } = useStep();
  const correct = positions.every(
    (position, index) => answers[index]!.trim().toLowerCase() === words[position],
  );

  useEffect(() => first.current?.focus(), []);

  const submit = (): void => {
    if (correct && !busy) void run(onSubmit);
  };

  return (
    <>
      <Modal.Header titleId={titleId} title="Check your recovery key" />
      <div className="space-y-4 px-5 pt-2 text-sm leading-6 text-ink-600">
        <p>Type these words from your recovery key to show you saved it.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {positions.map((position, index) => (
            <div key={position}>
              <label htmlFor={`${baseId}-${position}`} className="font-medium text-ink-800">
                Word {position + 1}
              </label>
              <input
                id={`${baseId}-${position}`}
                ref={index === 0 ? first : undefined}
                value={answers[index]}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((answer, at) => (at === index ? event.target.value : answer)),
                  )
                }
                onKeyDown={(event) => submitOnEnter(event, submit)}
                className={`${INPUT_CLASS} font-mono`}
              />
            </div>
          ))}
        </div>
        {error && (
          <div role="alert" className="text-danger">
            <CloudErrorMessage message={error.message} detail={error.detail} />
          </div>
        )}
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" disabled={!correct || busy} onClick={submit}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </Modal.Footer>
    </>
  );
}

/** Three distinct word positions, one from each third of the key. */
function pickPositions(count: number): number[] {
  const third = Math.floor(count / 3);
  const random = new Uint32Array(3);
  crypto.getRandomValues(random);
  return [0, 1, 2].map((part) => part * third + (random[part]! % third));
}

function submitOnEnter(event: React.KeyboardEvent, submit: () => void): void {
  if (isImeComposing(event) || event.key !== "Enter") return;
  event.preventDefault();
  submit();
}
