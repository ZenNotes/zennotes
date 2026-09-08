import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type { NoteContent, NoteMeta } from "@shared/ipc";
import { backlinksForNote } from "../lib/wikilinks";
import { countWords } from "../lib/word-count";
import { useHoveredLinkStore } from "../lib/hovered-link";
import {
  connectCloudAccountFromStatusBar,
  formatRelativeSyncTime,
  openCloudConflictReview,
  resolvableCloudConflictCount,
  syncCloudVaultWithStatus,
  type CloudSyncPhase,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";
import { requestSettingsTarget } from "../lib/settings-navigation";

/**
 * Footer strip showing quick stats for the active note: backlinks,
 * word count, character count, and estimated read time. Modelled on
 * the Obsidian status bar.
 *
 * Backlinks use the `wikilinks` field populated by the main process
 * on every `readMeta` call, so we don't need to re-scan note bodies
 * at render time.
 */
export function StatusBar({ note }: { note: NoteContent | null }): JSX.Element {
  const notes = useStore((s) => s.notes);
  const cursorPosition = useStore((s) => s.editorCursorPosition);

  const { words, characters, minutes } = useMemo(() => {
    const body = note?.body ?? "";
    const w = countWords(body);
    const c = body.length;
    const m = Math.max(1, Math.round(w / 200));
    return { words: w, characters: c, minutes: m };
  }, [note?.body]);

  // Backlinks depend only on the active note's *path* and the vault's
  // wikilink metadata — never on the note body. Keying the memo on
  // `note.path` (instead of the whole `note` object, which changes on every
  // keystroke) keeps this O(n) scan off the typing hot path while producing
  // an identical count.
  const backlinks = useMemo(() => {
    if (!note) return 0;
    return backlinksForNote(notes as NoteMeta[], note).length;
  }, [note?.path, notes]);

  // The target of the link the mouse is over (browser-style), shown on the left.
  const hoveredLink = useHoveredLinkStore((s) => s.href);

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between gap-2 px-3 text-xs text-ink-500 sm:gap-5 sm:px-6"
      style={{ borderTop: "1px solid var(--glass-stroke)" }}
    >
      <span
        className="min-w-0 flex-1 truncate font-mono text-ink-400"
        title={hoveredLink ?? undefined}
      >
        {hoveredLink}
      </span>
      <div className="flex shrink-0 items-center gap-2 sm:gap-5">
        <CloudSyncStatus separated={note !== null} />
        {note && (
          <>
            <Stat className="hidden lg:inline">
              {backlinks} {backlinks === 1 ? "backlink" : "backlinks"}
            </Stat>
            <Stat className="hidden lg:inline">
              {words.toLocaleString()} {words === 1 ? "word" : "words"}
            </Stat>
            <Stat className="hidden lg:inline">
              {characters.toLocaleString()} characters
            </Stat>
            <Stat className="hidden lg:inline">{minutes} min read</Stat>
            {cursorPosition && (
              <span
                data-editor-position
                className="hidden tabular-nums lg:inline"
                title={`Line ${cursorPosition.line}, column ${cursorPosition.column}`}
              >
                Ln {cursorPosition.line}, Col {cursorPosition.column}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CloudSyncStatus({
  separated,
}: {
  separated: boolean;
}): JSX.Element | null {
  const phase = useCloudSyncStatusStore((state) => state.phase);
  const vaultName = useCloudSyncStatusStore((state) => state.vaultName);
  const lastSyncedAt = useCloudSyncStatusStore((state) => state.lastSyncedAt);
  const error = useCloudSyncStatusStore((state) => state.error);
  const lastSummary = useCloudSyncStatusStore((state) => state.lastSummary);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const [now, setNow] = useState(() => Date.now());
  const resolvableConflictCount = resolvableCloudConflictCount(lastSummary);
  const hasResolvableConflict = resolvableConflictCount > 0;

  useEffect(() => {
    if (phase === "hidden" || lastSyncedAt === null) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [lastSyncedAt, phase]);

  if (phase === "hidden") return null;

  const label =
    phase === "disconnected"
      ? error
        ? "Cloud unavailable"
        : "ZenNotes Cloud"
      : phase === "connecting"
        ? "Connecting to Cloud…"
        : phase === "unlinked"
          ? "Cloud connected"
          : phase === "syncing"
            ? "Syncing…"
            : phase === "attention"
              ? hasResolvableConflict
                ? `${resolvableConflictCount} ${resolvableConflictCount === 1 ? "file needs" : "files need"} review`
                : "Sync incomplete"
              : phase === "error"
                ? "Sync failed"
                : lastSyncedAt === null
                  ? "Cloud ready"
                  : `Synced ${formatRelativeSyncTime(lastSyncedAt, now)}`;
  const title =
    phase === "disconnected"
      ? (error ?? "Connect this vault to ZenNotes Cloud.")
      : phase === "connecting"
        ? "Finish signing in in your browser."
        : phase === "unlinked"
          ? "Choose the cloud vault this device should use."
          : phase === "attention"
            ? (error ?? "Some Cloud changes could not be synchronized.")
            : phase === "error"
              ? `${error ?? "Sync could not finish."} Click to retry.`
              : phase === "syncing"
                ? `Syncing ${vaultName ?? "this vault"}`
                : `${vaultName ?? "Cloud vault"} is connected. Click to sync now.`;
  const statusTone =
    phase === "error"
      ? "text-danger"
      : phase === "attention"
        ? "text-warning"
        : phase === "ready" || phase === "unlinked"
          ? "text-success"
          : phase === "disconnected"
            ? "text-ink-500"
            : "text-accent";
  // Files waiting on a decision outrank every other action: the queue stays
  // one click away even while the next run is in flight, because those runs
  // cannot finish the waiting file anyway.
  const actionLabel =
    phase === "disconnected"
      ? error
        ? "Retry"
        : "Connect"
      : phase === "unlinked"
        ? "Set up"
        : hasResolvableConflict
          ? "Review now"
          : phase === "attention"
            ? "Review"
            : phase === "error"
              ? "Retry"
              : "Sync now";
  const showAction =
    hasResolvableConflict || (phase !== "syncing" && phase !== "connecting");

  const openCloudSettings = (): void => {
    requestSettingsTarget("cloud");
    setSettingsOpen(true);
  };

  const runCloudAction = (): void => {
    if (phase === "disconnected") {
      void connectCloudAccountFromStatusBar().catch(() => undefined);
      return;
    }
    if (phase === "unlinked") {
      openCloudSettings();
      return;
    }
    if (hasResolvableConflict) {
      openCloudConflictReview();
      return;
    }
    if (phase === "attention") {
      openCloudSettings();
      return;
    }
    void syncCloudVaultWithStatus().catch(() => undefined);
  };

  return (
    <div
      className={[
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        hasResolvableConflict
          ? "rounded-lg border border-warning/30 bg-warning/10 px-2 py-0.5"
          : "",
        separated ? "sm:border-r sm:border-paper-300/70 sm:pr-5" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        data-cloud-sync-status
        role="status"
        title={title}
        className={`inline-flex items-center gap-1.5 font-medium ${statusTone}`}
      >
        <CloudStatusIcon phase={phase} />
        <span className="tabular-nums">{label}</span>
      </span>
      {showAction && (
        <>
          <span aria-hidden="true" className="text-ink-300">
            ·
          </span>
          <button
            type="button"
            data-cloud-sync-action
            title={title}
            aria-label={`${actionLabel}: ${title}`}
            onClick={runCloudAction}
            className="-my-1 rounded-md px-2 py-1 font-normal text-ink-500 transition-colors hover:bg-paper-200/60 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {actionLabel}
          </button>
        </>
      )}
    </div>
  );
}

function CloudStatusIcon({
  phase,
}: {
  phase: Exclude<CloudSyncPhase, "hidden">;
}): JSX.Element {
  if (phase === "syncing" || phase === "connecting") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="h-3.5 w-3.5 animate-spin"
      >
        <path
          d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.8v4h-4"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (phase === "error" || phase === "attention") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="h-3.5 w-3.5"
      >
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M10 6.5v4.2M10 13.8v.1"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (phase === "disconnected" || phase === "unlinked") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="h-3.5 w-3.5"
      >
        <path
          d="M5.3 15.5h9.2a3 3 0 0 0 .5-5.95 4.7 4.7 0 0 0-8.9-1.3 3.6 3.6 0 0 0-.8 7.25Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-3.5 w-3.5"
    >
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="m6.8 10 2.1 2.1 4.4-4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Stat({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return <span className={`tabular-nums ${className}`.trim()}>{children}</span>;
}
