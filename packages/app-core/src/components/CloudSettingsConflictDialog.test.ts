// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VAULT_SETTINGS, type VaultSettings } from "@shared/ipc";
import type { CloudSyncSettingsConflict } from "@zennotes/bridge-contract/cloud-sync";
import { normalizeVaultSettings } from "../lib/vault-layout";
import { CloudSettingsConflictDialog } from "./CloudSettingsConflictDialog";

const local: VaultSettings = normalizeVaultSettings({
  ...DEFAULT_VAULT_SETTINGS,
  primaryNotesLocation: "root",
  favorites: ["Ideas.md", "inbox:Projects"],
  folderIcons: { "inbox:Projects": "bolt" },
});

/** The cloud's copy differs in two sections and carries a key this build has no setting for. */
const conflict: CloudSyncSettingsConflict = {
  path: ".zennotes/vault.json",
  cloud_path: ".zennotes/vault.cloud-conflict.json",
  cloud_settings: {
    ...JSON.parse(JSON.stringify(local)),
    favorites: ["inbox:Reading"],
    folderIcons: { "inbox:Projects": "bolt", "inbox:Archive": "archive" },
    experimentalSpellcheck: { enabled: true },
  },
};

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled ${label} in ${host.textContent}`);
  return found;
}

function sectionChoice(section: string, side: "This device" | "Cloud"): HTMLButtonElement {
  const group = document.body.querySelector(`[role="group"][aria-label="${section}: which to use"]`);
  const found = [...(group?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === side,
  );
  if (!found) throw new Error(`no ${side} choice for ${section}`);
  return found;
}

describe("CloudSettingsConflictDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const onResolve = vi.fn<(choice: "local" | "cloud") => Promise<void>>(async () => undefined);
  const onApply = vi.fn<(settings: VaultSettings) => Promise<void>>(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(CloudSettingsConflictDialog, {
          conflict,
          localSettings: local,
          vaultName: "Notes",
          onClose,
          onResolve,
          onApply,
        }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows each differing setting with this device's value beside the cloud's, and names what it cannot compare", () => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("Vault settings differ from the cloud");
    expect(text).toContain("2 settings differ");
    // Favorites: the two lists, in words.
    expect(text).toContain("Ideas.md, Inbox/Projects");
    expect(text).toContain("Inbox/Reading");
    // Folder icons: only the icon that differs, not the one both sides share.
    expect(text).toContain("Inbox/Archive");
    expect(text).toContain("Not set");
    expect(text).toContain("archive");
    // A key this build has no setting for is labelled, not silently dropped.
    expect(text).toContain("Not used on this device");
    expect(text).toContain("experimentalSpellcheck");
    // Existing guards key on the shared marker; the dialog also names itself.
    expect(document.body.querySelector("[data-cloud-conflict-dialog]")).not.toBeNull();
    expect(document.body.querySelector("[data-cloud-settings-conflict-dialog]")).not.toBeNull();
  });

  it("defaults to this device's settings, so the plain answer only drops the cloud's copy", async () => {
    expect(button(host, "Keep this device's settings")).toBeTruthy();
    await act(async () => button(host, "Keep this device's settings").click());
    expect(onResolve).toHaveBeenCalledWith("local");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("applies a per-section answer as this device's settings with the chosen sections from the cloud", async () => {
    await act(async () => sectionChoice("Folder icons", "Cloud").click());
    expect(button(host, "Apply choices")).toBeTruthy();
    await act(async () => button(host, "Apply choices").click());

    expect(onResolve).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledOnce();
    const applied = onApply.mock.calls[0][0];
    expect(applied.favorites).toEqual(["Ideas.md", "inbox:Projects"]);
    expect(applied.folderIcons).toEqual({ "inbox:Projects": "bolt", "inbox:Archive": "archive" });
    // The unknown key is not smuggled in through a chosen section.
    expect("experimentalSpellcheck" in applied).toBe(false);
  });

  it("offers the cloud for all sections in one step", async () => {
    await act(async () => button(host, "Cloud for all").click());
    expect(button(host, "Use the cloud's settings")).toBeTruthy();
    await act(async () => button(host, "Use the cloud's settings").click());
    const applied = onApply.mock.calls[0][0];
    expect(applied.favorites).toEqual(["inbox:Reading"]);
    expect(applied.folderIcons).toEqual({ "inbox:Projects": "bolt", "inbox:Archive": "archive" });
  });

  it("applies nothing when postponed", async () => {
    await act(async () => sectionChoice("Favorites", "Cloud").click());
    await act(async () => button(host, "Decide later").click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps the question open with the reason when applying fails", async () => {
    onApply.mockRejectedValueOnce(new Error("Disk full"));
    await act(async () => sectionChoice("Favorites", "Cloud").click());
    await act(async () => button(host, "Apply choices").click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Disk full");
    expect(onClose).not.toHaveBeenCalled();
    expect(button(host, "Apply choices").disabled).toBe(false);
  });
});

describe("CloudSettingsConflictDialog without a readable cloud copy", () => {
  it("falls back to the whole-file question", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onResolve = vi.fn(async () => undefined);
    act(() =>
      root.render(
        createElement(CloudSettingsConflictDialog, {
          conflict: { path: conflict.path, cloud_path: conflict.cloud_path },
          localSettings: local,
          vaultName: "Notes",
          onClose: vi.fn(),
          onResolve,
          onApply: vi.fn(async () => undefined),
        }),
      ),
    );
    expect(document.body.textContent).toContain("could not be read on this device");
    await act(async () => button(host, "Use the cloud's settings").click());
    expect(onResolve).toHaveBeenCalledWith("cloud");
    act(() => root.unmount());
    host.remove();
  });
});
