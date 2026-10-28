import { humanIpcError } from "./ipc-error";
import type { ZenBridge } from "@zennotes/bridge-contract/bridge";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import type {
  CloudSyncConflict,
  CloudSyncPendingConflict,
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
import { formatCloudBytes } from "@zennotes/shared-domain/cloud-bytes";
import {
  describeCloudError,
  type CloudErrorCopy,
  type CloudErrorKind,
} from "@zennotes/shared-domain/cloud-error-copy";
import {
  cloudSyncPathKey,
  shouldSyncVaultPath,
} from "@zennotes/shared-domain/cloud-sync";
import {
  CLOUD_VAULT_REMOVED_MESSAGE,
  CLOUD_VAULT_SUPERSEDED_MESSAGE,
} from "@zennotes/shared-domain/cloud-vault-availability";
import { vaultSettingsValueEqual } from "@zennotes/shared-domain/vault-settings-conflict";
import { useToastStore } from "./toast";

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

/**
 * Why a Cloud vault stopped being this device's to sync. Cloud answers "not
 * found" for a vault that no longer exists; "unavailable" is a refusal that
 * names the account instead; "encrypted" is a readable vault another device
 * replaced with an end-to-end encrypted one, which this device can open once
 * it unlocks encryption.
 */
export type CloudVaultRemovalReason = "deleted" | "unavailable" | "encrypted";

export interface CloudVaultRemoval {
  /** The name the link carried, read before the link went away. Null only
   *  when this window never read the link before losing it. */
  vaultName: string | null;
  reason: CloudVaultRemovalReason;
}

interface CloudSyncStatusStore {
  phase: CloudSyncPhase;
  vaultName: string | null;
  lastSyncedAt: number | null;
  /** What the status row and Settings say: a failure's plain sentence, or
   *  what a finished run needs from the person. */
  error: string | null;
  /** The technical line behind a failure, for Settings' Details. */
  errorDetail: string | null;
  /** Null for anything that is not a failure. */
  errorKind: CloudErrorKind | null;
  /** What the last completed run reported, so the status bar's Review can
   *  show the files that need attention without another sync first. */
  lastSummary: CloudSyncRunSummary | null;
  /** Whether the conflict queue is on screen. It lives here, not in the
   *  status bar, so the command palette and the vim leader open the same
   *  queue the status bar's Review now opens. */
  conflictReviewOpen: boolean;
  /** The file the queue opens on: the conflict a note's banner or the new
   *  conflict notification asked about. Null opens the first file. */
  conflictReviewStartId: string | null;
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
  /** The Cloud vault this device was linked to went away and took the link
   *  with it, whether it was deleted here, on another device, or on the
   *  website. On its own the unlinked phase reads like a device nobody set
   *  up, so this stays until the person links or creates a vault, or
   *  dismisses it. */
  removedVault: CloudVaultRemoval | null;
}

const emptyCloudSyncStatus: CloudSyncStatusStore = {
  phase: "hidden",
  vaultName: null,
  lastSyncedAt: null,
  error: null,
  errorDetail: null,
  errorKind: null,
  lastSummary: null,
  conflictReviewOpen: false,
  conflictReviewStartId: null,
  syncWindowLocked: false,
  resolutionSaved: false,
  settingsConflict: null,
  settingsConflictPromptOpen: false,
  removedVault: null,
};

type CloudSyncStatusText = Pick<CloudSyncStatusStore, "error" | "errorDetail" | "errorKind">;

/** Status text that is not a failure: an attention message, or nothing. */
function statusText(message: string | null): CloudSyncStatusText {
  return { error: message, errorDetail: null, errorKind: null };
}

function failureText(copy: CloudErrorCopy): CloudSyncStatusText {
  return { error: copy.message, errorDetail: copy.detail, errorKind: copy.kind };
}

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
/**
 * Where the removed-vault notice outlives a reload: one key per local vault,
 * because the notice is about that vault's link and another vault opened in
 * this window never had it. Null while no runtime runs for a vault, and then
 * the notice lasts the session.
 */
let removedVaultStorageKey: string | null = null;
const conflictDraftFlushers = new Set<() => Promise<void>>();
/**
 * Pending conflict ids this window has already told the user about. Module
 * state like the status store itself: one set per window, gone on reload, and
 * emptied whenever the account or the vault link changes.
 */
const announcedCloudConflictIds = new Set<string>();

/** A review's edits must reach durable storage before sync can retire it. */
export function registerCloudConflictDraftFlusher(
  flush: () => Promise<void>,
): () => void {
  conflictDraftFlushers.add(flush);
  return () => {
    conflictDraftFlushers.delete(flush);
  };
}

/**
 * `vaultKey` names the local vault this runtime syncs (its root), so a notice
 * that its Cloud vault went away survives a reload. Without one the notice
 * lasts the session.
 */
export function startCloudAutoSync(
  bridge: CloudAutoSyncBridge,
  environment: CloudAutoSyncEnvironment = browserCloudAutoSyncEnvironment(),
  timings: CloudAutoSyncTimings = {},
  vaultKey?: string,
): CloudAutoSyncRuntime {
  if (bridge.getCapabilities().supportsCloudSync !== true) {
    clearCloudSyncStatus();
    return { request: () => {}, stop: () => {} };
  }
  restoreRemovedCloudVault(vaultKey);

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
      // Any link at all, even one for another account, is newer than the
      // one that went away.
      if (link !== null) clearRemovedCloudVault();
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
      const copy = cloudSyncErrorCopy(error);
      if (copy.kind !== "signed-out") {
        reportError(error, retryInMs);
        return;
      }
      signOutAfterRefusal(bridge, copy);
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
          ...syncFailure(error),
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
      removedVaultStorageKey = null;
    },
  };
}

export function ensureCloudAutoSyncStarted(vaultKey?: string): void {
  installedRuntime ??= startCloudAutoSync(getZenBridge(), undefined, {}, vaultKey);
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
    markCloudSyncDisconnected(failureText(cloudSyncErrorCopy(error)));
    throw error;
  }
}

export async function syncCloudVaultWithStatus(
  bridge: Pick<CloudAutoSyncBridge, "syncCloudVault"> &
    Partial<
      Pick<CloudAutoSyncBridge, "getCloudVaultLink" | "getCloudSettingsConflict" | "logoutCloudAccount">
    > = getZenBridge(),
  vaultName?: string | null,
): Promise<CloudSyncRunSummary> {
  const current = useCloudSyncStatusStore.getState();
  const nextVaultName = vaultName ?? current.vaultName;
  useCloudSyncStatusStore.setState({
    phase: "syncing",
    vaultName: nextVaultName,
    ...statusText(null),
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
    const copy = cloudSyncErrorCopy(error);
    if (copy.kind === "signed-out") {
      signOutAfterRefusal(bridge, copy);
    } else if (!await refreshRemovedCloudLink(bridge, error)) {
      useCloudSyncStatusStore.setState({
        phase: "error",
        vaultName: nextVaultName,
        ...syncFailure(error),
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
            ...statusText(settledAttention),
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
      ? { phase: "attention", ...statusText(SETTINGS_ATTENTION_MESSAGE) }
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

/**
 * `notePath` is the note in front of the user. When it waits in the queue,
 * the queue opens on it: the conflicted-note banner names the leader binding
 * beside its Review button, so the key has to land where the button does.
 */
export function openPendingCloudReview(notePath?: string | null): void {
  if (hasResolvableCloudConflicts()) {
    const ownConflict = notePath
      ? pendingCloudConflictForPath(useCloudSyncStatusStore.getState().lastSummary, notePath)
      : null;
    openCloudConflictReview(ownConflict?.id);
  } else openCloudSettingsConflictPrompt();
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
  const vaultName = useCloudSyncStatusStore.getState().vaultName;
  markCloudSyncUnlinked(syncFailure(error));
  // The hosts drop a link after a failed request only once Cloud has answered
  // that its vault is gone ("not found") or was replaced by an encrypted one,
  // so a link found gone after a failure means a deleted vault unless the
  // error says it was replaced or names the account instead.
  recordRemovedCloudVault({
    vaultName,
    reason: cloudVaultGoneReason(error) ?? "deleted",
  });
  return true;
}

/**
 * What a refusal says about the vault it concerned: gone ("deleted"), refused
 * to this account ("unavailable"), replaced by an encrypted vault
 * ("encrypted"), or nothing at all (null). Desktop errors cross IPC as text
 * alone, so the hosts' own sentences count beside the status and code an
 * in-process host keeps on the error.
 */
export function cloudVaultGoneReason(
  error: unknown,
): CloudVaultRemovalReason | null {
  const response =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown })
      : {};
  const message = humanIpcError(
    error instanceof Error ? error : new Error(String(error)),
    "",
  );
  if (
    (response.status === 403 && response.code === "FORBIDDEN") ||
    /not available to this account/i.test(message)
  ) {
    return "unavailable";
  }
  if (
    (response.status === 410 && response.code === "VAULT_SUPERSEDED") ||
    message.startsWith(ENCRYPTED_VAULT_SENTENCE)
  ) {
    return "encrypted";
  }
  if (
    (response.status === 404 && response.code === "NOT_FOUND") ||
    message.startsWith(REMOVED_VAULT_SENTENCE)
  ) {
    return "deleted";
  }
  return null;
}

const firstSentence = (message: string): string =>
  message.slice(0, message.indexOf(".") + 1);

/** "This Cloud vault is no longer available.": the first sentence of the
 *  hosts' message for a link they dropped. The advice after it is free to
 *  change. */
const REMOVED_VAULT_SENTENCE = firstSentence(CLOUD_VAULT_REMOVED_MESSAGE);

/** "This Cloud vault is now end-to-end encrypted.": the same for a link they
 *  dropped because another device replaced the vault with an encrypted one. */
const ENCRYPTED_VAULT_SENTENCE = firstSentence(CLOUD_VAULT_SUPERSEDED_MESSAGE);

/**
 * This device deleted the Cloud vault it was linked to. The host has already
 * dropped the link, so the status says so now rather than at the next run,
 * and goes on saying why sync stopped.
 */
export function markCloudVaultDeleted(vaultName: string): void {
  markCloudSyncUnlinked();
  recordRemovedCloudVault({ vaultName, reason: "deleted" });
}

/** The person linked a vault, started a new one, or dismissed the notice. */
export function clearRemovedCloudVault(): void {
  if (useCloudSyncStatusStore.getState().removedVault === null) return;
  useCloudSyncStatusStore.setState({ removedVault: null });
  persistRemovedCloudVault(null);
}

/** True while the status row and Settings say this vault's Cloud vault went
 *  away. Signed out, the row asks to connect first and says nothing of it. */
export function hasCloudVaultRemovalNotice(
  state: Pick<CloudSyncStatusStore, "phase" | "removedVault"> =
    useCloudSyncStatusStore.getState(),
): boolean {
  return state.phase === "unlinked" && state.removedVault !== null;
}

const REMOVAL_LABELS: Record<CloudVaultRemovalReason, string> = {
  deleted: "Cloud vault deleted",
  unavailable: "Cloud vault unavailable",
  encrypted: "Cloud vault now encrypted",
};

/** The status row's words for it, and the heading of the Settings notice. */
export function cloudVaultRemovalLabel(removal: CloudVaultRemoval): string {
  return REMOVAL_LABELS[removal.reason];
}

/**
 * What happened, for the status row's hover and the Settings notice alike,
 * so one event is never told two ways.
 */
export function cloudVaultRemovalMessage(removal: CloudVaultRemoval): string {
  const vault = removal.vaultName
    ? `“${removal.vaultName}”`
    : "The cloud vault this vault synced with";
  const happened: Record<CloudVaultRemovalReason, string> = {
    deleted: `${vault} was deleted from ZenNotes Cloud`,
    unavailable: `${vault} is no longer available to this ZenNotes Cloud account`,
    encrypted: `${vault} was replaced by an end-to-end encrypted Cloud vault`,
  };
  return `${happened[removal.reason]}, so this vault stopped syncing. Your notes on this device are untouched.`;
}

function recordRemovedCloudVault(next: CloudVaultRemoval): void {
  const current = useCloudSyncStatusStore.getState().removedVault;
  // Two failing requests can both find the link gone, and the second no
  // longer knows the name the first one read.
  const removal = next.vaultName === null && current !== null ? current : next;
  useCloudSyncStatusStore.setState({ removedVault: removal });
  persistRemovedCloudVault(removal);
}

function restoreRemovedCloudVault(vaultKey: string | undefined): void {
  removedVaultStorageKey = vaultKey ? `zen.cloud.removedVault.${vaultKey}` : null;
  if (removedVaultStorageKey === null) return;
  let removal: CloudVaultRemoval | null = null;
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(removedVaultStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const { vaultName, reason } = parsed as Record<string, unknown>;
      if (
        (reason === "deleted" || reason === "unavailable" || reason === "encrypted") &&
        (typeof vaultName === "string" || vaultName === null)
      ) {
        removal = { vaultName, reason };
      }
    }
  } catch {
    removal = null;
  }
  useCloudSyncStatusStore.setState({ removedVault: removal });
}

function persistRemovedCloudVault(removal: CloudVaultRemoval | null): void {
  if (removedVaultStorageKey === null || typeof localStorage === "undefined") return;
  try {
    if (removal === null) localStorage.removeItem(removedVaultStorageKey);
    else localStorage.setItem(removedVaultStorageKey, JSON.stringify(removal));
  } catch {
    // Storage can be unavailable (a private window); the notice still lasts
    // the session.
  }
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
  // Resolved here, so a run may bring the same id back before any summary
  // without it arrives: that is a new conflict, and it is announced again.
  announcedCloudConflictIds.delete(conflictId);
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
    ...statusText(attention),
    lastSummary: summary,
    resolutionSaved: false,
    // Do not reopen a finished review on the next unrelated conflict.
    conflictReviewOpen: current.conflictReviewOpen && resolvableCloudConflictCount(summary) > 0,
  });
  announceNewCloudConflicts(summary, current.conflictReviewOpen);
}

/** Long enough to read the sentence and reach Review; the banner, the status
 *  bar and the queue keep the conflict after the toast is gone. */
const NEW_CONFLICT_TOAST_MS = 10_000;

/**
 * One notification per conflict, the first time a run reports it. A phone
 * hides the status bar and zen mode hides it everywhere, so without this a
 * conflict could pause a note with nothing on screen to say so.
 */
function announceNewCloudConflicts(
  summary: CloudSyncRunSummary,
  reviewOpen: boolean,
): void {
  const pending = summary.pending_conflicts ?? [];
  const pendingIds = new Set(pending.map((conflict) => conflict.id));
  for (const id of announcedCloudConflictIds) {
    if (!pendingIds.has(id)) announcedCloudConflictIds.delete(id);
  }
  const fresh = pending.filter((conflict) => !announcedCloudConflictIds.has(conflict.id));
  for (const conflict of fresh) announcedCloudConflictIds.add(conflict.id);
  // An open queue already lists the newcomers; they count as told.
  if (fresh.length === 0 || reviewOpen) return;
  const first = fresh[0];
  const message =
    fresh.length === 1
      ? `“${fileName(first.path).replace(/\.md$/i, "")}” changed on this device and on another device. Sync is paused for it.`
      : `${fresh.length} files changed on this device and on another device. Sync is paused for them.`;
  useToastStore.getState().addToast(
    message,
    "info",
    { label: "Review", onClick: () => openCloudConflictReview(first.id) },
    NEW_CONFLICT_TOAST_MS,
  );
}

/**
 * The phase the status row draws. A device whose Cloud vault went away, or
 * that Cloud signed out, stopped syncing without the person choosing to, so
 * it reads as attention rather than as a quiet unlinked or disconnected row.
 */
export function cloudSyncShownPhase(
  state: Pick<CloudSyncStatusStore, "phase" | "removedVault" | "errorKind">,
): CloudSyncPhase {
  if (state.phase === "unlinked" && state.removedVault !== null) return "attention";
  if (state.phase === "disconnected" && state.errorKind === "signed-out") return "attention";
  return state.phase;
}

/**
 * True while Cloud needs the person: a run that stopped for them or failed
 * (including a Cloud vault that went away and a device Cloud signed out), or
 * files or the vault settings question waiting for a decision. The status
 * bar shows for these even when it is turned off, so nothing that needs an
 * answer goes silent; the phone shells key their Cloud row on the same set
 * (the attention and error phases and the review hook).
 */
export function cloudSyncNeedsUser(
  state: Pick<
    CloudSyncStatusStore,
    "phase" | "removedVault" | "errorKind" | "lastSummary" | "settingsConflict"
  > = useCloudSyncStatusStore.getState(),
): boolean {
  const shown = cloudSyncShownPhase(state);
  return (
    shown === "attention" ||
    shown === "error" ||
    resolvableCloudConflictCount(state.lastSummary) > 0 ||
    state.settingsConflict !== null
  );
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

/**
 * Open the queue, on `conflictId` when one is named and still waiting; the
 * queue then carries on through the rest as usual.
 */
export function openCloudConflictReview(conflictId?: string): void {
  if (!hasResolvableCloudConflicts()) return;
  useCloudSyncStatusStore.setState({
    conflictReviewOpen: true,
    conflictReviewStartId: conflictId ?? null,
  });
}

export function closeCloudConflictReview(): void {
  useCloudSyncStatusStore.setState({
    conflictReviewOpen: false,
    conflictReviewStartId: null,
  });
}

export function clearCloudSyncStatus(): void {
  announcedCloudConflictIds.clear();
  useCloudSyncStatusStore.setState({ ...emptyCloudSyncStatus });
}

/**
 * A path sync cannot carry (a Windows-reserved character such as `:` in a
 * note name) has no key, and is never in the queue. The key function throws
 * for such a path, and the callers here run inside renders.
 */
export function cloudSyncPathKeyOrNull(path: string): string | null {
  try {
    return cloudSyncPathKey(path);
  } catch {
    return null;
  }
}

/**
 * The pending conflict a file belongs to, under the name it has on this
 * device or the one it has in Cloud (a move), compared as sync compares
 * paths: case-folded and Unicode-normalized.
 */
export function pendingCloudConflictForPath(
  summary: CloudSyncRunSummary | null,
  path: string,
): CloudSyncPendingConflict | null {
  const conflicts = summary?.pending_conflicts ?? [];
  if (conflicts.length === 0) return null;
  const key = cloudSyncPathKeyOrNull(path);
  if (key === null) return null;
  return (
    conflicts.find((conflict) =>
      [conflict.path, conflict.cloud_path].some(
        (candidate) => candidate !== null && cloudSyncPathKeyOrNull(candidate) === key,
      ),
    ) ?? null
  );
}

/**
 * What the banner over a conflicted note says. The content case speaks for
 * the open note; delete, move and path conflicts keep the words Settings
 * uses for them, so one conflict is never described two ways.
 */
export function cloudConflictNoteMessage(conflict: CloudSyncPendingConflict): string {
  if (conflict.kind === "content") {
    return "Sync is paused for this note. It changed on this device and on another device.";
  }
  return pendingCloudConflictDetail(conflict);
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
    ...statusText(null),
  });
}

function markCloudSyncDisconnected(failure: CloudSyncStatusText = statusText(null)): void {
  announcedCloudConflictIds.clear();
  const current = useCloudSyncStatusStore.getState();
  // Signing out after Cloud refused this device's sign-in announces the
  // account change too; why it happened stays until the person connects.
  const reason =
    failure.error === null && current.errorKind === "signed-out"
      ? { error: current.error, errorDetail: current.errorDetail, errorKind: current.errorKind }
      : failure;
  useCloudSyncStatusStore.setState({
    phase: "disconnected",
    vaultName: null,
    lastSyncedAt: null,
    resolutionSaved: false,
    ...reason,
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
    ...statusText(null),
  });
}

function markCloudSyncUnlinked(failure: CloudSyncStatusText = statusText(null)): void {
  announcedCloudConflictIds.clear();
  useCloudSyncStatusStore.setState({
    phase: "unlinked",
    vaultName: null,
    lastSyncedAt: null,
    resolutionSaved: false,
    ...failure,
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

let signingOutAfterRefusal: Promise<unknown> | null = null;

/**
 * Cloud no longer accepts this device's sign-in (it was removed from the
 * account on the website, or the sign-in expired). Every later request would
 * be refused the same way, so the device signs out, as if the person had
 * chosen Disconnect, and the status row says why until they connect again.
 * Concurrent refusals (another window, the change check) sign out once.
 */
export function signOutAfterRefusal(
  bridge: Partial<Pick<CloudAutoSyncBridge, "logoutCloudAccount">>,
  copy: CloudErrorCopy,
): void {
  const current = useCloudSyncStatusStore.getState();
  // A failed run reports here and to the controller's onError: one sign-out.
  if (current.phase === "disconnected" && current.errorKind === "signed-out") return;
  markCloudSyncDisconnected(failureText(copy));
  if (!bridge.logoutCloudAccount || signingOutAfterRefusal) return;
  signingOutAfterRefusal = bridge
    .logoutCloudAccount()
    .catch((error: unknown) => {
      console.warn("[cloud-sync] Signing out after a refused sign-in failed", error);
    })
    .finally(() => {
      signingOutAfterRefusal = null;
    });
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

function syncFailure(error: unknown): CloudSyncStatusText {
  const copy = cloudSyncErrorCopy(error);
  const prefix = useCloudSyncStatusStore.getState().resolutionSaved
    ? "Your note was saved, but the rest of the vault didn't sync. "
    : "";
  return failureText({ ...copy, message: prefix + copy.message });
}

/** A failed run or Cloud request in plain words, with its technical line. */
export function cloudSyncErrorCopy(error: unknown): CloudErrorCopy {
  return describeCloudError(error, CLOUD_SYNC_FAILED_MESSAGE);
}

export const CLOUD_SYNC_FAILED_MESSAGE = "Sync didn't finish. Choose Sync now to try again.";

function firstCapacityConflict(summary: CloudSyncRunSummary): CloudSyncConflict | undefined {
  return summary.conflicts.find((conflict) =>
    [
      "QUOTA_EXCEEDED",
      "CAPACITY_EXCEEDED",
      "FILE_SIZE_LIMIT_EXCEEDED",
    ].includes(conflict.code),
  );
}

/** Each file the run left on this device for being over the per-file limit. */
export function oversizedFileConflicts(summary: CloudSyncRunSummary): CloudSyncConflict[] {
  const seen = new Set<string>();
  return summary.conflicts.filter((conflict) => {
    const oversized =
      conflict.code === "FILE_SIZE_LIMIT_EXCEEDED" ||
      conflict.capacity?.dimension === "sync_max_file_bytes";
    if (!oversized || seen.has(conflict.item_id)) return false;
    seen.add(conflict.item_id);
    return true;
  });
}

/**
 * The few words the status row and the Settings heading give a run that could
 * not finish because of a Cloud limit. A phone has no hover to show the
 * sentence behind "Sync incomplete", so the limit names itself. Null when the
 * run stopped for any other reason.
 */
export function cloudSyncAttentionLabel(
  summary: CloudSyncRunSummary | null,
): string | null {
  if (!summary) return null;
  const capacityConflict = firstCapacityConflict(summary);
  if (!capacityConflict) return null;
  const dimension = capacityConflict.capacity?.dimension;
  if (dimension === "sync_max_file_bytes" || capacityConflict.code === "FILE_SIZE_LIMIT_EXCEEDED") {
    const count = Math.max(1, oversizedFileConflicts(summary).length);
    return `${count} ${count === 1 ? "file" : "files"} too large for Cloud`;
  }
  if (dimension === "sync_active_bytes") return "Cloud storage full";
  if (dimension === "sync_active_items") return "Cloud file limit reached";
  return "Cloud capacity reached";
}

export function cloudSyncAttentionMessage(
  summary: CloudSyncRunSummary,
): string | null {
  const capacityConflict = firstCapacityConflict(summary);
  if (capacityConflict) {
    const capacity = capacityConflict.capacity;
    if (capacity?.dimension === "sync_active_items") {
      return `Your ZenNotes Cloud plan holds up to ${formatCount(capacity.limit)} files across your account, and you have reached that. New files are waiting on this device. Delete files you no longer need, or change your plan under Billing on zennotes.org.`;
    }
    if (capacity?.dimension === "sync_active_bytes") {
      return `Your ZenNotes Cloud storage is full (${formatCloudBytes(capacity.used + capacity.reserved)} of ${formatCloudBytes(capacity.limit)}), so new and changed files are waiting on this device. Delete large files you no longer need, or add storage under Billing on zennotes.org.`;
    }
    if (capacity?.dimension === "sync_max_file_bytes") {
      // Name the file: "a file" sent people hunting through the whole vault.
      const limit = formatCloudBytes(capacity.limit);
      const oversized = oversizedFileConflicts(summary);
      const onlyPath = oversized.length === 1 ? oversized[0].path : null;
      if (oversized.length > 1) {
        return `${oversized.length} files are larger than the ${limit} Cloud file-size limit, so they stay on this device. Remove them or make them smaller to finish syncing.`;
      }
      return `${onlyPath ? `“${fileName(onlyPath)}”` : "A file"} is larger than the ${limit} Cloud file-size limit, so it stays on this device. Remove it or make it smaller to finish syncing.`;
    }
    return "Your ZenNotes Cloud plan is full, so some changes are waiting on this device. Delete files you no longer need, or change your plan under Billing on zennotes.org.";
  }

  const decisionCount =
    (summary.pending_conflicts?.length ?? 0) +
    (summary.bootstrap_conflicts?.length ?? 0);
  if (decisionCount > 0) {
    const count = decisionCount;
    return `${count} ${count === 1 ? "file was" : "files were"} changed both on this device and on another device. Choose Review to decide what to keep.`;
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
    return `${count} ${count === 1 ? "change" : "changes"} didn't sync. The list below says what happened to each file.`;
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
  /** What Cloud answered, for Details, when the row could not say more. */
  technical?: string | null;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "50,000": English grouping, like the rest of these sentences. */
function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function pendingCloudConflictDetail(conflict: CloudSyncPendingConflict): string {
  return conflict.kind === "delete"
    ? "This file was edited here and deleted on another device. Choose whether to keep the note or delete it everywhere."
    : conflict.kind === "move"
      ? "This file was changed here and moved on another device. Review its contents and location before sync continues."
      : conflict.kind === "path"
        ? "Another file already uses this name. Choose a clear name for each file."
        : conflict.can_merge
          ? "The same part of this note changed on two devices. Review the suggested combined note."
          : "Different versions exist on this device and another device. Choose what to keep.";
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
    items.push({
      kind: "pending",
      path: conflict.path,
      detail: pendingCloudConflictDetail(conflict),
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
    const path = conflict.path ?? conflict.current_path ?? "A file";
    const detail =
      conflict.code === "REVISION_CONFLICT"
        ? "Changed on another device after this device last synced. Sync again to load both versions into the resolver."
        : conflict.code === "PATH_CONFLICT"
          ? `Another Cloud file already uses this name${conflict.current_path && conflict.current_path !== path ? ` (${conflict.current_path})` : ""}. Rename one of them and sync again.`
          : conflict.code === "ITEM_DELETED"
            ? "Deleted on another device while this device still had a change. Sync again to choose whether to keep or delete it."
            : "ZenNotes Cloud didn't accept this change. Choose Sync now to retry; if it stays, copy the details and choose Report an Issue.";
    const known = ["REVISION_CONFLICT", "PATH_CONFLICT", "ITEM_DELETED"].includes(conflict.code);
    items.push({
      kind: "rejected",
      path,
      detail,
      conflictCopyPath: null,
      technical: known ? null : `${conflict.code} · item ${conflict.item_id}`,
    });
  }
  return items;
}

// The hosts word a refused backup's size before it crosses IPC as text, so
// the formatter lives in shared-domain; this keeps the app-core import path.
export { formatCloudBytes } from "@zennotes/shared-domain/cloud-bytes";
