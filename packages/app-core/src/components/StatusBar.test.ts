// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeSyncTime } from "../lib/cloud-auto-sync";
import { useCloudSyncStatusStore } from "../lib/cloud-auto-sync";
import { StatusBar } from "./StatusBar";
import { CloudConflictReviewHost } from "./CloudConflictReviewHost";
import { useStore } from "../store";
import type { NoteContent } from "@shared/ipc";

const bridgeMocks = vi.hoisted(() => ({
  getCloudConflict: vi.fn(),
  saveCloudConflictDraft: vi.fn(),
  resolveCloudConflict: vi.fn(),
  syncCloudVault: vi.fn(),
}));

vi.mock("@zennotes/bridge-contract/bridge", () => ({
  getZenBridge: () => bridgeMocks,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("cloud sync status time", () => {
  const now = new Date("2026-08-11T14:00:00.000Z").getTime();

  // The status store is module state: a leftover summary (or an open queue)
  // from one case would decide the action label in the next.
  beforeEach(() => {
    useCloudSyncStatusStore.setState({
      phase: "hidden",
      vaultName: null,
      lastSyncedAt: null,
      error: null,
      lastSummary: null,
      conflictReviewOpen: false,
    });
  });

  it("keeps a recent successful sync reassuring and readable", () => {
    expect(formatRelativeSyncTime(now - 20_000, now)).toBe("just now");
    expect(formatRelativeSyncTime(now - 60_000, now)).toBe("1m ago");
    expect(formatRelativeSyncTime(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatRelativeSyncTime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
  });

  it("keeps the success status semantic while the hover action stays neutral", () => {
    useCloudSyncStatusStore.setState({
      phase: "ready",
      vaultName: "Notes",
      lastSyncedAt: now,
      error: null,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(createElement(StatusBar, { note: null })));

    const status = host.querySelector<HTMLElement>("[data-cloud-sync-status]");
    const button = host.querySelector<HTMLButtonElement>(
      "[data-cloud-sync-action]",
    );
    expect(status?.className).toContain("text-success");
    expect(button?.className).toContain("hover:bg-paper-200/60");
    expect(button?.className).toContain("hover:text-ink-800");
    expect(status?.contains(button ?? null)).toBe(false);

    act(() => root.unmount());
    host.remove();
  });

  it("offers cloud connection before an account is configured", () => {
    useCloudSyncStatusStore.setState({
      phase: "disconnected",
      vaultName: null,
      lastSyncedAt: null,
      error: null,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(createElement(StatusBar, { note: null })));

    expect(host.textContent).toContain("ZenNotes Cloud");
    expect(
      host.querySelector<HTMLButtonElement>("[data-cloud-sync-action]")
        ?.textContent,
    ).toBe("Connect");

    act(() => root.unmount());
    host.remove();
  });

  it("shows conflicted syncs as incomplete and offers a review action", () => {
    useCloudSyncStatusStore.setState({
      phase: "attention",
      vaultName: "Notes",
      lastSyncedAt: null,
      error: "Cloud active-item limit reached (100 of 100).",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(createElement(StatusBar, { note: null })));

    const status = host.querySelector<HTMLElement>("[data-cloud-sync-status]");
    const action = host.querySelector<HTMLButtonElement>(
      "[data-cloud-sync-action]",
    );
    expect(status?.textContent).toContain("Sync incomplete");
    expect(status?.className).toContain("text-warning");
    expect(status?.title).toBe("Cloud active-item limit reached (100 of 100).");
    expect(action?.textContent).toBe("Review");

    act(() => root.unmount());
    host.remove();
  });

  it("opens an ongoing multi-device conflict directly from the status bar", async () => {
    const pending = {
      id: "item-ongoing",
      item_id: "item-ongoing",
      path: "Daily Notes/Today.md",
      cloud_path: "Daily Notes/Today.md",
      kind: "content" as const,
      can_merge: true,
      has_base: true,
    };
    bridgeMocks.getCloudConflict.mockResolvedValue({
      conflict: pending,
      base: {
        path: pending.path,
        revision: 1,
        sha256: "base",
        byte_length: 4,
        media_type: "text/markdown",
        text: "base",
        deleted: false,
      },
      local: {
        path: pending.path,
        revision: null,
        sha256: "local",
        byte_length: 5,
        media_type: "text/markdown",
        text: "local",
        deleted: false,
      },
      cloud: {
        path: pending.path,
        revision: 2,
        sha256: "cloud",
        byte_length: 5,
        media_type: "text/markdown",
        text: "cloud",
        deleted: false,
      },
      suggested_text: "local",
      draft_text: null,
      changes: [
        {
          id: "change-1",
          base_text: "base",
          local_text: "local",
          cloud_text: "cloud",
        },
      ],
      parts: [{ type: "change", change_id: "change-1" }],
    });
    useCloudSyncStatusStore.setState({
      phase: "attention",
      vaultName: "Cloud Notes",
      lastSyncedAt: null,
      error:
        "Cloud sync needs attention: 1 file differs on this device and in Cloud.",
      lastSummary: {
        cursor: 7,
        pulled: 1,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [],
        local_conflicts: [],
        pending_conflicts: [pending],
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      // The dialog is mounted app-wide (zen mode hides the status bar), so the
      // click and the queue it opens are two components.
      act(() =>
        root.render(
          createElement(
            Fragment,
            null,
            createElement(StatusBar, { note: null }),
            createElement(CloudConflictReviewHost),
          ),
        ),
      );
      const resolve = host.querySelector<HTMLButtonElement>(
        "[data-cloud-sync-action]",
      );
      expect(resolve?.textContent).toBe("Review now");
      expect(host.textContent).toContain("1 file needs review");
      await act(async () => {
        resolve!.click();
        await Promise.resolve();
      });

      const dialog = document.body.querySelector<HTMLElement>(
        "[data-cloud-conflict-dialog]",
      );
      expect(dialog?.textContent).toContain("Today.md");
      expect(dialog?.textContent).toContain("Other device");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("keeps the conflict queue reachable while the next run is syncing", async () => {
    const pending = {
      id: "item-during-sync",
      item_id: "item-during-sync",
      path: "Daily Notes/Today.md",
      cloud_path: "Daily Notes/Today.md",
      kind: "content" as const,
      can_merge: true,
      has_base: true,
    };
    bridgeMocks.getCloudConflict.mockResolvedValue({
      conflict: pending,
      base: textVersion(pending.path, "base"),
      local: textVersion(pending.path, "local"),
      cloud: textVersion(pending.path, "cloud"),
      suggested_text: "local",
      draft_text: null,
      changes: [],
      parts: [],
    });
    useCloudSyncStatusStore.setState({
      phase: "syncing",
      vaultName: "Cloud Notes",
      lastSyncedAt: null,
      error: null,
      lastSummary: {
        cursor: 7,
        pulled: 1,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [],
        local_conflicts: [],
        pending_conflicts: [pending],
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(createElement(StatusBar, { note: null })));
      const review = host.querySelector<HTMLButtonElement>(
        "[data-cloud-sync-action]",
      );
      expect(review?.textContent).toBe("Review now");

      await act(async () => {
        review!.click();
        await Promise.resolve();
      });
      expect(useCloudSyncStatusStore.getState().conflictReviewOpen).toBe(true);
      expect(bridgeMocks.syncCloudVault).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("shows the active editor line and column on the right (discussion #597)", () => {
    useCloudSyncStatusStore.setState({ phase: "hidden" });
    useStore.setState({
      notes: [],
      editorCursorPosition: { line: 3, column: 5 },
    });
    const note = {
      path: "inbox/editor-position.md",
      title: "Editor position",
      folder: "inbox",
      siblingOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      size: 16,
      tags: [],
      wikilinks: [],
      assetEmbeds: [],
      hasAttachments: false,
      excerpt: "alpha",
      body: "alpha\nbeta\ngamma",
    } as NoteContent;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(createElement(StatusBar, { note })));

    const position = host.querySelector<HTMLElement>("[data-editor-position]");
    expect(position?.textContent).toBe("Ln 3, Col 5");
    expect(position?.getAttribute("aria-live")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});

function textVersion(path: string, text: string) {
  return {
    path,
    revision: 2,
    sha256: `hash-${text}`,
    byte_length: text.length,
    media_type: "text/markdown",
    text,
    deleted: false,
  };
}
