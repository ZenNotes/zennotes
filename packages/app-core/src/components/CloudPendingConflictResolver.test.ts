// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudSyncPendingConflict,
  CloudSyncPendingConflictDetails,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import { CloudPendingConflictResolver } from "./CloudPendingConflictResolver";
import {
  clearCloudSyncStatus,
  syncCloudVaultWithStatus,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";

const bridge = vi.hoisted(() => ({
  getCloudConflict: vi.fn(),
  releaseCloudConflictReview: vi.fn(),
  saveCloudConflictDraft: vi.fn(),
  resolveCloudConflict: vi.fn(),
  syncCloudVault: vi.fn(),
}));

vi.mock("@zennotes/bridge-contract/bridge", () => ({
  getZenBridge: () => bridge,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const conflict: CloudSyncPendingConflict = {
  id: "item-1",
  item_id: "item-1",
  path: "Plans/Trip.md",
  cloud_path: "Plans/Trip.md",
  kind: "content",
  can_merge: true,
  has_base: true,
};

const details: CloudSyncPendingConflictDetails = {
  conflict,
  base: version("Plans/Trip.md", "Pack a coat.\n"),
  local: version("Plans/Trip.md", "Pack a warm coat.\n"),
  cloud: version("Plans/Trip.md", "Pack a rain coat.\n"),
  suggested_text: "# Trip\nPack a warm coat.\n",
  draft_text: null,
  changes: [
    {
      id: "change-1",
      base_text: "Pack a coat.\n",
      local_text: "Pack a warm coat.\n",
      cloud_text: "Pack a rain coat.\n",
    },
  ],
  parts: [
    { type: "text", text: "# Trip\n" },
    { type: "change", change_id: "change-1" },
  ],
};

const synced: CloudSyncRunSummary = {
  cursor: 8,
  pulled: 0,
  pushed: 1,
  conflicts: [],
  bootstrap_conflicts: [],
  local_conflicts: [],
  pending_conflicts: [],
};

beforeEach(() => {
  clearCloudSyncStatus();
  bridge.getCloudConflict.mockReset().mockResolvedValue(details);
  bridge.releaseCloudConflictReview.mockReset().mockResolvedValue(undefined);
  bridge.saveCloudConflictDraft.mockReset().mockResolvedValue(undefined);
  bridge.resolveCloudConflict.mockReset().mockResolvedValue(undefined);
  bridge.syncCloudVault.mockReset().mockResolvedValue(synced);
});

describe("CloudPendingConflictResolver", () => {
  it("finishes the saved decision before the remaining vault sync completes", async () => {
    let finishSync!: (summary: CloudSyncRunSummary) => void;
    bridge.syncCloudVault.mockImplementationOnce(() => new Promise((resolve) => {
      finishSync = resolve;
    }));
    const onResolved = vi.fn();
    const pending = { ...synced, pending_conflicts: [conflict] };
    useCloudSyncStatusStore.setState({ lastSummary: pending, lastSyncedAt: 123 });
    const view = mount({ onResolved });
    await act(async () => Promise.resolve());
    await act(async () => button(view.host, "Use other device").click());
    await act(async () => button(view.host, "Save combined note").click());

    expect(onResolved).toHaveBeenCalledWith(synced);
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "syncing", lastSyncedAt: 123, lastSummary: synced,
    });
    view.unmount();
    await act(async () => finishSync(synced));
  });

  it("does not reopen a saved conflict when follow-up sync times out", async () => {
    bridge.syncCloudVault.mockRejectedValueOnce(new Error("Request timed out"));
    const onResolved = vi.fn();
    useCloudSyncStatusStore.setState({
      lastSummary: { ...synced, pending_conflicts: [conflict] },
      lastSyncedAt: 123,
    });
    const view = mount({ onResolved });
    await act(async () => Promise.resolve());
    await act(async () => button(view.host, "Use other device").click());
    await act(async () => button(view.host, "Save combined note").click());

    expect(onResolved).toHaveBeenCalledWith(synced);
    expect(bridge.getCloudConflict).toHaveBeenCalledTimes(1);
    expect(useCloudSyncStatusStore.getState()).toMatchObject({
      phase: "error", lastSyncedAt: 123, lastSummary: synced,
      error: "Note saved. Remaining vault sync failed: Request timed out",
    });
    view.unmount();
  });

  it("releases its own review session after unmount even if the final draft save fails", async () => {
    const view = mount({});
    await act(async () => Promise.resolve());
    const reviewId = bridge.getCloudConflict.mock.calls[0][1];
    expect(typeof reviewId).toBe("string");
    await act(async () => button(view.host, "Use other device").click());
    bridge.saveCloudConflictDraft.mockRejectedValue(new Error("Disk is full"));
    view.unmount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(bridge.releaseCloudConflictReview).toHaveBeenCalledWith(conflict.id, reviewId);
  });

  it("flushes a freshly edited draft before background sync and locks editing until it finishes", async () => {
    let finishSave!: () => void;
    bridge.saveCloudConflictDraft.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishSave = resolve; }),
    );
    const pending = { ...synced, pending_conflicts: [conflict] };
    bridge.syncCloudVault.mockResolvedValue(pending);
    useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
    const view = mount({});
    await act(async () => Promise.resolve());

    await act(async () => {
      const editor = textarea(view.host);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set?.call(editor, "An unfinished third version\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(bridge.saveCloudConflictDraft).not.toHaveBeenCalled();

    let run!: Promise<CloudSyncRunSummary>;
    await act(async () => { run = syncCloudVaultWithStatus(bridge); });
    expect(bridge.saveCloudConflictDraft).toHaveBeenCalledWith(
      conflict.id, "An unfinished third version\n",
    );
    expect(bridge.syncCloudVault).not.toHaveBeenCalled();
    expect(textarea(view.host).disabled).toBe(true);

    await act(async () => { finishSave(); await run; });
    expect(bridge.syncCloudVault).toHaveBeenCalledOnce();
    expect(textarea(view.host).disabled).toBe(false);
    expect(textarea(view.host).value).toBe("An unfinished third version\n");
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true);
    view.unmount();
  });

  it("keeps an unsaved draft and the review open when its pre-sync save fails", async () => {
    bridge.saveCloudConflictDraft.mockRejectedValue(new Error("Disk is full"));
    useCloudSyncStatusStore.setState({ conflictReviewOpen: true });
    const view = mount({});
    await act(async () => Promise.resolve());
    await act(async () => button(view.host, "Use other device").click());
    await act(async () => {
      await expect(syncCloudVaultWithStatus(bridge)).rejects.toThrow("Disk is full");
    });
    expect(bridge.syncCloudVault).not.toHaveBeenCalled();
    expect(textarea(view.host).value).toBe("# Trip\nPack a rain coat.\n");
    expect(textarea(view.host).disabled).toBe(false);
    expect(view.host.textContent).toContain("Disk is full");
    expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true);
    view.unmount();
  });

  it("uses plain labels and requires an explicit choice for overlapping text", async () => {
    const onResolved = vi.fn();
    const view = mount({ onResolved });

    await act(async () => Promise.resolve());

    expect(view.host.textContent).toContain("This device");
    expect(view.host.textContent).toContain("Other device");
    expect(view.host.textContent).toContain("Last synced");
    expect(view.host.textContent).not.toContain("revision");
    expect(view.host.textContent).not.toContain("sha256");

    const save = button(view.host, "Save combined note");
    expect(save.disabled).toBe(true);

    await act(async () => button(view.host, "Use other device").click());
    expect(textarea(view.host).value).toBe("# Trip\nPack a rain coat.\n");
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.resolveCloudConflict).toHaveBeenCalledWith({
      conflict_id: "item-1",
      choice: "merged",
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: details.cloud.revision,
      merged_text: "# Trip\nPack a rain coat.\n",
      resolved_path: "Plans/Trip.md",
    });
    expect(onResolved).toHaveBeenCalledWith(synced);
    view.unmount();
  });

  it("gives first sync a direct two-version choice without implying an automatic merge", async () => {
    bridge.getCloudConflict.mockResolvedValue({
      ...details,
      conflict: {
        ...conflict,
        can_merge: false,
        has_base: false,
      },
      base: {
        path: "Plans/Trip.md",
        revision: null,
        sha256: null,
        byte_length: 0,
        media_type: null,
        text: null,
        deleted: false,
      },
      suggested_text: null,
      changes: [],
      parts: [],
    });
    const view = mount({
      conflict: { ...conflict, can_merge: false, has_base: false },
    });
    await act(async () => Promise.resolve());

    expect(view.host.textContent).toContain(
      "This is the first sync, so ZenNotes cannot tell which one is newer.",
    );
    expect(view.host.textContent).toContain("Use this device’s version");
    expect(view.host.textContent).toContain("Use other device’s version");
    expect(view.host.textContent).not.toContain("Combined note");
    expect(view.host.textContent).not.toContain("Last synced");

    await act(async () => button(view.host, "Combine them myself…").click());
    expect(view.host.textContent).toContain("Combined note");
    expect(button(view.host, "Save combined note").disabled).toBe(false);
    view.unmount();
  });

  it("confirms before replacing one complete version with the other", async () => {
    bridge.getCloudConflict.mockResolvedValue({
      ...details,
      conflict: {
        ...conflict,
        can_merge: false,
        has_base: false,
      },
      base: {
        path: "Plans/Trip.md",
        revision: null,
        sha256: null,
        byte_length: 0,
        media_type: null,
        text: null,
        deleted: false,
      },
      suggested_text: null,
      changes: [],
      parts: [],
    });
    const view = mount({
      conflict: { ...conflict, can_merge: false, has_base: false },
    });
    await act(async () => Promise.resolve());

    await act(async () => button(view.host, "Use other device’s version").click());

    expect(bridge.resolveCloudConflict).not.toHaveBeenCalled();
    const confirmation = view.host.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(confirmation?.textContent).toContain(
      "Use the other device’s complete version?",
    );
    expect(confirmation?.textContent).toContain(
      "Changes that exist only in this device’s version will not be included.",
    );
    expect(document.activeElement).toBe(confirmation);

    await act(async () => {
      button(view.host, "Replace with other device’s version").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.resolveCloudConflict).toHaveBeenCalledWith({
      conflict_id: "item-1",
      choice: "cloud",
      expected_local_sha256: details.local.sha256,
      expected_cloud_revision: details.cloud.revision,
    });
    view.unmount();
  });

  it("saves the latest draft before finishing later", async () => {
    const onClose = vi.fn();
    const view = mount({ onClose });
    await act(async () => Promise.resolve());

    await act(async () => {
      const editor = textarea(view.host);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(editor, "My careful combination\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button(view.host, "Finish later").click();
      await Promise.resolve();
    });

    const warning = view.host.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(warning?.textContent).toContain("Resolve this note later?");
    expect(warning?.textContent).toContain("both complete versions stay safe");
    expect(document.activeElement).toBe(warning);
    expect(view.host.querySelector("textarea")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      button(view.host, "Keep reviewing").click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(button(view.host, "Finish later"));

    await act(async () => {
      button(view.host, "Finish later").click();
      await Promise.resolve();
    });
    await act(async () => {
      button(view.host, "Save & finish later").click();
      await Promise.resolve();
    });

    expect(bridge.saveCloudConflictDraft).toHaveBeenCalledWith(
      "item-1",
      "My careful combination\n",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps the combined note locked until every change is answered", async () => {
    bridge.getCloudConflict.mockResolvedValue({
      ...details,
      changes: [
        {
          id: "change-1",
          base_text: "Pack a coat.\n",
          local_text: "Pack a warm coat.\n",
          cloud_text: "Pack a rain coat.\n",
        },
        {
          id: "change-2",
          base_text: "Leave Monday.\n",
          local_text: "Leave Tuesday.\n",
          cloud_text: "Leave Wednesday.\n",
        },
      ],
      parts: [
        { type: "text", text: "# Trip\n" },
        { type: "change", change_id: "change-1" },
        { type: "change", change_id: "change-2" },
      ],
    });
    const view = mount({});
    await act(async () => Promise.resolve());

    const save = button(view.host, "Save combined note");
    expect(save.disabled).toBe(true);

    await act(async () => button(view.host, "Use this device").click());
    expect(save.disabled).toBe(true);
    expect(view.host.textContent).toContain("the remaining change");

    // Typing is an edit, not an answer: the second change would still be
    // saved as the last synced wording.
    await act(async () => {
      const editor = textarea(view.host);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(editor, "# Trip\nPack a warm coat.\nLeave Tuesday.\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(true);
    expect(view.host.textContent).toContain("the remaining change");

    await act(async () =>
      [...view.host.querySelectorAll("button")]
        .filter((candidate) => candidate.textContent?.trim() === "Use other device")[1]
        .click(),
    );
    expect(save.disabled).toBe(false);
    expect(view.host.textContent).not.toContain("the remaining change");
    view.unmount();
  });

  it("reloads both versions after a rejected save so the retry is not stale", async () => {
    bridge.resolveCloudConflict.mockRejectedValueOnce(
      new Error("This file changed again while you were reviewing it."),
    );
    const view = mount({});
    await act(async () => Promise.resolve());
    expect(bridge.getCloudConflict).toHaveBeenCalledTimes(1);

    await act(async () => button(view.host, "Use other device").click());
    await act(async () => {
      button(view.host, "Save combined note").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.host.textContent).toContain(
      "This file changed again while you were reviewing it.",
    );
    expect(bridge.getCloudConflict).toHaveBeenCalledTimes(2);

    // The refetched details drive the next attempt, and the error stays up
    // until it succeeds.
    await act(async () => Promise.resolve());
    expect(view.host.textContent).toContain(
      "This file changed again while you were reviewing it.",
    );
    expect(button(view.host, "Save combined note")).toBeInstanceOf(
      HTMLButtonElement,
    );
    view.unmount();
  });

  it("explains a delete conflict as a human choice", async () => {
    bridge.getCloudConflict.mockResolvedValue({
      ...details,
      conflict: {
        ...conflict,
        kind: "delete",
        cloud_path: null,
        can_merge: false,
      },
      cloud: {
        ...details.cloud,
        path: null,
        sha256: null,
        text: null,
        deleted: true,
      },
      suggested_text: null,
      changes: [],
      parts: [],
    });
    const view = mount({
      conflict: {
        ...conflict,
        kind: "delete",
        cloud_path: null,
        can_merge: false,
      },
    });
    await act(async () => Promise.resolve());

    expect(view.host.textContent).toContain("deleted on another");
    expect(view.host.textContent).toContain("Keep this note");
    expect(view.host.textContent).toContain("Delete everywhere");

    await act(async () => button(view.host, "Delete everywhere").click());
    expect(bridge.resolveCloudConflict).not.toHaveBeenCalled();
    expect(view.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete this file everywhere?",
    );

    await act(async () => {
      button(view.host, "Delete file everywhere").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.resolveCloudConflict).toHaveBeenCalledWith(
      expect.objectContaining({ choice: "cloud" }),
    );
    view.unmount();
  });
});

function version(path: string, text: string) {
  return {
    path,
    revision: 7,
    sha256: `hash-${text}`,
    byte_length: text.length,
    media_type: "text/markdown",
    text,
    deleted: false,
  };
}

function mount(overrides: {
  conflict?: CloudSyncPendingConflict;
  onResolved?: (summary: CloudSyncRunSummary) => void;
  onClose?: () => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(CloudPendingConflictResolver, {
        conflict: overrides.conflict ?? conflict,
        summary: { ...synced, pending_conflicts: [overrides.conflict ?? conflict] },
        vaultName: "Cloud Notes",
        onResolved: overrides.onResolved ?? vi.fn(),
        onClose: overrides.onClose ?? vi.fn(),
      }),
    ),
  );
  return {
    host,
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Missing button: ${label}`);
  return match;
}

function textarea(host: HTMLElement): HTMLTextAreaElement {
  const value = host.querySelector("textarea");
  if (!(value instanceof HTMLTextAreaElement))
    throw new Error("Missing textarea");
  return value;
}
