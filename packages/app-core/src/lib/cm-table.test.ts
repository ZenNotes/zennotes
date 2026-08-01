// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vim, getCM, Vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import {
  renderInlineCell,
  tableBlockAt,
  tablePlugin,
  tableVimEntry,
  tableSelectionHighlight,
  focusFirstTableCell,
  nextWordStart,
  prevWordStart,
  nextWordEnd,
  textObjectRange,
  findChar,
} from "./cm-table";
import { closeTableContextMenu } from "./cm-table-menu";
import { useStore } from "../store";

const TABLE_DOC = `Intro text.

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

Outro text.`;

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        history(),
        tablePlugin,
      ],
    }),
  });
  // Ensure the GFM table node is parsed, then nudge the field to rebuild.
  forceParsing(view, doc.length, 5000);
  view.dispatch({ changes: { from: 0, insert: " " } });
  view.dispatch({ changes: { from: 0, to: 1 } });
  return view;
}

describe("tablePlugin", () => {
  it("renders a GFM table as an editable table widget without throwing", () => {
    const view = mount(TABLE_DOC);
    const widget = view.dom.querySelector(".cm-table-widget");
    expect(widget).toBeTruthy();
    const cells = widget?.querySelectorAll(".cm-table-cell") ?? [];
    // 2 header + 4 body cells.
    expect(cells.length).toBe(6);
    expect(view.dom.textContent).toContain("Alice");
    expect(view.dom.textContent).toContain("Age");
    // One row grip per body row (2), one column grip per column (2).
    expect(widget?.querySelectorAll(".cm-table-row-handle").length).toBe(2);
    expect(widget?.querySelectorAll(".cm-table-col-handle").length).toBe(2);
    view.destroy();
  });

  it("renders a plain doc with no table widget", () => {
    const view = mount("Just a paragraph, no table here.");
    expect(view.dom.querySelector(".cm-table-widget")).toBeNull();
    view.destroy();
  });

  // Vim mode defaults on (DEFAULT_PREFS.vimMode), so cells start in NORMAL mode.
  it("swallows vim normal-mode motion/printable keys inside a cell", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    // h/j/k/l are consumed as motions, not typed.
    for (const key of ["h", "j", "k", "l"]) {
      const ev = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    // A stray printable key is swallowed too (won't corrupt the cell text).
    const xEv = new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(xEv);
    expect(xEv.defaultPrevented).toBe(true);
    view.destroy();
  });

  // #232: arrow keys used to fall through to CodeMirror and scroll the page;
  // they should navigate the cell like h/j/k/l (consumed, not propagated).
  it("consumes arrow keys inside a cell instead of scrolling the page (#232)", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
      const ev = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    view.destroy();
  });

  // #213: directional cell navigation honors the configurable nav keymaps.
  it("honors a remapped nav key (nav.moveDown → n) inside a cell", () => {
    const view = mount(TABLE_DOC);
    const prev = useStore.getState().keymapOverrides;
    useStore.setState({ keymapOverrides: { ...prev, "nav.moveDown": "n" } });
    try {
      const start = view.dom.querySelector<HTMLElement>(
        '.cm-table-widget [data-row="0"][data-col="0"]',
      )!;
      start.focus();
      const ev = new KeyboardEvent("keydown", {
        key: "n",
        bubbles: true,
        cancelable: true,
      });
      start.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      // The remapped key moved the focus down a row, like `j` would by default.
      const below = view.dom.querySelector(
        '.cm-table-widget [data-row="1"][data-col="0"]',
      );
      expect(document.activeElement).toBe(below);
    } finally {
      useStore.setState({ keymapOverrides: prev });
    }
    view.destroy();
  });

  it("enters insert mode on `i`, revealing the raw cell source", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    expect(cell.dataset.rendered).toBe("true");
    // NORMAL cells are non-editable (no caret); editing turns it on.
    expect(cell.getAttribute("contenteditable")).toBe("false");
    const iEv = new KeyboardEvent("keydown", {
      key: "i",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(iEv);
    expect(iEv.defaultPrevented).toBe(true);
    // Now editing: cell is editable, shows raw markdown, accepts typed chars.
    expect(cell.getAttribute("contenteditable")).toBe("true");
    expect(cell.dataset.rendered).toBe("false");
    const xEv = new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(xEv);
    expect(xEv.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("opens the keyboard-navigable action menu on `m`", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    const mEv = new KeyboardEvent("keydown", {
      key: "m",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(mEv);
    expect(mEv.defaultPrevented).toBe(true);
    const menu = document.querySelector(".cm-table-menu");
    expect(menu).toBeTruthy();
    // The full Obsidian-style action set (add/move/dup/delete/align/sort).
    expect(
      menu!.querySelectorAll(".cm-table-menu-item").length,
    ).toBeGreaterThan(10);
    closeTableContextMenu();
    view.destroy();
  });

  it("supports x / dd / D editing operators in a cell", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    expect(cell.dataset.raw).toBe("Alice");
    // x deletes the char under the cursor (offset 0).
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.raw).toBe("lice");
    // D deletes to end of cell.
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "D",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.raw).toBe("");
    view.destroy();
  });

  it("supports char-wise visual mode: v + motion + d deletes the selection", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    expect(cell.dataset.raw).toBe("Alice");
    // v (anchor at 0) → l (extend to 1) → d (delete [0,2) = "Al").
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        bubbles: true,
        cancelable: true,
      }),
    );
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        bubbles: true,
        cancelable: true,
      }),
    );
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.raw).toBe("ice");
    view.destroy();
  });

  it("u commits the pending cell edit and undoes it", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.raw).toBe("lice");
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "u",
        bubbles: true,
        cancelable: true,
      }),
    );
    // The committed edit is undone — the source table is back to "Alice".
    expect(view.state.doc.toString()).toContain("| Alice |");
    view.destroy();
  });

  it("diw deletes the inner word (operator + text object)", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    expect(cell.dataset.raw).toBe("Alice");
    for (const key of ["d", "i", "w"]) {
      cell.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    }
    expect(cell.dataset.raw).toBe("");
    view.destroy();
  });

  it("Esc in a normal-mode cell is a no-op (stays put, no jump below)", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    const ev = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // Cell content untouched; widget still present (didn't tear down / jump out).
    expect(cell.dataset.raw).toBe("Alice");
    expect(view.dom.querySelector(".cm-table-widget")).toBeTruthy();
    view.destroy();
  });

  it("supports the dd operator (clear cell) via operator-pending", () => {
    const view = mount(TABLE_DOC);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="1"][data-col="0"]',
    )!;
    expect(cell.dataset.raw).toBe("Bob");
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        bubbles: true,
        cancelable: true,
      }),
    );
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.raw).toBe("");
    view.destroy();
  });
});

describe("vim word motions (cell cursor)", () => {
  const t = "foo bar baz";
  it("w moves to the next word start", () => {
    expect(nextWordStart(t, 0)).toBe(4);
    expect(nextWordStart(t, 4)).toBe(8);
    expect(nextWordStart(t, 8)).toBe(t.length - 1); // clamps at the last word
  });
  it("b moves to the previous word start", () => {
    expect(prevWordStart(t, 8)).toBe(4);
    expect(prevWordStart(t, 4)).toBe(0);
    expect(prevWordStart(t, 0)).toBe(0);
  });
  it("e moves to the next word end", () => {
    expect(nextWordEnd(t, 0)).toBe(2);
    expect(nextWordEnd(t, 2)).toBe(6);
  });
  it("treats punctuation as its own word", () => {
    // "a, b" → a(0) ,(1) space(2) b(3)
    expect(nextWordStart("a, b", 0)).toBe(1); // 'a' → ','
    expect(nextWordStart("a, b", 1)).toBe(3); // ',' → 'b'
  });
});

describe("vim find-char (f / t / F / T, cell cursor)", () => {
  const t = "Engineer"; // E n g i n e e r  (indices 0..7)
  it("f finds the next occurrence forward", () => {
    expect(findChar(t, 0, "n", 1, false)).toBe(1);
    expect(findChar(t, 1, "n", 1, false)).toBe(4); // skips the current char
    expect(findChar(t, 0, "r", 1, false)).toBe(7);
  });
  it("t stops one char before the target (forward)", () => {
    expect(findChar(t, 0, "e", 1, true)).toBe(4); // 'e' at 5 → 4
  });
  it("F finds the next occurrence backward", () => {
    expect(findChar(t, 7, "n", -1, false)).toBe(4);
    expect(findChar(t, 7, "E", -1, false)).toBe(0);
  });
  it("T stops one char after the target (backward)", () => {
    expect(findChar(t, 7, "g", -1, true)).toBe(3); // 'g' at 2 → 3
  });
  it("returns null when the char is not found", () => {
    expect(findChar(t, 0, "z", 1, false)).toBeNull();
    expect(findChar(t, 7, "z", -1, false)).toBeNull();
  });
});

describe("text objects (vi / va, di / ca)", () => {
  it("iw / aw select the word (a includes trailing space)", () => {
    const t = "foo bar baz";
    expect(textObjectRange(t, 5, "i", "w")).toEqual({ from: 4, to: 7 }); // "bar"
    expect(textObjectRange(t, 5, "a", "w")).toEqual({ from: 4, to: 8 }); // "bar "
  });
  it('i" / a" select inside / around quotes', () => {
    const t = 'say "hi" now';
    expect(textObjectRange(t, 5, "i", '"')).toEqual({ from: 5, to: 7 }); // hi
    expect(textObjectRange(t, 5, "a", '"')).toEqual({ from: 4, to: 8 }); // "hi"
  });
  it("i( / a) select inside / around brackets", () => {
    const t = "f(x, y)";
    expect(textObjectRange(t, 3, "i", "(")).toEqual({ from: 2, to: 6 }); // x, y
    expect(textObjectRange(t, 3, "a", ")")).toEqual({ from: 1, to: 7 }); // (x, y)
  });
  it("returns null when the object is absent", () => {
    expect(textObjectRange("plain", 0, "i", '"')).toBeNull();
  });
});

describe("tablePlugin — column widths (#294)", () => {
  const WIDTH_DOC = `Intro.

| Name | Age |
| --- | --- |
| Alice | 30 |
<!-- zen:cols=120,200 -->`;

  const PLAIN_DOC = `Intro.

| A | B |
| --- | --- |
| 1 | 2 |`;

  it("renders persisted widths as a <colgroup> and swallows the marker", () => {
    const view = mount(WIDTH_DOC);
    const widget = view.dom.querySelector(".cm-table-widget")!;
    expect(widget).toBeTruthy();
    const cols = widget.querySelectorAll("col");
    expect(cols.length).toBe(2);
    expect((cols[0] as HTMLElement).style.width).toBe("120px");
    expect((cols[1] as HTMLElement).style.width).toBe("200px");
    expect(
      widget.querySelector("table")?.classList.contains("cm-table-fixed"),
    ).toBe(true);
    // The raw marker is inside the widget's atomic range — never visible text.
    expect(view.dom.textContent ?? "").not.toContain("zen:cols");
    view.destroy();
  });

  it("a table with no marker renders a colgroup but no fixed widths", () => {
    const view = mount(PLAIN_DOC);
    const widget = view.dom.querySelector(".cm-table-widget")!;
    const cols = widget.querySelectorAll("col");
    expect(cols.length).toBe(2);
    expect((cols[0] as HTMLElement).style.width).toBe("");
    expect(
      widget.querySelector("table")?.classList.contains("cm-table-fixed"),
    ).toBe(false);
    view.destroy();
  });

  const drag = (view: EditorView, from: number, to: number): void => {
    const handle = view.dom.querySelector<HTMLElement>(".cm-table-col-resize");
    if (!handle) throw new Error("no resize handle");
    handle.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: from,
        bubbles: true,
        cancelable: true,
      }),
    );
    handle.dispatchEvent(
      new MouseEvent("pointermove", { clientX: to, bubbles: true }),
    );
    handle.dispatchEvent(
      new MouseEvent("pointerup", { clientX: to, bubbles: true }),
    );
  };

  it("dragging a column resize grip persists a zen:cols marker in the source", () => {
    const view = mount(PLAIN_DOC);
    drag(view, 100, 180);
    expect(view.state.doc.toString()).toContain("<!-- zen:cols=");
    view.destroy();
  });

  it("re-resizing replaces the marker — never duplicates it", () => {
    const view = mount(PLAIN_DOC);
    drag(view, 100, 180);
    drag(view, 100, 140);
    const markers = view.state.doc.toString().match(/zen:cols/g) ?? [];
    expect(markers.length).toBe(1);
    view.destroy();
  });
});

describe("table cell link following (#445)", () => {
  const saved = {
    notes: useStore.getState().notes,
    selectNote: useStore.getState().selectNote,
    selectedPath: useStore.getState().selectedPath,
    vimMode: useStore.getState().vimMode,
  };
  afterEach(() => {
    useStore.setState(saved);
    vi.restoreAllMocks();
  });

  function setup(vimMode: boolean): ReturnType<typeof vi.fn> {
    const selectNote = vi.fn(async () => { });
    useStore.setState({
      vimMode,
      selectedPath: "Doc.md",
      // Minimal note refs the resolvers need (title + folder + path).
      notes: [
        { path: "Target-Note.md", title: "Target-Note", folder: "inbox" },
      ],
      selectNote,
    } as never);
    return selectNote;
  }

  const WIKILINK_DOC = "| A | B |\n| --- | --- |\n| x | [[Target-Note]] |";
  const MDLINK_DOC = "| A | B |\n| --- | --- |\n| x | [go](Target-Note.md) |";

  it("follows a [[wikilink]] in a cell on plain click instead of revealing raw source", () => {
    const selectNote = setup(false);
    const view = mount(WIKILINK_DOC);
    const anchor = view.dom.querySelector<HTMLAnchorElement>(
      ".cm-table-cell a.wikilink",
    );
    expect(anchor).toBeTruthy();
    expect(anchor?.dataset.wikilink).toBe("Target-Note");
    anchor?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(selectNote).toHaveBeenCalledWith("Target-Note.md");
    view.destroy();
  });

  it("follows a [text](Note.md) link in a cell on Cmd/Ctrl-click", () => {
    const selectNote = setup(false);
    const view = mount(MDLINK_DOC);
    const anchor = view.dom.querySelector<HTMLAnchorElement>(
      '.cm-table-cell a[href="Target-Note.md"]',
    );
    expect(anchor).toBeTruthy();
    anchor?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, metaKey: true }),
    );
    expect(selectNote).toHaveBeenCalledWith("Target-Note.md");
    view.destroy();
  });

  it("follows the link under the cursor on `gd` in a cell (Vim)", () => {
    const selectNote = setup(true);
    const view = mount(WIKILINK_DOC);
    const cell = [
      ...view.dom.querySelectorAll<HTMLElement>(".cm-table-cell"),
    ].find((c) => c.dataset.raw === "[[Target-Note]]");
    expect(cell).toBeTruthy();
    cell?.focus(); // Vim: enter NORMAL mode in the cell (cursor at offset 0)
    cell?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "g", bubbles: true }),
    );
    cell?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "d", bubbles: true }),
    );
    expect(selectNote).toHaveBeenCalledWith("Target-Note.md");
    view.destroy();
  });
});

describe("tableBlockAt — the fallback when the parse has not caught up (#485)", () => {
  const doc = (text: string) => Text.of(text.split("\n"));

  it("finds the table around a position, header row to last row", () => {
    const text = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter";
    const t = doc(text);
    const inside = text.indexOf("| 1 | 2 |") + 2;
    const range = tableBlockAt(t, inside);
    expect(range).not.toBeNull();
    expect(text.slice(range!.from, range!.to)).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("takes the trailing zen:cols marker with it, like the tree path does", () => {
    const text =
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n<!-- zen:cols=273,227 -->\ntail";
    const t = doc(text);
    const range = tableBlockAt(t, 3);
    expect(text.slice(range!.from, range!.to)).toContain("zen:cols=273,227");
  });

  it("refuses a lone pipe line — that is prose, not a table", () => {
    const t = doc("a | b is not a table\n| stray |\nplain");
    expect(tableBlockAt(t, t.line(2).from + 2)).toBeNull();
  });

  it("returns null off the table", () => {
    const t = doc("prose here\n\n| A |\n| --- |");
    expect(tableBlockAt(t, 2)).toBeNull();
  });

  it("handles a table at the very start and end of the document", () => {
    const text = "| A | B |\n| --- | --- |";
    const t = doc(text);
    const range = tableBlockAt(t, 0);
    expect(range).toEqual({ from: 0, to: text.length });
  });
});

describe("renderInlineCell", () => {
  // A cell is inline content, so a leading block marker is just a character.
  // These all rendered as empty blocks before, losing the text outright. (#559)
  it("keeps a cell that is only a list marker visible", () => {
    expect(renderInlineCell("-")).toBe("-");
    expect(renderInlineCell("+")).toBe("+");
    expect(renderInlineCell("*")).toBe("*");
  });

  it("keeps the other block markers literal too", () => {
    expect(renderInlineCell("#")).toBe("#");
    expect(renderInlineCell("1.")).toBe("1.");
    expect(renderInlineCell("---")).toBe("---");
    expect(renderInlineCell("# H")).toBe("# H");
    expect(renderInlineCell("- x")).toBe("- x");
    expect(renderInlineCell("> q")).toBe("&gt; q");
  });

  it("still renders inline markup", () => {
    expect(renderInlineCell("**b**")).toBe("<strong>b</strong>");
    expect(renderInlineCell("`c`")).toBe("<code>c</code>");
    expect(renderInlineCell("[[note]]")).toContain('class="wikilink"');
    expect(renderInlineCell("#tag")).toContain('class="hashtag"');
  });

  it("renders a literal pipe rather than splitting the synthetic row", () => {
    expect(renderInlineCell("a | b")).toBe("a | b");
  });

  it("renders nothing for an empty cell", () => {
    expect(renderInlineCell("")).toBe("");
    expect(renderInlineCell("   ")).toBe("");
  });

  it("flattens a pasted newline instead of breaking out of the cell", () => {
    expect(renderInlineCell("a\nb")).toBe("a b");
  });
});

describe("table cell inline-mark shortcuts (Mod-b / Mod-i / Mod-e / Mod-Shift-x)", () => {
  // The editor's `markdownKeymap` can't reach inside the atomic table widget, so
  // the cell handles the chords itself. See `toggleInline` in cm-table.ts.
  const saved = {
    vimMode: useStore.getState().vimMode,
  };
  afterEach(() => {
    useStore.setState({ vimMode: saved.vimMode });
    vi.restoreAllMocks();
  });

  /** Select [from, to) within a cell's text node (the raw source shown while
   *  editing). `from === to` collapses the caret there. */
  function selectIn(el: HTMLElement, from: number, to = from): void {
    const node = el.firstChild;
    const range = document.createRange();
    if (node && node.nodeType === Node.TEXT_NODE) {
      const max = node.textContent?.length ?? 0;
      range.setStart(node, Math.max(0, Math.min(from, max)));
      range.setEnd(node, Math.max(0, Math.min(Math.max(from, to), max)));
    } else {
      range.selectNodeContents(el);
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  const mod = (key: string, shift = false): KeyboardEvent =>
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      metaKey: true,
      shiftKey: shift,
    });

  it("wraps a selection in **bold** (Mod-b) and commits to dataset.raw", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| hello | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    // Focus revealed the raw source "hello"; select "ell".
    selectIn(cell, 1, 4);
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("h**ell**o");
    view.destroy();
  });

  it("wraps the word under a collapsed caret when nothing is selected", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| hello | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    selectIn(cell, 2); // inside "hello"
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("**hello**");
    view.destroy();
  });

  it("unwraps an already-marked selection (true toggle)", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| a**bc**d | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    // Source is "a**bc**d"; select the inner "bc" (offsets 3..5).
    selectIn(cell, 3, 5);
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("abcd");
    view.destroy();
  });

  it("toggles bold OFF from a collapsed caret inside a marked word", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| **hello** | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    // Caret on a letter inside **hello** (offset 4 = 'l').
    selectIn(cell, 4);
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("hello");
    view.destroy();
  });

  it("toggles OFF when the whole marked span is selected (incl. markers)", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| **hello** | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    // Select-all: the markers are inside the selection, so before/after see
    // nothing — the unwrap must come from detecting the inner word instead.
    selectIn(cell, 0, 9);
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("hello");
    view.destroy();
  });

  it("covers italic (*), code (`) and strikethrough (~~)", () => {
    useStore.setState({ vimMode: false });
    const cases: Array<{
      key: string;
      shift: boolean;
      raw: string;
      want: string;
    }> = [
        { key: "i", shift: false, raw: "word", want: "*word*" },
        { key: "e", shift: false, raw: "word", want: "`word`" },
        { key: "x", shift: true, raw: "word", want: "~~word~~" },
      ];
    for (const c of cases) {
      const view = mount(`| A |\n| --- |\n| ${c.raw} |`);
      const cell = view.dom.querySelector<HTMLElement>(
        '.cm-table-widget [data-row="0"][data-col="0"]',
      )!;
      cell.focus();
      selectIn(cell, 0, c.raw.length);
      cell.dispatchEvent(mod(c.key, c.shift));
      expect(cell.dataset.raw).toBe(c.want);
      view.destroy();
    }
  });

  it("inserts empty markers with the caret between them on an empty cell", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A |\n| --- |\n|  |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("****");
    view.destroy();
  });

  it("works in Vim INSERT mode (after pressing `i`)", () => {
    useStore.setState({ vimMode: true });
    const view = mount("| A | B |\n| --- | --- |\n| hello | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus(); // NORMAL mode
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "i",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(cell.dataset.rendered).toBe("false");
    selectIn(cell, 0, 5);
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("**hello**");
    view.destroy();
  });

  it("does not add markers in Vim NORMAL mode (the cell is not editable)", () => {
    useStore.setState({ vimMode: true });
    const view = mount("| A | B |\n| --- | --- |\n| hello | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus(); // NORMAL mode — not editable
    cell.dispatchEvent(mod("b"));
    expect(cell.dataset.raw).toBe("hello");
    view.destroy();
  });

  it("ignores Alt-modified combos so it never clobbers other chords", () => {
    useStore.setState({ vimMode: false });
    const view = mount("| A | B |\n| --- | --- |\n| hello | x |");
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="0"][data-col="0"]',
    )!;
    cell.focus();
    selectIn(cell, 0, 5);
    const ev = new KeyboardEvent("keydown", {
      key: "b",
      bubbles: true,
      cancelable: true,
      metaKey: true,
      altKey: true,
    });
    cell.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(cell.dataset.raw).toBe("hello");
    view.destroy();
  });
});
    })
  })
})

describe('focusFirstTableCell — /table lands in the first header cell', () => {
  // The table in TABLE_DOC starts at offset 13 (after "Intro text.\n\n").
  const TABLE_FROM = 13

  it('focuses the first header cell once the widget is rendered', async () => {
    const view = mount(TABLE_DOC)
    focusFirstTableCell(view, TABLE_FROM)
    // `mount` has already forced the parse, so the widget exists and the first
    // rAF tick lands focus in the cell.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const first = view.dom.querySelector<HTMLElement>(
      '.cm-table-widget [data-row="-1"][data-col="0"]'
    )
    expect(first).toBeTruthy()
    expect(document.activeElement).toBe(first)
    view.destroy()
  })

  it('is a harmless no-op when no table widget sits at the position', async () => {
    const view = mount('Just a paragraph, no table here.')
    expect(() => focusFirstTableCell(view, 0)).not.toThrow()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(view.dom.querySelector('.cm-table-cell')).toBeNull()
    view.destroy()
  })
})

describe('visual-mode table selection — snap + highlight', () => {
  // Vim's own vertical motion needs layout (getClientRects), which jsdom lacks,
  // so this drives the snap through real key events: `tableVimEntry` intercepts
  // the down motion and dispatches the selection directly (no coordinates),
  // which is exactly what happens in a browser.
  const saved = { vimMode: useStore.getState().vimMode }
  afterEach(() => {
    useStore.setState({ vimMode: saved.vimMode })
    vi.restoreAllMocks()
  })

  const DOC = `line above

| A | B |
| --- | --- |
| 1 | 2 |

line below`

  // Markdown always separates a table from surrounding text by a blank line,
  // so the line "directly adjacent" to the table is that blank line. These are
  // the positions on the blank lines above and below the table block.
  const TABLE_FROM = DOC.indexOf('| A |')
  const TABLE_TO = TABLE_FROM + '| A | B |\n| --- | --- |\n| 1 | 2 |'.length
  const ABOVE_BLANK = DOC.indexOf('\n\n| A |') + 1
  const BELOW_BLANK = DOC.indexOf('\n\nline below') + 1

  function mountVim(): EditorView {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC,
        extensions: [
          vim(),
          markdown({ base: markdownLanguage }),
          tablePlugin,
          tableVimEntry,
          tableSelectionHighlight
        ]
      })
    })
    forceParsing(view, DOC.length, 5000)
    return view
  }

  const press = (view: EditorView, key: string, keyCode: number): void => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })
    )
  }

  // Enter visual mode via the Vim API rather than a DOM keydown: the DOM path
  // is fragile under jsdom once earlier describes in the file have mutated the
  // global store / left stale listeners.  Vim.handleKey drives vim's key
  // processing directly.
  function enterVisual(view: EditorView): void {
    Vim.handleKey(getCM(view)!, 'v', 'user')
  }

  it('snaps a visual selection across the whole table on a down motion', () => {
    useStore.setState({ vimMode: true })
    const view = mountVim()
    view.focus()
    // Caret on the blank line directly above the table, then visual mode.
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    enterVisual(view)
    // One down motion → head snaps to the table's end, covering the whole table.
    press(view, 'ArrowDown', 40)
    const sel = view.state.selection.main
    expect(sel.from).toBe(ABOVE_BLANK)
    expect(sel.to).toBe(TABLE_TO)
    view.destroy()
  })

  it('deletes the whole table cleanly with `d` after the snap', () => {
    useStore.setState({ vimMode: true })
    const view = mountVim()
    view.focus()
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    enterVisual(view)
    press(view, 'ArrowDown', 40)
    Vim.handleKey(getCM(view)!, 'd', 'user')
    const after = view.state.doc.toString()
    expect(after).not.toContain('| A |')
    expect(after).not.toContain('---')
    // The text after the table survives.
    expect(after).toContain('line below')
    view.destroy()
  })

  it('snaps upward from below the table too', () => {
    useStore.setState({ vimMode: true })
    const view = mountVim()
    view.focus()
    view.dispatch({ selection: { anchor: BELOW_BLANK } })
    enterVisual(view)
    press(view, 'ArrowUp', 38)
    const sel = view.state.selection.main
    // Head moved up to the table's start; anchor stayed on the blank line below.
    expect(sel.head).toBe(TABLE_FROM)
    expect(sel.anchor).toBe(BELOW_BLANK)
    view.destroy()
  })

  it('lights the widget with .is-selected while the selection covers it', () => {
    useStore.setState({ vimMode: true })
    const view = mountVim()
    view.focus()
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    enterVisual(view)
    press(view, 'ArrowDown', 40)
    const widget = view.dom.querySelector('.cm-table-widget')
    expect(widget?.classList.contains('is-selected')).toBe(true)
    view.destroy()
  })

  it('clears .is-selected when the selection no longer covers the table', () => {
    useStore.setState({ vimMode: true })
    const view = mountVim()
    view.focus()
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    enterVisual(view)
    press(view, 'ArrowDown', 40)
    const widget = view.dom.querySelector('.cm-table-widget')!
    expect(widget.classList.contains('is-selected')).toBe(true)
    // Collapse the selection back to a point — the highlight must drop.
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    expect(widget.classList.contains('is-selected')).toBe(false)
    view.destroy()
  })

  it('does not snap in non-vim mode (the handler is a no-op without vim)', () => {
    useStore.setState({ vimMode: false })
    const view = mountVim()
    view.focus()
    view.dispatch({ selection: { anchor: ABOVE_BLANK } })
    enterVisual(view)
    press(view, 'ArrowDown', 40)
    // No table-snap dispatch occurred: head did not jump to the table end.
    const sel = view.state.selection.main
    expect(sel.to).toBeLessThan(TABLE_FROM)
    view.destroy()
  })
})
