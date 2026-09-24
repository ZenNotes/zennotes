// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { requestSettingsTarget } from "../lib/settings-navigation";
import {
  getSettingsSearchResults,
  type SettingsSearchCategory,
} from "../lib/settings-search";

// Spied, not replaced: the modal hands search every category it built, which
// is how the guards below read the real search items and sub-tabs.
vi.mock("../lib/settings-search", { spy: true });

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
      externalApplicationSchemes: [],
      setExternalApplicationSchemes: vi.fn(),
      darkSidebar: false,
      showWindowTitleBar: true,
      setShowWindowTitleBar: vi.fn(),
      editorFontSize: 16,
      editorLineHeight: 1.6,
      editorScrollOff: 0,
      fzfBinaryPath: null,
      hiddenWorkflowPresets: [],
      hideBuiltinTemplates: false,
      interfaceFont: null,
      keymapOverrides: {} as Record<string, string>,
      lineNumberMode: "off",
      mathRenderer: "katex" as "katex" | "typst",
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
    runtime: "desktop" as "desktop" | "web",
    capabilities: {} as Record<string, boolean>,
    setSettingsOpen: state.setSettingsOpen,
    setVaultSettings: state.setVaultSettings,
  };
});

const defaultVaultSettings = mocks.state.vaultSettings;

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
      runtime: mocks.runtime,
      version: "2.4.0",
      description: "ZenNotes",
      homepage: "https://github.com/ZenNotes/zennotes/releases/latest",
    }),
    getCapabilities: () => ({
      supportsCustomTemplates: true,
      supportsRemoteWorkspace: false,
      supportsCloudSync: true,
      ...mocks.capabilities,
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

/** Folder fields that only render in folder mode, right under the location
 *  row a search hit already opens (tasks-location for tasks-folder). */
const REACHED_THROUGH_LOCATION_ROW = new Set([
  "drawings-folder",
  "databases-folder",
  "tasks-folder",
]);

type BuiltSettingsCategory = SettingsSearchCategory & {
  content?: ReactNode;
  subTabs?: { id: string; searchIds?: string[]; content: ReactNode }[];
};

/** The search targets a pane's JSX registers: a row's `settingId`, or a
 *  `data-settings-search-id` spread onto a plain element. */
function searchTargetsIn(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(searchTargetsIn);
  if (!isValidElement(node)) return [];
  const props = node.props as {
    settingId?: unknown;
    "data-settings-search-id"?: unknown;
    children?: ReactNode;
  };
  const own = [props.settingId, props["data-settings-search-id"]].filter(
    (id): id is string => typeof id === "string",
  );
  return [...own, ...searchTargetsIn(props.children)];
}

/** Every id a search hit can name: each item's own id and the row it jumps to. */
function searchItemTargets(categories: SettingsSearchCategory[]): Set<string> {
  return new Set(
    categories.flatMap((category) =>
      (category.searchItems ?? []).flatMap((item) => [
        item.id,
        item.targetId ?? item.id,
      ]),
    ),
  );
}

describe("SettingsModal date note directories", () => {
  let root: Root;
  let host: HTMLDivElement;
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime = "desktop";
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    mocks.state.vimMode = false;
    mocks.state.vimWrappedLineMotions = "logical";
    mocks.state.keymapOverrides = {};
    mocks.state.workspaceMode = "local";
    mocks.state.remoteWorkspaceInfo = null;
    mocks.state.mathRenderer = "katex";
    mocks.state.vaultSettings = defaultVaultSettings;
    mocks.capabilities = {};
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
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("opens application link settings and saves normalized prefixes", async () => {
    requestSettingsTarget("external-links");
    await act(async () => root.render(createElement(SettingsModal)));
    const input = host.querySelector<HTMLInputElement>('input[placeholder="zotero, obsidian, vscode"]');
    expect(input).toBeTruthy();
    await act(async () => changeInput(input!, "Zotero://, obsidian:, zotero"));
    await act(async () => blurInput(input!));
    expect(mocks.state.setExternalApplicationSchemes).toHaveBeenCalledWith(["zotero", "obsidian"]);
  });

  it("finds the title bar setting by Hyprland and toggles it", async () => {
    await act(async () => root.render(createElement(SettingsModal)));
    const search = host.querySelector<HTMLInputElement>('input[placeholder="Search settings…"]');
    await act(async () => changeInput(search!, "hyprland"));
    const toggle = host.querySelector<HTMLButtonElement>('[data-settings-search-id="window-title-bar"] [role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle!.click());
    expect(mocks.state.setShowWindowTitleBar).toHaveBeenCalledWith(false);
  });

  it("finds the new-file location rows by the words people search for", async () => {
    await act(async () => root.render(createElement(SettingsModal)));
    const search = host.querySelector<HTMLInputElement>('input[placeholder="Search settings…"]')!;
    const cases = [
      ["tasks folder", "Default tasks location", "tasks-location"],
      ["task folder", "Default tasks location", "tasks-location"],
      ["new task", "Default tasks location", "tasks-location"],
      ["drawings folder", "Default drawings location", "drawings-location"],
      ["database location", "Default databases location", "databases-location"],
    ] as const;
    for (const [query, title, settingId] of cases) {
      await act(async () => changeInput(search, query));
      const result = [...host.querySelectorAll<HTMLButtonElement>("aside nav button")].find(
        (button) => button.textContent?.includes(title),
      );
      expect(result, query).toBeTruthy();
      await act(async () => result!.click());
      expect(host.querySelector(`[data-settings-search-id="${settingId}"]`), query).toBeTruthy();
    }
  });

  it("says where a specific tasks folder really lands for the vault's layout", async () => {
    const original = mocks.state.vaultSettings;
    const withTasksFolder = (primaryNotesLocation: "inbox" | "root") =>
      ({
        ...original,
        primaryNotesLocation,
        tasksLocation: { mode: "folder", folder: "Tasks" },
      }) as typeof original;
    const folderRowText = () =>
      host.querySelector('[data-settings-search-id="tasks-folder"]')?.textContent ?? "";
    try {
      mocks.state.vaultSettings = withTasksFolder("inbox");
      await act(async () => root.render(createElement(SettingsModal)));
      const search = host.querySelector<HTMLInputElement>('input[placeholder="Search settings…"]')!;
      await act(async () => changeInput(search, "tasks folder"));
      expect(folderRowText()).toContain("New task files go to `inbox/Tasks/`.");
      expect(folderRowText()).not.toContain("Vault-relative");

      mocks.state.vaultSettings = withTasksFolder("root");
      await act(async () => root.render(createElement(SettingsModal)));
      expect(folderRowText()).toContain("New task files go to `Tasks/`.");
    } finally {
      mocks.state.vaultSettings = original;
    }
  });

  /** Renders once with every gate a row can sit behind switched on (Vim mode,
   *  Typst, Harper, undofile, remote workspaces, periodic notes, the folder
   *  modes) and returns the categories the modal handed to search. */
  async function renderEveryRow(): Promise<BuiltSettingsCategory[]> {
    mocks.state.vimMode = true;
    mocks.state.mathRenderer = "typst";
    mocks.state.vaultSettings = {
      ...defaultVaultSettings,
      dailyNotes: { ...defaultVaultSettings.dailyNotes, enabled: true },
      weeklyNotes: { ...defaultVaultSettings.weeklyNotes, enabled: true },
      monthlyNotes: { ...defaultVaultSettings.monthlyNotes, enabled: true },
      drawingsLocation: { mode: "folder", folder: "Drawings" },
      databasesLocation: { mode: "folder", folder: "Databases" },
      tasksLocation: { mode: "folder", folder: "Tasks" },
    } as typeof defaultVaultSettings;
    mocks.capabilities = {
      supportsRemoteWorkspace: true,
      supportsUndoFile: true,
      supportsCustomCodeLanguages: true,
    };
    Object.assign(window.zen, {
      getCapabilities: () => ({ supportsHarper: true }),
    });
    await act(async () => root.render(createElement(SettingsModal)));
    return vi.mocked(getSettingsSearchResults).mock
      .lastCall![0] as BuiltSettingsCategory[];
  }

  /** Types a query, opens the result with this title, and returns the row the
   *  jump highlighted once the two frames it waits for have run. */
  async function openSearchHit(
    query: string,
    title: string,
  ): Promise<string | undefined> {
    const search = host.querySelector<HTMLInputElement>('input[placeholder="Search settings…"]')!;
    await act(async () => changeInput(search, query));
    const result = [...host.querySelectorAll<HTMLButtonElement>("aside nav button")].find(
      (button) => button.textContent?.includes(title),
    );
    expect(result, `${query} → ${title}`).toBeTruthy();
    await act(async () => result!.click());
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    return host.querySelector<HTMLElement>('[data-settings-search-highlight="true"]')
      ?.dataset.settingsSearchId;
  }

  it("gives every settings row a search item, so Settings search can find it", async () => {
    const findable = searchItemTargets(await renderEveryRow());
    // Not `new URL(…, import.meta.url)`: in a jsdom test Vite rewrites that
    // into a dev-server asset URL, which readFileSync cannot open.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "SettingsModal.tsx"),
      "utf8",
    );
    const rows = new Set(
      [
        ...source.matchAll(
          /(?:settingId=|settingsSearchTargetProps\(|data-settings-search-id=)"([^"]+)"/g,
        ),
      ].map((match) => match[1]),
    );
    // A scan that stopped matching the file would pass on nothing.
    expect(rows.size).toBeGreaterThan(100);
    const unfindable = [...rows].filter(
      (id) => !findable.has(id) && !REACHED_THROUGH_LOCATION_ROW.has(id),
    );
    expect(unfindable).toEqual([]);
  });

  it("lists every row in the searchIds of the sub-tab that renders it", async () => {
    // Walks the JSX each pane is built from rather than the source, so rows
    // named by an expression (`${key}-path`) count too.
    const problems: string[] = [];
    for (const category of await renderEveryRow()) {
      const findable = searchItemTargets([category]);
      const panes = category.subTabs ?? [
        { id: category.id, content: category.content },
      ];
      for (const pane of panes) {
        const rendered = searchTargetsIn(pane.content).filter(
          (id) => !REACHED_THROUGH_LOCATION_ROW.has(id),
        );
        for (const id of rendered) {
          if (!findable.has(id)) {
            problems.push(`${category.id}: no search item for ${id}`);
          }
          if (category.subTabs && !pane.searchIds?.includes(id)) {
            problems.push(`${category.id}/${pane.id}: searchIds is missing ${id}`);
          }
        }
        for (const id of pane.searchIds ?? []) {
          if (!rendered.includes(id)) {
            problems.push(`${category.id}/${pane.id}: searchIds lists ${id}, which it does not render`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("finds each row by the words people search for and lands on it", async () => {
    mocks.state.vimMode = true;
    await act(async () => root.render(createElement(SettingsModal)));
    const cases = [
      ["pdf theme", "Use theme for PDF export", "pdf-export-use-theme"],
      ["clipboard", "Sync clipboard with Vim registers", "vim-yank-to-clipboard"],
      ["korean", "Keep the input method out of normal mode", "vim-block-ime-in-normal-mode"],
      ["strikethrough", "Completed task style", "completed-task-style"],
      ["open in preview", "Default view mode", "default-view-mode"],
      ["event triggers", "Event triggers", "workflow-event-triggers"],
      ["due date", "Tasks are due on the note's date", "daily-notes-tasks-due-on-date"],
      ["rollover", "Roll over unfinished tasks to today", "daily-notes-rollover"],
      ["tutorial", "Guided tutorial", "workflow-tutorial"],
      ["recipe gallery", "Built-in recipes", "workflow-hidden-recipes"],
      ["trash folder", "Trash path", "trash-path"],
      ["quick notes folder", "Quick Notes path", "quick-path"],
      ["math renderer", "Math renderer", "math-renderer"],
      ["quick note prefix", "Quick Note prefix", "quick-note-prefix"],
    ] as const;
    for (const [query, title, settingId] of cases) {
      expect(await openSearchHit(query, title), query).toBe(settingId);
    }
  });

  it("lands on the switch that reveals a row while that row is hidden", async () => {
    mocks.state.vimMode = false;
    mocks.state.vaultSettings = {
      ...defaultVaultSettings,
      dailyNotes: { ...defaultVaultSettings.dailyNotes, enabled: false },
    };
    await act(async () => root.render(createElement(SettingsModal)));
    const cases = [
      ["clipboard", "Sync clipboard with Vim registers", "vim-mode"],
      ["korean", "Keep the input method out of normal mode", "vim-mode"],
      ["due date", "Tasks are due on the note's date", "enable-daily-notes"],
      ["rollover", "Roll over unfinished tasks to today", "enable-daily-notes"],
    ] as const;
    for (const [query, title, settingId] of cases) {
      expect(await openSearchHit(query, title), query).toBe(settingId);
    }
  });

  it("does not offer native title bar settings in the web app", async () => {
    mocks.runtime = "web";
    await act(async () => root.render(createElement(SettingsModal)));
    expect(host.querySelector('[data-settings-search-id="window-title-bar"]')).toBeNull();
  });

  it("rejects reserved prefixes with a visible explanation", async () => {
    requestSettingsTarget("external-links");
    await act(async () => root.render(createElement(SettingsModal)));
    const input = host.querySelector<HTMLInputElement>('input[placeholder="zotero, obsidian, vscode"]')!;
    await act(async () => changeInput(input, "javascript"));
    await act(async () => blurInput(input));
    expect(mocks.state.setExternalApplicationSchemes).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not an available application prefix');
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
