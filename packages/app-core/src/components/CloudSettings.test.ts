// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudAccountStatus,
  CloudServiceAccount,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import { CloudSettings } from "./CloudSettings";
import { subscribePublishedNoteChanges } from "../lib/published-note-events";

const mocks = vi.hoisted(() => ({
  getCloudAccountStatus: vi.fn(),
  connectCloudAccount: vi.fn(),
  logoutCloudAccount: vi.fn(),
  onCloudAccountChange: vi.fn(() => vi.fn()),
  getCloudServiceAccount: vi.fn(),
  listCloudPublishedNotes: vi.fn(),
  unpublishCloudNote: vi.fn(),
  clipboardWriteText: vi.fn(),
  listCloudVaults: vi.fn(),
  getCloudVaultLink: vi.fn(),
  linkCloudVault: vi.fn(),
  createAndLinkCloudVault: vi.fn(),
  unlinkCloudVault: vi.fn(),
  syncCloudVault: vi.fn(),
  getCloudSettingsConflict: vi.fn(),
  resolveCloudSettingsConflict: vi.fn(),
  listCloudBackups: vi.fn(),
  getCloudBackupSchedule: vi.fn(),
  updateCloudBackupSchedule: vi.fn(),
  listCloudBackupItems: vi.fn(),
  restoreCloudBackupNote: vi.fn(),
  createCloudBackup: vi.fn(),
  downloadCloudBackup: vi.fn(),
  deleteCloudBackup: vi.fn(),
  restoreCloudBackup: vi.fn(),
  requestCloudAutoSync: vi.fn(),
  syncCloudVaultWithStatus: vi.fn(),
  confirmApp: vi.fn(async () => true),
}));

vi.mock("@zennotes/bridge-contract/bridge", () => ({
  getZenBridge: () => mocks,
}));

vi.mock("../lib/confirm-requests", () => ({
  confirmApp: mocks.confirmApp,
}));

vi.mock("../lib/cloud-auto-sync", () => ({
  requestCloudAutoSync: mocks.requestCloudAutoSync,
  syncCloudVaultWithStatus: mocks.syncCloudVaultWithStatus,
}));

const disconnected: CloudAccountStatus = {
  state: "disconnected",
  account: null,
};

const connected: CloudAccountStatus = {
  state: "connected",
  account: {
    base_url: "https://zennotes.org",
    user: { name: "Ada", email: "ada@example.com" },
    device: { id: "device-1", name: "Ada’s iPhone", platform: "ios" },
    connected_at: "2026-08-10T12:00:00.000Z",
  },
};

const serviceAccount: CloudServiceAccount = {
  user: connected.account!.user,
  device: { ...connected.account!.device, app_version: "1.5.0" },
  features: {
    sync: {
      active: true,
      limits: { max_storage_bytes: 1_073_741_824 },
    },
    backup: {
      active: false,
      limits: {
        max_snapshots: 30,
        max_snapshot_bytes: 52_428_800,
        retention_days: 30,
      },
    },
    publish: { active: true, limits: null },
  },
  usage: {
    storage: {
      total_bytes: 1_573_888,
      sync_bytes: 1_572_864,
      backup_bytes: 1_024,
      publish_bytes: 0,
    },
    sync: { vaults: 2, items: 38 },
    backup: {
      snapshots: 1,
      ready_snapshots: 1,
      latest_at: "2026-08-10T12:00:00.000Z",
    },
    publish: {
      notes: 1,
      assets: 0,
      latest_at: "2026-08-10T12:05:00.000Z",
    },
  },
};

describe("CloudSettings", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCloudPublishedNotes.mockResolvedValue([]);
    mocks.getCloudBackupSchedule.mockResolvedValue({
      enabled: false,
      frequency: "daily",
      next_backup_at: null,
      last_backup_at: null,
    });
    mocks.syncCloudVaultWithStatus.mockImplementation(() =>
      mocks.syncCloudVault(),
    );
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("starts browser sign-in and presents a cancellable connecting state", async () => {
    mocks.getCloudAccountStatus
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce({ state: "connecting", account: null });
    mocks.connectCloudAccount.mockResolvedValue({
      authorization_url: "https://zennotes.org/app/connect",
      expires_at: "2026-08-10T12:05:00.000Z",
    });
    mocks.logoutCloudAccount.mockResolvedValue(disconnected);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    const connect = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Connect ZenNotes Cloud",
    );
    expect(connect).toBeTruthy();

    await act(async () => connect!.click());

    expect(mocks.connectCloudAccount).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Finish signing in in your browser");

    const cancel = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel sign-in",
    );
    expect(cancel).toBeTruthy();
    await act(async () => cancel!.click());
    expect(mocks.logoutCloudAccount).toHaveBeenCalledOnce();
  });

  it("shows the connected account and server-side feature entitlements", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults.mockResolvedValue([]);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("ada@example.com");
    expect(host.textContent).toContain("SyncIncluded");
    expect(host.textContent).toContain("BackupNot included");
    expect(host.textContent).toContain("PublishIncluded");
    expect(host.textContent).toContain("Cloud storage");
    expect(host.textContent).toContain("1.5 MB of 1.0 GB");
    expect(host.textContent).toContain("38 synced notes across 2 vaults");
    expect(host.textContent).toContain("1 backup · 30-day retention");
    expect(host.textContent).toContain("1 published note");
    expect(host.textContent).not.toContain("views");
  });

  it("lists, copies, and unpublishes public notes", async () => {
    const publishedNoteChanged = vi.fn();
    const unsubscribe = subscribePublishedNoteChanges(publishedNoteChanged);
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.listCloudPublishedNotes.mockResolvedValue([
      {
        id: 42,
        slug: "launch",
        url: "https://zennotes.org/s/launch",
        title: "Launch notes",
        note_path: "Notes/Launch.md",
        created_at: "2026-08-10T12:00:00.000Z",
        updated_at: "2026-08-10T12:05:00.000Z",
      },
    ]);
    mocks.unpublishCloudNote.mockResolvedValue(undefined);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("Published notes");
    expect(host.textContent).toContain("Launch notes");
    expect(host.textContent).not.toContain("views");
    expect(host.textContent).toContain("Updated");

    const copy = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Copy link",
    );
    copy!.click();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(
      "https://zennotes.org/s/launch",
    );

    const unpublish = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Unpublish",
    );
    await act(async () => unpublish!.click());

    expect(mocks.confirmApp).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, confirmLabel: "Unpublish" }),
    );
    expect(mocks.unpublishCloudNote).toHaveBeenCalledWith(42);
    expect(host.textContent).not.toContain("Launch notes");
    expect(publishedNoteChanged).toHaveBeenCalledWith({
      notePath: "Notes/Launch.md",
      url: null,
    });
    unsubscribe();
  });

  it("continues with a cloud vault created on another device and reports a completed manual sync", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValueOnce(null);
    mocks.listCloudVaults.mockResolvedValue([
      {
        id: "vault-1",
        name: "Cloud Notes",
        cursor: 4,
        created_at: "2026-08-10T12:00:00.000Z",
        updated_at: "2026-08-10T12:30:00.000Z",
      },
    ]);
    mocks.linkCloudVault.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    const summary: CloudSyncRunSummary = {
      cursor: 7,
      pulled: 2,
      pushed: 3,
      conflicts: [],
      bootstrap_conflicts: [], local_conflicts: [],
    };
    mocks.syncCloudVault.mockResolvedValue(summary);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("Continue with your cloud vault");
    expect(host.textContent).toContain("Cloud Notes");
    expect(host.textContent).toContain("Updated");
    expect(host.textContent).toContain(
      "Notes already on this device are merged safely",
    );
    expect(host.textContent).not.toContain("vault-1");

    const link = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Open on this device",
    );
    expect(link).toBeTruthy();
    await act(async () => link!.click());

    expect(mocks.linkCloudVault).toHaveBeenCalledWith("vault-1");
    expect(mocks.requestCloudAutoSync).toHaveBeenCalledWith("vault-link");
    expect(host.textContent).toContain("Linked to Cloud Notes");

    const sync = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Sync now",
    );
    await act(async () => sync!.click());

    expect(mocks.syncCloudVaultWithStatus).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Downloaded 2 · Uploaded 3");
    expect(host.textContent).not.toContain("Cursor 7");
  });

  // Settings that differ between devices are a question, not a silent merge.
  // Doing nothing keeps this device's settings, so the local choice leads.
  it("asks which vault settings to keep and applies the answer", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudSettingsConflict.mockResolvedValue({
      path: ".zennotes/vault.json",
      cloud_path: ".zennotes/vault.cloud-conflict.json",
    });

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("Vault settings differ from the cloud");
    expect(host.textContent).toContain("This device’s settings are the ones in use.");

    const keepLocal = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Keep this device's",
    );
    const useCloud = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Use the cloud's",
    );
    expect(keepLocal).toBeTruthy();
    expect(useCloud).toBeTruthy();

    mocks.getCloudSettingsConflict.mockResolvedValue(null);
    await act(async () => useCloud!.click());

    expect(mocks.resolveCloudSettingsConflict).toHaveBeenCalledWith("cloud");
    // Answered, so the question stops being asked.
    expect(host.textContent).not.toContain("Vault settings differ from the cloud");
  });

  it("does not request vault data when sync is not included", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue({
      ...serviceAccount,
      features: {
        ...serviceAccount.features,
        sync: { active: false, limits: null },
      },
    });

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain(
      "Sync is not included in this subscription",
    );
    expect(mocks.listCloudVaults).not.toHaveBeenCalled();
    expect(mocks.getCloudVaultLink).not.toHaveBeenCalled();
  });

  it("does not request vault data for a temporary folder session", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: false,
          localVaultName: "desktop",
        }),
      ),
    );

    expect(host.textContent).toContain(
      "Save this folder as a local vault before linking it to ZenNotes Cloud.",
    );
    expect(host.textContent).not.toContain("Create a new cloud vault");
    expect(mocks.listCloudVaults).not.toHaveBeenCalled();
    expect(mocks.getCloudVaultLink).not.toHaveBeenCalled();
  });

  it("removes the Electron IPC wrapper from actionable errors", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockRejectedValue(
      new Error(
        "Error invoking remote method 'cloud-vaults:list': Error: The cloud service is unavailable.",
      ),
    );
    mocks.getCloudVaultLink.mockResolvedValue(null);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("The cloud service is unavailable.");
    expect(host.textContent).not.toContain("Error invoking remote method");
  });

  it("guides a vault linked to another cloud service into the current account", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue({
      ...serviceAccount,
      features: {
        ...serviceAccount.features,
        backup: { active: true, limits: null },
      },
    });
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "http://zennotes.test",
      vault_id: "local-vault",
      vault_name: "My Vault",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.createAndLinkCloudVault.mockResolvedValue({
      base_url: connected.account!.base_url,
      vault_id: "cloud-vault",
      vault_name: "Notes",
      linked_at: "2026-08-11T12:00:00.000Z",
    });
    mocks.listCloudBackups.mockResolvedValue([]);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain(
      "This vault was linked to http://zennotes.test",
    );
    expect(host.textContent).toContain(
      `You’re now connected to ${connected.account!.base_url}`,
    );
    expect(host.textContent).not.toContain("different ZenNotes Cloud account");
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Sync now",
      ),
    ).toBe(false);
    expect(mocks.listCloudBackups).not.toHaveBeenCalled();

    const move = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create and move",
    );
    expect(move).toBeTruthy();
    await act(async () => move!.click());

    expect(mocks.createAndLinkCloudVault).toHaveBeenCalledWith("Notes");
    expect(mocks.requestCloudAutoSync).toHaveBeenCalledWith("vault-link");
    expect(host.textContent).toContain("Linked to Notes");
  });

  it("creates and safely restores backups for a linked vault", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue({
      ...serviceAccount,
      features: {
        ...serviceAccount.features,
        backup: { active: true, limits: { max_snapshots: 30 } },
      },
    });
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.listCloudBackups.mockResolvedValue([
      {
        id: "backup-1",
        label: "Before migration",
        trigger: "manual",
        status: "ready",
        cursor: 12,
        item_count: 8,
        total_bytes: 2048,
        archive_bytes: 1024,
        expires_at: "2026-09-09T12:00:00.000Z",
        created_at: "2026-08-10T12:00:00.000Z",
      },
      {
        id: "backup-earlier",
        label: "Earlier recovery point",
        trigger: "automatic",
        status: "ready",
        cursor: 8,
        item_count: 6,
        total_bytes: 1536,
        archive_bytes: 768,
        expires_at: "2026-09-07T18:00:00.000Z",
        created_at: "2026-08-08T18:00:00.000Z",
      },
    ]);
    mocks.createCloudBackup.mockResolvedValue({
      id: "backup-2",
      label: null,
      trigger: "manual",
      status: "pending",
      cursor: 12,
      item_count: 8,
      total_bytes: 2048,
      archive_bytes: null,
      expires_at: "2026-09-09T12:00:00.000Z",
      created_at: "2026-08-10T12:05:00.000Z",
    });
    mocks.restoreCloudBackup.mockResolvedValue({
      restore: {
        id: "restore-1",
        backup_id: "backup-1",
        mode: "replace",
        status: "completed",
        expected_cursor: 12,
        start_cursor: 12,
        end_cursor: 18,
        restored_items: 8,
        deleted_items: 2,
        error: null,
        created_at: "2026-08-10T12:06:00.000Z",
        updated_at: "2026-08-10T12:06:01.000Z",
      },
      sync: {
        cursor: 18,
        pulled: 10,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [], local_conflicts: [],
      },
    });
    mocks.updateCloudBackupSchedule.mockResolvedValue({
      enabled: true,
      frequency: "daily",
      next_backup_at: "2026-08-11T12:00:00.000Z",
      last_backup_at: null,
    });
    mocks.listCloudBackupItems.mockResolvedValue([
      {
        id: 42,
        item_id: "note-1",
        path: "Journal/Monday.md",
        kind: "text",
        byte_length: 512,
        revision: 3,
        content_hash: "abc",
        media_type: "text/markdown",
      },
      {
        id: 43,
        item_id: "note-2",
        path: "Projects/Launch plan.md",
        kind: "text",
        byte_length: 768,
        revision: 2,
        content_hash: "def",
        media_type: "text/markdown",
      },
    ]);
    mocks.restoreCloudBackupNote.mockResolvedValue({
      restore: {
        id: "note-restore-1",
        status: "completed",
        item_id: "note-1",
        path: "Journal/Monday.md",
        revision: 5,
        cursor: 19,
        error_code: null,
        created_at: "2026-08-10T12:07:00.000Z",
      },
      sync: {
        cursor: 19,
        pulled: 1,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [], local_conflicts: [],
      },
    });

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("Before migration");
    expect(host.textContent).toContain("Manual");
    expect(host.textContent).toContain("Automatic daily backups");
    expect(host.textContent).toContain("8 items · 2.0 KB source");
    expect(host.textContent).toContain("1.0 KB archive");
    expect(host.textContent).toContain("Expires");
    expect(host.textContent).not.toContain("Cursor 12");
    const download = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save archive",
    );
    await act(async () => download!.click());
    expect(mocks.downloadCloudBackup).toHaveBeenCalledWith("backup-1");

    const automatic = host.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => automatic!.click());
    expect(mocks.updateCloudBackupSchedule).toHaveBeenCalledWith(true);

    const create = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create backup",
    );
    await act(async () => create!.click());
    expect(mocks.createCloudBackup).toHaveBeenCalledWith(undefined);
    expect(host.textContent).toContain("Preparing");

    const restore = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Restore" && !button.disabled,
    );
    await act(async () => restore!.click());

    expect(mocks.confirmApp).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(mocks.restoreCloudBackup).toHaveBeenCalledWith("backup-1");
    expect(host.textContent).toContain("Restored 8 items");

    const browse = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Browse notes",
    );
    await act(async () => browse!.click());
    expect(mocks.listCloudBackupItems).toHaveBeenCalledWith("backup-1");
    expect(host.textContent).toContain("Journal/Monday.md");
    expect(host.textContent).toContain("Projects/Launch plan.md");

    const search = host.querySelector<HTMLInputElement>(
      'input[aria-label="Search notes in this backup"]',
    );
    expect(search).toBeTruthy();
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(search, "monday");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Journal/Monday.md");
    expect(host.textContent).not.toContain("Projects/Launch plan.md");

    await act(async () => {
      valueSetter?.call(search, "missing note");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain('No notes match "missing note".');

    await act(async () => {
      valueSetter?.call(search, "");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const restoreNote = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Restore note",
    );
    await act(async () => restoreNote!.click());
    expect(mocks.confirmApp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Other notes are unchanged"),
      }),
    );
    expect(mocks.restoreCloudBackupNote).toHaveBeenCalledWith("backup-1", 42);

    const restoreDate = host.querySelector<HTMLInputElement>(
      'input[aria-label="Restore from date"]',
    );
    expect(restoreDate).toBeTruthy();
    const earlierDate = new Date("2026-08-08T18:00:00.000Z");
    const exactDate = [
      earlierDate.getFullYear(),
      String(earlierDate.getMonth() + 1).padStart(2, "0"),
      String(earlierDate.getDate()).padStart(2, "0"),
    ].join("-");
    const followingDate = new Date(
      earlierDate.getFullYear(),
      earlierDate.getMonth(),
      earlierDate.getDate() + 1,
    );
    const fallbackDate = [
      followingDate.getFullYear(),
      String(followingDate.getMonth() + 1).padStart(2, "0"),
      String(followingDate.getDate()).padStart(2, "0"),
    ].join("-");

    await act(async () => {
      valueSetter?.call(restoreDate, exactDate);
      restoreDate!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Earlier recovery point");
    expect(host.textContent).not.toContain("Before migration");

    await act(async () => {
      valueSetter?.call(restoreDate, fallbackDate);
      restoreDate!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain(
      "No backup was created on this date. Showing the closest earlier recovery point",
    );
    expect(host.textContent).toContain("Earlier recovery point");

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const futureDate = [
      tomorrow.getFullYear(),
      String(tomorrow.getMonth() + 1).padStart(2, "0"),
      String(tomorrow.getDate()).padStart(2, "0"),
    ].join("-");
    await act(async () => {
      valueSetter?.call(restoreDate, futureDate);
      restoreDate!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(restoreDate?.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Choose today or an earlier date.");
    expect(host.textContent).not.toContain("Earlier recovery point");

    await act(async () => {
      valueSetter?.call(restoreDate, "2020-01-01");
      restoreDate!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain(
      "No backup is available on or before this date.",
    );

    const showAll = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Show all",
    );
    await act(async () => showAll!.click());
    expect(host.textContent).toContain("Earlier recovery point");
    expect(host.textContent).toContain("Before migration");
  });
});
