// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteMeta } from "@shared/ipc";
import { setHoveredLink, useHoveredLinkStore } from "../lib/hovered-link";
import { useStore } from "../store";
import { Preview } from "./Preview";

const navMocks = vi.hoisted(() => ({
  openWikilinkTarget: vi.fn(async () => true),
}));

vi.mock("../lib/wikilink-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/wikilink-navigation")>()),
  openWikilinkTarget: navMocks.openWikilinkTarget,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const alphaPlan = {
  path: "Alpha plan.md",
  title: "Alpha plan",
  folder: "inbox",
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 0,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: "",
} as NoteMeta;

/** The preview attaches its DOM after an async render pass; wait for the link. */
async function renderedWikilink(host: HTMLElement): Promise<HTMLAnchorElement> {
  for (let i = 0; i < 50; i++) {
    const anchor = host.querySelector<HTMLAnchorElement>("a.wikilink");
    if (anchor) return anchor;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("preview never rendered the wikilink");
}

describe("Preview status-bar link hover", () => {
  beforeEach(() => {
    navMocks.openWikilinkTarget.mockClear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    Object.defineProperty(window, "zen", {
      configurable: true,
      value: {
        getAppInfo: () => ({ runtime: "web" }),
        // The hover card the mousemove opens reads the target note.
        readNote: async () => ({ ...alphaPlan, body: "# Milestones" }),
      },
    });
    useStore.setState({ notes: [alphaPlan] });
    setHoveredLink(null);
  });

  afterEach(() => {
    delete (window as unknown as { zen?: unknown }).zen;
  });

  it("clears the hovered target when the wikilink is followed (#820)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(Preview, {
            markdown: "Go to [[Alpha plan#Milestones]] first.",
            notePath: "Beta.md",
          }),
        ),
      );
      const anchor = await renderedWikilink(host);
      expect(anchor.dataset.resolvedPath).toBe("Alpha plan.md");

      // A tap on a touch screen: the browser synthesizes mousemove and click
      // on the link, and no mouseleave ever follows.
      act(() => {
        anchor.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      expect(useHoveredLinkStore.getState().href).toBe("Alpha plan#Milestones");

      act(() => {
        anchor.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      expect(navMocks.openWikilinkTarget).toHaveBeenCalledWith(
        "Alpha plan.md",
        "Alpha plan#Milestones",
      );
      expect(useHoveredLinkStore.getState().href).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
