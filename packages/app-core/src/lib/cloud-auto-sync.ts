import { humanIpcError } from "./ipc-error";
import type { ZenBridge } from "@zennotes/bridge-contract/bridge";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import type {
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
} from "@zennotes/bridge-contract/cloud-sync";
import type { VaultChangeEvent } from "@shared/ipc";
import { create } from "zustand";
import {
  CloudAutoSyncController,
  type CloudAutoSyncControllerOptions,
  type CloudAutoSyncReason,
} from "@zennotes/shared-domain/cloud-auto-sync";
import { shouldSyncVaultPath } from "@zennotes/shared-domain/cloud-sync";
import { vaultSettingsValueEqual } from "@zennotes/shared-domain/vault-settings-conflict";

/** A host without the settings question (the web client's bridge answers it
 *  with null; a test bridge may leave it out) simply never asks it. */
type CloudSettingsConflictBridge = Partial<
  Pick<ZenBridge, "getCloudSettingsConflict">
>;

export type CloudAutoSyncBridge = Pick<
  ZenBridge,
  | "getCapabilities"
  | "getCloudAccountStatus"
  | "logoutCloudAccount"
  | "getCloudVaultLink"
  | "syncCloudVault"
  | "hasCloudVaultChanges"
  | "onCloudSyncWindow"
  | "onVaultChange"
  | "onCloudAccountChange"
> &
  CloudSettingsConflictBridge;

export interface CloudAutoSyncEnvironment {
  online(): boolean;
  active(): boolean;
  onOnline(listener: () => void): () => void;
  onForeground(listener: () => void): () => void;
}

export interface CloudAutoSyncRuntime {
  request(reason: CloudAutoSyncReason): void;
  stop(): void;
}

export type CloudSyncPhase =
  | "hidden"
  | "disconnected"
  | "connecting"
  | "unlinked"
  | "ready"
  | "syncing"
  | "attention"
  | "error";

interface CloudSyncStatusStore {
  phase: CloudSyncPhase;
  vaultName: string | null;
  lastSyncedAt: number | null;
  error: string | null;
  /** What the last completed run reported, so the status bar's Review can
   *  show the files that need attention without another sync first. */
  lastSummary: CloudSyncRunSummary | null;
  /** Whether the conflict queue is on screen. It lives here, not in the
   *  status bar, so the command palette and the vim leader open the same
   *  queue the status bar's Review now opens. */
  conflictReviewOpen: boolean;
  /** Remains locked even if this window's own controller refreshes its status. */
  syncWindowLocked: boolean;
  /** A note was saved, but the following whole-vault sync has not completed. */
  resolutionSaved: boolean;
  /** The vault settings question, while one is pending: sync parked the
   *  cloud's vault.json beside this device's and waits for an answer. It is
   *  read from the parked copy after every run, not from the run summary,
   *  because only the run that parked it reports it and the question stays
   *  open long after that summary is gone. */
  settingsConflict: CloudSyncSettingsConflict | null;
  /** Whether the settings prompt is on screen. Lives here for the same reason
   *  as conflictReviewOpen: the status bar, the palette, the leader binding
   *  and the sync runtime itself all open the one prompt. */
  settingsConflictPromptOpen: boolean;
}

const emptyCloudSyncStatus: CloudSyncStatusStore = {
  phase: "hidden",
  vaultName: null,
  lastSyncedAt: null,
  error: null,
  lastSummary: null,
  conflictReviewOpen: false,
  syncWindowLocked: false,
  resolutionSaved: false,
  settingsConflict: null,
  settingsConflictPromptOpen: false,
};

const SETTINGS_ATTENTION_MESSAGE =
  "Vault settings differ on this device and in Cloud. Choose which settings to use.";

export const useCloudSyncStatusStore = create<CloudSyncStatusStore>(() => ({
  ...emptyCloudSyncStatus,
}));

/**
 * Phases in which a ZenNotes Cloud account is signed in on this device.
 * Publishing a note talks to the account, not to a linked vault, so
 * `unlinked` counts; `hidden` (no cloud capability, or status not yet
 * known), `disconnected` and `connecting` do not.
 */
export function isCloudAccountConnectedPhase(phase: CloudSyncPhase): boolean {
  return phase !== "hidden" && phase !== "disconnected" && phase !== "connecting";
}

type CloudAutoSyncTimings = Pick<
  CloudAutoSyncControllerOptions,
  "debounceMs" | "intervalMs" | "retryDelaysMs" | "onError"
>;

let installedRuntime: CloudAutoSyncRuntime | null = null;
const conflictDraftFlushers = new Set<() => Promise<void>>();

/** A review's edits must reach durable storage before sync can retire it. */
export function registerCloudConflictDraftFlusher(
  flush: () => Promise<void>,
): () => void {
  conflictDraftFlushers.add(flush);
  return () => {
    conflictDraftFlushers.delete(flush);
  };
}

export function startCloudAutoSync(
  bridge: CloudAutoSyncBridge,
  environment: CloudAutoSyncEnvironment = browserCloudAutoSyncEnvironment(),
  timings: CloudAutoSyncTimings = {},
): CloudAutoSyncRuntime {
  if (bridge.getCapabilities().supportsCloudSync !== true) {
    clearCloudSyncStatus();
    return { request: () => {}, stop: () => {} };
  }

  const reportError = timings.onError ?? logAutomaticSyncError;
  const controller = new CloudAutoSyncController({
    ready: async () => {
      const status = await bridge.getCloudAccountStatus();
      if (status.state === "connecting") {
        markCloudSyncConnecting();
        return false;
      }
      if (status.state !== "connected" || !status.account) {
        markCloudSyncDisconnected();
        return false;
      }

      const link = await bridge.getCloudVaultLink();
      if (link === null || link.base_url !== status.account.base_url) {
        markCloudSyncUnlinked();
        return false;
      }

      markCloudSyncReady(link.vault_name);
      return true;
    },
    sync: async () => {
      await syncCloudVaultWithStatus(bridge);
    },
    checkRemoteChanges: bridge.hasCloudVaultChanges
      ? async () => {
          const state = useCloudSyncStatusStore.getState();
          if (!state.vaultName || !isCloudAccountConnectedPhase(state.phase)) return false;
          try {
            return await bridge.hasCloudVaultChanges!();
          } catch (error) {
            await refreshRemovedCloudLink(bridge, error);
            throw error;
          }
        }
      : undefined,
    online: environment.online,
    active: environment.active,
    debounceMs: timings.debounceMs,
    intervalMs: timings.intervalMs,
    retryDelaysMs: timings.retryDelaysMs,
    onError(error, retryInMs) {
      if (!isUnauthorizedCloudError(error)) {
        reportError(error, retryInMs);
        return;
      }

      void bridge.logoutCloudAccount().catch((logoutError) => {
        reportError(logoutError, retryInMs);
      });
    },
  });
  const unsubscribeVault = bridge.onVaultChange((event) => {
    if (isSyncableVaultChange(event)) controller.request("local-change");
  });
  const unsubscribeSyncWindow = bridge.onCloudSyncWindow?.({
    async prepare() {
      useCloudSyncStatusStore.setState({ syncWindowLocked: true });
      await Promise.all([...conflictDraftFlushers].map((flush) => flush()));
    },
    finished(summary, error) {
      if (summary) applyCloudSyncSummary(summary);
      else if (error) {
        useCloudSyncStatusStore.setState({
          phase: "error",
          error: syncFailureMessage(error),
        });
        void refreshRemovedCloudLink(bridge, error);
      }
      useCloudSyncStatusStore.setState({ syncWindowLocked: false });
      // The other window's run may have parked, replaced or (after an answer
      // there) removed the settings question; this window's status follows.
      void refreshCloudSettingsConflict(bridge);
    },
  });
  const unsubscribeAccount = bridge.onCloudAccountChange((status) => {
    if (status.state === "connecting") markCloudSyncConnecting();
    if (status.state === "disconnected") markCloudSyncDisconnected();
    controller.request("account-change");
  });
  const unsubscribeOnline = environment.onOnline(() =>
    controller.request("online"),
  );
  const unsubscribeForeground = environment.onForeground(() =>
    controller.request("foreground"),
  );

  controller.start();

  return {
    request: (reason) => controller.request(reason),
    stop() {
      controller.stop();
      unsubscribeVault();
      unsubscribeSyncWindow?.();
      unsubscribeAccount();
      unsubscribeOnline();
      unsubscribeForeground();
    },
  };
}

export function ensureCloudAutoSyncStarted(): void {
  installedRuntime ??= startCloudAutoSync(getZenBridge());
}

export function requestCloudAutoSync(reason: CloudAutoSyncReason): void {
  installedRuntime?.request(reason);
}

export async function connectCloudAccountFromStatusBar(
  bridge: Pick<ZenBridge, "connectCloudAccount"> = getZenBridge(),
): Promise<void> {
  markCloudSyncConnecting();
  try {
    await bridge.connectCloudAccount();
  } catch (error) {
    markCloudSyncDisconnected(cloudSyncErrorMessage(error));
    throw error;
  }
}

export async function syncCloudVaultWithStatus(
  bridge: Pick<CloudAutoSyncBridge, "syncCloudVault"> &
    Partial<Pick<CloudAutoSyncBridge, "getCloudVaultLink" | "getCloudSettingsConflict">> = getZenBridge(),
  vaultName?: string | null,
): Promise<CloudSyncRunSummary> {
  const current = useCloudSyncStatusStore.getState();
  const nextVaultName = vaultName ?? current.vaultName;
  useCloudSyncStatusStore.setState({
    phase: "syncing",
    vaultName: nextVaultName,
    error: null,
  });

  try {
    if (conflictDraftFlushers.size > 0) {
      await Promise.all([...conflictDraftFlushers].map((flush) => flush()));
    }
    const summary = await bridge.syncCloudVault();
    // Read the settings question before the run's status is drawn from the
    // summary, so a still-open question is part of that status rather than a
    // correction to it a moment later.
    await refreshCloudSettingsConflict(bridge);
    applyCloudSyncSummary(summary, nextVaultName);
    return summary;
  } catch (error) {
    if (!await refreshRemovedCloudLink(bridge, error)) {
      useCloudSyncStatusStore.setState({
        phase: "error",
        vaultName: nextVaultName,
        error: syncFailureMessage(error),
      });
    }
    // The parked copy is local, so a failed run can still surface a question
    // an earlier run left behind (the first run after a restart, offline).
    void refreshCloudSettingsConflict(bridge);
    throw error;
  }
}

/**
 * Re-read the pending vault settings question from the host and fold it into
 * the status. Safe with a bridge that cannot answer it (the web client, a
 * remote vault): such a host has no question to ask.
 */
export async function refreshCloudSettingsConflict(
  bridge: CloudSettingsConflictBridge = getZenBridge(),
): Promise<void> {
  if (!bridge.getCloudSettingsConflict) return;
  let next: CloudSyncSettingsConflict | null;
  try {
    next = (await bridge.getCloudSettingsConflict()) ?? null;
  } catch {
    next = null;
  }
  applyCloudSettingsConflict(next);
}

function applyCloudSettingsConflict(next: CloudSyncSettingsConflict | null): void {
  const current = useCloudSyncStatusStore.getState();
  const previous = current.settingsConflict;
  if (next === null) {
    if (previous === null) return;
    // Answered, here or in another window. A status that only spoke of the
    // question goes back to what the last run reported; the summary of the
    // run that parked it still lists it, and that entry is now stale.
    const settledAttention =
      current.phase === "attention" && current.error === SETTINGS_ATTENTION_MESSAGE
        ? attentionMessageWithoutSettings(current.lastSummary)
        : undefined;
    useCloudSyncStatusStore.setState({
      settingsConflict: null,
      settingsConflictPromptOpen: false,
      ...(settledAttention === undefined
        ? {}
        : {
            phase: settledAttention === null ? "ready" : "attention",
            error: settledAttention,
          }),
    });
    return;
  }
  // The prompt opens itself for a new question, and again when the cloud's
  // copy changed underneath a postponed one (sync replaces the parked copy
  // with the newest cloud version). It does not reopen the same postponed
  // question on every run: "Decide later" means that.
  const newQuestion =
    previous === null ||
    !vaultSettingsValueEqual(previous.cloud_settings, next.cloud_settings);
  useCloudSyncStatusStore.setState({
    settingsConflict: next,
    settingsConflictPromptOpen: current.settingsConflictPromptOpen || newQuestion,
    ...(current.phase === "ready"
      ? { phase: "attention", error: SETTINGS_ATTENTION_MESSAGE }
      : {}),
  });
}

function attentionMessageWithoutSettings(
  summary: CloudSyncRunSummary | null,
): string | null {
  if (summary === null) return null;
  const attention = cloudSyncAttentionMessage(summary);
  return attention === SETTINGS_ATTENTION_MESSAGE ? null : attention;
}

/** True while sync waits for an answer about the vault settings. */
export function hasPendingCloudSettingsConflict(): boolean {
  return useCloudSyncStatusStore.getState().settingsConflict !== null;
}

/**
 * True when the settings question is the only thing keeping the status at
 * attention, so a status surface can say "settings" instead of the generic
 * "incomplete" and open the prompt directly. Capacity trouble or rejected
 * changes alongside it keep the generic wording: those are read in Settings.
 */
export function cloudSyncAttentionIsSettingsOnly(
  state: Pick<CloudSyncStatusStore, "phase" | "error" | "settingsConflict"> =
    useCloudSyncStatusStore.getState(),
): boolean {
  return (
    state.phase === "attention" &&
    state.settingsConflict !== null &&
    state.error === SETTINGS_ATTENTION_MESSAGE
  );
}

export function openCloudSettingsConflictPrompt(): void {
  if (!hasPendingCloudSettingsConflict()) return;
  useCloudSyncStatusStore.setState({ settingsConflictPromptOpen: true });
}

/** Postpones the question. Nothing is applied: this device's settings stay in
 *  use and the cloud's copy stays parked until the prompt is answered. */
export function closeCloudSettingsConflictPrompt(): void {
  useCloudSyncStatusStore.setState({ settingsConflictPromptOpen: false });
}

/**
 * Answer the question on the host and sync the answer. Keeping this device's
 * settings only drops the parked copy, which is not itself a synced file, so
 * the run that pushes the local settings up has to be asked for here.
 */
export async function resolveCloudSettingsConflictWithStatus(
  choice: CloudSyncSettingsChoice,
  bridge: Pick<ZenBridge, "resolveCloudSettingsConflict"> &
    CloudSettingsConflictBridge = getZenBridge(),
): Promise<void> {
  await bridge.resolveCloudSettingsConflict(choice);
  await refreshCloudSettingsConflict(bridge);
  requestCloudAutoSync("local-change");
}

/**
 * Whatever Cloud is waiting on the user for, most urgent first: the file
 * queue outranks the settings question, because its files cannot sync at all
 * until answered. One entry point so the status bar, the palette entry and
 * the leader binding agree on what "review" opens.
 */
export function hasPendingCloudReview(): boolean {
  return hasResolvableCloudConflicts() || hasPendingCloudSettingsConflict();
}

export function openPendingCloudReview(): void {
  if (hasResolvableCloudConflicts()) openCloudConflictReview();
  else openCloudSettingsConflictPrompt();
}

async function refreshRemovedCloudLink(
  bridge: Partial<Pick<CloudAutoSyncBridge, "getCloudVaultLink">>,
  error: unknown,
): Promise<boolean> {
  if (!bridge.getCloudVaultLink) return false;
  try {
    if (await bridge.getCloudVaultLink() !== null) return false;
  } catch {
    return false;
  }
  markCloudSyncUnlinked(syncFailureMessage(error));
  return true;
}

/** Retire only the acknowledged decision, not the status of the whole vault. */
export function acknowledgeCloudConflictResolution(
  conflictId: string,
  fallbackSummary: CloudSyncRunSummary,
): CloudSyncRunSummary {
  const current = useCloudSyncStatusStore.getState();
  // Linking or restoring can present a new queue before the shared run status
  // catches up. Never replace that queue with an older, unrelated summary.
  const previous = current.lastSummary?.pending_conflicts?.some(
    (item) => item.id === conflictId,
  ) ? current.lastSummary : fallbackSummary;
  const summary = {
    ...previous,
    pending_conflicts:
      previous.pending_conflicts?.filter((item) => item.id !== conflictId) ?? [],
  };
  useCloudSyncStatusStore.setState({
    lastSummary: summary,
    resolutionSaved: true,
    conflictReviewOpen:
      current.conflictReviewOpen && resolvableCloudConflictCount(summary) > 0,
  });
  return summary;
}

function applyCloudSyncSummary(summary: CloudSyncRunSummary, vaultName?: string | null): void {
  const current = useCloudSyncStatusStore.getState();
  // A run that reports nothing new has still not synced the vault settings
  // while the question from an earlier run is open.
  const attention =
    cloudSyncAttentionMessage(summary) ??
    (current.settingsConflict !== null ? SETTINGS_ATTENTION_MESSAGE : null);
  useCloudSyncStatusStore.setState({
    phase: attention === null ? "ready" : "attention",
    vaultName: vaultName ?? current.vaultName,
    lastSyncedAt: attention === null ? Date.now() : current.lastSyncedAt,
    error: attention,
    lastSummary: summary,
    resolutionSaved: false,
    // Do not reopen a finished review on the next unrelated conflict.
    conflictReviewOpen: current.conflictReviewOpen && resolvableCloudConflictCount(summary) > 0,
  });
}

/** Conflicts the queue can actually resolve. Bootstrap conflicts are no longer
 *  emitted by the coordinator, so only the durable pending queue counts. */
export function resolvableCloudConflictCount(
  summary: CloudSyncRunSummary | null,
): number {
  return summary?.pending_conflicts?.length ?? 0;
}

/** True when there is a conflict queue worth opening. */
export function hasResolvableCloudConflicts(): boolean {
  return (
    resolvableCloudConflictCount(useCloudSyncStatusStore.getState().lastSummary) > 0
  );
}

export function openCloudConflictReview(): void {
  if (!hasResolvableCloudConflicts()) return;
  useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
}

export function closeCloudConflictReview(): void {
  useCloudSyncStatusStore.setState({ conflictReviewOpen: false });
}

export function clearCloudSyncStatus(): void {
  useCloudSyncStatusStore.setState({ ...emptyCloudSyncStatus });
}

export function formatRelativeSyncTime(
  lastSyncedAt: number,
  now = Date.now(),
): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - lastSyncedAt) / 1_000));
  if (elapsedSeconds < 45) return "just now";
  if (elapsedSeconds < 90) return "1m ago";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

export function stopCloudAutoSync(): void {
  installedRuntime?.stop();
  installedRuntime = null;
  clearCloudSyncStatus();
}

function markCloudSyncReady(vaultName: string): void {
  const current = useCloudSyncStatusStore.getState();
  useCloudSyncStatusStore.setState({
    phase: "ready",
    vaultName,
    lastSyncedAt: current.vaultName === vaultName ? current.lastSyncedAt : null,
    resolutionSaved: current.vaultName === vaultName && current.resolutionSaved,
    error: null,
  });
}

function markCloudSyncDisconnected(error: string | null = null): void {
  useCloudSyncStatusStore.setState({
    phase: "disconnected",
    vaultName: null,
    lastSyncedAt: null,
    resolutionSaved: false,
    error,
    settingsConflict: null,
    settingsConflictPromptOpen: false,
  });
}

function markCloudSyncConnecting(): void {
  useCloudSyncStatusStore.setState({
    phase: "connecting",
    vaultName: null,
    lastSyncedAt: null,
    resolutionSaved: false,
    error: null,
  });
}

function markCloudSyncUnlinked(error: string | null = null): void {
  useCloudSyncStatusStore.setState({
    phase: "unlinked",
    vaultName: null,
    lastSyncedAt: null,
    resolutionSaved: false,
    error,
    lastSummary: null,
    conflictReviewOpen: false,
    // Unlinking leaves the parked copy on disk, but there is no cloud to
    // answer to; linking again asks afresh.
    settingsConflict: null,
    settingsConflictPromptOpen: false,
  });
}

function isSyncableVaultChange(event: VaultChangeEvent): boolean {
  if (event.scope === "resync") return false;
  return shouldSyncVaultPath(event.path);
}

function isUnauthorizedCloudError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 401
  );
}

function browserCloudAutoSyncEnvironment(): CloudAutoSyncEnvironment {
  return {
    online: () => navigator.onLine !== false,
    active: () => document.visibilityState !== "hidden",
    onOnline(listener) {
      window.addEventListener("online", listener);
      return () => window.removeEventListener("online", listener);
    },
    onForeground(listener) {
      const onVisibilityChange = (): void => {
        if (document.visibilityState !== "hidden") listener();
      };
      window.addEventListener("focus", listener);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        window.removeEventListener("focus", listener);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    },
  };
}

function logAutomaticSyncError(error: unknown, retryInMs: number): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[cloud-sync] Automatic sync failed; retrying in ${retryInMs}ms: ${message}`,
  );
}

function syncFailureMessage(error: unknown): string {
  const prefix = useCloudSyncStatusStore.getState().resolutionSaved
    ? "Note saved. Remaining vault sync failed: "
    : "";
  return prefix + cloudSyncErrorMessage(error);
}

function cloudSyncErrorMessage(error: unknown): string {
  return humanIpcError(error instanceof Error ? error : new Error(String(error)), "Cloud sync failed.");
}

export function cloudSyncAttentionMessage(
  summary: CloudSyncRunSummary,
): string | null {
  const capacityConflict = summary.conflicts.find((conflict) =>
    [
      "QUOTA_EXCEEDED",
      "CAPACITY_EXCEEDED",
      "FILE_SIZE_LIMIT_EXCEEDED",
    ].includes(conflict.code),
  );
  if (capacityConflict) {
    const capacity = capacityConflict.capacity;
    if (capacity?.dimension === "sync_active_items") {
      return `Cloud active-item limit reached (${capacity.used + capacity.reserved} of ${capacity.limit}). Remove files or increase your Cloud capacity.`;
    }
    if (capacity?.dimension === "sync_active_bytes") {
      return `Cloud storage limit reached (${formatCloudBytes(capacity.used + capacity.reserved)} of ${formatCloudBytes(capacity.limit)}). Remove files or increase your Cloud capacity.`;
    }
    if (capacity?.dimension === "sync_max_file_bytes") {
      return `A file exceeds the ${formatCloudBytes(capacity.limit)} Cloud file-size limit. Reduce or remove the oversized file to finish syncing.`;
    }
    return "Cloud capacity reached. Remove files or increase your Cloud capacity.";
  }

  const decisionCount =
    (summary.pending_conflicts?.length ?? 0) +
    (summary.bootstrap_conflicts?.length ?? 0);
  if (decisionCount > 0) {
    const count = decisionCount;
    return `Cloud sync needs attention: ${count} ${count === 1 ? "file differs" : "files differ"} on this device and in Cloud.`;
  }
  if (summary.local_conflicts.length > 0) {
    const count = summary.local_conflicts.length;
    if (summary.local_conflicts.every((conflict) => conflict.code === "SETTINGS_CONFLICT")) {
      return SETTINGS_ATTENTION_MESSAGE;
    }
    return `Cloud sync kept both versions of ${count} changed ${count === 1 ? "file" : "files"}. Review the conflict copies.`;
  }
  if (summary.conflicts.length > 0) {
    const count = summary.conflicts.length;
    return `Cloud sync needs attention: ${count} ${count === 1 ? "change could" : "changes could"} not be applied.`;
  }

  return null;
}

const CAPACITY_CODES = new Set([
  "QUOTA_EXCEEDED",
  "CAPACITY_EXCEEDED",
  "FILE_SIZE_LIMIT_EXCEEDED",
]);

export interface CloudSyncAttentionItem {
  kind:
    | "pending"
    | "legacy"
    | "kept-both"
    | "kept-local"
    | "settings"
    | "bootstrap"
    | "rejected";
  /** The file on this device the item is about. */
  path: string;
  /** What happened and what to do, in plain words. */
  detail: string;
  /** Where the Cloud version was parked, when there is one to look at. */
  conflictCopyPath: string | null;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * One row per file that needs the user's eyes, from a run summary. Capacity
 * rejections are not listed: they are queued uploads that retry on their own,
 * and the summary already says how many. Everything else names the file and
 * says what sync did with it, because "1 change could not be applied" with
 * nothing to open is a dead end (Discord).
 */
export function cloudSyncAttentionItems(
  summary: CloudSyncRunSummary,
): CloudSyncAttentionItem[] {
  const items: CloudSyncAttentionItem[] = [];
  for (const conflict of summary.pending_conflicts ?? []) {
    const detail =
      conflict.kind === "delete"
        ? "This file was edited here and deleted on another device. Choose whether to keep the note or delete it everywhere."
        : conflict.kind === "move"
          ? "This file was changed here and moved on another device. Review its contents and location before sync continues."
          : conflict.kind === "path"
            ? "Another file already uses this name. Choose a clear name for each file."
            : conflict.can_merge
              ? "The same part of this note changed on two devices. Review the suggested combined note."
              : "Different versions exist on this device and another device. Choose what to keep.";
    items.push({
      kind: "pending",
      path: conflict.path,
      detail,
      conflictCopyPath: null,
    });
  }
  for (const copy of summary.legacy_conflict_copies ?? []) {
    items.push({
      kind: "legacy",
      path: copy.path,
      detail: `This looks like a copy made by an older sync version. Compare it with ${fileName(copy.original_path)}, then keep it or move it to Trash.`,
      conflictCopyPath: null,
    });
  }
  // Still read, still tolerant: the field remains on the wire (and in other
  // hosts' summaries) even though this coordinator always sends it empty.
  for (const conflict of summary.bootstrap_conflicts ?? []) {
    items.push({
      kind: "bootstrap",
      path: conflict.path,
      detail:
        "Different versions use this filename on this device and in Cloud. Compare them and choose what to keep before sync continues.",
      conflictCopyPath: null,
    });
  }
  for (const conflict of summary.local_conflicts) {
    if (conflict.code === "SETTINGS_CONFLICT") {
      items.push({
        kind: "settings",
        path: conflict.path,
        detail:
          "Vault settings differ from the cloud. Compare them and choose which to keep from the card above.",
        conflictCopyPath: null,
      });
    } else if (conflict.conflict_copy_path) {
      items.push({
        kind: "kept-both",
        path: conflict.path,
        detail: `Edited on this device and in Cloud. Your version stays in place; the Cloud version is beside it as ${fileName(conflict.conflict_copy_path)}.`,
        conflictCopyPath: conflict.conflict_copy_path,
      });
    } else {
      items.push({
        kind: "kept-local",
        path: conflict.path,
        detail:
          "Cloud removed or moved this file, but it was edited on this device. Your version was kept and will be uploaded again.",
        conflictCopyPath: null,
      });
    }
  }
  for (const conflict of summary.conflicts) {
    if (CAPACITY_CODES.has(conflict.code)) continue;
    const path = conflict.path ?? conflict.current_path ?? `item ${conflict.item_id}`;
    const detail =
      conflict.code === "REVISION_CONFLICT"
        ? "Changed on another device after this device last synced. Sync again to load both versions into the resolver."
        : conflict.code === "PATH_CONFLICT"
          ? `Another Cloud file already uses this name${conflict.current_path && conflict.current_path !== path ? ` (${conflict.current_path})` : ""}. Rename one of them and sync again.`
          : conflict.code === "ITEM_DELETED"
            ? "Deleted on another device while this device still had a change. Sync again to choose whether to keep or delete it."
            : `Cloud rejected this change (${conflict.code}).`;
    items.push({ kind: "rejected", path, detail, conflictCopyPath: null });
  }
  return items;
}

function formatCloudBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
