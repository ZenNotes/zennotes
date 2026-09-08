// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { requestSettingsTarget } from "../lib/settings-navigation";

const cloudMocks = vi.hoisted(() => ({
  getCloudAccountStatus: vi
    .fn()
    .mockResolvedValue({ state: "disconnected", account: null }),
  onCloudAccountChange: vi.fn(() => vi.fn()),
}));

const mocks = vi.hoisted(() => {
  const state = new Proxy(
    {
      autoCalendarPanel: true,
      calendarShowWeekNumbers: true,
      calendarWeekStart: "monday",
      customTemplates: [],
      darkSidebar: false,
      editorFontSize: 16,
      editorLineHeight: 1.6,
      editorScrollOff: 0,
      fzfBinaryPath: null,
      hiddenWorkflowPresets: [],
      hideBuiltinTemplates: false,
      interfaceFont: null,
      keymapOverrides: {} as Record<string, string>,
      lineNumberMode: "off",
      monoFont: null,
      previewMaxWidth: 760,
      quickNoteTitlePrefix: null,
      remoteWorkspaceInfo: null as null | { mode: string; baseUrl: string | null; authConfigured: boolean; capabilities: Record<string, unknown> | null; profileId: string | null; bootError: string | null },
      remoteWorkspaceProfiles: [],
      ripgrepBinaryPath: null,
      setSettingsOpen: vi.fn(),
      setVaultSettings: vi.fn(),
      showSidebarChevrons: true,
      systemFolderLabels: {},
      textReplacements: { "->": "→" },
      textReplacementsEnabled: true,
      setTextReplacements: vi.fn(),
      textFont: null,
      themeFamily: "apple",
      themeId: "apple-light",
      themeMode: "light",
      vault: { root: "/tmp/zennotes-test-vault", name: "Test Vault" },
      vaultSettings: {
        primaryNotesLocation: "inbox",
        dailyNotes: { enabled: true, directory: "Daily Not" },
        weeklyNotes: { enabled: false, directory: "Weekly Notes" },
        monthlyNotes: { enabled: false, directory: "Monthly Notes" },
        folderIcons: {},
      },
      vaultTextSearchBackend: "auto",
      vimInsertEscape: "",
      vimMode: false,
      vimWrappedLineMotions: "logical",
      setVimWrappedLineMotions: vi.fn(),
      setKeymapBinding: vi.fn(),
      whichKeyHintMode: "timed",
      whichKeyHintTimeoutMs: 1200,
      whichKeyHints: true,
      workspaceMode: "local" as "local" | "remote",
    },
    {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target];
        return vi.fn();
      },
    },
  );

  return {
    state,
    setSettingsOpen: state.setSettingsOpen,
    setVaultSettings: state.setVaultSettings,
  };
});

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));

vi.mock("../lib/system-fonts", () => ({
  hasSystemFontAccess: () => false,
  listSystemFonts: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/app-update-state", () => ({
  useAppUpdateState: () => ({ phase: "idle", message: "Manual check" }),
}));

vi.mock("@zennotes/bridge-contract/bridge", () => ({
  getZenBridge: () => ({
    getAppInfo: () => ({
      runtime: "desktop",
      version: "2.4.0",
      description: "ZenNotes",
      homepage: "https://github.com/ZenNotes/zennotes/releases/latest",
    }),
    getCapabilities: () => ({
      supportsCustomTemplates: true,
      supportsRemoteWorkspace: false,
      supportsCloudSync: true,
    }),
    ...cloudMocks,
  }),
}));

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function blurInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

describe("SettingsModal date note directories", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.vimMode = false;
    mocks.state.vimWrappedLineMotions = "logical";
    mocks.state.keymapOverrides = {};
    mocks.state.workspaceMode = "local";
    mocks.state.remoteWorkspaceInfo = null;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "zen", {
      configurable: true,
      value: {
        getVaultTextSearchCapabilities: vi
          .fn()
          .mockResolvedValue({ ripgrep: false, fzf: false }),
        checkForAppUpdates: vi
          .fn()
          .mockResolvedValue({ phase: "idle", message: "Manual check" }),
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not restore the default daily directory while the field is being cleared", async () => {
    await act(async () => {
      root.render(createElement(SettingsModal));
    });

    const search = [...host.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.placeholder === "Search settings…",
    );
    expect(search).toBeTruthy();

    await act(async () => {
      changeInput(search!, "daily notes directory");
    });

    const dailyDirectory = [
      ...host.querySelectorAll<HTMLInputElement>("input"),
    ].find((input) => input.value === "Daily Not");
    expect(dailyDirectory).toBeTruthy();

    await act(async () => {
      changeInput(dailyDirectory!, "");
    });

    expect(mocks.setVaultSettings).not.toHaveBeenCalled();
  });

  it("saves the daily directory when the edit is committed", async () => {
    await act(async () => {
      root.render(createElement(SettingsModal));
    });

    const search = [...host.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.placeholder === "Search settings…",
    );
    expect(search).toBeTruthy();

    await act(async () => {
      changeInput(search!, "daily notes directory");
    });

    const dailyDirectory = [
      ...host.querySelectorAll<HTMLInputElement>("input"),
    ].find((input) => input.value === "Daily Not");
    expect(dailyDirectory).toBeTruthy();

    await act(async () => {
      changeInput(dailyDirectory!, "inbox/Journal");
    });

    expect(mocks.setVaultSettings).not.toHaveBeenCalled();

    await act(async () => {
      blurInput(dailyDirectory!);
    });

    expect(mocks.setVaultSettings).toHaveBeenCalledWith({
      primaryNotesLocation: "inbox",
      dailyNotes: { enabled: true, directory: "inbox/Journal" },
      weeklyNotes: { enabled: false, directory: "Weekly Notes" },
      monthlyNotes: { enabled: false, directory: "Monthly Notes" },
      folderIcons: {},
    });
  });

  it("opens the text replacements tab and saves edited rules", async () => {
    await act(async () => {
      root.render(createElement(SettingsModal));
    });

    const editorButton = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Editor");
    expect(editorButton).toBeTruthy();
    await act(async () => editorButton!.click());

    const replacementsTab = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Text replacements");
    expect(replacementsTab).toBeTruthy();
    await act(async () => replacementsTab!.click());

    const trigger = host.querySelector<HTMLInputElement>(
      'input[aria-label="Text to replace"]',
    );
    const replacement = host.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement text"]',
    );
    expect(trigger?.value).toBe("->");
    expect(replacement?.value).toBe("→");

    await act(async () => changeInput(trigger!, "(c)"));
    expect(mocks.state.setTextReplacements).toHaveBeenCalledWith({
      "(c)": "→",
    });
  });

  it("offers display-row and logical-line Vim motion behavior", async () => {
    mocks.state.vimMode = true;
    await act(async () => {
      root.render(createElement(SettingsModal));
    });

    const search = [...host.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.placeholder === "Search settings…",
    );
    await act(async () => changeInput(search!, "wrapped line motions"));

    const displayRow = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Display row");
    const logicalLine = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Logical line");
    expect(displayRow).toBeTruthy();
    expect(logicalLine).toBeTruthy();

    await act(async () => displayRow!.click());
    expect(mocks.state.setVimWrappedLineMotions).toHaveBeenCalledWith(
      "display",
    );
  });

  it("opens directly to ZenNotes Cloud when requested by the app shell", async () => {
    requestSettingsTarget("cloud");
    await act(async () => {
      root.render(createElement(SettingsModal));
    });

    const cloudButton = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Cloud");
    expect(cloudButton).toBeTruthy();
    expect(cloudButton?.className).toContain("bg-paper-200/85");

    expect(host.textContent).toContain("Keep your vault available everywhere");
    expect(host.textContent).toContain("Connect ZenNotes Cloud");
  });
  async function openKeymapRow(title: string): Promise<HTMLElement> {
    await act(async () => {
      root.render(createElement(SettingsModal));
    });
    const keymapButton = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Keymap");
    expect(keymapButton).toBeTruthy();
    await act(async () => keymapButton!.click());
    const filter = host.querySelector<HTMLInputElement>(
      'input[placeholder="Filter keymaps…"]',
    );
    expect(filter).toBeTruthy();
    await act(async () => changeInput(filter!, title));
    const label = [...host.querySelectorAll<HTMLSpanElement>("span")].find(
      (span) => span.textContent === title,
    );
    expect(label).toBeTruthy();
    const row = label!.closest<HTMLElement>(".justify-between");
    expect(row).toBeTruthy();
    return row!;
  }

  function rowButton(row: HTMLElement, text: string): HTMLButtonElement {
    const button = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    expect(button, `${text} button`).toBeTruthy();
    return button!;
  }

  it("unbinds a keymap from its row with an empty-string override", async () => {
    const row = await openKeymapRow("Zoom in");
    const unbind = rowButton(row, "Unbind");
    expect(unbind.disabled).toBe(false);
    await act(async () => unbind.click());
    expect(mocks.state.setKeymapBinding).toHaveBeenCalledWith(
      "global.zoomIn",
      "",
    );
  });

  it("shows an unbound keymap as Unbound and only offers Reset or Change", async () => {
    mocks.state.keymapOverrides = { "global.zoomIn": "" };
    const row = await openKeymapRow("Zoom in");
    expect(row.textContent).toContain("Unbound");
    expect(rowButton(row, "Unbind").disabled).toBe(true);
    expect(rowButton(row, "Reset").disabled).toBe(false);

    await act(async () => rowButton(row, "Change…").click());
    const recorder = document.body.textContent ?? "";
    expect(recorder).toContain("Current: Unbound");
  });
  async function openTemplatesSection(): Promise<void> {
    await act(async () => {
      root.render(createElement(SettingsModal));
    });
    const templatesButton = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Templates");
    expect(templatesButton).toBeTruthy();
    await act(async () => templatesButton!.click());
  }

  function newTemplateButton(): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "New template",
    );
  }

  it("offers custom templates on a remote vault whose server advertises them (#723)", async () => {
    mocks.state.workspaceMode = "remote";
    mocks.state.remoteWorkspaceInfo = {
      mode: "remote",
      baseUrl: "http://localhost:7878",
      authConfigured: true,
      capabilities: { supportsCustomTemplates: true },
      profileId: null,
      bootError: null,
    };
    await openTemplatesSection();
    expect(newTemplateButton()).toBeTruthy();
    expect(host.textContent).not.toContain("need ZenNotes server 2.46");
  });

  it("keeps templates read-only on a remote vault behind an older server", async () => {
    mocks.state.workspaceMode = "remote";
    mocks.state.remoteWorkspaceInfo = {
      mode: "remote",
      baseUrl: "http://localhost:7878",
      authConfigured: true,
      capabilities: { supportsWorkflows: true },
      profileId: null,
      bootError: null,
    };
    await openTemplatesSection();
    expect(newTemplateButton()).toBeUndefined();
    expect(host.textContent).toContain("need ZenNotes server 2.46 or later");
    expect(host.textContent).toContain("reconnect this workspace");
  });
});
