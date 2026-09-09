import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudSyncMergeChange,
  CloudSyncPendingConflict,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import { syncCloudVaultWithStatus } from "../lib/cloud-auto-sync";
import { Button } from "./ui/Button";

type ChangeChoice = "local" | "cloud" | "both";
type WholeVersionChoice = "local" | "cloud";

export function CloudPendingConflictResolver({
  conflict,
  vaultName,
  onResolved,
  onClose,
}: {
  conflict: CloudSyncPendingConflict;
  vaultName: string;
  onResolved: (summary: CloudSyncRunSummary) => void;
  onClose: () => void;
}): JSX.Element {
  const [bridge] = useState(() => getZenBridge());
  const [details, setDetails] =
    useState<CloudSyncPendingConflictDetails | null>(null);
  const [choices, setChoices] = useState<Record<string, ChangeChoice>>({});
  const [draft, setDraft] = useState("");
  const [manualDraft, setManualDraft] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keepBothOpen, setKeepBothOpen] = useState(false);
  const [finishLaterOpen, setFinishLaterOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [wholeVersionChoice, setWholeVersionChoice] =
    useState<WholeVersionChoice | null>(null);
  const [keepBothPath, setKeepBothPath] = useState(() =>
    localCopyPath(conflict.path),
  );
  // Bumped after a failed resolve. A rejected save means the file moved under
  // us, so the next attempt needs fresh hashes: without a refetch every retry
  // fails with the same stale-choice error and the queue is a dead end.
  const [reload, setReload] = useState({ nonce: 0, keepError: false });
  const [reloading, setReloading] = useState(false);
  const [resolvedPath, setResolvedPath] = useState(conflict.path);
  const loadedDraft = useRef<string | null>(null);
  const finishLaterButton = useRef<HTMLButtonElement>(null);
  const finishLaterDialog = useRef<HTMLDivElement>(null);
  const wholeVersionSource = useRef<HTMLElement | null>(null);
  const wholeVersionDialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setChoices({});
    if (!reload.keepError) setError(null);
    setReloading(reload.keepError);
    setKeepBothOpen(false);
    setFinishLaterOpen(false);
    setCombineOpen(false);
    setWholeVersionChoice(null);
    void bridge
      .getCloudConflict(conflict.id)
      .then((next) => {
        if (cancelled) return;
        setReloading(false);
        const initialDraft =
          next.draft_text ??
          (next.parts.length > 0
            ? combinedText(next, {})
            : (next.suggested_text ??
              next.local.text ??
              next.cloud.text ??
              ""));
        loadedDraft.current = initialDraft;
        setDetails(next);
        setResolvedPath(next.local.path ?? next.cloud.path ?? conflict.path);
        setDraft(initialDraft);
        setManualDraft(next.draft_text !== null);
        setSaveState(next.draft_text !== null ? "saved" : "idle");
      })
      .catch((cause) => {
        if (cancelled) return;
        setReloading(false);
        setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, conflict.id, reload]);

  useEffect(() => {
    if (finishLaterOpen) finishLaterDialog.current?.focus();
  }, [finishLaterOpen]);

  useEffect(() => {
    if (wholeVersionChoice) wholeVersionDialog.current?.focus();
  }, [wholeVersionChoice]);

  useEffect(() => {
    if (!details || draft === loadedDraft.current) return undefined;
    setSaveState("saving");
    const timeout = window.setTimeout(() => {
      void bridge
        .saveCloudConflictDraft(conflict.id, draft)
        .then(() => {
          loadedDraft.current = draft;
          setSaveState("saved");
        })
        .catch((cause) => {
          setSaveState("idle");
          setError(message(cause));
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [bridge, conflict.id, details, draft]);

  const unresolvedChanges =
    details?.changes.filter((change) => choices[change.id] === undefined)
      .length ?? 0;
  // Editing the text by hand does not answer an overlapping change: an
  // unanswered one still renders as the last synced wording, so saving with
  // any left would silently drop both devices' edits to that part.
  const canSaveCombined = Boolean(
    details !== null &&
    details.local.text !== null &&
    details.cloud.text !== null &&
    resolvedPath.trim().length > 0 &&
    unresolvedChanges === 0 &&
    (details.changes.length > 0 ||
      manualDraft ||
      (conflict.has_base && details.suggested_text !== null)),
  );
  const titleId = useMemo(
    () => `cloud-pending-conflict-${safeId(conflict.id)}`,
    [conflict.id],
  );

  const chooseChange = (changeId: string, choice: ChangeChoice): void => {
    if (!details) return;
    setWholeVersionChoice(null);
    const nextChoices = { ...choices, [changeId]: choice };
    setChoices(nextChoices);
    setDraft(combinedText(details, nextChoices));
    setManualDraft(false);
  };

  const chooseWholeVersion = (choice: WholeVersionChoice): void => {
    wholeVersionSource.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setKeepBothOpen(false);
    setWholeVersionChoice(choice);
  };

  const cancelWholeVersion = (): void => {
    setWholeVersionChoice(null);
    window.setTimeout(() => wholeVersionSource.current?.focus(), 0);
  };

  const resolve = async (
    resolution: Pick<
      CloudSyncPendingConflictResolution,
      "choice" | "keep_both_path" | "merged_text" | "resolved_path"
    >,
  ): Promise<void> => {
    if (!details) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.resolveCloudConflict({
        conflict_id: conflict.id,
        expected_local_sha256: details.local.sha256,
        expected_cloud_revision: details.cloud.revision,
        ...resolution,
      });
      onResolved(await syncCloudVaultWithStatus(bridge, vaultName));
    } catch (cause) {
      setError(message(cause));
      setReload((current) => ({ nonce: current.nonce + 1, keepError: true }));
    } finally {
      setBusy(false);
    }
  };

  const finishLater = async (): Promise<void> => {
    if (details && draft !== loadedDraft.current) {
      setSaveState("saving");
      try {
        await bridge.saveCloudConflictDraft(conflict.id, draft);
        loadedDraft.current = draft;
      } catch (cause) {
        setError(message(cause));
        setSaveState("idle");
        return;
      }
    }
    onClose();
  };

  return (
    <section
      aria-labelledby={titleId}
      data-cloud-pending-conflict={conflict.id}
    >
      <div className="flex flex-col gap-3 border-b border-paper-300/50 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={titleId} className="text-base font-semibold text-ink-900">
            {fileName(conflict.path)}
          </h3>
          <div
            className="mt-1 truncate font-mono text-xs text-ink-500"
            title={conflict.path}
          >
            {conflict.path}
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-600">
            {conflictExplanation(conflict)}
          </p>
        </div>
        <Button
          ref={finishLaterButton}
          variant="ghost"
          disabled={busy}
          onClick={() => setFinishLaterOpen(true)}
        >
          Finish later
        </Button>
      </div>

      {finishLaterOpen && (
        <div
          ref={finishLaterDialog}
          role="alertdialog"
          tabIndex={-1}
          aria-labelledby={`${titleId}-finish-later-title`}
          aria-describedby={`${titleId}-finish-later-description`}
          className="mt-3 rounded-xl border border-warning/35 bg-warning/10 p-3 outline-none focus-visible:ring-2 focus-visible:ring-warning/50"
        >
          <h4
            id={`${titleId}-finish-later-title`}
            className="text-sm font-semibold text-ink-900"
          >
            Resolve this note later?
          </h4>
          <p
            id={`${titleId}-finish-later-description`}
            className="mt-1 text-xs leading-5 text-ink-600"
          >
            This note will wait to sync. Your draft and both complete versions
            stay safe, while your other notes keep syncing.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setFinishLaterOpen(false);
                window.setTimeout(() => finishLaterButton.current?.focus(), 0);
              }}
            >
              Keep reviewing
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void finishLater()}
            >
              Save &amp; finish later
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm leading-5 text-danger"
        >
          {error}
        </div>
      )}

      {!details && (!error || reloading) && (
        <div role="status" className="py-8 text-center text-sm text-ink-500">
          Loading the versions kept for you…
        </div>
      )}

      {details && !finishLaterOpen && (
        <>
          {!details.conflict.has_base && (
            <FirstSyncChoice
              details={details}
              disabled={busy}
              onChooseLocal={() => chooseWholeVersion("local")}
              onChooseCloud={() => chooseWholeVersion("cloud")}
              onKeepBoth={() => {
                setWholeVersionChoice(null);
                setKeepBothOpen(true);
              }}
              onCombine={
                details.local.text !== null && details.cloud.text !== null
                  ? () => {
                      setWholeVersionChoice(null);
                      setCombineOpen(true);
                      setManualDraft(true);
                    }
                  : undefined
              }
            />
          )}

          {!details.conflict.has_base && keepBothOpen && (
            <KeepBothForm
              titleId={titleId}
              path={keepBothPath}
              busy={busy}
              onPathChange={setKeepBothPath}
              onSave={() =>
                void resolve({
                  choice: "both",
                  keep_both_path: keepBothPath.trim(),
                })
              }
              onBack={() => setKeepBothOpen(false)}
            />
          )}

          {details.changes.length > 0 && (
            <div className="mt-4 space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-ink-900">
                  Choose what to keep
                </h4>
                <p className="mt-1 text-xs leading-5 text-ink-500">
                  ZenNotes already combined edits made in different parts. For
                  each part below, choose what the combined note should say.
                  Nothing is replaced until you save.
                </p>
              </div>
              {details.changes.map((change, index) => (
                <ChangeChoiceCard
                  key={change.id}
                  number={index + 1}
                  change={change}
                  choice={choices[change.id]}
                  disabled={busy}
                  onChoose={(choice) => chooseChange(change.id, choice)}
                />
              ))}
            </div>
          )}

          {details.local.text !== null &&
            details.cloud.text !== null &&
            (details.conflict.has_base || combineOpen) && (
              <div className="mt-4 rounded-xl border border-paper-300/60 bg-paper-50/55 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <label
                      htmlFor={`${titleId}-draft`}
                      className="text-sm font-semibold text-ink-900"
                    >
                      Combined note
                    </label>
                    <div role="status" className="mt-0.5 text-xs text-ink-400">
                      {saveState === "saving"
                        ? "Saving draft…"
                        : saveState === "saved"
                          ? "Draft saved"
                          : "Your original versions are safe"}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    disabled={busy || !canSaveCombined}
                    onClick={() =>
                      void resolve({
                        choice: "merged",
                        merged_text: draft,
                        resolved_path: resolvedPath.trim(),
                      })
                    }
                  >
                    {busy ? "Saving…" : "Save combined note"}
                  </Button>
                </div>
                <textarea
                  id={`${titleId}-draft`}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setManualDraft(true);
                  }}
                  className="mt-2 min-h-44 w-full resize-y rounded-lg border border-paper-300 bg-paper-100 px-3 py-2 font-mono text-xs leading-5 text-ink-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                />
                {differentPaths(details) && (
                  <div className="mt-3 rounded-lg border border-paper-300/60 bg-paper-100/55 p-3">
                    <label
                      htmlFor={`${titleId}-resolved-path`}
                      className="text-xs font-medium text-ink-800"
                    >
                      Where should the combined note live?
                    </label>
                    <input
                      id={`${titleId}-resolved-path`}
                      value={resolvedPath}
                      disabled={busy}
                      onChange={(event) => setResolvedPath(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-xs text-ink-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {details.local.path && (
                        <ChoiceButton
                          active={resolvedPath === details.local.path}
                          disabled={busy}
                          onClick={() => setResolvedPath(details.local.path!)}
                        >
                          This device&rsquo;s location
                        </ChoiceButton>
                      )}
                      {details.cloud.path && (
                        <ChoiceButton
                          active={resolvedPath === details.cloud.path}
                          disabled={busy}
                          onClick={() => setResolvedPath(details.cloud.path!)}
                        >
                          Other device&rsquo;s location
                        </ChoiceButton>
                      )}
                    </div>
                  </div>
                )}
                {unresolvedChanges > 0 && (
                  <p className="mt-2 text-xs leading-5 text-ink-500">
                    Choose an option for{" "}
                    {unresolvedChanges === 1
                      ? "the remaining change"
                      : `all ${unresolvedChanges} remaining changes`}{" "}
                    before saving. Your own edits to the text above are kept.
                  </p>
                )}
                <p className="mt-2 text-xs text-ink-400">
                  Sync continues automatically after the combined note is saved.
                </p>
              </div>
            )}

          {details.conflict.has_base && (
            <details className="mt-4 rounded-xl border border-paper-300/60 bg-paper-50/45 p-3">
              <summary className="cursor-pointer text-sm font-medium text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                Compare complete versions
              </summary>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <VersionPreview label="Last synced" version={details.base} />
                <VersionPreview label="This device" version={details.local} />
                <VersionPreview label="Other device" version={details.cloud} />
              </div>
            </details>
          )}

          {details.conflict.has_base && (
            <div className="mt-4 rounded-xl border border-paper-300/60 bg-paper-100/35 p-3">
              <h4 className="text-sm font-semibold text-ink-900">
                Use one complete version
              </h4>
              <p className="mt-1 text-xs leading-5 text-ink-500">
                These choices skip the combined note. ZenNotes still checks that
                neither version changed while this window was open.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => chooseWholeVersion("local")}
                >
                  {localChoiceLabel(details)}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => chooseWholeVersion("cloud")}
                >
                  {cloudChoiceLabel(details)}
                </Button>
                {!details.local.deleted && !details.cloud.deleted && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setWholeVersionChoice(null);
                      setKeepBothOpen(true);
                    }}
                  >
                    Keep both as separate files…
                  </Button>
                )}
              </div>
            </div>
          )}

          {details.conflict.has_base && keepBothOpen && (
            <KeepBothForm
              titleId={titleId}
              path={keepBothPath}
              busy={busy}
              onPathChange={setKeepBothPath}
              onSave={() =>
                void resolve({
                  choice: "both",
                  keep_both_path: keepBothPath.trim(),
                })
              }
              onBack={() => setKeepBothOpen(false)}
            />
          )}

          {wholeVersionChoice && (
            <WholeVersionConfirmation
              dialogRef={wholeVersionDialog}
              choice={wholeVersionChoice}
              details={details}
              busy={busy}
              onConfirm={() =>
                void resolve({ choice: wholeVersionChoice })
              }
              onCancel={cancelWholeVersion}
            />
          )}
        </>
      )}
    </section>
  );
}

function WholeVersionConfirmation({
  dialogRef,
  choice,
  details,
  busy,
  onConfirm,
  onCancel,
}: {
  dialogRef: React.RefObject<HTMLDivElement>;
  choice: WholeVersionChoice;
  details: CloudSyncPendingConflictDetails;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const selected = choice === "local" ? details.local : details.cloud;
  const other = choice === "local" ? details.cloud : details.local;
  const selectedLabel =
    choice === "local" ? "this device’s" : "the other device’s";
  const otherLabel =
    choice === "local" ? "the other device’s" : "this device’s";
  const title = selected.deleted
    ? "Delete this file everywhere?"
    : choice === "local"
      ? "Use this device’s complete version?"
      : "Use the other device’s complete version?";
  const description = selected.deleted
    ? "This removes the file from both devices when sync finishes."
    : other.deleted
      ? `This restores ${selectedLabel} complete version on both devices.`
      : `This makes ${selectedLabel} complete version the synced note. Changes that exist only in ${otherLabel} version will not be included.`;
  const action = selected.deleted
    ? "Delete file everywhere"
    : choice === "local"
      ? "Replace with this device’s version"
      : "Replace with other device’s version";

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
      aria-labelledby="cloud-whole-version-confirmation-title"
      aria-describedby="cloud-whole-version-confirmation-description"
      className="mt-4 rounded-xl border border-warning/35 bg-warning/10 p-3 outline-none focus-visible:ring-2 focus-visible:ring-warning/50"
    >
      <h4
        id="cloud-whole-version-confirmation-title"
        className="text-sm font-semibold text-ink-900"
      >
        {title}
      </h4>
      <p
        id="cloud-whole-version-confirmation-description"
        className="mt-1 text-xs leading-5 text-ink-600"
      >
        {description}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving…" : action}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Go back
        </Button>
      </div>
    </div>
  );
}

function FirstSyncChoice({
  details,
  disabled,
  onChooseLocal,
  onChooseCloud,
  onKeepBoth,
  onCombine,
}: {
  details: CloudSyncPendingConflictDetails;
  disabled: boolean;
  onChooseLocal: () => void;
  onChooseCloud: () => void;
  onKeepBoth: () => void;
  onCombine?: () => void;
}): JSX.Element {
  return (
    <div className="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3">
      <h4 className="text-sm font-semibold text-ink-900">
        Choose the note you want to keep
      </h4>
      <p className="mt-1 text-xs leading-5 text-ink-600">
        Both versions are safe. This is the first sync, so ZenNotes cannot tell
        which one is newer.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <VersionPreview label="This device" version={details.local} />
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={onChooseLocal}
          >
            Use this device&rsquo;s version
          </Button>
        </div>
        <div className="space-y-2">
          <VersionPreview label="Other device" version={details.cloud} />
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={onChooseCloud}
          >
            Use other device&rsquo;s version
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={disabled} onClick={onKeepBoth}>
          Keep both as separate files…
        </Button>
        {onCombine && (
          <Button variant="ghost" disabled={disabled} onClick={onCombine}>
            Combine them myself…
          </Button>
        )}
      </div>
    </div>
  );
}

function KeepBothForm({
  titleId,
  path,
  busy,
  onPathChange,
  onSave,
  onBack,
}: {
  titleId: string;
  path: string;
  busy: boolean;
  onPathChange: (path: string) => void;
  onSave: () => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="mt-3 rounded-xl border border-accent/25 bg-accent/5 p-3">
      <label
        htmlFor={`${titleId}-copy-path`}
        className="text-sm font-medium text-ink-800"
      >
        Name for this device&rsquo;s version
      </label>
      <p className="mt-1 text-xs leading-5 text-ink-500">
        The other device&rsquo;s version keeps its current name. Choose a name
        you will recognize, not a technical conflict label.
      </p>
      <input
        id={`${titleId}-copy-path`}
        value={path}
        disabled={busy}
        onChange={(event) => onPathChange(event.target.value)}
        className="mt-2 w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-xs text-ink-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || !path.trim()}
          onClick={onSave}
        >
          {busy ? "Saving both…" : "Keep both files"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

function ChangeChoiceCard({
  number,
  change,
  choice,
  disabled,
  onChoose,
}: {
  number: number;
  change: CloudSyncMergeChange;
  choice: ChangeChoice | undefined;
  disabled: boolean;
  onChoose: (choice: ChangeChoice) => void;
}): JSX.Element {
  return (
    <fieldset className="rounded-xl border border-warning/30 bg-warning/5 p-3">
      <legend className="px-1 text-xs font-semibold text-ink-700">
        Choice {number}
      </legend>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        <ChangeVersion label="This device" text={change.local_text} />
        <ChangeVersion label="Other device" text={change.cloud_text} />
      </div>
      <div
        className="mt-3 flex flex-wrap gap-2"
        aria-label={`Choice ${number}`}
      >
        <ChoiceButton
          active={choice === "local"}
          disabled={disabled}
          onClick={() => onChoose("local")}
        >
          Use this device
        </ChoiceButton>
        <ChoiceButton
          active={choice === "cloud"}
          disabled={disabled}
          onClick={() => onChoose("cloud")}
        >
          Use other device
        </ChoiceButton>
        <ChoiceButton
          active={choice === "both"}
          disabled={disabled}
          onClick={() => onChoose("both")}
        >
          Keep both changes
        </ChoiceButton>
      </div>
    </fieldset>
  );
}

function ChoiceButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        "rounded-lg border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50",
        active
          ? "border-accent/50 bg-accent/10 text-ink-900"
          : "border-paper-300 bg-paper-100 text-ink-600 hover:bg-paper-200 hover:text-ink-900",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function ChangeVersion({
  label,
  text,
}: {
  label: string;
  text: string;
}): JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-paper-300/50 bg-paper-100/70 p-2">
      <div className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
        {label}
      </div>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink-700">
        {preview(text)}
      </pre>
    </div>
  );
}

function VersionPreview({
  label,
  version,
}: {
  label: string;
  version: CloudSyncPendingConflictDetails["local"];
}): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-paper-300/60 bg-paper-100/55">
      <div className="border-b border-paper-300/60 px-3 py-2">
        <div className="text-xs font-semibold text-ink-800">{label}</div>
        {version.path && (
          <div
            className="mt-0.5 truncate font-mono text-2xs text-ink-400"
            title={version.path}
          >
            {version.path}
          </div>
        )}
      </div>
      {version.deleted ? (
        <div className="px-3 py-4 text-xs leading-5 text-ink-500">
          This file was deleted.
        </div>
      ) : version.text === null ? (
        <div className="px-3 py-4 text-xs leading-5 text-ink-500">
          A text preview is not available for this file. The complete file is
          still safe.
        </div>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-ink-700">
          {version.text || "(empty file)"}
        </pre>
      )}
    </div>
  );
}

function combinedText(
  details: CloudSyncPendingConflictDetails,
  choices: Readonly<Record<string, ChangeChoice>>,
): string {
  const byId = new Map(details.changes.map((change) => [change.id, change]));
  return details.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      const change = byId.get(part.change_id);
      if (!change) return "";
      const choice = choices[part.change_id];
      if (choice === "local") return change.local_text;
      if (choice === "cloud") return change.cloud_text;
      if (choice === "both")
        return joinBoth(change.local_text, change.cloud_text);
      return change.base_text;
    })
    .join("");
}

function joinBoth(local: string, cloud: string): string {
  if (!local) return cloud;
  if (!cloud || local === cloud) return local;
  const lineBreak =
    local.includes("\r\n") || cloud.includes("\r\n") ? "\r\n" : "\n";
  return `${local}${/[\r\n]$/.test(local) ? "" : lineBreak}${cloud}`;
}

function conflictExplanation(conflict: CloudSyncPendingConflict): string {
  if (conflict.kind === "delete") {
    return "You changed this file on one device while it was deleted on another. Both outcomes are safe until you choose.";
  }
  if (conflict.kind === "move") {
    return "This file was changed and moved on different devices. Review the note and choose where it belongs.";
  }
  if (conflict.kind === "path") {
    return "Two files are trying to use the same name. Give each one a clear name before sync continues.";
  }
  return conflict.can_merge
    ? "The same part of this note changed on two devices. Review the suggested combination below."
    : "This file changed on two devices before either change could sync. Choose the version you want to keep.";
}

function localChoiceLabel(details: CloudSyncPendingConflictDetails): string {
  if (details.local.deleted) return "Delete everywhere";
  if (details.cloud.deleted) return "Keep this note";
  return "Use this device’s version";
}

function cloudChoiceLabel(details: CloudSyncPendingConflictDetails): string {
  return details.cloud.deleted
    ? "Delete everywhere"
    : "Use other device’s version";
}

function differentPaths(details: CloudSyncPendingConflictDetails): boolean {
  return Boolean(
    details.local.path &&
    details.cloud.path &&
    details.local.path !== details.cloud.path,
  );
}

function preview(text: string): string {
  if (!text) return "(nothing here)";
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

function localCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? `${directory}${filename.slice(0, dot)} (this device)${filename.slice(dot)}`
    : `${directory}${filename} (this device)`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
