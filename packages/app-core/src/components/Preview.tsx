import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NoteMeta } from "@shared/ipc";
import { renderMarkdown } from "../lib/markdown";
import { useStore } from "../store";
import { resolveAuto, THEMES } from "../lib/themes";
import { resolveWikilinkTarget } from "../lib/wikilinks";
import { toggleTaskAtIndex } from "../lib/tasklists";
import {
  enhanceLocalAssetNodes,
  resolveAssetVaultRelativePath,
} from "../lib/local-assets";
import { enhancePreviewHeadingFolds } from "../lib/preview-heading-fold";
import { renderDiagrams } from "../lib/diagram-renderers";
import { NoteHoverPreview } from "./NoteHoverPreview";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

// ---------------------------------------------------------------------------
// Mermaid: lazy singleton + theme-aware render
// ---------------------------------------------------------------------------

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

/** Read a `--z-*` CSS variable (stored as `"R G B"` triplet) as a hex
 *  color string. Mermaid's themeVariables expect real color values, not
 *  raw triplets. Falls back to a neutral grey if the var is missing. */
function readThemeColor(name: string, fallback = "#888888"): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const parts = raw.split(/[\s,]+/).map((n) => Number(n));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`;
}

interface MermaidThemeConfig {
  theme: "base";
  themeVariables: Record<string, string>;
  darkMode: boolean;
}

/** Build a complete Mermaid themeVariables map from the current `--z-*`
 *  CSS custom properties on `<html>`. We use mermaid's `base` theme and
 *  drive every color from the app theme so the diagram naturally matches
 *  whichever of the 16+ app themes is active. */
function buildMermaidTheme(mode: "light" | "dark"): MermaidThemeConfig {
  const bg = readThemeColor("--z-bg");
  const bg1 = readThemeColor("--z-bg-1");
  const bg2 = readThemeColor("--z-bg-2");
  const bg3 = readThemeColor("--z-bg-3");
  const bgSofter = readThemeColor("--z-bg-softer", bg1);
  const fg = readThemeColor("--z-fg");
  const fg1 = readThemeColor("--z-fg-1", fg);
  const grey = readThemeColor("--z-grey-1");
  const accent = readThemeColor("--z-accent", "#c35e0a");
  const red = readThemeColor("--z-red", "#c14a4a");
  const green = readThemeColor("--z-green", "#6c782e");
  const yellow = readThemeColor("--z-yellow", "#b47109");
  const blue = readThemeColor("--z-blue", "#45707a");
  const purple = readThemeColor("--z-purple", "#945e80");
  const aqua = readThemeColor("--z-aqua", "#4c7a5d");

  return {
    theme: "base",
    darkMode: mode === "dark",
    themeVariables: {
      // Typography
      fontFamily: "inherit",
      fontSize: "14px",

      // Core palette — mermaid derives most diagrams from these.
      background: bg,
      primaryColor: bg2,
      primaryTextColor: fg1,
      primaryBorderColor: bg3,
      secondaryColor: bg1,
      secondaryTextColor: fg,
      secondaryBorderColor: bg3,
      tertiaryColor: bgSofter,
      tertiaryTextColor: fg,
      tertiaryBorderColor: bg3,

      // Flow nodes + edges
      mainBkg: bg2,
      nodeBorder: bg3,
      nodeTextColor: fg1,
      lineColor: grey,
      arrowheadColor: grey,
      edgeLabelBackground: bg,

      // Cluster / subgraph
      clusterBkg: bgSofter,
      clusterBorder: bg3,
      titleColor: fg1,

      // Sequence diagrams
      actorBkg: bg2,
      actorBorder: bg3,
      actorTextColor: fg1,
      actorLineColor: grey,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: bg2,
      labelBoxBorderColor: bg3,
      labelTextColor: fg1,
      loopTextColor: fg,
      noteBkgColor: bgSofter,
      noteBorderColor: bg3,
      noteTextColor: fg1,
      activationBkgColor: bg3,
      activationBorderColor: grey,
      sequenceNumberColor: bg,

      // State / class diagrams
      labelColor: fg1,
      altBackground: bgSofter,
      transitionColor: grey,
      transitionLabelColor: fg,
      stateLabelColor: fg1,
      stateBkg: bg2,
      compositeBackground: bgSofter,
      compositeBorder: bg3,
      compositeTitleBackground: bg1,
      specialStateColor: accent,
      innerEndBackground: fg1,

      // ER diagrams
      attributeBackgroundColorOdd: bg,
      attributeBackgroundColorEven: bgSofter,

      // Gantt
      taskBkgColor: accent,
      taskTextColor: bg,
      taskTextOutsideColor: fg1,
      taskTextLightColor: bg,
      taskTextDarkColor: fg1,
      taskTextClickableColor: accent,
      activeTaskBkgColor: accent,
      activeTaskBorderColor: accent,
      doneTaskBkgColor: bg3,
      doneTaskBorderColor: grey,
      gridColor: bg3,
      sectionBkgColor: bg1,
      sectionBkgColor2: bgSofter,
      altSectionBkgColor: bgSofter,

      // XY chart
      xyChart: JSON.stringify({
        backgroundColor: bg,
        titleColor: fg1,
        xAxisLabelColor: fg,
        xAxisTitleColor: fg1,
        xAxisTickColor: grey,
        xAxisLineColor: grey,
        yAxisLabelColor: fg,
        yAxisTitleColor: fg1,
        yAxisTickColor: grey,
        yAxisLineColor: grey,
        plotColorPalette: [accent, blue, green, purple, yellow, red, aqua].join(
          ", ",
        ),
      }),

      // Git graph
      git0: accent,
      git1: blue,
      git2: green,
      git3: purple,
      git4: yellow,
      git5: red,
      git6: aqua,
      git7: fg,
      gitBranchLabel0: bg,
      gitBranchLabel1: bg,
      gitBranchLabel2: bg,
      gitBranchLabel3: bg,
      gitBranchLabel4: fg1,
      gitBranchLabel5: bg,
      gitBranchLabel6: bg,
      gitBranchLabel7: bg,

      // Pie
      pie1: accent,
      pie2: blue,
      pie3: green,
      pie4: purple,
      pie5: yellow,
      pie6: red,
      pie7: aqua,
      pie8: fg1,
      pie9: grey,
      pie10: bg3,
      pieTitleTextColor: fg1,
      pieSectionTextColor: bg,
      pieLegendTextColor: fg1,
      pieStrokeColor: bg,
      pieOuterStrokeColor: grey,

      // Signals / errors
      errorBkgColor: red,
      errorTextColor: bg,
    },
  };
}

type ExpandedDiagramKind = "mermaid" | "tikz" | "jsxgraph" | "function-plot";

interface ExpandedDiagram {
  kind: ExpandedDiagramKind;
  source: string;
}

const DIAGRAM_CLASS_BY_KIND: Record<ExpandedDiagramKind, string> = {
  mermaid: "mermaid",
  tikz: "zen-tikz",
  jsxgraph: "zen-jsxgraph",
  "function-plot": "zen-function-plot",
};

const DIAGRAM_SOURCE_ATTR_BY_KIND: Record<ExpandedDiagramKind, string> = {
  mermaid: "data-mermaid-source",
  tikz: "data-tikz-source",
  jsxgraph: "data-jsxgraph-source",
  "function-plot": "data-function-plot-source",
};

function prepareMermaidShell(el: HTMLElement, source: string): HTMLDivElement {
  const expanded = el.dataset.zenDiagramExpanded === "true";
  el.dataset.zenDiagramKind = "mermaid";
  el.dataset.zenDiagramSource = source;
  el.innerHTML = "";

  if (!expanded) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zen-diagram-expand";
    button.setAttribute("aria-label", "Open diagram in a larger view");
    button.textContent = "Expand";
    el.appendChild(button);
  }

  const surface = document.createElement("div");
  surface.className = expanded
    ? "zen-diagram-surface zen-diagram-surface-expanded"
    : "zen-diagram-surface";
  el.appendChild(surface);
  return surface;
}

async function renderMermaidBlocks(
  root: HTMLElement,
  mode: "light" | "dark",
  opts: { expanded?: boolean } = {},
): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mermaid"));
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  const cfg = buildMermaidTheme(mode);
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      ...cfg,
    });
  } catch {
    /* initialize is tolerant across versions — ignore */
  }

  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    if (opts.expanded) el.dataset.zenDiagramExpanded = "true";
    else delete el.dataset.zenDiagramExpanded;
    const source =
      el.getAttribute("data-mermaid-source") ?? el.textContent ?? "";
    if (!source.trim()) continue;
    el.setAttribute("data-mermaid-source", source);
    const surface = prepareMermaidShell(el, source);
    const id = `zen-mermaid-${Date.now()}-${i}-${opts.expanded ? "expanded" : "inline"}`;
    try {
      const { svg } = await mermaid.render(id, source);
      surface.innerHTML = svg;
    } catch (err) {
      surface.innerHTML = `<pre class="whitespace-pre-wrap text-xs text-[color:rgb(var(--z-red))]">Mermaid error: ${
        (err as Error).message
      }</pre>`;
    }
  }
}

export const Preview = memo(function Preview({
  markdown,
  notePath,
  onRequestEdit,
}: {
  markdown: string;
  notePath: string;
  onRequestEdit?: (() => void) | null;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const vault = useStore((s) => s.vault);
  const notes = useStore((s) => s.notes);
  const themeId = useStore((s) => s.themeId);
  const themeFamily = useStore((s) => s.themeFamily);
  const themeMode = useStore((s) => s.themeMode);
  // Track the OS-level preference so `mode: 'auto'` themes still pick
  // the right mermaid palette when the system toggles between light/dark.
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent): void => setPrefersDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const effectiveMode: "light" | "dark" = useMemo(() => {
    const resolvedId =
      themeMode === "auto" ? resolveAuto(themeFamily, prefersDark) : themeId;
    return THEMES.find((t) => t.id === resolvedId)?.mode ?? "light";
  }, [themeId, themeFamily, themeMode, prefersDark]);
  const selectNote = useStore((s) => s.selectNote);
  const setView = useStore((s) => s.setView);
  const updateActiveBody = useStore((s) => s.updateActiveBody);
  const persistActive = useStore((s) => s.persistActive);
  const pinAssetReference = useStore((s) => s.pinAssetReference);
  const pinAssetReferenceForNote = useStore((s) => s.pinAssetReferenceForNote);
  const pinnedRefPath = useStore((s) => s.pinnedRefPath);
  const pinnedRefKind = useStore((s) => s.pinnedRefKind);
  const pinnedRefVisible = useStore((s) => s.pinnedRefVisible);
  const togglePinnedRefVisible = useStore((s) => s.togglePinnedRefVisible);
  const pinnedAssetPath = pinnedRefKind === "asset" ? pinnedRefPath : null;
  const [hovered, setHovered] = useState<{
    note: NoteMeta;
    rect: DOMRect;
  } | null>(null);
  // Grace timer that keeps the hover preview open for ~200ms after the
  // pointer leaves a wikilink, so the user can actually slide the
  // cursor onto the popover itself without it disappearing mid-flight.
  const hoverDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverDismiss = (): void => {
    if (hoverDismissRef.current) {
      clearTimeout(hoverDismissRef.current);
      hoverDismissRef.current = null;
    }
  };
  const scheduleHoverDismiss = (): void => {
    clearHoverDismiss();
    hoverDismissRef.current = setTimeout(() => {
      hoverDismissRef.current = null;
      setHovered(null);
    }, 220);
  };
  // Flush any pending timer when the preview closes or on unmount so
  // we never call setHovered against a disposed component.
  useEffect(() => () => clearHoverDismiss(), []);
  const [assetMenu, setAssetMenu] = useState<{
    x: number;
    y: number;
    url: string;
    vaultRel: string | null;
    href: string;
  } | null>(null);
  const [expandedDiagram, setExpandedDiagram] =
    useState<ExpandedDiagram | null>(null);
  const workspaceMode = useStore((s) => s.workspaceMode);
  const canRevealInFileManager =
    window.zen.getAppInfo().runtime === "desktop" && workspaceMode !== "remote";

  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  const notesRef = useRef(notes);
  const markdownRef = useRef(markdown);
  const notePathRef = useRef(notePath);
  const onRequestEditRef = useRef(onRequestEdit);
  const vaultRootRef = useRef(vault?.root ?? null);
  const pinnedAssetPathRef = useRef<string | null>(pinnedAssetPath);
  const pinnedRefVisibleRef = useRef(pinnedRefVisible);
  const togglePinnedRefVisibleRef = useRef(togglePinnedRefVisible);
  const selectNoteRef = useRef(selectNote);
  const updateActiveBodyRef = useRef(updateActiveBody);
  const persistActiveRef = useRef(persistActive);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);
  useEffect(() => {
    notePathRef.current = notePath;
  }, [notePath]);
  useEffect(() => {
    onRequestEditRef.current = onRequestEdit;
  }, [onRequestEdit]);
  useEffect(() => {
    vaultRootRef.current = vault?.root ?? null;
  }, [vault?.root]);
  useEffect(() => {
    pinnedAssetPathRef.current = pinnedAssetPath;
  }, [pinnedAssetPath]);
  useEffect(() => {
    pinnedRefVisibleRef.current = pinnedRefVisible;
  }, [pinnedRefVisible]);
  useEffect(() => {
    togglePinnedRefVisibleRef.current = togglePinnedRefVisible;
  }, [togglePinnedRefVisible]);
  useEffect(() => {
    selectNoteRef.current = selectNote;
  }, [selectNote]);
  useEffect(() => {
    updateActiveBodyRef.current = updateActiveBody;
  }, [updateActiveBody]);
  useEffect(() => {
    persistActiveRef.current = persistActive;
  }, [persistActive]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      const expandButton = target.closest(
        ".zen-diagram-expand",
      ) as HTMLButtonElement | null;
      if (expandButton) {
        e.preventDefault();
        const host = expandButton.closest<HTMLElement>(
          "[data-zen-diagram-kind][data-zen-diagram-source]",
        );
        const kind = host?.dataset.zenDiagramKind as
          | ExpandedDiagramKind
          | undefined;
        const source = host?.dataset.zenDiagramSource;
        if (host && kind && source) setExpandedDiagram({ kind, source });
        return;
      }
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.classList.contains("wikilink")) {
        e.preventDefault();
        const path = anchor.dataset.resolvedPath;
        if (path) void selectNoteRef.current(path);
        return;
      }
      if (anchor.classList.contains("hashtag")) {
        e.preventDefault();
        const tag = anchor.getAttribute("data-tag");
        if (tag) void useStore.getState().openTagView(tag);
        return;
      }
      const localAssetUrl = anchor.dataset.localAssetUrl;
      if (localAssetUrl) {
        e.preventDefault();
        window.open(localAssetUrl, "_blank");
        return;
      }
      // External links: let Electron's window-open handler send them to the OS browser.
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) {
        e.preventDefault();
        window.open(href, "_blank");
        return;
      }
      e.preventDefault();
    };
    const onMouseOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a.wikilink") as HTMLAnchorElement | null;
      if (!anchor) return;
      const resolvedPath = anchor.dataset.resolvedPath;
      if (!resolvedPath) return;
      const note = notesRef.current.find((item) => item.path === resolvedPath);
      if (!note) return;
      clearHoverDismiss();
      setHovered({ note, rect: anchor.getBoundingClientRect() });
    };
    const onMouseMove = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a.wikilink") as HTMLAnchorElement | null;
      if (!anchor) {
        // Pointer moved off the link. Don't dismiss immediately — the
        // popover lives outside this root, and the user is probably on
        // their way to it. The grace timer will clear the hover if
        // they never arrive.
        scheduleHoverDismiss();
        return;
      }
      const resolvedPath = anchor.dataset.resolvedPath;
      if (!resolvedPath) return;
      const note = notesRef.current.find((item) => item.path === resolvedPath);
      if (!note) return;
      clearHoverDismiss();
      setHovered({ note, rect: anchor.getBoundingClientRect() });
    };
    const onMouseOut = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest("a.wikilink")) scheduleHoverDismiss();
    };
    const onChange = (e: Event): void => {
      const input = e.target as HTMLInputElement | null;
      if (!input || input.type !== "checkbox") return;
      const taskIndex = Number.parseInt(input.dataset.taskIndex ?? "-1", 10);
      if (!Number.isFinite(taskIndex) || taskIndex < 0) return;
      const nextMarkdown = toggleTaskAtIndex(
        markdownRef.current,
        taskIndex,
        input.checked,
      );
      if (nextMarkdown === markdownRef.current) return;
      updateActiveBodyRef.current(nextMarkdown);
      void persistActiveRef.current();
    };
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      // Find the closest embedded-asset host (figure/anchor) that we
      // tagged in `enhanceLocalAssetNodes` or the CM PDF widget.
      const host = target.closest<HTMLElement>(
        "[data-local-asset-kind][data-local-asset-url]",
      );
      if (!host) return;
      const url = host.dataset.localAssetUrl || "";
      const href =
        host.dataset.localAssetHref || host.getAttribute("href") || "";
      if (!url) return;
      e.preventDefault();
      const vaultRoot = vaultRootRef.current;
      const vaultRel = vaultRoot
        ? resolveAssetVaultRelativePath(vaultRoot, notePathRef.current, href || url)
        : null;
      setAssetMenu({ x: e.clientX, y: e.clientY, url, vaultRel, href });
    };

    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mousemove", onMouseMove);
    root.addEventListener("mouseout", onMouseOut);
    root.addEventListener("change", onChange);
    root.addEventListener("contextmenu", onContextMenu);

    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mousemove", onMouseMove);
      root.removeEventListener("mouseout", onMouseOut);
      root.removeEventListener("change", onChange);
      root.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;

    const stage = document.createElement("article");
    stage.innerHTML = html;

    stage.querySelectorAll<HTMLAnchorElement>("a.wikilink").forEach((a) => {
      const target = a.getAttribute("data-wikilink") || "";
      const resolved = resolveWikilinkTarget(notes, target);
      if (resolved) {
        a.classList.remove("broken");
        a.dataset.resolvedPath = resolved.path;
      } else {
        a.classList.add("broken");
        delete a.dataset.resolvedPath;
      }
    });

    enhanceLocalAssetNodes(stage, {
      vaultRoot: vault?.root,
      notePath,
      onRequestEdit,
      pinnedAssetPath,
      onActivatePinnedRef: () => {
        if (!pinnedRefVisible) togglePinnedRefVisible();
      },
    });

    enhancePreviewHeadingFolds(stage);

    stage
      .querySelectorAll<HTMLInputElement>('li.task-list-item input[type="checkbox"]')
      .forEach((input, idx) => {
        input.disabled = false;
        input.dataset.taskIndex = String(idx);
        input.setAttribute("role", "checkbox");
        input.classList.add("cursor-pointer");
      });

    const applyRenderedDom = async (): Promise<void> => {
      try {
        await renderMermaidBlocks(stage, effectiveMode);
      } catch {
        /* render errors are surfaced inline per block */
      }
      await renderDiagrams(stage, { themeKey: effectiveMode, expanded: false });
      if (cancelled) return;
      root.replaceChildren(...Array.from(stage.childNodes));
    };

    void applyRenderedDom();

    return () => {
      cancelled = true;
    };
  }, [
    effectiveMode,
    html,
    notePath,
    notes,
    onRequestEdit,
    pinnedAssetPath,
    pinnedRefVisible,
    togglePinnedRefVisible,
    vault?.root,
  ]);

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return [];
    const items: ContextMenuItem[] = [
      {
        label: "Open",
        onSelect: async () => {
          window.open(assetMenu.url, "_blank");
        },
      },
      {
        label: "Open as Reference (This Note)",
        disabled: !assetMenu.vaultRel,
        onSelect: async () => {
          if (assetMenu.vaultRel) {
            pinAssetReferenceForNote(notePath, assetMenu.vaultRel);
          }
        },
      },
      {
        label: "Open as Reference (Global)",
        disabled: !assetMenu.vaultRel,
        onSelect: async () => {
          if (assetMenu.vaultRel) pinAssetReference(assetMenu.vaultRel);
        },
      },
      {
        label: "Open in New Window",
        onSelect: async () => {
          window.open(assetMenu.url, "_blank");
        },
      },
    ];

    if (canRevealInFileManager && assetMenu.vaultRel) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await window.zen.revealNote(assetMenu.vaultRel!);
        },
      });
    }

    return items;
  }, [
    assetMenu,
    canRevealInFileManager,
    notePath,
    pinAssetReference,
    pinAssetReferenceForNote,
  ]);
  const closeAssetMenu = useCallback(() => setAssetMenu(null), []);

  return (
    <>
      <article
        data-preview-content
        ref={ref}
        className="prose-zen py-8"
      />
      {hovered && (
        <NoteHoverPreview
          note={hovered.note}
          anchorRect={hovered.rect}
          interactive
          onPointerEnter={clearHoverDismiss}
          onPointerLeave={scheduleHoverDismiss}
        />
      )}
      {assetMenu && (
        <ContextMenu
          x={assetMenu.x}
          y={assetMenu.y}
          items={assetMenuItems}
          onClose={closeAssetMenu}
        />
      )}
      {expandedDiagram && (
        <ExpandedDiagramModal
          diagram={expandedDiagram}
          themeKey={effectiveMode}
          onClose={() => setExpandedDiagram(null)}
        />
      )}
    </>
  );
});

function ExpandedDiagramModal({
  diagram,
  themeKey,
  onClose,
}: {
  diagram: ExpandedDiagram;
  themeKey: "light" | "dark";
  onClose: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    const el = document.createElement("div");
    el.className = DIAGRAM_CLASS_BY_KIND[diagram.kind];
    el.setAttribute(DIAGRAM_SOURCE_ATTR_BY_KIND[diagram.kind], diagram.source);
    el.dataset.zenDiagramKind = diagram.kind;
    el.dataset.zenDiagramSource = diagram.source;
    el.dataset.zenDiagramExpanded = "true";
    host.appendChild(el);

    if (diagram.kind === "mermaid") {
      void renderMermaidBlocks(host, themeKey, { expanded: true });
    } else {
      void renderDiagrams(host, { themeKey, expanded: true });
    }
  }, [diagram, themeKey]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm md:p-6"
      onClick={onClose}
    >
      <div
        className="w-[min(1360px,96vw)] overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-100 shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-paper-300/60 px-5 py-3">
          <div>
            <div className="text-sm font-semibold text-ink-900">
              Expanded diagram
            </div>
            <div className="text-xs text-ink-500">
              Press Esc or click outside to close.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1 text-sm text-ink-700 transition hover:bg-paper-200"
          >
            Close
          </button>
        </div>
        <div className="max-h-[90vh] overflow-auto p-4 md:p-5">
          <div ref={hostRef} className="zen-diagram-modal-host" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
