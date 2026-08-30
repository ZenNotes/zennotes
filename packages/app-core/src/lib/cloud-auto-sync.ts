import type { ZenBridge } from "@zennotes/bridge-contract/bridge";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import type { CloudSyncRunSummary } from "@zennotes/bridge-contract/cloud-sync";
import type { VaultChangeEvent } from "@shared/ipc";
import { create } from "zustand";
import {
  CloudAutoSyncController,
  type CloudAutoSyncControllerOptions,
  type CloudAutoSyncReason,
} from "@zennotes/shared-domain/cloud-auto-sync";
import { shouldSyncVaultPath } from "@zennotes/shared-domain/cloud-sync";

export type CloudAutoSyncBridge = Pick<
  ZenBridge,
  | "getCapabilities"
  | "getCloudAccountStatus"
  | "logoutCloudAccount"
  | "getCloudVaultLink"
  | "syncCloudVault"
  | "onVaultChange"
  | "onCloudAccountChange"
>;

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
}

const emptyCloudSyncStatus: CloudSyncStatusStore = {
  phase: "hidden",
  vaultName: null,
  lastSyncedAt: null,
  error: null,
  lastSummary: null,
};

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
  bridge: Pick<CloudAutoSyncBridge, "syncCloudVault"> = getZenBridge(),
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
    const summary = await bridge.syncCloudVault();
    const attention = cloudSyncAttentionMessage(summary);
    if (attention !== null) {
      useCloudSyncStatusStore.setState({
        phase: "attention",
        vaultName: nextVaultName,
        lastSyncedAt: current.lastSyncedAt,
        error: attention,
        lastSummary: summary,
      });
      return summary;
    }
    useCloudSyncStatusStore.setState({
      phase: "ready",
      vaultName: nextVaultName,
      lastSyncedAt: Date.now(),
      error: null,
      lastSummary: summary,
    });
    return summary;
  } catch (error) {
    useCloudSyncStatusStore.setState({
      phase: "error",
      vaultName: nextVaultName,
      error: cloudSyncErrorMessage(error),
    });
    throw error;
  }
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
    error: null,
  });
}

function markCloudSyncDisconnected(error: string | null = null): void {
  useCloudSyncStatusStore.setState({
    phase: "disconnected",
    vaultName: null,
    lastSyncedAt: null,
    error,
  });
}

function markCloudSyncConnecting(): void {
  useCloudSyncStatusStore.setState({
    phase: "connecting",
    vaultName: null,
    lastSyncedAt: null,
    error: null,
  });
}

function markCloudSyncUnlinked(): void {
  useCloudSyncStatusStore.setState({
    phase: "unlinked",
    vaultName: null,
    lastSyncedAt: null,
    error: null,
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

function cloudSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      return `A file exceeds the ${formatCloudBytes(capacity.limit)} Cloud file-size limit.`;
    }
    return "Cloud capacity reached. Remove files or increase your Cloud capacity.";
  }

  if (summary.bootstrap_conflicts.length > 0) {
    const count = summary.bootstrap_conflicts.length;
    return `Cloud sync needs attention: ${count} ${count === 1 ? "file differs" : "files differ"} on this device and in Cloud.`;
  }
  if (summary.local_conflicts.length > 0) {
    const count = summary.local_conflicts.length;
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
  kind: "kept-both" | "kept-local" | "settings" | "bootstrap" | "rejected";
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
  for (const conflict of summary.bootstrap_conflicts) {
    items.push({
      kind: "bootstrap",
      path: conflict.path,
      detail:
        "Differs on this device and in Cloud, and sync has not agreed on a version yet. Keep one copy (edit or rename the other) and sync again.",
      conflictCopyPath: null,
    });
  }
  for (const conflict of summary.local_conflicts) {
    if (conflict.code === "SETTINGS_CONFLICT") {
      items.push({
        kind: "settings",
        path: conflict.path,
        detail: "Vault settings differ from the cloud. Choose which to keep above.",
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
        ? "Changed in Cloud after this device last synced. The next sync brings the Cloud version and keeps yours beside it if they differ."
        : conflict.code === "PATH_CONFLICT"
          ? `Another Cloud file already uses this name${conflict.current_path && conflict.current_path !== path ? ` (${conflict.current_path})` : ""}. Rename one of them and sync again.`
          : conflict.code === "ITEM_DELETED"
            ? "Deleted in Cloud. Your copy stays on this device and is uploaded again as a new file on the next sync."
            : `Cloud rejected this change (${conflict.code}).`;
    items.push({ kind: "rejected", path, detail, conflictCopyPath: null });
  }
  return items;
}

function formatCloudBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
