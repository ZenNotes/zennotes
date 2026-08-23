// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { formatRelativeSyncTime } from "../lib/cloud-auto-sync";
import { useCloudSyncStatusStore } from "../lib/cloud-auto-sync";
import { StatusBar } from "./StatusBar";
import { useStore } from "../store";
import type { NoteContent } from "@shared/ipc";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("cloud sync status time", () => {
  const now = new Date("2026-08-11T14:00:00.000Z").getTime();

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
