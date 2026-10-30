// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteContent } from "@shared/ipc";
import type { PaneLeaf } from "../lib/pane-layout";
import type { PaneMode } from "../lib/pane-mode";
import { useStore } from "../store";
import { EditorPane } from "./EditorPane";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const note: NoteContent = {
  path: "inbox/Today.md",
  title: "Today",
  folder: "inbox",
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 11,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: "Hello there",
  body: "Hello there",
};

const pane: PaneLeaf = {
  kind: "leaf",
  id: "pane-1",
  tabs: [note.path],
  pinnedTabs: [],
  activeTab: note.path,
};

describe("EditorPane header tooltips (#1020)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalStore: ReturnType<typeof useStore.getState>;

  beforeEach(() => {
    // jsdom has no layout; CodeMirror still measures.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    for (const method of ["scrollIntoView", "scrollTo"] as const) {
      Object.defineProperty(HTMLElement.prototype, method, {
        configurable: true,
        value: () => {},
      });
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        matches: false,
        media,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }),
    });
    // Anything the pane asks the host for on mount answers "nothing".
    (window as unknown as { zen: unknown }).zen = new Proxy(
      {
        getCapabilities: () => ({ supportsCloudSync: true }),
        getAppInfo: () => ({ runtime: "desktop" }),
      } as Record<string, unknown>,
      {
        get: (target, key: string) => target[key] ?? (async () => undefined),
      },
    );
    originalStore = useStore.getState();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState(originalStore, true);
    delete (window as unknown as { zen?: unknown }).zen;
  });

  async function mountIn(mode: PaneMode, open: NoteContent = note): Promise<void> {
    const leaf: PaneLeaf = { ...pane, tabs: [open.path], activeTab: open.path };
    useStore.setState({
      vault: { root: "/vault", name: "Vault" },
      activePaneId: leaf.id,
      noteContents: { [open.path]: open },
      noteDirty: {},
      paneModes: { [leaf.id]: { [open.path]: mode } },
      vimMode: false,
      keymapOverrides: {},
    });
    await act(async () => root.render(createElement(EditorPane, { pane: leaf })));
  }

  // The header's last button sits at the pane's right edge. A tooltip centred
  // under it ran past the window and was cut off ("Move to tras"), so it is
  // anchored to the button's right edge instead, as the leftmost buttons are
  // anchored to their left edge.
  const tooltipOf = (label: string): HTMLElement => {
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    const tip = [...button!.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === label,
    );
    expect(tip, `${label} tooltip`).toBeDefined();
    return tip!;
  };

  it("anchors the last button's tooltip to its right edge", async () => {
    await mountIn("edit");
    const tip = tooltipOf("Move to trash");
    expect(tip.className).toContain("right-0");
    expect(tip.className).not.toContain("-translate-x-1/2");
    // The buttons before it keep their centred tooltips.
    expect(tooltipOf("Archive").className).toContain("-translate-x-1/2");
  });

  it("does the same for Delete permanently on a note in the Trash", async () => {
    const trashed = { ...note, folder: "trash" as const, path: "trash/Today.md" };
    useStore.setState({ noteContents: { [trashed.path]: trashed } });
    await mountIn("edit", trashed);
    const tip = tooltipOf("Delete permanently");
    expect(tip.className).toContain("right-0");
    expect(tip.className).not.toContain("-translate-x-1/2");
  });
});
