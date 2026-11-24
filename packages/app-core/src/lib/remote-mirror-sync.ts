import type { ZenBridge } from "@zennotes/bridge-contract/bridge";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import type { RemoteMirrorStatus } from "@shared/ipc";
import {
  CloudAutoSyncController,
  type CloudAutoSyncControllerOptions,
} from "@zennotes/shared-domain/cloud-auto-sync";
import { renameCloud } from "@zennotes/shared-domain/remote-mirror-copy";
import {
  applyCloudSyncWindowFinished,
  cloudAutoSyncLogError,
  defaultCloudAutoSyncEnvironment,
  flushCloudConflictDrafts,
  installCloudSyncRuntime,
  isCloudSyncableVaultChange,
  markRemoteMirrorReady,
  refreshCloudSettingsConflict,
  requestCloudAutoSync,
  syncCloudVaultWithStatus,
  useCloudSyncStatusStore,
  type CloudAutoSyncEnvironment,
  type CloudAutoSyncRuntime,
} from "./cloud-auto-sync";

/**
 * The sync runtime of a window on an offline copy of a server vault (#1108).
 *
 * The copy is synced by Cloud's engine, so this is Cloud's runtime with the
 * account taken out: the same controller (a save syncs after 2 seconds, a
 * change on the server pulls at once, failures back off 5, 15, 60 and 300
 * seconds), the same status store, the same review queue. What it adds is
 * the copy's own state from the desktop: whether the server answered, how
 * many changes wait for it, and Work Offline.
 */

export type RemoteMirrorBridge = Pick<
  ZenBridge,
  | "syncCloudVault"
  | "hasCloudVaultChanges"
  | "getCloudVaultLink"
  | "getCloudSettingsConflict"
  | "onCloudSyncWindow"
  | "onVaultChange"
  | "getRemoteMirrorStatus"
  | "setRemoteMirrorPaused"
  | "onRemoteMirrorChange"
>;

type Timings = Pick<
  CloudAutoSyncControllerOptions,
  "debounceMs" | "intervalMs" | "retryDelaysMs" | "onError"
>;

/** How long after a save the "changes waiting" count is read again. */
const STATUS_REFRESH_DELAY_MS = 800;

export function startRemoteMirrorAutoSync(
  bridge: RemoteMirrorBridge,
  options: {
    /** The copy this window shows was turned off, here or in another window. */
    onRemoved(): void;
    /** The server answers again: what only it holds (attachments) can be
     *  listed again. */
    onReconnected?(): void;
    environment?: CloudAutoSyncEnvironment;
    timings?: Timings;
  },
): CloudAutoSyncRuntime {
  const environment = options.environment ?? defaultCloudAutoSyncEnvironment();
  const timings = options.timings ?? {};
  const reportError = timings.onError ?? cloudAutoSyncLogError;
  useCloudSyncStatusStore.setState({ source: "remote" });

  let stopped = false;
  let wasReachable: boolean | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async (): Promise<RemoteMirrorStatus | null> => {
    if (!bridge.getRemoteMirrorStatus) return null;
    try {
      const mirror = await bridge.getRemoteMirrorStatus();
      if (stopped) return mirror;
      useCloudSyncStatusStore.setState({ mirror, source: "remote" });
      if (mirror?.reachable && wasReachable === false) options.onReconnected?.();
      if (mirror) wasReachable = mirror.reachable;
      return mirror;
    } catch {
      return useCloudSyncStatusStore.getState().mirror;
    }
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, STATUS_REFRESH_DELAY_MS);
  };

  const controller = new CloudAutoSyncController({
    ready: async () => {
      const mirror = await refresh();
      if (!mirror) return false;
      markRemoteMirrorReady(mirror.origin.profileName);
      // Work Offline: the copy keeps every change, and nothing is sent.
      return !mirror.paused;
    },
    sync: async () => {
      try {
        await syncCloudVaultWithStatus(bridge);
      } finally {
        await refresh();
      }
    },
    checkRemoteChanges: bridge.hasCloudVaultChanges
      ? async () => {
          if (useCloudSyncStatusStore.getState().mirror?.paused) return false;
          return await bridge.hasCloudVaultChanges!();
        }
      : undefined,
    online: environment.online,
    active: environment.active,
    debounceMs: timings.debounceMs,
    intervalMs: timings.intervalMs,
    retryDelaysMs: timings.retryDelaysMs,
    onError(error, retryInMs) {
      reportError(error, retryInMs);
      void refresh();
    },
  });

  const unsubscribeVault = bridge.onVaultChange((event) => {
    if (!isCloudSyncableVaultChange(event)) return;
    controller.request("local-change");
    scheduleRefresh();
  });
  const unsubscribeSyncWindow = bridge.onCloudSyncWindow?.({
    async prepare() {
      await flushCloudConflictDrafts();
    },
    finished(summary, error) {
      applyCloudSyncWindowFinished(summary, error);
      void refreshCloudSettingsConflict(bridge);
      void refresh();
    },
  });
  const unsubscribeMirror = bridge.onRemoteMirrorChange?.((event) => {
    if (event.removed) {
      options.onRemoved();
      return;
    }
    if (event.remote) controller.request("remote-change");
    void refresh();
  });
  const unsubscribeOnline = environment.onOnline(() => controller.request("online"));
  const unsubscribeForeground = environment.onForeground(() =>
    controller.request("foreground"),
  );

  controller.start();

  return {
    request: (reason) => controller.request(reason),
    stop() {
      stopped = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      controller.stop();
      unsubscribeVault();
      unsubscribeSyncWindow?.();
      unsubscribeMirror?.();
      unsubscribeOnline();
      unsubscribeForeground();
    },
  };
}

export function ensureRemoteMirrorAutoSyncStarted(handlers: {
  onRemoved(): void;
  onReconnected?(): void;
}): void {
  installCloudSyncRuntime(() => startRemoteMirrorAutoSync(getZenBridge(), handlers));
}

/** Sync Remote Vault Now: the palette, `Space R` and the status bar. */
export function syncRemoteMirrorNow(): void {
  requestCloudAutoSync("vault-link");
}

/** Work Offline and Work Online. */
export async function setRemoteMirrorPaused(paused: boolean): Promise<void> {
  const bridge = getZenBridge();
  if (!bridge.setRemoteMirrorPaused) return;
  const mirror = await bridge.setRemoteMirrorPaused(paused);
  useCloudSyncStatusStore.setState({ mirror });
  if (!paused) requestCloudAutoSync("vault-link");
}

export interface RemoteMirrorStatusLine {
  /** The few words in the status bar. */
  label: string;
  /** The tooltip: the server, and when it was last reached. */
  title: string;
  tone: "quiet" | "busy" | "offline" | "attention";
}

/** Waiting changes, the way the status bar counts them. */
export function remoteMirrorChangesLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"} waiting`;
}

/**
 * What the status bar says for a copy. Offline is not an error here: the
 * copy keeps every save, so it says so calmly and counts what waits.
 */
export function remoteMirrorStatusLine(
  state: {
    phase: string;
    error: string | null;
    mirror: RemoteMirrorStatus | null;
    lastSyncedAt: number | null;
  },
  now = Date.now(),
): RemoteMirrorStatusLine | null {
  const mirror = state.mirror;
  if (!mirror) return null;
  const name = mirror.origin.profileName;
  const waiting = mirror.pendingChanges > 0 ? ` · ${remoteMirrorChangesLabel(mirror.pendingChanges)}` : "";
  const reached =
    mirror.lastReachedAt !== null
      ? `${name} was last reached ${relativeTime(mirror.lastReachedAt, now)}.`
      : `${name} has not been reached yet.`;
  const where = `Offline copy of ${name} (${mirror.origin.baseUrl}).`;
  if (mirror.vaultMismatch) {
    return {
      label: "Sync stopped",
      title: `${name} now serves a different vault than this offline copy was made from. The copy is kept as it is.`,
      tone: "attention",
    };
  }
  if (mirror.paused) {
    return { label: `Working offline${waiting}`, title: `${where} Sync is stopped until you choose Work Online. ${reached}`, tone: "offline" };
  }
  if (state.phase === "syncing") {
    return { label: "Syncing", title: `${where} ${reached}`, tone: "busy" };
  }
  if (!mirror.reachable) {
    return { label: `Offline${waiting}`, title: `${where} Notes open and save here; they reach the server when it answers. ${reached}`, tone: "offline" };
  }
  if (state.phase === "attention" || state.phase === "error") {
    return {
      label: state.phase === "error" ? "Sync didn't finish" : "Needs review",
      title: renameCloud(state.error ?? "", name) || `${where} ${reached}`,
      tone: "attention",
    };
  }
  return {
    label: mirror.pendingChanges > 0 ? remoteMirrorChangesLabel(mirror.pendingChanges) : "Synced",
    title: `${where} ${reached}`,
    tone: "quiet",
  };
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
