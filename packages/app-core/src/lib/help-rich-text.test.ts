// @vitest-environment jsdom

import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { HELP_HOW_TO_GUIDES, helpForHost, helpText } from "./help";
import { helpSearchText, renderHelpRichText } from "./help-rich-text";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function rendered(node: ReactNode): HTMLDivElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(Fragment, null, node)));
  return host;
}

const paragraphs = (host: HTMLElement) =>
  [...host.children].filter((child) => child.matches("span.block"));

/** Every string the manual holds, whatever field it sits in. */
function manualStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(manualStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(manualStrings);
  return [];
}

describe("the manual's rich text", () => {
  it("renders **bold** as strong text, keeping the words and dropping the markers", () => {
    const host = rendered(renderHelpRichText(
      "In the desktop app, **Save archive** under Backups saves a readable archive.",
      "text-sm",
    ));
    expect(host.querySelector("strong")?.textContent).toBe("Save archive");
    expect(host.textContent).toBe(
      "In the desktop app, Save archive under Backups saves a readable archive.",
    );
  });

  it("starts a paragraph at a blank line, and leaves a single paragraph inline as before", () => {
    const two = rendered(renderHelpRichText("First, with **bold**.\n\nSecond.", "text-sm"));
    expect(paragraphs(two).map((p) => p.textContent)).toEqual(["First, with bold.", "Second."]);

    const one = rendered(renderHelpRichText("Just one, with `code`.", "text-sm"));
    expect(paragraphs(one)).toEqual([]);
    expect(one.textContent).toBe("Just one, with code.");
  });

  it("keeps code literal: short spans inline, long or multi-line ones as a block", () => {
    const host = rendered(renderHelpRichText(
      "Match `inbox/**/*.md` or `**not bold**`, then start it:\n`docker run -d \\\n  -e TOKEN=1 \\\n  image`\nand open it.",
      "text-sm",
    ));
    const code = [...host.querySelectorAll("code")];
    expect(code.map((c) => c.textContent)).toEqual([
      "inbox/**/*.md",
      "**not bold**",
      "docker run -d \\\n  -e TOKEN=1 \\\n  image",
    ]);
    expect(code.map((c) => c.classList.contains("block"))).toEqual([false, false, true]);
    expect(host.querySelector("strong")).toBeNull();
    // Single newlines around a code block are not paragraph breaks.
    expect(paragraphs(host)).toEqual([]);
  });

  it("gives a code span between blank lines a paragraph of its own", () => {
    const host = rendered(renderHelpRichText("Run this:\n\n`npm run build`\n\nThen open it.", "text-sm"));
    expect(paragraphs(host).map((p) => p.textContent)).toEqual([
      "Run this:",
      "npm run build",
      "Then open it.",
    ]);
  });

  it("leaves the manual's wikilink, tag and link examples as typed", () => {
    const text = "Type [[ to link, add #task to a note, or write [Paper](zotero://open-pdf/library/items/X).";
    const host = rendered(renderHelpRichText(text, "text-sm"));
    expect(host.textContent).toBe(text);
    expect(host.querySelector("a, strong, code")).toBeNull();
  });

  it("shows no bold markers anywhere in the manual outside code", () => {
    // As each host reads it: a host-gated part must not cut a span in two.
    const strings = manualStrings([
      helpForHost({ runtime: "desktop", hostKind: "desktop" }),
      helpForHost({ runtime: "web", hostKind: "browser", supportsWorkflows: true }),
      helpForHost({ runtime: "web", hostKind: "ios" }),
    ]);
    expect(strings.some((text) => text.includes("**"))).toBe(true);
    for (const text of strings) {
      const host = rendered(renderHelpRichText(text, "text-sm"));
      host.querySelectorAll("code").forEach((code) => code.remove());
      expect(host.textContent, text.slice(0, 80)).not.toContain("**");
    }
  });

  it("renders the encryption guide as two paragraphs with its four control names in bold", () => {
    const guide = HELP_HOW_TO_GUIDES.find((card) => card.title === "Encrypt a Cloud vault end to end")!;
    const host = rendered(renderHelpRichText(helpText(guide.body, { runtime: "desktop" }), "text-sm"));
    expect(paragraphs(host)).toHaveLength(2);
    expect([...host.querySelectorAll("strong")].map((s) => s.textContent)).toEqual([
      "End-to-end encryption",
      "End-to-end encrypt this vault",
      "Encrypt this vault",
      "Save archive",
    ]);
  });

  it("searches what the reader sees", () => {
    expect(helpSearchText("In the desktop app, **Save archive** under Backups")).toBe(
      "In the desktop app, Save archive under Backups",
    );
    expect(helpSearchText("Match `inbox/**/*.md` with a glob")).toBe("Match inbox/**/*.md with a glob");
    expect(helpSearchText("First.\n\nSecond.")).toBe("First. Second.");
  });
});
