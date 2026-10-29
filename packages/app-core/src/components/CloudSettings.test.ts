// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudAccountStatus,
  CloudBackupItemsPage,
  CloudBackupItemsQuery,
  CloudBackupSnapshotItem,
  CloudServiceAccount,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import type { ZenBridge } from "@zennotes/bridge-contract/bridge";
import { useStore } from "../store";
import { getPublishNoteRequest, dismissPublishNoteRequest } from "../lib/publish-note-requests";
import { CloudSettings } from "./CloudSettings";
import { subscribePublishedNoteChanges } from "../lib/published-note-events";
import { clearCloudSyncStatus, useCloudSyncStatusStore } from "../lib/cloud-auto-sync";
import {
  CLOUD_SIGNED_OUT_MESSAGE,
  describeCloudError,
  encodeCloudErrorMessage,
} from "@zennotes/shared-domain/cloud-error-copy";

const mocks = vi.hoisted(() => ({
  getCloudAccountStatus: vi.fn(),
  connectCloudAccount: vi.fn(),
  logoutCloudAccount: vi.fn(),
  onCloudAccountChange: vi.fn(() => vi.fn()),
  getCloudServiceAccount: vi.fn(),
  listCloudPublishedNotes: vi.fn(),
  unpublishCloudNote: vi.fn(),
  readNote: vi.fn(),
  clipboardWriteText: vi.fn(),
  listCloudVaults: vi.fn(),
  getCloudVaultLink: vi.fn(),
  linkCloudVault: vi.fn(),
  createAndLinkCloudVault: vi.fn(),
  unlinkCloudVault: vi.fn(),
  deleteCloudVault: vi.fn(),
  syncCloudVault: vi.fn(),
  getCloudConflict: vi.fn(),
  saveCloudConflictDraft: vi.fn(),
  resolveCloudConflict: vi.fn(),
  releaseCloudConflictReview: vi.fn(),
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
  focusEditorNormalMode: vi.fn(),
}));

vi.mock("@zennotes/bridge-contract/bridge", () => ({
  getZenBridge: () => mocks,
}));

vi.mock("../lib/confirm-requests", () => ({
  confirmApp: mocks.confirmApp,
}));

vi.mock("../lib/editor-focus", () => ({
  focusEditorNormalMode: mocks.focusEditorNormalMode,
}));

vi.mock("../lib/cloud-auto-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cloud-auto-sync")>()),
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
      limits: { max_storage_bytes: 1_000_000_000 },
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
    sync: {
      vaults: 2,
      items: 38,
      markdown_items: 30,
      binary_items: 5,
      other_items: 2,
      metadata_items: 1,
    },
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

  beforeEach(async () => {
    vi.clearAllMocks();
    clearCloudSyncStatus();
    mocks.saveCloudConflictDraft.mockResolvedValue(undefined);
    mocks.resolveCloudConflict.mockResolvedValue(undefined);
    mocks.releaseCloudConflictReview.mockResolvedValue(undefined);
    mocks.listCloudPublishedNotes.mockResolvedValue([]);
    mocks.getCloudBackupSchedule.mockResolvedValue({
      enabled: false,
      frequency: "daily",
      next_backup_at: null,
      last_backup_at: null,
    });
    const actual = await vi.importActual<typeof import("../lib/cloud-auto-sync")>("../lib/cloud-auto-sync");
    mocks.syncCloudVaultWithStatus.mockImplementation(actual.syncCloudVaultWithStatus);
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
    expect(host.textContent).toContain("1.6 MB of 1.0 GB");
    expect(host.textContent).toContain("38 synced files across 2 vaults");
    expect(host.textContent).toContain(
      "30 Markdown · 5 binary · 2 other · 1 ZenNotes metadata",
    );
    expect(host.textContent).toContain("1 backup · 30-day retention");
    expect(host.textContent).toContain("1 published note");
    expect(host.textContent).not.toContain("views");
  });

  it("opens an explicit update with the latest local draft from Published notes", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.listCloudPublishedNotes.mockResolvedValue([{
      id: 42, slug: "launch", url: "https://zennotes.org/s/launch",
      title: "Launch notes", note_path: "Notes/Launch.md", created_at: null, updated_at: null,
    }]);
    const draft = { path: "Notes/Launch.md", title: "Launch notes", body: "Newest unsaved draft", assetEmbeds: [] };
    useStore.setState({ noteContents: { [draft.path]: draft as never }, noteDirty: { [draft.path]: true }, notes: [draft as never] });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    expect(host.textContent).toContain("Refresh list");
    expect(host.textContent).toContain("Edits stay private until you choose Update note");
    const update = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Update note");
    expect(update).toBeTruthy();
    await act(async () => update!.click());
    expect(getPublishNoteRequest()?.note.body).toBe(draft.body);
    expect(mocks.readNote).not.toHaveBeenCalled();
    const request = getPublishNoteRequest();
    if (request) dismissPublishNoteRequest(request);
    act(() => useStore.setState({ noteContents: {}, noteDirty: {}, notes: [] }));
  });

  it("reads the current file instead of a stale clean cache when updating a public note", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults.mockResolvedValue([]);
    const cached = { path: "Notes/Old.md", title: "Old", body: "Old cache", assetEmbeds: [] };
    mocks.listCloudPublishedNotes.mockResolvedValue([{
      id: 43, slug: "old", url: "https://zennotes.org/s/old", title: cached.title,
      note_path: cached.path, created_at: null, updated_at: null,
    }]);
    mocks.readNote.mockResolvedValueOnce({ ...cached, body: "Latest from Cloud" });
    useStore.setState({ noteContents: { [cached.path]: cached as never }, noteDirty: {}, notes: [cached as never] });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    const update = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Update note");
    await act(async () => update!.click());
    const request = getPublishNoteRequest();
    expect(request?.note.body).toBe("Latest from Cloud");
    if (request) dismissPublishNoteRequest(request);
    act(() => useStore.setState({ noteContents: {}, noteDirty: {}, notes: [] }));
  });

  it("prefers a draft edited while the Update note disk read is pending", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults.mockResolvedValue([]);
    const note = { path: "Notes/Race.md", title: "Race", body: "Old disk content", assetEmbeds: [] };
    mocks.listCloudPublishedNotes.mockResolvedValue([{
      id: 43, slug: "race", url: "https://zennotes.org/s/race", title: note.title,
      note_path: note.path, created_at: null, updated_at: null,
    }]);
    let finish!: (value: unknown) => void;
    mocks.readNote.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useStore.setState({ noteContents: {}, notes: [note as never] });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    const update = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Update note");
    await act(async () => update!.click());
    await act(async () => {
      useStore.setState({ noteContents: { [note.path]: { ...note, body: "New draft" } as never }, noteDirty: { [note.path]: true } });
      finish(note);
    });
    const request = getPublishNoteRequest();
    expect(request?.note.body).toBe("New draft");
    if (request) dismissPublishNoteRequest(request);
    act(() => useStore.setState({ noteContents: {}, noteDirty: {}, notes: [] }));
  });

  it("asks for a smaller file instead of promising automatic recovery from an oversized upload", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({ base_url: connected.account!.base_url,
      vault_id: "vault-1", vault_name: "Notes", linked_at: "2026-09-14T12:00:00Z" });
    mocks.syncCloudVault.mockResolvedValue({ cursor: 1, pulled: 0, pushed: 0,
      bootstrap_conflicts: [], local_conflicts: [], conflicts: [{
        operation_id: "large", item_id: "large", code: "FILE_SIZE_LIMIT_EXCEEDED",
        current_revision: null, current_path: null,
        capacity: { dimension: "sync_max_file_bytes", limit: 10_000_000, used: 0,
          reserved: 0, projected: 12_600_000, can_retry_after_reduction: true },
      }] });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    const sync = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Sync now");
    await act(async () => sync!.click());
    expect(host.textContent).toContain("10 MB Cloud file-size limit");
    expect(host.textContent).toContain("Remove it or make it smaller to finish syncing");
    expect(host.textContent).toContain("1 file too large for Cloud");
    expect(host.textContent).not.toContain("will retry automatically");
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
      bootstrap_conflicts: [],
      local_conflicts: [],
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

  it("shows an encrypted vault's name once this device unlocks, without reopening Settings", async () => {
    const encrypted = {
      id: "vault-e",
      cursor: 1,
      created_at: "2026-10-12T12:00:00.000Z",
      updated_at: "2026-10-12T12:30:00.000Z",
      encryption: {
        scheme: "zne1" as const,
        key_id: "0123456789abcdef0123456789abcdef",
        key_version: 1,
        vault_key_envelope: "sealed",
        name: "sealed-name",
      },
    };
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.listCloudVaults
      .mockResolvedValueOnce([{ ...encrypted, name: "Encrypted vault" }])
      .mockResolvedValue([{ ...encrypted, name: "Work notes" }]);
    let unlocked = false;
    const bridge = mocks as unknown as Record<string, unknown>;
    bridge.getCloudEncryptionStatus = vi.fn(async () => ({ available: true, keyset: true, unlocked }));
    bridge.unlockCloudEncryption = vi.fn(async () => {
      unlocked = true;
    });
    try {
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      // The vault's placeholder name, not the panel's "Encrypted vaults sync…".
      expect(host.textContent).toMatch(/Encrypted vault(?!s)/);
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(1);

      const open = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Unlock this device",
      );
      await act(async () => open!.click());
      const input = document.querySelector<HTMLInputElement>('input[type="password"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "correct horse");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const unlock = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Unlock",
      );
      await act(async () => unlock!.click());

      expect(bridge.unlockCloudEncryption).toHaveBeenCalledOnce();
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("Work notes");
      expect(host.textContent).not.toMatch(/Encrypted vault(?!s)/);
    } finally {
      delete bridge.getCloudEncryptionStatus;
      delete bridge.unlockCloudEncryption;
    }
  });

  it("separates unlinking this device from permanently deleting the cloud vault", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.unlinkCloudVault.mockResolvedValue(undefined);
    mocks.deleteCloudVault.mockResolvedValue(undefined);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    const unlink = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Unlink this device",
    );
    const remove = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Delete Cloud vault",
    );

    expect(unlink).toBeTruthy();
    expect(remove).toBeTruthy();
    await act(async () => remove!.click());

    // Deleting reaches every device, so it has its own dialog that names the
    // vault and waits for that name, never the shared yes/no confirmation.
    expect(mocks.confirmApp).not.toHaveBeenCalled();
    const dialog = deleteDialog();
    expect(dialog?.querySelector('[role="dialog"]')?.textContent).toContain(
      "Delete “Cloud Notes” for every device?",
    );
    expect(dialog?.textContent).toContain(
      "Every device linked to this Cloud vault stops syncing.",
    );
    expect(dialog?.textContent).toContain(
      "Its Cloud copy, backups, and exports are permanently deleted",
    );
    expect(dialog?.textContent).toContain(
      "Notes already on your devices stay where they are.",
    );
    expect(dialog?.textContent).toContain("use Unlink this device instead");
    await act(async () => typeInto(deleteNameInput()!, "Cloud Notes"));
    await act(async () => deleteConfirmButton()!.click());

    expect(deleteDialog()).toBeNull();
    expect(mocks.deleteCloudVault).toHaveBeenCalledOnce();
    expect(mocks.unlinkCloudVault).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Linked to Cloud Notes");
  });

  describe("deleting a Cloud vault", () => {
    const linked = {
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    };
    const otherVault = {
      id: "vault-2",
      name: "Other preserved vault",
      cursor: 3,
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:30:00.000Z",
    };

    beforeEach(async () => {
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.getCloudVaultLink.mockResolvedValue(linked);
      mocks.listCloudVaults.mockResolvedValue([
        { ...otherVault, id: "vault-1", name: "Cloud Notes" },
        otherVault,
      ]);
      // What the service holds once the vault is gone. The host answers the
      // link question a moment later, after the panel has already redrawn
      // without the link, as it does in the app.
      mocks.deleteCloudVault.mockImplementation(async () => {
        mocks.getCloudVaultLink.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(null), 0)),
        );
        mocks.listCloudVaults.mockResolvedValue([otherVault]);
      });
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      await act(async () => buttonNamed("Delete Cloud vault")!.click());
    });

    it("keeps Delete disabled until the vault name is typed, and Escape cancels", async () => {
      const confirm = deleteConfirmButton()!;
      expect(confirm.disabled).toBe(true);
      // The field is where the keyboard lands, so the name can be typed at once.
      expect(document.activeElement).toBe(deleteNameInput());

      await act(async () => typeInto(deleteNameInput()!, "Cloud"));
      expect(confirm.disabled).toBe(true);
      await act(async () => typeInto(deleteNameInput()!, "cloud notes"));
      expect(confirm.disabled).toBe(true);
      // Enter does nothing until the name matches.
      await act(async () => pressKey(deleteNameInput()!, "Enter"));
      expect(mocks.deleteCloudVault).not.toHaveBeenCalled();
      await act(async () => typeInto(deleteNameInput()!, "Cloud Notes"));
      expect(confirm.disabled).toBe(false);

      await act(async () => pressKey(deleteNameInput()!, "Escape"));
      expect(deleteDialog()).toBeNull();
      expect(mocks.deleteCloudVault).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Linked to Cloud Notes");

      // A fresh dialog starts empty, and Enter in the field deletes once the
      // name matches.
      await act(async () => buttonNamed("Delete Cloud vault")!.click());
      expect(deleteNameInput()!.value).toBe("");
      expect(deleteConfirmButton()!.disabled).toBe(true);
      await act(async () => typeInto(deleteNameInput()!, "Cloud Notes"));
      await act(async () => pressKey(deleteNameInput()!, "Enter"));
      expect(mocks.deleteCloudVault).toHaveBeenCalledOnce();
    });

    it("says in This vault and on the status that the vault was deleted, and reads the vault list again", async () => {
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(1);
      await act(async () => typeInto(deleteNameInput()!, "Cloud Notes"));
      await act(async () => deleteConfirmButton()!.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(useCloudSyncStatusStore.getState()).toMatchObject({
        phase: "unlinked",
        removedVault: { vaultName: "Cloud Notes", reason: "deleted" },
      });
      const notice = host.querySelector<HTMLElement>("[data-cloud-vault-removed]");
      expect(notice?.closest('[data-settings-search-id="cloud-vault"]')).not.toBeNull();
      expect(notice?.textContent).toContain("Cloud vault deleted");
      expect(notice?.textContent).toContain(
        "“Cloud Notes” was deleted from ZenNotes Cloud, so this vault stopped syncing. Your notes on this device are untouched. Choose a cloud vault or start a new one.",
      );
      // The list comes from the service again, not from editing the old one.
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(2);
      const offered = host.textContent!.replace(notice!.textContent!, "");
      expect(offered).not.toContain("Cloud Notes");
      expect(offered).toContain("Other preserved vault");
      expect(buttonNamed("Open on this device")?.disabled).toBe(false);
    });
  });

  describe("a vault deleted on another device", () => {
    const ghost = {
      id: "vault-ghost",
      name: "Cloud QA Mac",
      cursor: 3,
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:30:00.000Z",
    };

    beforeEach(() => {
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.getCloudVaultLink.mockResolvedValue(null);
    });

    it("reads the list again when opening it fails, and says so inside This vault", async () => {
      mocks.listCloudVaults.mockResolvedValueOnce([ghost]).mockResolvedValue([]);
      mocks.linkCloudVault.mockRejectedValue(
        new Error(
          "Error invoking remote method 'cloud-vault:link': Error: That ZenNotes Cloud vault is not available to this account.",
        ),
      );
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      expect(host.textContent).toContain("Cloud QA Mac");

      await act(async () => buttonNamed("Open on this device")!.click());

      expect(mocks.linkCloudVault).toHaveBeenCalledWith("vault-ghost");
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(2);
      const alerts = [...host.querySelectorAll<HTMLElement>('[role="alert"]')];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].closest('[data-settings-search-id="cloud-vault"]')).not.toBeNull();
      expect(alerts[0].textContent).toBe(
        "“Cloud QA Mac” is no longer in your ZenNotes Cloud account. It may have been deleted on another device. The list below is up to date.",
      );
      expect(host.textContent).not.toContain("Continue with your cloud vault");
      expect(host.textContent).toContain("Create a new cloud vault");
    });

    it("shows any other failure from This vault there too, as the host worded it", async () => {
      mocks.listCloudVaults.mockResolvedValue([ghost]);
      mocks.linkCloudVault.mockRejectedValue(
        new Error("Error invoking remote method 'cloud-vault:link': Error: Connection timed out."),
      );
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );

      await act(async () => buttonNamed("Open on this device")!.click());

      const alert = host.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.closest('[data-settings-search-id="cloud-vault"]')).not.toBeNull();
      expect(alert?.textContent).toBe("Connection timed out.");
      // Nothing says the vault is gone, so the list is left as it was.
      expect(mocks.listCloudVaults).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Continue with your cloud vault");
    });

    it.each(["Open on this device", "Create and link"] as const)(
      "keeps the notice until %s links this vault again",
      async (choice) => {
        useCloudSyncStatusStore.setState({
          phase: "unlinked",
          removedVault: { vaultName: "Cloud QA iPhone", reason: "deleted" },
        });
        mocks.listCloudVaults.mockResolvedValue([
          { ...ghost, id: "vault-2", name: "Notes" },
        ]);
        mocks.linkCloudVault.mockResolvedValue({
          base_url: connected.account!.base_url,
          vault_id: "vault-2",
          vault_name: "Notes",
          linked_at: "2026-08-11T12:00:00.000Z",
        });
        mocks.createAndLinkCloudVault.mockResolvedValue({
          base_url: connected.account!.base_url,
          vault_id: "vault-3",
          vault_name: "Notes",
          linked_at: "2026-08-11T12:00:00.000Z",
        });
        await act(async () =>
          root.render(
            createElement(CloudSettings, {
              localVaultAvailable: true,
              localVaultName: "Notes",
            }),
          ),
        );
        expect(
          host.querySelector("[data-cloud-vault-removed]")?.textContent,
        ).toContain(
          "“Cloud QA iPhone” was deleted from ZenNotes Cloud, so this vault stopped syncing.",
        );

        await act(async () => buttonNamed(choice)!.click());

        expect(host.textContent).toContain("Linked to Notes");
        expect(host.querySelector("[data-cloud-vault-removed]")).toBeNull();
        expect(useCloudSyncStatusStore.getState().removedVault).toBeNull();
        // The list is read again after linking rather than edited here.
        expect(mocks.listCloudVaults).toHaveBeenCalledTimes(2);
      },
    );

    it("lets the notice be dismissed", async () => {
      useCloudSyncStatusStore.setState({
        phase: "unlinked",
        removedVault: { vaultName: "Cloud QA iPhone", reason: "deleted" },
      });
      mocks.listCloudVaults.mockResolvedValue([]);
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      const notice = host.querySelector("[data-cloud-vault-removed]");
      // With nothing left to choose, the notice points at the one way on.
      expect(notice?.textContent).toContain(
        "Create a new cloud vault to sync it again.",
      );

      await act(async () => buttonNamed("Dismiss")!.click());

      expect(host.querySelector("[data-cloud-vault-removed]")).toBeNull();
      expect(useCloudSyncStatusStore.getState().removedVault).toBeNull();
    });
  });

  describe("a vault another device encrypted", () => {
    const replaced = {
      phase: "unlinked" as const,
      removedVault: { vaultName: "Notes", reason: "encrypted" as const },
    };
    const renderSettings = () =>
      act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );

    beforeEach(() => {
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.getCloudVaultLink.mockResolvedValue(null);
      mocks.listCloudVaults.mockResolvedValue([]);
    });

    afterEach(() => {
      delete (mocks as Record<string, unknown>).getCloudEncryptionStatus;
    });

    it("says the vault was replaced, not deleted, and asks a locked device to unlock first", async () => {
      useCloudSyncStatusStore.setState(replaced);
      await renderSettings();

      const notice = host.querySelector<HTMLElement>("[data-cloud-vault-removed]");
      expect(notice?.textContent).toContain("Cloud vault now encrypted");
      expect(notice?.textContent).toContain(
        "“Notes” was replaced by an end-to-end encrypted Cloud vault, so this vault stopped syncing. Your notes on this device are untouched. Unlock this device under End-to-end encryption, then choose the encrypted vault.",
      );
      expect(notice?.textContent).not.toContain("deleted");
    });

    it("points an unlocked device straight at the encrypted vault", async () => {
      Object.assign(mocks, {
        getCloudEncryptionStatus: vi.fn(async () => ({ available: true, keyset: true, unlocked: true })),
      });
      useCloudSyncStatusStore.setState(replaced);
      await renderSettings();

      expect(host.querySelector("[data-cloud-vault-removed]")?.textContent).toContain(
        "Choose the encrypted vault to sync it again.",
      );
    });
  });

  it("presents capacity rejections as queued uploads instead of reviewable conflicts", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.syncCloudVault.mockResolvedValue({
      cursor: 7,
      pulled: 0,
      pushed: 0,
      conflicts: Array.from({ length: 107 }, (_, index) => ({
        operation_id: `operation-${index}`,
        item_id: `item-${index}`,
        code: "QUOTA_EXCEEDED" as const,
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
      })),
      bootstrap_conflicts: [],
      local_conflicts: [],
    });

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    const sync = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Sync now",
    );
    await act(async () => sync!.click());

    expect(host.textContent).toContain("Cloud file limit reached");
    expect(host.textContent).toContain(
      "Your ZenNotes Cloud plan holds up to 100 files across your account",
    );
    expect(host.textContent).toContain("107 changes are waiting to upload");
    expect(host.textContent).not.toContain("Everything is up to date");
    expect(host.textContent).not.toContain("conflicts need review");
  });

  it("says calmly which file Cloud refused, with Cloud's answer under Details (#1004)", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    const detail = "HTTP 422 · VALIDATION_FAILED · This path is not eligible for vault sync.";
    mocks.syncCloudVault.mockResolvedValue({
      cursor: 7,
      pulled: 0,
      pushed: 12,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [],
      refused_paths: [{ path: ".zennotes/agent-edits/inbox/Plan.md.json", detail }],
    });
    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );
    const sync = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Sync now",
    );
    await act(async () => sync!.click());

    expect(host.textContent).toContain("1 file stays on this device");
    expect(host.textContent).toContain(
      "ZenNotes Cloud didn't accept “Plan.md.json”, so it stays on this device while the rest of the vault keeps syncing.",
    );
    const list = host.querySelector('[aria-label="Files that need attention"]');
    const rows = [...list!.querySelectorAll("li")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(".zennotes/agent-edits/inbox/Plan.md.json");
    expect(rows[0].textContent).toContain("Sync offers it again once a day.");
    // Cloud's own answer sits under the row's Details, not in the sentence.
    expect(rows[0].querySelector("details")?.textContent).toContain(detail);
    // A file under .zennotes is not a note to open.
    expect([...rows[0].querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Open");
  });

  it("lists each file that needs attention with a reason and an Open action", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.syncCloudVault.mockResolvedValue({
      cursor: 7,
      pulled: 1,
      pushed: 0,
      conflicts: [
        {
          operation_id: "op-1",
          item_id: "item-1",
          code: "REVISION_CONFLICT",
          current_revision: 4,
          current_path: null,
          path: "inbox/Daily.md",
        },
      ],
      bootstrap_conflicts: [],
      local_conflicts: [
        {
          code: "LOCAL_EDIT_CONFLICT",
          path: "inbox/Plan.md",
          conflict_copy_path: "inbox/Plan (cloud conflict).md",
        },
      ],
    });
    const openNoteInTab = vi.fn(async () => undefined);
    const setSettingsOpen = vi.fn();
    const { useStore } = await import("../store");
    const previous = { openNoteInTab: useStore.getState().openNoteInTab, setSettingsOpen: useStore.getState().setSettingsOpen };
    useStore.setState({ openNoteInTab, setSettingsOpen });

    try {
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      const sync = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Sync now",
      );
      await act(async () => sync!.click());

      expect(host.textContent).toContain("Sync incomplete");
      const list = host.querySelector('[aria-label="Files that need attention"]');
      expect(list).not.toBeNull();
      const rows = [...list!.querySelectorAll("li")].map((row) => row.textContent ?? "");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("inbox/Plan.md");
      expect(rows[0]).toContain("Plan (cloud conflict).md");
      expect(rows[1]).toContain("inbox/Daily.md");
      expect(rows[1]).toContain("Changed on another device");

      const openCopy = [...list!.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Open copy",
      );
      mocks.focusEditorNormalMode.mockClear();
      await act(async () => openCopy!.click());
      expect(setSettingsOpen).toHaveBeenCalledWith(false);
      expect(openNoteInTab).toHaveBeenCalledWith("inbox/Plan (cloud conflict).md");
      // Settings held the keyboard; the note opened behind it takes it (#863).
      expect(mocks.focusEditorNormalMode).toHaveBeenCalledTimes(1);
    } finally {
      useStore.setState(previous);
    }
  });

  describe("opened for This vault, as Review on the Cloud status opens it", () => {
    const linked = {
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    };
    const needsAttention: CloudSyncRunSummary = {
      cursor: 7,
      pulled: 0,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [
        {
          code: "LOCAL_EDIT_CONFLICT",
          path: "inbox/Plan.md",
          conflict_copy_path: "inbox/Plan (cloud conflict).md",
        },
      ],
    };
    let scrolled: Element[];
    let originalScrollIntoView: PropertyDescriptor | undefined;

    beforeEach(() => {
      scrolled = [];
      originalScrollIntoView = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value(this: Element) {
          scrolled.push(this);
        },
      });
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.listCloudVaults.mockResolvedValue([]);
      mocks.getCloudVaultLink.mockResolvedValue(linked);
      useCloudSyncStatusStore.setState({
        phase: "attention",
        vaultName: "Cloud Notes",
        lastSummary: needsAttention,
        error: "Cloud sync kept both versions of 1 changed file. Review the conflict copies.",
      });
    });

    afterEach(() => {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
      (document.activeElement as HTMLElement | null)?.blur();
    });

    async function open(props: {
      revealVault?: boolean;
      onVaultRevealed?: () => void;
    }): Promise<void> {
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
            ...props,
          }),
        ),
      );
    }

    function vaultSection(): HTMLElement | null {
      return host.querySelector<HTMLElement>('[data-settings-search-id="cloud-vault"]');
    }

    it("brings the files that need attention into view and hands them the keyboard", async () => {
      const onVaultRevealed = vi.fn();
      await open({ revealVault: true, onVaultRevealed });

      const files = host.querySelector('[aria-label="Files that need attention"]');
      const attention = files?.closest<HTMLElement>("[data-cloud-attention]");
      expect(attention).toBeTruthy();
      expect(vaultSection()?.contains(attention!)).toBe(true);
      expect(document.activeElement).toBe(attention);
      // This vault's top first, for the vault it is about, then the files.
      expect(scrolled).toEqual([vaultSection(), attention]);
      expect(onVaultRevealed).toHaveBeenCalledOnce();
    });

    it("lands on the notice when this vault's Cloud vault went away", async () => {
      useCloudSyncStatusStore.setState({
        phase: "unlinked",
        lastSummary: null,
        error: null,
        removedVault: { vaultName: "Cloud QA iPhone", reason: "deleted" },
      });
      mocks.getCloudVaultLink.mockResolvedValue(null);
      await open({ revealVault: true });

      const notice = host.querySelector<HTMLElement>("[data-cloud-vault-removed]");
      expect(notice?.hasAttribute("data-cloud-attention")).toBe(true);
      expect(document.activeElement).toBe(notice);
    });

    it("hands This vault itself the keyboard when nothing in it waits, as Set up asks", async () => {
      useCloudSyncStatusStore.setState({ phase: "unlinked", lastSummary: null, error: null });
      mocks.getCloudVaultLink.mockResolvedValue(null);
      await open({ revealVault: true });

      expect(host.textContent).toContain("Create a new cloud vault");
      expect(document.activeElement).toBe(vaultSection());
      expect(scrolled).toEqual([vaultSection()]);
    });

    it("leaves the keyboard where the person moved it while the page loaded", async () => {
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      try {
        elsewhere.focus();
        const onVaultRevealed = vi.fn();
        await open({ revealVault: true, onVaultRevealed });

        expect(document.activeElement).toBe(elsewhere);
        expect(scrolled).toEqual([]);
        // Asked and answered: coming back to the page does not try again.
        expect(onVaultRevealed).toHaveBeenCalledOnce();
      } finally {
        elsewhere.remove();
      }
    });

    it("stays at the top of the page when nothing asked for This vault", async () => {
      await open({});

      expect(host.querySelector("[data-cloud-attention]")).not.toBeNull();
      expect(document.activeElement).toBe(document.body);
      expect(scrolled).toEqual([]);
    });
  });

  describe("the storage card while Settings stays open", () => {
    const linked = {
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    };
    const uploaded: CloudSyncRunSummary = {
      cursor: 9,
      pulled: 0,
      pushed: 3,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [],
    };
    const grown: CloudServiceAccount = {
      ...serviceAccount,
      usage: {
        ...serviceAccount.usage!,
        sync: { ...serviceAccount.usage!.sync, items: 41 },
      },
    };
    let visibility: DocumentVisibilityState;

    function show(state: DocumentVisibilityState): void {
      visibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
    }

    /** Lets a pause pass, and whatever it set off land. */
    async function wait(milliseconds: number): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });
    }

    beforeEach(async () => {
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.listCloudVaults.mockResolvedValue([]);
      mocks.getCloudVaultLink.mockResolvedValue(linked);
      mocks.getCloudSettingsConflict.mockResolvedValue(null);
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      expect(host.textContent).toContain("38 synced files across 2 vaults");
      vi.useFakeTimers();
      mocks.getCloudServiceAccount.mockClear();
      mocks.getCloudServiceAccount.mockResolvedValue(grown);
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("reads usage again once sync runs settle, once for a burst of runs", async () => {
      await act(async () => useCloudSyncStatusStore.setState({ lastSummary: uploaded }));
      await wait(2_000);
      await act(async () =>
        useCloudSyncStatusStore.setState({ lastSummary: { ...uploaded, cursor: 10 } }),
      );
      await wait(2_000);
      expect(mocks.getCloudServiceAccount).not.toHaveBeenCalled();

      await wait(2_000);
      expect(mocks.getCloudServiceAccount).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("41 synced files across 2 vaults");

      await wait(30_000);
      expect(mocks.getCloudServiceAccount).toHaveBeenCalledOnce();
    });

    it("leaves usage alone after a run that moved nothing", async () => {
      await act(async () =>
        useCloudSyncStatusStore.setState({ lastSummary: { ...uploaded, pushed: 0 } }),
      );
      await wait(30_000);

      expect(mocks.getCloudServiceAccount).not.toHaveBeenCalled();
      expect(host.textContent).toContain("38 synced files across 2 vaults");
    });

    it("reads nothing while the window is hidden, and reads usage once it is shown", async () => {
      show("hidden");
      await act(async () => useCloudSyncStatusStore.setState({ lastSummary: uploaded }));
      await wait(30_000);
      expect(mocks.getCloudServiceAccount).not.toHaveBeenCalled();

      show("visible");
      await wait(5_000);
      expect(mocks.getCloudServiceAccount).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("41 synced files across 2 vaults");
    });

    it("does not read usage a second time after Sync now has read it", async () => {
      mocks.syncCloudVault.mockResolvedValue(uploaded);
      await act(async () => buttonNamed("Sync now")!.click());
      expect(mocks.getCloudServiceAccount).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("41 synced files across 2 vaults");

      await wait(30_000);
      expect(mocks.getCloudServiceAccount).toHaveBeenCalledOnce();
    });
  });

  it("refreshes Settings when follow-up sync clears the next conflict after a saved decision", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org", vault_id: "vault-1", vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    const pending: CloudSyncRunSummary = {
      cursor: 7, pulled: 0, pushed: 0, conflicts: [], bootstrap_conflicts: [], local_conflicts: [],
      pending_conflicts: ["First.md", "Second.md"].map((path) => ({
        id: path, item_id: path, path, cloud_path: path, kind: "content", can_merge: true, has_base: true,
      })),
    };
    const synced = { ...pending, cursor: 8, pending_conflicts: [] };
    mocks.getCloudConflict.mockImplementation(async (id: string) => {
      const conflict = pending.pending_conflicts!.find((item) => item.id === id)!;
      const version = { path: id, revision: 7, sha256: "agreed", byte_length: 6,
        media_type: "text/markdown", text: "agreed", deleted: false };
      return { conflict, base: version, local: version, cloud: version,
        suggested_text: "agreed", draft_text: null, changes: [], parts: [] };
    });
    let finishSync!: () => void;
    mocks.syncCloudVaultWithStatus.mockImplementationOnce(() => new Promise((resolve) => {
      finishSync = () => {
        useCloudSyncStatusStore.setState({ lastSummary: synced });
        resolve(synced);
      };
    }));
    useCloudSyncStatusStore.setState({ lastSummary: pending });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    const button = (text: string) => [...host.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === text)!;

    await act(async () => button("Resolve").click());
    await act(async () => button("Save combined note").click());
    expect(host.querySelector('[data-cloud-pending-conflict="Second.md"]')).not.toBeNull();
    expect(host.textContent).not.toContain("First.md");

    await act(async () => finishSync());

    expect(host.textContent).not.toContain("Second.md");
    expect(host.querySelector("[data-cloud-pending-conflict]")).toBeNull();
    expect(host.textContent).toContain("Everything is up to date");
  });

  it("preserves explicit summaries between sync results and clears them when the active vault status resets", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org", vault_id: "vault-1", vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    const prior: CloudSyncRunSummary = {
      cursor: 2, pulled: 1, pushed: 0, conflicts: [], bootstrap_conflicts: [], local_conflicts: [],
    };
    const manual = { ...prior, cursor: 3, pulled: 2, pushed: 3 };
    useCloudSyncStatusStore.setState({ lastSummary: prior });
    mocks.syncCloudVault.mockResolvedValue(manual);
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Notes",
    })));
    expect(host.textContent).toContain("Downloaded 1 · Uploaded 0");
    const sync = [...host.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === "Sync now")!;
    await act(async () => sync.click());
    expect(host.textContent).toContain("Downloaded 2 · Uploaded 3");

    // A readiness or error update is not a newer sync result and must not
    // replace an explicit summary returned by restore/bootstrap/manual work.
    await act(async () => useCloudSyncStatusStore.setState({ phase: "ready" }));
    expect(host.textContent).toContain("Downloaded 2 · Uploaded 3");
    await act(async () => clearCloudSyncStatus());
    expect(host.textContent).not.toContain("Downloaded 2 · Uploaded 3");
    expect(host.textContent).not.toContain("Everything is up to date");

    await act(async () => root.render(null));
    useCloudSyncStatusStore.setState({ lastSummary: prior });
    await act(async () => root.render(createElement(CloudSettings, {
      localVaultAvailable: true, localVaultName: "Another vault",
    })));
    expect(host.textContent).toContain("Downloaded 1 · Uploaded 0");
    expect(host.textContent).not.toContain("Downloaded 2 · Uploaded 3");
  });

  describe("live sync status", () => {
    let syncWithStatus: typeof import("../lib/cloud-auto-sync").syncCloudVaultWithStatus;
    const completed: CloudSyncRunSummary = {
      cursor: 7,
      pulled: 0,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [],
      local_conflicts: [],
    };

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("../lib/cloud-auto-sync")>(
        "../lib/cloud-auto-sync",
      );
      syncWithStatus = actual.syncCloudVaultWithStatus;
      mocks.syncCloudVaultWithStatus.mockImplementation(syncWithStatus);
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.listCloudVaults.mockResolvedValue([]);
      mocks.getCloudVaultLink.mockResolvedValue({
        base_url: "https://zennotes.org",
        vault_id: "vault-1",
        vault_name: "Cloud Notes",
        linked_at: "2026-08-10T12:00:00.000Z",
      });
      mocks.getCloudSettingsConflict.mockResolvedValue(null);
      mocks.syncCloudVault.mockResolvedValue(completed);
      await act(async () => root.render(createElement(CloudSettings, {
        localVaultAvailable: true,
        localVaultName: "Notes",
      })));
    });

    it.each(["Settings", "editor"] as const)(
      "replaces an earlier successful result when a sync from %s fails",
      async (source) => {
        await act(async () => { await syncWithStatus(mocks, "Cloud Notes"); });
        expect(host.textContent).toContain("All changes are synced.");
        mocks.syncCloudVault.mockRejectedValueOnce(new Error("Cloud sync timed out."));

        await act(async () => {
          if (source === "Settings") {
            [...host.querySelectorAll("button")]
              .find((button) => button.textContent?.trim() === "Sync now")!.click();
          } else {
            await expect(syncWithStatus(mocks, "Cloud Notes"))
              .rejects.toThrow("Cloud sync timed out.");
          }
        });

        expect(useCloudSyncStatusStore.getState().phase).toBe("error");
        expect(host.textContent).toContain("Cloud sync timed out.");
        expect(host.textContent).not.toContain("Everything is up to date");
        expect(host.textContent).not.toContain("All changes are synced.");
      },
    );

    it("removes a Settings sync failure when a later editor retry succeeds", async () => {
      mocks.syncCloudVault.mockRejectedValueOnce(new Error("Cloud sync timed out."));
      await act(async () => {
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Sync now")!.click();
      });
      expect(host.textContent).toContain("Cloud sync timed out.");

      await act(async () => { await syncWithStatus(mocks, "Cloud Notes"); });

      expect(useCloudSyncStatusStore.getState().phase).toBe("ready");
      expect(host.textContent).toContain("Everything is up to date");
      expect(host.textContent).not.toContain("Cloud sync timed out.");
    });

    it("does not claim all changes are synced while an editor retry is still uploading", async () => {
      await act(async () => { await syncWithStatus(mocks, "Cloud Notes"); });
      let finishUpload!: (summary: CloudSyncRunSummary) => void;
      mocks.syncCloudVault.mockImplementationOnce(() => new Promise<CloudSyncRunSummary>((resolve) => {
        finishUpload = resolve;
      }));
      let retry!: Promise<CloudSyncRunSummary>;
      await act(async () => { retry = syncWithStatus(mocks, "Cloud Notes"); });
      try {
        expect(useCloudSyncStatusStore.getState().phase).toBe("syncing");
        expect(host.textContent).not.toContain("Everything is up to date");
        expect(host.textContent).not.toContain("All changes are synced.");
        expect(host.textContent).toContain("Syncing");
      } finally {
        await act(async () => {
          finishUpload({ ...completed, cursor: 8, pushed: 1 });
          await retry;
        });
      }
      expect(host.textContent).toContain("Downloaded 0 · Uploaded 1");
      expect(host.textContent).toContain("All changes are synced.");
    });

    it.each(["publishing", "backup"] as const)(
      "preserves an unrelated %s error when background sync fails and recovers",
      async (operation) => {
        const actionError = operation === "publishing"
          ? "Could not load published notes."
          : "Could not create the backup.";
        if (operation === "backup") {
          await act(async () => root.render(null));
          mocks.getCloudServiceAccount.mockResolvedValue({
            ...serviceAccount,
            features: {
              ...serviceAccount.features,
              backup: { active: true, limits: { max_snapshots: 30 } },
            },
          });
          mocks.listCloudBackups.mockResolvedValue([]);
          mocks.createCloudBackup.mockRejectedValueOnce(new Error(actionError));
          await act(async () => root.render(createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          })));
        } else {
          mocks.listCloudPublishedNotes.mockRejectedValueOnce(new Error(actionError));
        }
        await act(async () => {
          [...host.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === (
              operation === "publishing" ? "Refresh list" : "Create backup"
            ))!.click();
        });
        expect(host.textContent).toContain(actionError);

        mocks.syncCloudVault.mockRejectedValueOnce(new Error("Cloud sync timed out."));
        await act(async () => {
          await expect(syncWithStatus(mocks, "Cloud Notes"))
            .rejects.toThrow("Cloud sync timed out.");
        });
        expect(host.textContent).toContain("Cloud sync timed out.");
        expect(host.textContent).toContain(actionError);

        await act(async () => { await syncWithStatus(mocks, "Cloud Notes"); });

        expect(host.textContent).toContain("All changes are synced.");
        expect(host.textContent).not.toContain("Cloud sync timed out.");
        expect(host.textContent).toContain(actionError);
      },
    );

    it("keeps an open conflict and its draft available during an upload and after a sync failure", async () => {
      const conflict = {
        id: "note-1",
        item_id: "note-1",
        path: "Daily.md",
        cloud_path: "Daily.md",
        kind: "content" as const,
        can_merge: true,
        has_base: true,
      };
      const pending: CloudSyncRunSummary = {
        ...completed,
        pending_conflicts: [conflict],
      };
      const version = {
        path: "Daily.md",
        revision: 7,
        sha256: "local-version",
        byte_length: 10,
        media_type: "text/markdown",
        text: "Local note",
        deleted: false,
      };
      mocks.getCloudConflict.mockResolvedValue({
        conflict,
        base: { ...version, text: "Base note" },
        local: version,
        cloud: { ...version, sha256: "cloud-version", text: "Cloud note" },
        suggested_text: "Combined note",
        draft_text: null,
        changes: [],
        parts: [],
      });
      mocks.syncCloudVault.mockResolvedValueOnce(pending);
      await act(async () => { await syncWithStatus(mocks, "Cloud Notes"); });
      await act(async () => {
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Resolve")!.click();
      });
      const draftSelector = '[data-cloud-pending-conflict="note-1"] textarea';
      const draft = host.querySelector<HTMLTextAreaElement>(draftSelector)!;
      const userDraft = "My unfinished conflict review";
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
          .set!.call(draft, userDraft);
        draft.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(draft.value).toBe(userDraft);

      let failUpload!: (cause: Error) => void;
      mocks.syncCloudVault.mockImplementationOnce(() => new Promise<CloudSyncRunSummary>((_, reject) => {
        failUpload = reject;
      }));
      let retry!: Promise<unknown>;
      await act(async () => {
        retry = syncWithStatus(mocks, "Cloud Notes").catch((cause: unknown) => cause);
      });
      try {
        expect(host.textContent).toContain("Waiting for all changes to finish.");
        expect(host.querySelector('[aria-label="Files that need attention"]')?.textContent)
          .toContain("Daily.md");
        expect(host.querySelector<HTMLTextAreaElement>(draftSelector)?.value).toBe(userDraft);
        expect(host.querySelector<HTMLTextAreaElement>(draftSelector)?.disabled).toBe(true);
      } finally {
        await act(async () => {
          failUpload(new Error("Cloud sync timed out."));
          await retry;
        });
      }

      expect(host.textContent).toContain("Cloud sync timed out.");
      expect(host.querySelector('[aria-label="Files that need attention"]')?.textContent)
        .toContain("Daily.md");
      expect(host.querySelector<HTMLTextAreaElement>(draftSelector)?.value).toBe(userDraft);
      expect(host.querySelector<HTMLTextAreaElement>(draftSelector)?.disabled).toBe(false);
      expect(host.textContent).not.toContain("All changes are synced.");
    });
  });

  it("clears a stale successful summary when a later manual sync times out", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.syncCloudVault
      .mockResolvedValueOnce({
        cursor: 7,
        pulled: 0,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [],
        local_conflicts: [],
      })
      .mockRejectedValueOnce(new Error("Cloud sync timed out."));

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    const sync = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Sync now",
    );
    await act(async () => sync!.click());
    expect(host.textContent).toContain("Everything is up to date");

    await act(async () => sync!.click());

    expect(host.textContent).toContain("Cloud sync timed out.");
    expect(host.textContent).not.toContain("Everything is up to date");
  });

  it.each(["manual", "background"] as const)(
    "retires deleted Cloud actions after a %s sync confirms that the host removed the link (#791)",
    async (trigger) => {
      mocks.getCloudAccountStatus.mockResolvedValue(connected);
      mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
      mocks.listCloudVaults.mockResolvedValue([{ id: "vault-1", name: "Cloud Notes" }, { id: "vault-2", name: "Other preserved vault" }]);
      mocks.getCloudVaultLink.mockResolvedValue({
        base_url: connected.account!.base_url,
        vault_id: "vault-1",
        vault_name: "Cloud Notes",
        linked_at: "2026-08-10T12:00:00.000Z",
      });
      mocks.syncCloudVault.mockResolvedValueOnce({
        cursor: 7, pulled: 0, pushed: 0, conflicts: [], bootstrap_conflicts: [], local_conflicts: [],
      }).mockImplementationOnce(async () => {
        // Host confirmation retires only the remote association. Settings
        // must discover that result even while this panel stays mounted.
        mocks.getCloudVaultLink.mockResolvedValue(null);
        // The service no longer lists the vault it deleted.
        mocks.listCloudVaults.mockResolvedValue([{ id: "vault-2", name: "Other preserved vault" }]);
        throw new Error("Error invoking remote method 'cloud-vault:sync': Error: This Cloud vault no longer exists. Your local notes are safe.");
      });
      await act(async () => root.render(createElement(CloudSettings, {
        localVaultAvailable: true, localVaultName: "Notes",
      })));
      const sync = () => [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Sync now",
      );
      await act(async () => sync()!.click());
      expect(host.textContent).toContain("Everything is up to date");
      if (trigger === "manual") {
        await act(async () => sync()!.click());
      } else {
        const actual = await vi.importActual<typeof import("../lib/cloud-auto-sync")>("../lib/cloud-auto-sync");
        await act(async () => {
          await actual.syncCloudVaultWithStatus(mocks, "Cloud Notes").catch(() => undefined);
        });
      }

      expect(host.textContent).not.toContain("Linked to Cloud Notes");
      expect(host.textContent).not.toContain("Error invoking remote method");
      // This vault says which vault went and why sync stopped, where the
      // person can act on it, instead of a banner at the top of the page.
      const notice = host.querySelector<HTMLElement>("[data-cloud-vault-removed]");
      expect(notice?.closest('[data-settings-search-id="cloud-vault"]')).not.toBeNull();
      expect(notice?.textContent).toContain(
        "“Cloud Notes” was deleted from ZenNotes Cloud, so this vault stopped syncing.",
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();
      // Nothing else on the page still offers the deleted vault.
      const offered = host.textContent!.replace(notice!.textContent!, "");
      expect(offered).not.toContain("Cloud Notes");
      expect(offered).toContain("Other preserved vault");
      const actions = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
      expect(actions).not.toContain("Sync now");
      expect(actions).not.toContain("Unlink this device");
      expect(actions).not.toContain("Delete Cloud vault");
      expect(host.textContent).not.toContain("Everything is up to date");
      const open = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open on this device");
      expect(open).toBeDefined();
      expect(open!.disabled).toBe(false);
      expect(mocks.logoutCloudAccount).not.toHaveBeenCalled();
    },
  );

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
    expect(host.textContent).toContain(
      "This device’s settings are the ones in use.",
    );

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
    expect(host.textContent).not.toContain(
      "Vault settings differ from the cloud",
    );
  });

  // With the cloud's copy in hand the card says what differs and hands the
  // per-setting choice to the shared prompt (#816).
  it("names the settings that differ and opens the comparison prompt", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-1",
      vault_name: "Cloud Notes",
      linked_at: "2026-08-10T12:00:00.000Z",
    });
    mocks.listCloudVaults.mockResolvedValue([]);
    const local = useStore.getState().vaultSettings;
    mocks.getCloudSettingsConflict.mockResolvedValue({
      path: ".zennotes/vault.json",
      cloud_path: ".zennotes/vault.cloud-conflict.json",
      cloud_settings: {
        ...JSON.parse(JSON.stringify(local)),
        favorites: [...local.favorites, "inbox:Reading"],
        folderColors: { ...local.folderColors, "inbox:Reading": "amber" },
        experimentalSpellcheck: { enabled: true },
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

    expect(host.textContent).toContain("What differs: Folder colors, Favorites.");
    expect(host.textContent).toContain("settings this device does not use (experimentalSpellcheck)");

    // Sync surfaced the question and opened the prompt; the card reopens it
    // after a "Decide later".
    useCloudSyncStatusStore.setState({ settingsConflictPromptOpen: false });
    const compare = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Compare and choose…",
    );
    expect(compare).toBeTruthy();
    await act(async () => compare!.click());
    expect(useCloudSyncStatusStore.getState().settingsConflictPromptOpen).toBe(true);
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
      "Sync isn't part of your current plan. Choose a plan under Billing on zennotes.org",
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

  it("states a 10 GB plan as 10 GB, counting in thousands as the plans do", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue({
      ...serviceAccount,
      features: {
        ...serviceAccount.features,
        sync: { active: true, limits: { max_storage_bytes: 10_000_000_000 } },
      },
      usage: {
        ...serviceAccount.usage!,
        storage: { ...serviceAccount.usage!.storage, sync_bytes: 4_800_000 },
      },
    });
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue(null);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    expect(host.textContent).toContain("4.8 MB of 10 GB");
    expect(host.textContent).not.toContain("9.3 GB");
  });

  it("drops the error class name a main-process rejection carries", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockRejectedValue(
      new Error(
        "Error invoking remote method 'cloud-vaults:list': CloudServiceRequestError: This backup would exceed your plan limits.",
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

    expect(host.textContent).toContain("This backup would exceed your plan limits.");
    expect(host.textContent).not.toContain("CloudServiceRequestError");
  });

  it("refreshes and clears a connection error when the network comes back", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue(null);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );

    // The runtime's words stay in Details, never as the message.
    const message = host.querySelector("[data-cloud-error-message]");
    expect(message?.textContent).toMatch(/^ZenNotes can't reach ZenNotes Cloud\./);
    expect(message?.textContent).not.toContain("fetch failed");
    expect(host.querySelector("[data-cloud-error-details] pre")?.textContent).toBe(
      "TypeError · fetch failed",
    );

    await act(async () => window.dispatchEvent(new Event("online")));

    expect(host.textContent).not.toContain("can't reach ZenNotes Cloud");
    expect(host.textContent).toContain("SyncIncluded");
  });

  it("signs out when Cloud refuses this device's sign-in, and says why above Connect", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue(serviceAccount);
    mocks.getCloudVaultLink.mockResolvedValue(null);
    mocks.logoutCloudAccount.mockResolvedValue(disconnected);
    // What the desktop main process sends for a revoked device.
    const worded = encodeCloudErrorMessage(
      describeCloudError(
        Object.assign(new Error("Authentication is required."), {
          name: "CloudServiceRequestError",
          status: 401,
          code: "UNAUTHENTICATED",
        }),
      ),
    );
    mocks.listCloudVaults.mockRejectedValue(
      new Error(`Error invoking remote method 'cloud-vaults:list': Error: ${worded}`),
    );

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );
    expect(mocks.logoutCloudAccount).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    const [accountChanged] = mocks.onCloudAccountChange.mock.calls[0] as unknown as [
      (status: CloudAccountStatus) => void,
    ];
    await act(async () => accountChanged(disconnected));

    const notice = host.querySelector("[data-cloud-signed-out]");
    expect(notice?.querySelector("[data-cloud-error-message]")?.textContent).toBe(
      CLOUD_SIGNED_OUT_MESSAGE,
    );
    expect(notice?.querySelector("[data-cloud-error-details] pre")?.textContent).toBe(
      "HTTP 401 · UNAUTHENTICATED · Authentication is required.",
    );
    expect(host.textContent).toContain("Connect ZenNotes Cloud");
  });

  it("loads again after a sign-in cancels the first load instead of reporting the cancellation", async () => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount
      .mockRejectedValueOnce(
        new DOMException("Cloud account changed while loading credentials.", "AbortError"),
      )
      .mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue(null);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(host.textContent).not.toContain("changed while loading credentials");
    expect(host.textContent).toContain("SyncIncluded");
    // The cancelled read was retried (Published notes adds its own usage refresh).
    expect(mocks.getCloudServiceAccount.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the newest account load when an older one fails late", async () => {
    let failFirstLoad: (error: unknown) => void = () => {};
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => { failFirstLoad = reject; }),
      )
      .mockResolvedValue(serviceAccount);
    mocks.listCloudVaults.mockResolvedValue([]);
    mocks.getCloudVaultLink.mockResolvedValue(null);

    await act(async () =>
      root.render(
        createElement(CloudSettings, {
          localVaultAvailable: true,
          localVaultName: "Notes",
        }),
      ),
    );
    const [accountChanged] = mocks.onCloudAccountChange.mock.calls[0] as unknown as [
      (status: CloudAccountStatus) => void,
    ];
    await act(async () => accountChanged(connected));
    expect(host.textContent).toContain("SyncIncluded");

    await act(async () => failFirstLoad(new TypeError("fetch failed")));

    expect(host.textContent).not.toContain("fetch failed");
    expect(host.textContent).toContain("SyncIncluded");
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

  it.each([
    ["a phone, which cannot open the archive", {}, false],
    ["the desktop app", { supportsEncryptedBackupArchive: true }, true],
  ])("offers Save archive for an encrypted vault only where it works: %s", async (_host, capabilities, offered) => {
    mocks.getCloudAccountStatus.mockResolvedValue(connected);
    mocks.getCloudServiceAccount.mockResolvedValue({
      ...serviceAccount,
      features: {
        ...serviceAccount.features,
        backup: { active: true, limits: { max_snapshots: 30 } },
      },
    });
    mocks.listCloudVaults.mockResolvedValue([
      {
        id: "vault-e",
        name: "Work notes",
        cursor: 3,
        created_at: "2026-10-12T12:00:00.000Z",
        updated_at: "2026-10-12T12:30:00.000Z",
        encryption: {
          scheme: "zne1",
          key_id: "0123456789abcdef0123456789abcdef",
          key_version: 1,
          vault_key_envelope: "sealed",
          name: "sealed-name",
        },
      },
    ]);
    mocks.getCloudVaultLink.mockResolvedValue({
      base_url: "https://zennotes.org",
      vault_id: "vault-e",
      vault_name: "Work notes",
      linked_at: "2026-10-12T12:00:00.000Z",
    });
    mocks.listCloudBackups.mockResolvedValue([
      {
        id: "backup-1",
        label: "Before migration",
        trigger: "manual",
        status: "ready",
        cursor: 3,
        item_count: 8,
        total_bytes: 2048,
        archive_bytes: 1024,
        expires_at: "2026-11-09T12:00:00.000Z",
        created_at: "2026-10-12T12:00:00.000Z",
      },
    ]);
    const bridge = mocks as unknown as Record<string, unknown>;
    bridge.getCapabilities = vi.fn(() => capabilities);
    try {
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      expect(host.textContent).toContain("Before migration");
      const saveArchive = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save archive",
      );
      expect(!!saveArchive).toBe(offered);
      expect(!!host.querySelector("[data-cloud-archive-desktop-only]")).toBe(!offered);
      // Browse and Restore work on every host.
      expect(host.textContent).toContain("Browse notes");
      expect(host.textContent).toContain("Restore");
    } finally {
      delete bridge.getCapabilities;
    }
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
        bootstrap_conflicts: [],
        local_conflicts: [],
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
        bootstrap_conflicts: [],
        local_conflicts: [],
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
      expect.objectContaining({
        title: "Restore “Before migration”?",
        danger: true,
      }),
    );
    expect(mocks.restoreCloudBackup).toHaveBeenCalledWith("backup-1");
    expect(host.textContent).toContain(
      "Restored 8 items and removed 2 newer items. This vault now matches the backup.",
    );
    expect(host.textContent).not.toContain("cursor");

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

  describe("restoring a whole backup", () => {
    async function restore(
      label: string | null,
      counts: { restored_items: number; deleted_items: number },
      sync: Partial<CloudSyncRunSummary> = {},
    ): Promise<void> {
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
          label,
          trigger: "manual",
          status: "ready",
          cursor: 12,
          item_count: 8,
          total_bytes: 2048,
          archive_bytes: 1024,
          expires_at: "2026-09-09T12:00:00.000Z",
          created_at: "2026-08-10T12:00:00.000Z",
        },
      ]);
      mocks.restoreCloudBackup.mockResolvedValue({
        restore: {
          id: "restore-1",
          backup_id: "backup-1",
          mode: "replace",
          status: "completed",
          expected_cursor: 12,
          start_cursor: 12,
          end_cursor: 18,
          ...counts,
          error: null,
          created_at: "2026-08-10T12:06:00.000Z",
          updated_at: "2026-08-10T12:06:01.000Z",
        },
        sync: {
          cursor: 18,
          pulled: 1,
          pushed: 0,
          conflicts: [],
          bootstrap_conflicts: [],
          local_conflicts: [],
          ...sync,
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
      const button = [...host.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent?.trim() === "Restore" && !candidate.disabled,
      );
      await act(async () => button!.click());
    }

    function restoreResult(): string {
      return (
        host.querySelector('[data-settings-search-id="cloud-backups"] [role="status"]')
          ?.textContent ?? ""
      );
    }

    it("quotes the label, so a label that starts with Restore reads once", async () => {
      await restore("Restore QA baseline", {
        restored_items: 8,
        deleted_items: 2,
      });

      expect(mocks.confirmApp).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Restore “Restore QA baseline”?" }),
      );
    });

    it("asks to restore this backup when it has no label", async () => {
      await restore(null, { restored_items: 8, deleted_items: 2 });

      expect(mocks.confirmApp).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Restore this backup?" }),
      );
    });

    it("counts one restored and one removed item in the singular", async () => {
      await restore("Before migration", {
        restored_items: 1,
        deleted_items: 1,
      });

      expect(restoreResult()).toBe(
        "Restored 1 item and removed 1 newer item. This vault now matches the backup.",
      );
    });

    it("leaves out the removed clause when nothing newer was removed", async () => {
      await restore("Before migration", {
        restored_items: 3,
        deleted_items: 0,
      });

      expect(restoreResult()).toBe(
        "Restored 3 items. This vault now matches the backup.",
      );
      expect(host.textContent).not.toContain("newer item");
    });

    it("claims no match while the sync after it left a file waiting, which This vault lists", async () => {
      await restore(
        "Before migration",
        { restored_items: 3, deleted_items: 0 },
        {
          pending_conflicts: [
            {
              id: "Plan.md",
              item_id: "Plan.md",
              path: "Plan.md",
              cloud_path: "Plan.md",
              kind: "content",
              can_merge: true,
              has_base: true,
            },
          ],
        },
      );

      expect(restoreResult()).toBe("Restored 3 items.");
      expect(host.textContent).not.toContain("cursor");
      expect(
        host.querySelector('[data-settings-search-id="cloud-vault"]')?.textContent,
      ).toContain("Plan.md");
    });
  });

  describe("a failed automatic backup", () => {
    const occurredAt = "2026-10-04T03:00:00.000Z";
    const onDate = new Date(occurredAt).toLocaleDateString();

    async function openWithSchedule(schedule: Record<string, unknown>): Promise<void> {
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
      mocks.listCloudBackups.mockResolvedValue([]);
      // The shape the service's backup-schedule endpoint answers with.
      mocks.getCloudBackupSchedule.mockResolvedValue({
        enabled: true,
        frequency: "daily",
        next_backup_at: "2026-10-05T03:00:00.000Z",
        last_backup_at: "2026-10-02T03:00:00.000Z",
        ...schedule,
      });
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
    }

    function failureNotice(): HTMLElement | null {
      return host.querySelector<HTMLElement>("[data-cloud-backup-failure]");
    }

    it("says which plan limit skipped it, and when", async () => {
      await openWithSchedule({
        last_failure: {
          code: "BACKUP_QUOTA_EXCEEDED",
          message:
            "The latest automatic backup was skipped because this vault has 30 retained backups, but its limit is 30. Delete an older manual backup or contact support to increase the limit. ZenNotes will retry daily.",
          details: { limit: "max_snapshots", current: 30, allowed: 30 },
          occurred_at: occurredAt,
        },
      });

      expect(failureNotice()?.textContent).toBe(
        `The automatic backup on ${onDate} was skipped. This vault already keeps 30 backups, the most your plan allows. Delete an older backup to make room.`,
      );
      // Beside the switch it is about.
      expect(
        failureNotice()?.closest("[data-cloud-automatic-backups]")?.querySelector('[role="switch"]'),
      ).not.toBeNull();
    });

    it("words a limit this version cannot read without inventing numbers", async () => {
      await openWithSchedule({
        last_failure: {
          code: "BACKUP_QUOTA_EXCEEDED",
          message: null,
          details: { limit: "max_snapshot_widgets", current: 3, allowed: 2 },
          occurred_at: occurredAt,
        },
      });

      expect(failureNotice()?.textContent).toBe(
        `The automatic backup on ${onDate} was skipped because this vault reached a backup limit on your plan.`,
      );
    });

    it("gives any other failure a short sentence with its date", async () => {
      await openWithSchedule({
        last_failure: {
          code: "AUTOMATIC_BACKUP_FAILED",
          message:
            "The latest automatic backup failed after several attempts. ZenNotes will retry automatically. Contact support if the problem continues.",
          details: { message: "The automatic backup could not be created after several attempts." },
          occurred_at: occurredAt,
        },
      });

      expect(failureNotice()?.textContent).toBe(
        `The automatic backup on ${onDate} failed. ZenNotes will try again.`,
      );
    });

    it("says nothing once the last one succeeded, or for a service that never reports it", async () => {
      await openWithSchedule({ last_failure: null });
      expect(host.textContent).toContain("Automatic daily backups");
      expect(failureNotice()).toBeNull();

      await act(async () => root.render(null));
      await openWithSchedule({});
      expect(host.textContent).toContain("Automatic daily backups");
      expect(failureNotice()).toBeNull();
    });

    it("says nothing about a schedule that is turned off", async () => {
      await openWithSchedule({
        enabled: false,
        next_backup_at: null,
        last_failure: {
          code: "AUTOMATIC_BACKUP_FAILED",
          message: null,
          details: null,
          occurred_at: occurredAt,
        },
      });

      expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
      expect(failureNotice()).toBeNull();
    });
  });

  describe("browsing a backup's notes", () => {
    // 110 journal days, then 10 launch notes that the first page never holds.
    const backupNotes = [
      ...Array.from({ length: 110 }, (_, index) =>
        backupNote(
          index + 1,
          `Journal/Day ${String(index + 1).padStart(3, "0")}.md`,
        ),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        backupNote(111 + index, `Projects/Launch ${index + 1}.md`),
      ),
    ];
    const listPage = vi.fn<NonNullable<ZenBridge["listCloudBackupItemsPage"]>>();

    /** A host that pages and searches on the service, 50 notes a page. */
    function usePagedHost(): void {
      listPage.mockImplementation(async (_backupId, query) =>
        servicePage(backupNotes, query),
      );
      Object.assign(mocks, { listCloudBackupItemsPage: listPage });
    }

    async function openBackupNotes(): Promise<void> {
      await act(async () =>
        root.render(
          createElement(CloudSettings, {
            localVaultAvailable: true,
            localVaultName: "Notes",
          }),
        ),
      );
      await act(async () => buttonNamed("Browse notes")!.click());
    }

    function searchBox(): HTMLInputElement | null {
      return host.querySelector<HTMLInputElement>(
        'input[aria-label="Search notes in this backup"]',
      );
    }

    function shownNotes(): number {
      return [...host.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Restore note",
      ).length;
    }

    beforeEach(() => {
      listPage.mockReset();
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
        base_url: "https://zennotes.org",
        vault_id: "vault-1",
        vault_name: "Cloud Notes",
        linked_at: "2026-08-10T12:00:00.000Z",
      });
      mocks.listCloudBackups.mockResolvedValue([
        {
          id: "backup-1",
          label: "Nightly",
          trigger: "automatic",
          status: "ready",
          cursor: 12,
          item_count: backupNotes.length,
          total_bytes: 61_440,
          archive_bytes: 2_048,
          expires_at: null,
          created_at: "2026-09-30T03:00:00.000Z",
        },
      ]);
    });

    afterEach(() => {
      delete (mocks as { listCloudBackupItemsPage?: unknown })
        .listCloudBackupItemsPage;
    });

    it("says how many notes are loaded and appends each further page until the last", async () => {
      usePagedHost();
      let answerSecondPage: () => void = () => {};
      listPage.mockImplementation(async (_backupId, query) => {
        const page = servicePage(backupNotes, query);
        if (query.page !== 2) return page;
        // The second page repeats the note the first one ended on.
        await new Promise<void>((resolve) => {
          answerSecondPage = resolve;
        });
        return { ...page, items: [backupNotes[49], ...page.items] };
      });

      await openBackupNotes();

      expect(listPage).toHaveBeenCalledWith("backup-1", { page: 1 });
      expect(mocks.listCloudBackupItems).not.toHaveBeenCalled();
      expect(shownNotes()).toBe(50);
      expect(host.textContent).toContain("Showing 50 of 120 notes");

      await act(async () => buttonNamed("Load more")!.click());
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 2,
        search: "",
      });
      expect(buttonNamed("Loading…")?.disabled).toBe(true);
      await act(async () => answerSecondPage());
      expect(shownNotes()).toBe(100);
      expect(host.textContent).toContain("Showing 100 of 120 notes");

      await act(async () => buttonNamed("Load more")!.click());
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 3,
        search: "",
      });
      expect(shownNotes()).toBe(120);
      expect(host.textContent).toContain("Projects/Launch 10.md");
      expect(host.textContent).not.toContain("Showing");
      expect(buttonNamed("Load more")).toBeUndefined();
    });

    it("searches the whole backup on the service with the trimmed words, after a pause", async () => {
      usePagedHost();
      await openBackupNotes();

      await act(async () => typeInto(searchBox()!, "  LAUNCH  "));
      // The loaded page holds no launch note, and the service has not been
      // asked yet, so the list waits instead of saying nothing matches.
      expect(listPage).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Searching…");
      expect(host.textContent).not.toContain("No notes match");

      await afterSearchPause();
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 1,
        search: "LAUNCH",
      });
      expect(shownNotes()).toBe(10);
      expect(host.textContent).toContain("Projects/Launch 1.md");
      expect(host.textContent).not.toContain("Journal/Day 001.md");
      expect(host.textContent).not.toContain("Showing");
      expect(host.textContent).not.toContain("Searching…");

      await act(async () => typeInto(searchBox()!, "journal"));
      await afterSearchPause();
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 1,
        search: "journal",
      });
      expect(host.textContent).toContain("Showing 50 of 110 matches");

      await act(async () => buttonNamed("Load more")!.click());
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 2,
        search: "journal",
      });
      expect(host.textContent).toContain("Showing 100 of 110 matches");

      await act(async () => typeInto(searchBox()!, ""));
      await afterSearchPause();
      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 1,
        search: "",
      });
      expect(host.textContent).toContain("Showing 50 of 120 notes");

      // Closing drops a search still waiting to be asked, and opening again
      // starts over from the whole backup.
      await act(async () => typeInto(searchBox()!, "launch"));
      await act(async () => buttonNamed("Hide notes")!.click());
      await act(async () => buttonNamed("Browse notes")!.click());
      await afterSearchPause();
      expect(searchBox()!.value).toBe("");
      expect(listPage).toHaveBeenLastCalledWith("backup-1", { page: 1 });
      expect(host.textContent).toContain("Showing 50 of 120 notes");
    });

    it("still filters what a service that ignores the search sends back", async () => {
      usePagedHost();
      listPage.mockImplementation(async (_backupId, query) => ({
        ...servicePage(backupNotes, { page: query.page }),
        search: query.search?.trim() ?? "",
      }));
      await openBackupNotes();

      await act(async () => typeInto(searchBox()!, "day 04"));
      await afterSearchPause();

      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 1,
        search: "day 04",
      });
      expect(shownNotes()).toBe(10);
      expect(host.textContent).toContain("Journal/Day 040.md");
      expect(host.textContent).not.toContain("Journal/Day 001.md");
    });

    it("keeps the search box when nothing matches, and says so", async () => {
      usePagedHost();
      await openBackupNotes();

      await act(async () => typeInto(searchBox()!, "zzz"));
      await afterSearchPause();

      expect(listPage).toHaveBeenLastCalledWith("backup-1", {
        page: 1,
        search: "zzz",
      });
      expect(searchBox()).toBeTruthy();
      expect(host.textContent).toContain('No notes match "zzz".');
      expect(host.textContent).not.toContain("This backup contains no notes.");
      expect(host.textContent).not.toContain("Searching…");
    });

    it("says an empty backup contains no notes, with nothing to search", async () => {
      usePagedHost();
      listPage.mockImplementation(async (_backupId, query) =>
        servicePage([], query),
      );
      await openBackupNotes();

      expect(host.textContent).toContain("This backup contains no notes.");
      expect(searchBox()).toBeNull();
      expect(buttonNamed("Load more")).toBeUndefined();
    });

    it("lets only the newest search land when an older answer arrives late", async () => {
      usePagedHost();
      let answerPlan: (page: CloudBackupItemsPage) => void = () => {};
      listPage.mockImplementation(async (_backupId, query) =>
        query.search === "plan"
          ? new Promise<CloudBackupItemsPage>((resolve) => {
              answerPlan = resolve;
            })
          : servicePage(backupNotes, query),
      );
      await openBackupNotes();

      await act(async () => typeInto(searchBox()!, "plan"));
      await afterSearchPause();
      await act(async () => typeInto(searchBox()!, "launch"));
      await afterSearchPause();
      expect(shownNotes()).toBe(10);

      // The late answer also matches "launch", so only the request order
      // keeps it off the screen.
      await act(async () =>
        answerPlan({
          items: [backupNote(999, "Projects/Launch plan.md")],
          page: 1,
          lastPage: 1,
          total: 1,
          search: "plan",
        }),
      );

      expect(shownNotes()).toBe(10);
      expect(host.textContent).toContain("Projects/Launch 1.md");
      expect(host.textContent).not.toContain("Launch plan.md");
      expect(host.textContent).not.toContain("Searching…");
    });

    it("shows a failed search or page under the search box, not across the page", async () => {
      usePagedHost();
      listPage.mockImplementation(async (_backupId, query) => {
        if (query.search === "launch") {
          throw new Error("ZenNotes Cloud is busy. Try again in a moment.");
        }
        if (query.page === 2) throw new Error("");
        return servicePage(backupNotes, query);
      });
      await openBackupNotes();

      await act(async () => buttonNamed("Load more")!.click());
      const inline = (): string | null | undefined =>
        host.querySelector('p[role="alert"]')?.textContent;
      expect(inline()).toBe(
        "ZenNotes couldn't load more notes from this backup. Try again in a moment.",
      );
      expect(shownNotes()).toBe(50);

      await act(async () => typeInto(searchBox()!, "launch"));
      expect(inline()).toBeUndefined();
      await afterSearchPause();
      expect(inline()).toBe("ZenNotes Cloud is busy. Try again in a moment.");
      expect(host.querySelector('div[role="alert"]')).toBeNull();
      expect(buttonNamed("Hide notes")!.disabled).toBe(false);
      expect(host.textContent).not.toContain("Searching…");
    });

    it("lists one page and filters it here on a host that cannot page", async () => {
      mocks.listCloudBackupItems.mockResolvedValue(backupNotes.slice(0, 50));
      await openBackupNotes();

      expect(mocks.listCloudBackupItems).toHaveBeenCalledTimes(1);
      expect(mocks.listCloudBackupItems).toHaveBeenCalledWith("backup-1");
      expect(shownNotes()).toBe(50);
      expect(host.textContent).not.toContain("Showing");
      expect(buttonNamed("Load more")).toBeUndefined();

      await act(async () => typeInto(searchBox()!, "day 00"));
      expect(shownNotes()).toBe(9);
      await act(async () => typeInto(searchBox()!, "launch"));
      expect(host.textContent).toContain('No notes match "launch".');
      await afterSearchPause();
      expect(mocks.listCloudBackupItems).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain('No notes match "launch".');
    });
  });
});

function backupNote(id: number, path: string): CloudBackupSnapshotItem {
  return {
    id,
    item_id: `note-${id}`,
    path,
    kind: "text",
    byte_length: 512,
    revision: 1,
    content_hash: null,
    media_type: "text/markdown",
  };
}

/** The service's answer: a case-insensitive path search, 50 notes a page. */
function servicePage(
  notes: CloudBackupSnapshotItem[],
  query: CloudBackupItemsQuery,
): CloudBackupItemsPage {
  const search = query.search?.trim() ?? "";
  const matches = search
    ? notes.filter((note) =>
        note.path.toLowerCase().includes(search.toLowerCase()),
      )
    : notes;
  const page = query.page ?? 1;
  return {
    items: matches.slice((page - 1) * 50, page * 50),
    page,
    lastPage: Math.max(1, Math.ceil(matches.length / 50)),
    total: matches.length,
    search,
  };
}

/** Past the pause a backup search waits for before it asks the service. */
async function afterSearchPause(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === name,
  );
}

function deleteDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[data-cloud-vault-delete-dialog]");
}

function deleteNameInput(): HTMLInputElement | null {
  return deleteDialog()?.querySelector<HTMLInputElement>("input") ?? null;
}

function deleteConfirmButton(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>("[data-cloud-vault-delete-confirm]");
}

function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
