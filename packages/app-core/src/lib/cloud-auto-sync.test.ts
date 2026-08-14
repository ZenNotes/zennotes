import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountStatus } from "@zennotes/bridge-contract/cloud-sync";
import type { VaultChangeEvent } from "@shared/ipc";
import {
  clearCloudSyncStatus,
  connectCloudAccountFromStatusBar,
  startCloudAutoSync,
  syncCloudVaultWithStatus,
  type CloudAutoSyncBridge,
  type CloudAutoSyncEnvironment,
  useCloudSyncStatusStore,
} from "./cloud-auto-sync";

function setup(
  initialStatus: CloudAccountStatus = {
    state: "connected",
    account: {
      base_url: "https://zennotes.org",
      user: { name: "Ada", email: "ada@example.com" },
      device: { id: "device-1", name: "Ada’s Mac", platform: "desktop" },
      connected_at: "2026-08-10T12:00:00.000Z",
    },
  },
) {
  let status = initialStatus;
  let vaultListener: ((event: VaultChangeEvent) => void) | null = null;
  let accountListener: ((next: CloudAccountStatus) => void) | null = null;
  let onlineListener: (() => void) | null = null;
  let foregroundListener: (() => void) | null = null;
  let linked = true;
  let linkBaseUrl = "https://zennotes.org";
  let online = true;
  let active = true;
  const syncCloudVault = vi.fn(async () => ({
    cursor: 1,
    pulled: 0,
    pushed: 0,
    conflicts: [],
    bootstrap_conflicts: [], local_conflicts: [],
  }));
  const logoutCloudAccount = vi.fn(async (): Promise<CloudAccountStatus> => {
    const disconnected: CloudAccountStatus = {
      state: "disconnected",
      account: null,
    };
    status = disconnected;
    accountListener?.(disconnected);
    return disconnected;
  });
  const bridge = {
    getCapabilities: () => ({
      supportsUpdater: false,
      supportsNativeMenus: false,
      supportsFloatingWindows: false,
      supportsLocalFilesystemPickers: true,
      supportsRemoteWorkspace: false,
      supportsCloudSync: true,
      supportsCliInstall: false,
      supportsCustomTemplates: false,
    }),
    getCloudAccountStatus: async () => status,
    logoutCloudAccount,
    getCloudVaultLink: async () =>
      linked
        ? {
            base_url: linkBaseUrl,
            vault_id: "vault-1",
            vault_name: "Notes",
            linked_at: "2026-08-10T12:00:00.000Z",
          }
        : null,
    syncCloudVault,
    onVaultChange(listener: (event: VaultChangeEvent) => void) {
      vaultListener = listener;
      return () => {
        vaultListener = null;
      };
    },
    onCloudAccountChange(listener: (next: CloudAccountStatus) => void) {
      accountListener = listener;
      return () => {
        accountListener = null;
      };
    },
  };
  const environment: CloudAutoSyncEnvironment = {
    online: () => online,
    active: () => active,
    onOnline(listener) {
      onlineListener = listener;
      return () => {
        onlineListener = null;
      };
    },
    onForeground(listener) {
      foregroundListener = listener;
      return () => {
        foregroundListener = null;
      };
    },
  };

  return {
    bridge,
    environment,
    syncCloudVault,
    logoutCloudAccount,
    setStatus(next: CloudAccountStatus) {
      status = next;
      accountListener?.(next);
    },
    setLinked(next: boolean) {
      linked = next;
    },
    setLinkBaseUrl(next: string) {
      linkBaseUrl = next;
    },
    setOnline(next: boolean) {
      online = next;
      if (next) onlineListener?.();
    },
    setActive(next: boolean) {
      active = next;
      if (next) foregroundListener?.();
    },
    emitVaultChange(event: VaultChangeEvent) {
      vaultListener?.(event);
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("cloud auto sync host wiring", () => {
  beforeEach(() => {
    clearCloudSyncStatus();
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearCloudSyncStatus();
    vi.useRealTimers();
  });

  it("syncs at startup and debounces syncable vault changes", async () => {
    const host = setup();
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      debounceMs: 2_000,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "ready",
      vaultName: "Notes",
      error: null,
    });
    expect(useCloudSyncStatusStore.getState().lastSyncedAt).not.toBeNull();

    host.emitVaultChange({
      kind: "change",
      path: ".zennotes/workspace.json",
      folder: "inbox",
      scope: "content",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    host.emitVaultChange({
      kind: "change",
      path: "inbox/Plan.md",
      folder: "inbox",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    host.emitVaultChange({
      kind: "change",
      path: "inbox/Plan.md",
      folder: "inbox",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(2);

    runtime.stop();
  });

  it("shows a manual sync in progress and records its completion", async () => {
    const host = setup();
    let finishSync: (() => void) | undefined;
    host.syncCloudVault.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSync = () =>
            resolve({
              cursor: 2,
              pulled: 1,
              pushed: 0,
              conflicts: [],
              bootstrap_conflicts: [], local_conflicts: [],
            });
        }),
    );

    const pending = syncCloudVaultWithStatus(host.bridge, "Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "syncing",
      vaultName: "Notes",
      lastSyncedAt: null,
    });

    finishSync?.();
    await pending;

    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "ready",
      vaultName: "Notes",
      error: null,
    });
    expect(useCloudSyncStatusStore.getState().lastSyncedAt).not.toBeNull();
  });

  it("starts cloud sign-in from the status bar", async () => {
    const connectCloudAccount = vi.fn(async () => ({
      authorization_url: "https://zennotes.org/app/connect",
      expires_at: "2026-08-11T14:05:00.000Z",
    }));

    await connectCloudAccountFromStatusBar({ connectCloudAccount });

    expect(connectCloudAccount).toHaveBeenCalledOnce();
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "connecting",
      vaultName: null,
      error: null,
    });
  });

  it("keeps the linked vault visible when a sync needs attention", async () => {
    const host = setup();
    host.syncCloudVault.mockRejectedValue(new Error("Network unavailable."));

    await expect(
      syncCloudVaultWithStatus(host.bridge, "Notes"),
    ).rejects.toThrow("Network unavailable.");

    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "error",
      vaultName: "Notes",
      error: "Network unavailable.",
    });
  });

  it("does not loop when a completed sync refreshes the vault", async () => {
    const host = setup();
    host.syncCloudVault.mockImplementation(async () => {
      host.emitVaultChange({
        kind: "change",
        path: "",
        folder: "inbox",
        scope: "resync",
      });
      return {
        cursor: 1,
        pulled: 0,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [], local_conflicts: [],
      };
    });
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      debounceMs: 2_000,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    runtime.stop();
  });

  it("waits for a connected account and linked vault, then reacts to lifecycle recovery", async () => {
    const disconnected: CloudAccountStatus = {
      state: "disconnected",
      account: null,
    };
    const host = setup(disconnected);
    host.setLinked(false);
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      debounceMs: 2_000,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).not.toHaveBeenCalled();

    host.setLinked(true);
    host.setStatus({
      state: "connected",
      account: {
        base_url: "https://zennotes.org",
        user: { name: "Ada", email: "ada@example.com" },
        device: { id: "device-1", name: "Ada’s iPhone", platform: "ios" },
        connected_at: "2026-08-10T12:00:00.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    host.setOnline(false);
    host.emitVaultChange({
      kind: "change",
      path: "inbox/Offline.md",
      folder: "inbox",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    host.setOnline(true);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(2);

    host.setActive(false);
    host.setActive(true);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(3);

    runtime.stop();
  });

  it("does not sync a vault linked to another cloud service", async () => {
    const host = setup();
    host.setLinkBaseUrl("http://zennotes.test");
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      debounceMs: 2_000,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(host.syncCloudVault).not.toHaveBeenCalled();

    host.emitVaultChange({
      kind: "change",
      path: "inbox/Plan.md",
      folder: "inbox",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(host.syncCloudVault).not.toHaveBeenCalled();

    runtime.stop();
  });

  it("disconnects when the service rejects the stored credential", async () => {
    const host = setup();
    const unauthorized = Object.assign(new Error("Unauthenticated."), {
      status: 401,
    });
    host.syncCloudVault.mockRejectedValue(unauthorized);
    const onError = vi.fn();
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      intervalMs: 60_000,
      retryDelaysMs: [5_000],
      onError,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(host.logoutCloudAccount).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(host.syncCloudVault).toHaveBeenCalledTimes(1);

    runtime.stop();
  });

  it("keeps the account connected for non-authentication failures", async () => {
    const host = setup();
    const forbidden = Object.assign(new Error("Forbidden."), { status: 403 });
    host.syncCloudVault.mockRejectedValue(forbidden);
    const onError = vi.fn();
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      retryDelaysMs: [5_000],
      onError,
    });

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(host.logoutCloudAccount).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(forbidden, 5_000);

    runtime.stop();
  });
});
