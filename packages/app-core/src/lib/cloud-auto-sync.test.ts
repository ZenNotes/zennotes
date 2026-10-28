import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudAccountStatus,
  CloudSyncRunSummary,
  CloudSyncWindowHandlers,
} from "@zennotes/bridge-contract/cloud-sync";
import type { VaultChangeEvent } from "@shared/ipc";
import {
  CLOUD_VAULT_REMOVED_MESSAGE,
  CLOUD_VAULT_SUPERSEDED_MESSAGE,
} from "@zennotes/shared-domain/cloud-vault-availability";
import { CLOUD_SIGNED_OUT_MESSAGE } from "@zennotes/shared-domain/cloud-error-copy";
import {
  acknowledgeCloudConflictResolution,
  clearCloudSyncStatus,
  clearRemovedCloudVault,
  cloudSyncAttentionIsSettingsOnly,
  cloudSyncAttentionItems,
  cloudSyncAttentionLabel,
  cloudSyncAttentionMessage,
  cloudSyncNeedsUser,
  cloudVaultGoneReason,
  cloudVaultRemovalLabel,
  cloudVaultRemovalMessage,
  closeCloudConflictReview,
  closeCloudSettingsConflictPrompt,
  connectCloudAccountFromStatusBar,
  hasCloudVaultRemovalNotice,
  hasPendingCloudReview,
  markCloudVaultDeleted,
  openCloudConflictReview,
  openPendingCloudReview,
  registerCloudConflictDraftFlusher,
  resolveCloudSettingsConflictWithStatus,
  startCloudAutoSync,
  syncCloudVaultWithStatus,
  type CloudAutoSyncBridge,
  type CloudAutoSyncEnvironment,
  useCloudSyncStatusStore,
} from "./cloud-auto-sync";
import { useToastStore } from "./toast";

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
  const syncCloudVault = vi.fn(
    async (): Promise<CloudSyncRunSummary> => ({
      cursor: 1,
      pulled: 0,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [],
    }),
  );
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

  it("formats a decimal 10 MB file limit and explains how to recover", () => {
    expect(cloudSyncAttentionMessage({
      cursor: 1, pulled: 0, pushed: 0, bootstrap_conflicts: [], local_conflicts: [],
      conflicts: [{ operation_id: "op", item_id: "item", code: "FILE_SIZE_LIMIT_EXCEEDED",
        current_revision: null, current_path: null,
        capacity: { dimension: "sync_max_file_bytes", used: 0, reserved: 0,
          limit: 10_000_000, projected: 12_600_000, can_retry_after_reduction: true } }]
    })).toBe("A file is larger than the 10 MB Cloud file-size limit, so it stays on this device. Remove it or make it smaller to finish syncing.");
  });

  it("names the oversized file, counts several, and gives each Cloud limit a short label", () => {
    const tooLarge = (item: string, path: string | null) => ({
      operation_id: `op-${item}`, item_id: item, code: "FILE_SIZE_LIMIT_EXCEEDED" as const,
      current_revision: null, current_path: null, path,
      capacity: { dimension: "sync_max_file_bytes", used: 0, reserved: 0,
        limit: 10_000_000, projected: 151_250_581, can_retry_after_reduction: true },
    });
    const run = (conflicts: CloudSyncRunSummary["conflicts"]): CloudSyncRunSummary => ({
      cursor: 1, pulled: 0, pushed: 0, bootstrap_conflicts: [], local_conflicts: [], conflicts,
    });

    const one = run([tooLarge("video", "assets/IMG_2709.mov")]);
    expect(cloudSyncAttentionMessage(one)).toBe(
      "“IMG_2709.mov” is larger than the 10 MB Cloud file-size limit, so it stays on this device. Remove it or make it smaller to finish syncing.",
    );
    expect(cloudSyncAttentionLabel(one)).toBe("1 file too large for Cloud");

    // The same file rejected twice in one run is still one file.
    const several = run([tooLarge("a", "a.mov"), tooLarge("b", "b.mov"), tooLarge("a", "a.mov")]);
    expect(cloudSyncAttentionMessage(several)).toBe(
      "2 files are larger than the 10 MB Cloud file-size limit, so they stay on this device. Remove them or make them smaller to finish syncing.",
    );
    expect(cloudSyncAttentionLabel(several)).toBe("2 files too large for Cloud");

    const limit = (dimension: string) => run([{
      operation_id: "op", item_id: "item", code: "QUOTA_EXCEEDED", current_revision: null, current_path: null,
      capacity: { dimension, used: 10, reserved: 0, limit: 10, projected: 11, can_retry_after_reduction: true },
    }]);
    expect(cloudSyncAttentionLabel(limit("sync_active_bytes"))).toBe("Cloud storage full");
    expect(cloudSyncAttentionLabel(limit("sync_active_items"))).toBe("Cloud file limit reached");
    expect(cloudSyncAttentionLabel(limit("vaults"))).toBe("Cloud capacity reached");
    expect(cloudSyncAttentionLabel(run([]))).toBeNull();
    expect(cloudSyncAttentionLabel(null)).toBeNull();
  });

  it("keeps the rest of a newly linked review queue when the shared summary is older", () => {
    const oldSummary: CloudSyncRunSummary = {
      cursor: 1, pulled: 0, pushed: 0, conflicts: [], bootstrap_conflicts: [], local_conflicts: [],
      pending_conflicts: [],
    };
    const conflict = {
      id: "saved-note", item_id: "saved-note", path: "Note.md", cloud_path: "Note.md",
      kind: "content" as const, can_merge: true, has_base: true,
    };
    const other = { ...conflict, id: "other-note", item_id: "other-note", path: "Other.md" };
    useCloudSyncStatusStore.setState({ lastSummary: oldSummary });
    const next = acknowledgeCloudConflictResolution("saved-note", {
      ...oldSummary, cursor: 2, pending_conflicts: [conflict, other],
    });
    expect(next.pending_conflicts).toEqual([other]);
  });

  it("preserves the saved-note context when another sync listener reports the same failure", async () => {
    const host = setup();
    let handlers!: CloudSyncWindowHandlers;
    const runtime = startCloudAutoSync({
      ...host.bridge,
      onCloudSyncWindow(next) { handlers = next; return () => {}; },
    }, host.environment);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const summary = useCloudSyncStatusStore.getState().lastSummary!;
    acknowledgeCloudConflictResolution("saved-note", summary);
    host.syncCloudVault.mockRejectedValueOnce(new Error("Connection timed out"));
    try {
      await expect(syncCloudVaultWithStatus(host.bridge)).rejects.toThrow("Connection timed out");
      handlers.finished(null, "Connection timed out");
      expect(useCloudSyncStatusStore.getState().error).toBe(
        "Your note was saved, but the rest of the vault didn't sync. Connection timed out",
      );
      handlers.finished(summary, null);
      handlers.finished(null, "A later unrelated error");
      expect(useCloudSyncStatusStore.getState().error).toBe("A later unrelated error");
    } finally { runtime.stop(); }
  });

  it("flushes and locks a sibling window review, then closes it from the host's matching result", async () => {
    const host = setup();
    let handlers!: CloudSyncWindowHandlers;
    const unsubscribe = vi.fn();
    const runtime = startCloudAutoSync({
      ...host.bridge,
      onCloudSyncWindow(next) { handlers = next; return unsubscribe; },
    }, host.environment);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    let saved!: () => void;
    const unregister = registerCloudConflictDraftFlusher(
      () => new Promise<void>((resolve) => { saved = resolve; }),
    );
    try {
      useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
      let prepared = false;
      const preparation = handlers.prepare().then(() => { prepared = true; });
      expect(useCloudSyncStatusStore.getState().syncWindowLocked).toBe(true);
      await flushPromises();
      expect(prepared).toBe(false);
      saved();
      await preparation;
      expect(useCloudSyncStatusStore.getState().syncWindowLocked).toBe(true);
      const summary = await host.syncCloudVault();
      handlers.finished(summary, null);
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        syncWindowLocked: false, phase: "ready", conflictReviewOpen: false,
        lastSummary: summary,
      });
    } finally { unregister(); runtime.stop(); }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("unlocks a failed sibling sync without dismissing the review", async () => {
    const host = setup();
    let handlers!: CloudSyncWindowHandlers;
    const runtime = startCloudAutoSync({
      ...host.bridge,
      onCloudSyncWindow(next) { handlers = next; return () => {}; },
    }, host.environment);
    const unregister = registerCloudConflictDraftFlusher(async () => {
      throw new Error("Draft save failed");
    });
    try {
      useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
      await expect(handlers.prepare()).rejects.toThrow("Draft save failed");
      expect(useCloudSyncStatusStore.getState().syncWindowLocked).toBe(true);
      handlers.finished(null, "Draft save failed");
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        syncWindowLocked: false, phase: "error", conflictReviewOpen: true,
      });
    } finally { unregister(); runtime.stop(); }
  });

  it("clears the stale success state when the metadata probe discovers an unlinked vault", async () => {
    const host = setup();
    const missing = new Error("This Cloud vault is no longer available. Your local notes are unchanged.");
    const probe = vi.fn(async () => { host.setLinked(false); throw missing; });
    const runtime = startCloudAutoSync({ ...host.bridge, hasCloudVaultChanges: probe }, host.environment, {
      intervalMs: 60_000, onError: vi.fn(),
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(useCloudSyncStatusStore.getState().lastSummary).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probe).toHaveBeenCalledOnce();
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "unlinked", vaultName: null, lastSummary: null, lastSyncedAt: null,
        conflictReviewOpen: false, error: missing.message,
      });
      expect(host.logoutCloudAccount).not.toHaveBeenCalled();
    } finally { runtime.stop(); }
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
              bootstrap_conflicts: [],
              local_conflicts: [],
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

  it("persists a pending review draft before syncing can clear a converged conflict", async () => {
    const host = setup();
    let finishSave!: () => void;
    const flush = vi.fn(
      () => new Promise<void>((resolve) => { finishSave = resolve; }),
    );
    const unregister = registerCloudConflictDraftFlusher(flush);
    try {
      const run = syncCloudVaultWithStatus(host.bridge);
      expect(flush).toHaveBeenCalledOnce();
      expect(useCloudSyncStatusStore.getState().phase).toBe("syncing");
      expect(host.syncCloudVault).not.toHaveBeenCalled();
      finishSave();
      await run;
      expect(host.syncCloudVault).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("does not run sync or close the review if saving its draft fails", async () => {
    const host = setup();
    useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
    const unregister = registerCloudConflictDraftFlusher(async () => {
      throw new Error("Draft could not be saved");
    });
    try {
      await expect(syncCloudVaultWithStatus(host.bridge)).rejects.toThrow(
        "Draft could not be saved",
      );
      expect(host.syncCloudVault).not.toHaveBeenCalled();
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "error",
        conflictReviewOpen: true,
      });
    } finally {
      unregister();
    }
  });

  it("does not report a quota-conflicted sync as successful", async () => {
    const host = setup();
    host.syncCloudVault.mockResolvedValue({
      cursor: 2,
      pulled: 0,
      pushed: 0,
      conflicts: [
        {
          operation_id: "operation-1",
          item_id: "item-1",
          code: "QUOTA_EXCEEDED",
          current_revision: null,
          current_path: null,
        },
      ],
      bootstrap_conflicts: [],
      local_conflicts: [],
    });

    await syncCloudVaultWithStatus(host.bridge, "Notes");

    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "attention",
      vaultName: "Notes",
      lastSyncedAt: null,
      error:
        "Your ZenNotes Cloud plan is full, so some changes are waiting on this device. Delete files you no longer need, or change your plan under Billing on zennotes.org.",
    });
  });

  it("shows the active item usage returned with a quota conflict", async () => {
    const host = setup();
    host.syncCloudVault.mockResolvedValue({
      cursor: 2,
      pulled: 0,
      pushed: 0,
      conflicts: [
        {
          operation_id: "operation-1",
          item_id: "item-1",
          code: "QUOTA_EXCEEDED",
          current_revision: null,
          current_path: null,
          capacity: {
            dimension: "sync_active_items",
            used: 100,
            reserved: 0,
            limit: 100,
            projected: 101,
            can_retry_after_reduction: true,
          },
        },
      ],
      bootstrap_conflicts: [],
      local_conflicts: [],
    });

    await syncCloudVaultWithStatus(host.bridge, "Notes");

    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "attention",
      error:
        "Your ZenNotes Cloud plan holds up to 100 files across your account, and you have reached that. New files are waiting on this device. Delete files you no longer need, or change your plan under Billing on zennotes.org.",
    });
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
        bootstrap_conflicts: [],
        local_conflicts: [],
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
    // The shape both the desktop client and the phone shells throw.
    const unauthorized = Object.assign(new Error("Authentication is required."), {
      name: "CloudServiceRequestError",
      status: 401,
      code: "UNAUTHENTICATED",
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
    // The row says why the device is signed out, in words, until it connects.
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "disconnected",
      error: CLOUD_SIGNED_OUT_MESSAGE,
      errorKind: "signed-out",
      errorDetail: "HTTP 401 · UNAUTHENTICATED · Authentication is required.",
    });

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

describe("cloudSyncAttentionItems (Discord: name the file, not the count)", () => {
  const base: CloudSyncRunSummary = {
    cursor: 9,
    pulled: 0,
    pushed: 0,
    conflicts: [],
    bootstrap_conflicts: [],
    local_conflicts: [],
  };

  it("names each kept-both, kept-local, bootstrap and rejected file with what to do", () => {
    const items = cloudSyncAttentionItems({
      ...base,
      bootstrap_conflicts: [
        {
          code: "BOOTSTRAP_CONTENT_CONFLICT",
          item_id: "b",
          path: "inbox/Boot.md",
          local_sha256: "a",
          remote_sha256: "b",
        },
      ],
      local_conflicts: [
        {
          code: "LOCAL_EDIT_CONFLICT",
          path: "inbox/Plan.md",
          conflict_copy_path: "inbox/Plan (cloud conflict).md",
        },
        { code: "LOCAL_EDIT_CONFLICT", path: "inbox/Moved.md", conflict_copy_path: null },
      ],
      conflicts: [
        {
          operation_id: "op-1",
          item_id: "i-1",
          code: "REVISION_CONFLICT",
          current_revision: 4,
          current_path: null,
          path: "inbox/Daily.md",
        },
        {
          operation_id: "op-2",
          item_id: "i-2",
          code: "PATH_CONFLICT",
          current_revision: null,
          current_path: "inbox/plan.md",
          path: "inbox/Plan.md",
        },
        {
          operation_id: "op-3",
          item_id: "i-3",
          code: "QUOTA_EXCEEDED",
          current_revision: null,
          current_path: null,
          path: "assets/big.png",
        },
      ],
    });
    expect(items.map((item) => [item.kind, item.path])).toEqual([
      ["bootstrap", "inbox/Boot.md"],
      ["kept-both", "inbox/Plan.md"],
      ["kept-local", "inbox/Moved.md"],
      ["rejected", "inbox/Daily.md"],
      ["rejected", "inbox/Plan.md"],
    ]);
    expect(items[0].detail).toContain("Compare");
    expect(items[1].conflictCopyPath).toBe("inbox/Plan (cloud conflict).md");
    expect(items[1].detail).toContain("Plan (cloud conflict).md");
    expect(items[3].detail).toContain("Changed on another device");
    expect(items[4].detail).toContain("(inbox/plan.md)");
  });

  it("falls back to the cloud path or the item id when the client sent no path", () => {
    const items = cloudSyncAttentionItems({
      ...base,
      conflicts: [
        {
          operation_id: "op",
          item_id: "i-9",
          code: "ITEM_DELETED",
          current_revision: null,
          current_path: "inbox/Old.md",
        },
        {
          operation_id: "op2",
          item_id: "i-10",
          code: "ITEM_DELETED",
          current_revision: null,
          current_path: null,
        },
      ],
    });
    expect(items.map((item) => item.path)).toEqual(["inbox/Old.md", "A file"]);
  });

  it("remembers the last run summary so Review can show it without another sync", async () => {
    clearCloudSyncStatus();
    const summary: CloudSyncRunSummary = {
      ...base,
      conflicts: [
        {
          operation_id: "op",
          item_id: "i",
          code: "REVISION_CONFLICT",
          current_revision: 2,
          current_path: null,
          path: "inbox/Daily.md",
        },
      ],
    };
    await syncCloudVaultWithStatus({ syncCloudVault: async () => summary }, "Notes");
    expect(useCloudSyncStatusStore.getState().phase).toBe("attention");
    expect(useCloudSyncStatusStore.getState().lastSummary).toEqual(summary);
    clearCloudSyncStatus();
    expect(useCloudSyncStatusStore.getState().lastSummary).toBeNull();
  });

  it("opens the review queue only for conflicts it can resolve, and closes it when they are gone", async () => {
    clearCloudSyncStatus();
    const pending = {
      id: "item-1",
      item_id: "item-1",
      path: "Plans/Trip.md",
      cloud_path: "Plans/Trip.md",
      kind: "content" as const,
      can_merge: true,
      has_base: true,
    };

    // A rejected upload is not a decision the queue can take.
    await syncCloudVaultWithStatus(
      {
        syncCloudVault: async () => ({
          ...base,
          conflicts: [
            {
              operation_id: "op",
              item_id: "i",
              code: "REVISION_CONFLICT",
              current_revision: 2,
              current_path: null,
              path: "inbox/Daily.md",
            },
          ],
        }),
      },
      "Notes",
    );
    openCloudConflictReview();
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(false);

    await syncCloudVaultWithStatus(
      { syncCloudVault: async () => ({ ...base, pending_conflicts: [pending] }) },
      "Notes",
    );
    openCloudConflictReview();
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true);

    // The next run resolves it: the flag must not survive to reopen the queue
    // on an unrelated conflict later.
    await syncCloudVaultWithStatus({ syncCloudVault: async () => base }, "Notes");
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(false);
    closeCloudConflictReview();
  });
});

describe("the vault settings question (#816)", () => {
  const base: CloudSyncRunSummary = {
    cursor: 9,
    pulled: 0,
    pushed: 0,
    conflicts: [],
    bootstrap_conflicts: [],
    local_conflicts: [],
  };
  const question = {
    path: ".zennotes/vault.json",
    cloud_path: ".zennotes/vault.cloud-conflict.json",
    cloud_settings: { favorites: ["inbox:Projects"] },
  };

  function bridgeWith(parked: () => typeof question | null) {
    return {
      syncCloudVault: async () => base,
      getCloudSettingsConflict: async () => parked(),
      resolveCloudSettingsConflict: vi.fn(async () => undefined),
    };
  }

  beforeEach(() => clearCloudSyncStatus());
  afterEach(() => clearCloudSyncStatus());

  it("surfaces the question right after the run that parked it, and opens the prompt once", async () => {
    let parked: typeof question | null = question;
    const bridge = bridgeWith(() => parked);

    await syncCloudVaultWithStatus(bridge, "Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "attention",
      settingsConflict: question,
      settingsConflictPromptOpen: true,
    });
    expect(cloudSyncAttentionIsSettingsOnly()).toBe(true);
    expect(hasPendingCloudReview()).toBe(true);

    // "Decide later" applies nothing: the question stays, the prompt closes,
    // and the next run with the same parked copy does not reopen it.
    closeCloudSettingsConflictPrompt();
    await syncCloudVaultWithStatus(bridge, "Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "attention",
      settingsConflict: question,
      settingsConflictPromptOpen: false,
    });

    // The status bar and the leader binding reopen the same prompt.
    openPendingCloudReview();
    expect(useCloudSyncStatusStore.getState().settingsConflictPromptOpen).toBe(true);
    closeCloudSettingsConflictPrompt();

    // A newer cloud copy is a new question, so it is asked again.
    parked = { ...question, cloud_settings: { favorites: ["inbox:Reading"] } };
    await syncCloudVaultWithStatus(bridge, "Notes");
    expect(useCloudSyncStatusStore.getState().settingsConflictPromptOpen).toBe(true);
  });

  it("clears the question and the attention once it is answered", async () => {
    let parked: typeof question | null = question;
    const bridge = bridgeWith(() => parked);
    await syncCloudVaultWithStatus(bridge, "Notes");

    parked = null;
    await resolveCloudSettingsConflictWithStatus("cloud", bridge);
    expect(bridge.resolveCloudSettingsConflict).toHaveBeenCalledWith("cloud");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "ready",
      error: null,
      settingsConflict: null,
      settingsConflictPromptOpen: false,
    });
    expect(hasPendingCloudReview()).toBe(false);
    // Nothing to open: the guard keeps an empty prompt off the screen.
    openPendingCloudReview();
    expect(useCloudSyncStatusStore.getState().settingsConflictPromptOpen).toBe(false);
  });

  it("keeps the generic wording when files also need attention, and lets the file queue go first", async () => {
    const pending = {
      id: "item-1",
      item_id: "item-1",
      path: "Plans/Trip.md",
      cloud_path: "Plans/Trip.md",
      kind: "content" as const,
      can_merge: true,
      has_base: true,
    };
    await syncCloudVaultWithStatus(
      {
        syncCloudVault: async () => ({ ...base, pending_conflicts: [pending] }),
        getCloudSettingsConflict: async () => question,
      },
      "Notes",
    );
    const state = useCloudSyncStatusStore.getState();
    expect(state.phase).toBe("attention");
    expect(state.error).toContain("1 file was changed both on this device and on another device");
    expect(cloudSyncAttentionIsSettingsOnly()).toBe(false);
    expect(state.settingsConflict).toEqual(question);

    openPendingCloudReview();
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true);
  });

  it("is a question of the host: a bridge without one, or one answering nothing, asks nothing", async () => {
    await syncCloudVaultWithStatus({ syncCloudVault: async () => base }, "Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "ready",
      settingsConflict: null,
      settingsConflictPromptOpen: false,
    });
    await syncCloudVaultWithStatus(
      {
        syncCloudVault: async () => base,
        getCloudSettingsConflict: (async () => undefined) as unknown as () => Promise<null>,
      },
      "Notes",
    );
    expect(useCloudSyncStatusStore.getState().settingsConflict).toBeNull();
  });

  it("surfaces a question left by an earlier run even when this run fails", async () => {
    await expect(
      syncCloudVaultWithStatus(
        {
          syncCloudVault: async () => {
            throw new Error("Offline");
          },
          getCloudSettingsConflict: async () => question,
        },
        "Notes",
      ),
    ).rejects.toThrow("Offline");
    await flushPromises();
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "error",
      settingsConflict: question,
      settingsConflictPromptOpen: true,
    });
  });
});

describe("the new conflict notification", () => {
  const base: CloudSyncRunSummary = {
    cursor: 9,
    pulled: 0,
    pushed: 0,
    conflicts: [],
    bootstrap_conflicts: [],
    local_conflicts: [],
  };
  const conflict = (id: string, path: string) => ({
    id,
    item_id: id,
    path,
    cloud_path: path,
    kind: "content" as const,
    can_merge: true,
    has_base: true,
  });
  const trip = conflict("trip", "Plans/Trip.md");
  const budget = conflict("budget", "Plans/Budget.md");
  const packing = conflict("packing", "Plans/Packing list.md");

  async function runWith(...pending: ReturnType<typeof conflict>[]): Promise<void> {
    await syncCloudVaultWithStatus(
      { syncCloudVault: async () => ({ ...base, pending_conflicts: pending }) },
      "Notes",
    );
  }
  const toasts = () => useToastStore.getState().toasts;

  beforeEach(() => {
    clearCloudSyncStatus();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    clearCloudSyncStatus();
    useToastStore.setState({ toasts: [] });
    vi.useRealTimers();
  });

  it("names one new conflict once, and not again while it waits", async () => {
    vi.useFakeTimers();
    await runWith(trip);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      type: "info",
      message:
        "“Trip” changed on this device and on another device. Sync is paused for it.",
      action: { label: "Review" },
    });

    await runWith(trip);
    await runWith(trip);
    expect(toasts()).toHaveLength(1);

    // Long enough to reach Review, then out of the way.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(toasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(toasts()).toHaveLength(0);
  });

  it("counts several new conflicts in one notification, then names a later newcomer", async () => {
    await runWith(trip, budget);
    expect(toasts().map((toast) => toast.message)).toEqual([
      "2 files changed on this device and on another device. Sync is paused for them.",
    ]);

    await runWith(trip, budget, packing);
    expect(toasts().map((toast) => toast.message)).toEqual([
      "2 files changed on this device and on another device. Sync is paused for them.",
      "“Packing list” changed on this device and on another device. Sync is paused for it.",
    ]);
  });

  it("announces again once a conflict is resolved and a new one arrives on the same note", async () => {
    await runWith(trip);
    await runWith();
    expect(toasts()).toHaveLength(1);
    await runWith(trip);
    expect(toasts()).toHaveLength(2);

    // Resolved in this window, and the next run already reports a fresh
    // conflict under the same id: no summary without it ever arrived.
    acknowledgeCloudConflictResolution(trip.id, useCloudSyncStatusStore.getState().lastSummary!);
    await runWith(trip);
    expect(toasts()).toHaveLength(3);
  });

  it("stays silent while the review is open, and counts what the open queue showed as told", async () => {
    await runWith(trip);
    expect(toasts()).toHaveLength(1);
    openCloudConflictReview();
    await runWith(trip, budget);
    expect(toasts()).toHaveLength(1);

    closeCloudConflictReview();
    await runWith(trip, budget);
    expect(toasts()).toHaveLength(1);
  });

  it("opens the queue on the conflict it announced", async () => {
    await runWith(trip);
    await runWith(trip, budget);
    const [, second] = toasts();
    expect(second.message).toContain("“Budget”");

    second.action!.onClick();
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      conflictReviewOpen: true,
      conflictReviewStartId: budget.id,
    });
  });

  it("starts over when the vault or its Cloud link changes", async () => {
    await runWith(trip);
    clearCloudSyncStatus();
    await runWith(trip);
    expect(toasts()).toHaveLength(2);

    // The link was removed on the server: the failed run finds no link.
    await expect(
      syncCloudVaultWithStatus(
        {
          syncCloudVault: async () => {
            throw new Error("Vault link not found");
          },
          getCloudVaultLink: async () => null,
        },
        "Notes",
      ),
    ).rejects.toThrow("Vault link not found");
    expect(useCloudSyncStatusStore.getState().phase).toBe("unlinked");
    await runWith(trip);
    expect(toasts()).toHaveLength(3);
  });
});

describe("a Cloud vault that went away", () => {
  const removedByHost = new Error(
    `Error invoking remote method 'cloud-vault:sync': Error: ${CLOUD_VAULT_REMOVED_MESSAGE}`,
  );

  beforeEach(() => {
    clearCloudSyncStatus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearCloudSyncStatus();
  });

  it("is recorded with the name its link carried, outlasts later checks, and clears once a link exists", async () => {
    const host = setup();
    let vaultGone = false;
    host.syncCloudVault.mockImplementation(async () => {
      if (vaultGone) {
        host.setLinked(false);
        throw removedByHost;
      }
      return {
        cursor: 1, pulled: 0, pushed: 0, conflicts: [], bootstrap_conflicts: [], local_conflicts: [],
      };
    });
    const runtime = startCloudAutoSync(host.bridge, host.environment, {
      intervalMs: 60_000, onError: vi.fn(),
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "ready", vaultName: "Notes", removedVault: null,
      });

      vaultGone = true;
      runtime.request("foreground");
      await vi.advanceTimersByTimeAsync(1);
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "unlinked",
        vaultName: null,
        removedVault: { vaultName: "Notes", reason: "deleted" },
      });
      expect(hasCloudVaultRemovalNotice()).toBe(true);

      // Every later check finds no link and says unlinked again; what
      // happened to the link still stands.
      runtime.request("foreground");
      await vi.advanceTimersByTimeAsync(1);
      expect(useCloudSyncStatusStore.getState().removedVault).toEqual({
        vaultName: "Notes", reason: "deleted",
      });

      vaultGone = false;
      host.setLinked(true);
      runtime.request("vault-link");
      await vi.advanceTimersByTimeAsync(1);
      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "ready", removedVault: null,
      });
    } finally {
      runtime.stop();
    }
  });

  it("tells a deleted vault from one refused to this account, by what each host surfaces", () => {
    expect(cloudVaultGoneReason(new Error(CLOUD_VAULT_REMOVED_MESSAGE))).toBe("deleted");
    expect(cloudVaultGoneReason(removedByHost)).toBe("deleted");
    expect(cloudVaultGoneReason(
      Object.assign(new Error("The requested resource was not found."), { status: 404, code: "NOT_FOUND" }),
    )).toBe("deleted");
    expect(cloudVaultGoneReason(new Error(
      "Error invoking remote method 'cloud-vault:link': Error: That ZenNotes Cloud vault is not available to this account.",
    ))).toBe("unavailable");
    expect(cloudVaultGoneReason(
      Object.assign(new Error("You are not allowed to perform this action."), { status: 403, code: "FORBIDDEN" }),
    )).toBe("unavailable");
    // A 404 without Cloud's own code proves nothing about the vault, and a
    // refusal about the device is not about the vault either.
    expect(cloudVaultGoneReason(
      Object.assign(new Error("Not Found"), { status: 404, code: null }),
    )).toBeNull();
    expect(cloudVaultGoneReason(
      Object.assign(new Error("This device was revoked."), { status: 403, code: "ACTIVE_DEVICE_REQUIRED" }),
    )).toBeNull();
    expect(cloudVaultGoneReason("Cloud sync timed out.")).toBeNull();
  });

  it("tells a vault another device encrypted from a deleted one, by what each host surfaces", () => {
    expect(cloudVaultGoneReason(new Error(CLOUD_VAULT_SUPERSEDED_MESSAGE))).toBe("encrypted");
    expect(cloudVaultGoneReason(new Error(
      `Error invoking remote method 'cloud-vault:sync': Error: ${CLOUD_VAULT_SUPERSEDED_MESSAGE}`,
    ))).toBe("encrypted");
    expect(cloudVaultGoneReason(Object.assign(
      new Error("This vault was replaced by an end-to-end encrypted vault. Update ZenNotes on this device to keep syncing it."),
      { status: 410, code: "VAULT_SUPERSEDED" },
    ))).toBe("encrypted");
    // A 410 without Cloud's own code says nothing about the vault.
    expect(cloudVaultGoneReason(
      Object.assign(new Error("Gone"), { status: 410, code: null }),
    )).toBeNull();
  });

  it("records a vault another device encrypted as encrypted, not deleted", async () => {
    const replaced = {
      syncCloudVault: async () => {
        throw new Error(CLOUD_VAULT_SUPERSEDED_MESSAGE);
      },
      getCloudVaultLink: async () => null,
    };
    await expect(syncCloudVaultWithStatus(replaced, "Notes")).rejects.toThrow();
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "unlinked",
      removedVault: { vaultName: "Notes", reason: "encrypted" },
    });
  });

  it("brings back a stored notice that the vault is now encrypted", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "zen.cloud.removedVault./vaults/Notes"
          ? JSON.stringify({ vaultName: "Notes", reason: "encrypted" })
          : null,
      setItem: () => {},
      removeItem: () => {},
    });
    const host = setup();
    const runtime = startCloudAutoSync(host.bridge, host.environment, { onError: vi.fn() }, "/vaults/Notes");
    try {
      expect(useCloudSyncStatusStore.getState().removedVault).toEqual({
        vaultName: "Notes", reason: "encrypted",
      });
    } finally {
      runtime.stop();
    }
  });

  it("records a refusal to this account as unavailable, and keeps the first name it read", async () => {
    const refused = {
      syncCloudVault: async () => {
        throw Object.assign(new Error("You are not allowed to perform this action."), {
          status: 403, code: "FORBIDDEN",
        });
      },
      getCloudVaultLink: async () => null,
    };
    await expect(syncCloudVaultWithStatus(refused, "Work")).rejects.toThrow();
    expect(useCloudSyncStatusStore.getState().removedVault).toEqual({
      vaultName: "Work", reason: "unavailable",
    });

    // A second failure no longer knows the name; it does not erase it.
    await expect(syncCloudVaultWithStatus(refused)).rejects.toThrow();
    expect(useCloudSyncStatusStore.getState().removedVault?.vaultName).toBe("Work");
  });

  it("words it one way for the status row and Settings", () => {
    expect(cloudVaultRemovalLabel({ vaultName: "Cloud QA iPhone", reason: "deleted" }))
      .toBe("Cloud vault deleted");
    expect(cloudVaultRemovalMessage({ vaultName: "Cloud QA iPhone", reason: "deleted" })).toBe(
      "“Cloud QA iPhone” was deleted from ZenNotes Cloud, so this vault stopped syncing. Your notes on this device are untouched.",
    );
    expect(cloudVaultRemovalLabel({ vaultName: "Work", reason: "unavailable" }))
      .toBe("Cloud vault unavailable");
    expect(cloudVaultRemovalMessage({ vaultName: "Work", reason: "unavailable" })).toBe(
      "“Work” is no longer available to this ZenNotes Cloud account, so this vault stopped syncing. Your notes on this device are untouched.",
    );
    expect(cloudVaultRemovalMessage({ vaultName: null, reason: "deleted" })).toBe(
      "The cloud vault this vault synced with was deleted from ZenNotes Cloud, so this vault stopped syncing. Your notes on this device are untouched.",
    );
    expect(cloudVaultRemovalLabel({ vaultName: "Notes", reason: "encrypted" }))
      .toBe("Cloud vault now encrypted");
    expect(cloudVaultRemovalMessage({ vaultName: "Notes", reason: "encrypted" })).toBe(
      "“Notes” was replaced by an end-to-end encrypted Cloud vault, so this vault stopped syncing. Your notes on this device are untouched.",
    );
  });

  it("says at once that this device deleted its own Cloud vault", () => {
    useCloudSyncStatusStore.setState({ phase: "ready", vaultName: "Notes", lastSyncedAt: 1 });
    markCloudVaultDeleted("Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "unlinked",
      vaultName: null,
      lastSyncedAt: null,
      removedVault: { vaultName: "Notes", reason: "deleted" },
    });
  });

  it("survives a reload of the same vault, never shows for another vault, and is forgotten once dismissed", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
    });
    const host = setup();
    host.syncCloudVault.mockImplementationOnce(async () => {
      host.setLinked(false);
      throw removedByHost;
    });
    // A reload starts from an empty status and a new runtime for the vault.
    const reload = async (vaultKey: string) => {
      clearCloudSyncStatus();
      const runtime = startCloudAutoSync(host.bridge, host.environment, { onError: vi.fn() }, vaultKey);
      await vi.advanceTimersByTimeAsync(1);
      return runtime;
    };

    let runtime = await reload("/vaults/Notes");
    expect(useCloudSyncStatusStore.getState().removedVault).toEqual({
      vaultName: "Notes", reason: "deleted",
    });
    runtime.stop();

    runtime = await reload("/vaults/Notes");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "unlinked",
      removedVault: { vaultName: "Notes", reason: "deleted" },
    });
    runtime.stop();

    runtime = await reload("/vaults/Work");
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "unlinked", removedVault: null,
    });
    runtime.stop();

    runtime = await reload("/vaults/Notes");
    clearRemovedCloudVault();
    runtime.stop();
    runtime = await reload("/vaults/Notes");
    expect(useCloudSyncStatusStore.getState().removedVault).toBeNull();
    runtime.stop();
    expect(values.size).toBe(0);
  });
});

describe("cloudSyncNeedsUser (the status bar shows for it even when turned off)", () => {
  const quiet = {
    phase: "ready" as const,
    removedVault: null,
    errorKind: null,
    lastSummary: null,
    settingsConflict: null,
  };

  it("is quiet for the everyday phases", () => {
    for (const phase of ["hidden", "disconnected", "connecting", "unlinked", "ready", "syncing"] as const) {
      expect(cloudSyncNeedsUser({ ...quiet, phase })).toBe(false);
    }
  });

  it("needs the user for a stopped or failed run", () => {
    expect(cloudSyncNeedsUser({ ...quiet, phase: "attention" })).toBe(true);
    expect(cloudSyncNeedsUser({ ...quiet, phase: "error", errorKind: "offline" })).toBe(true);
  });

  it("needs the user for a vault that went away and a device Cloud signed out", () => {
    expect(
      cloudSyncNeedsUser({
        ...quiet,
        phase: "unlinked",
        removedVault: { vaultName: "Notes", reason: "deleted" },
      }),
    ).toBe(true);
    expect(cloudSyncNeedsUser({ ...quiet, phase: "disconnected", errorKind: "signed-out" })).toBe(true);
  });

  it("needs the user while files or the settings question wait, even mid-sync", () => {
    const summary = { pending_conflicts: [{ id: "c1" }] } as never;
    expect(cloudSyncNeedsUser({ ...quiet, phase: "syncing", lastSummary: summary })).toBe(true);
    expect(cloudSyncNeedsUser({ ...quiet, phase: "ready", settingsConflict: {} as never })).toBe(true);
  });
});
