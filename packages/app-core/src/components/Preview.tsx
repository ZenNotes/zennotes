import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { NoteMeta } from "@shared/ipc";
import { renderMarkdown } from "../lib/markdown";
import { resolveNoteDirection } from "../lib/bidi-dir";
import {
  setMarkdownLooseMathDelimiters,
  setMarkdownMathRenderer,
} from "../lib/markdown-settings";
import { expandEmbeds, hasNoteEmbeds } from "../lib/transclusion";
import { todayIso } from "../lib/task-metadata-tokens";
import { selectTypstPreambleFor } from "../lib/typst-preamble-select";
import { useStore } from "../store";
import { useDiagramTheme } from "../lib/use-diagram-theme-mode";
import {
  isSameFileBlockLink,
  isSameFileHeadingLink,
  resolveWikilinkTarget,
} from "../lib/wikilinks";
import {
  openWikilinkTarget,
} from "../lib/wikilink-navigation";
import { listDatabaseLinkTargets, resolveDatabaseWikilink } from "../lib/database-links";
import { externalLinkUrl, resolveInternalNoteHref } from "../lib/internal-links";
import { toggleTaskAtIndex } from "../lib/tasklists";
import {
  enhanceLocalAssetNodes,
  hrefFragment,
  resolveAssetVaultRelativePath,
} from "../lib/local-assets";
import { assetTabPath } from "../lib/asset-tabs";
import { isExcalidrawPath, isObsidianExcalidrawPath } from "@shared/excalidraw";
import { resolveExcalidrawEmbedPath } from "../lib/excalidraw-preview";
import { LazyExcalidrawPreview } from "./LazyExcalidrawPreview";
import { enhancePreviewHeadingFolds } from "../lib/preview-heading-fold";
import { renderDiagrams } from "../lib/diagram-renderers";
import { renderEmbeds, renderBookmarks } from "../lib/embed-renderers";
import { renderTypstMath } from "../lib/typst-math-render";
import { externalFileLink, openExternalFileLink } from "../lib/external-file-link";
import { setHoveredLink } from "../lib/hovered-link";
import { attachInlineDiagramPanZoom } from "../lib/inline-diagram-pan-zoom";
import {
  CODE_COPY_BUTTON_SELECTOR,
  CODE_FOLD_BUTTON_SELECTOR,
  copyCodeBlockToClipboard,
  enhanceCodeBlockCopy,
  toggleCodeBlockFold,
} from "../lib/code-block-copy";
import {
  diagramZoomLabel,
  fitDiagramToViewport,
  stepDiagramZoom,
  zoomDiagramAtPoint,
  zoomFromWheelDelta,
  type DiagramPanZoomState,
} from "../lib/diagram-pan-zoom";
import {
  diagramTabPath,
  diagramTitleFromKind,
  type DiagramTabKind,
  type DiagramTabPayload,
} from "../lib/diagram-tabs";
import { NoteHoverPreview } from "./NoteHoverPreview";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ArrowUpRightIcon, MaximizeIcon, MinimizeIcon } from "./icons";
import { promptApp } from "../lib/prompt-requests";
import { buildMermaidTheme, loadMermaid } from "../lib/mermaid-render";
import { confirmApp } from "../lib/confirm-requests";

// Mermaid's lazy loader and theme live in `lib/mermaid-render`, shared with
// the editor's live preview so both draw the same diagram the same way.

type ExpandedDiagramKind = DiagramTabKind;

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
    // Toolbar row above the diagram: inline zoom controls slot in to the
    // left of the Expand button (see attachInlineDiagramPanZoom).
    const toolbar = document.createElement("div");
    toolbar.className = "zen-diagram-toolbar";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zen-diagram-expand";
    button.setAttribute("aria-label", "Open diagram in a larger view");
    button.textContent = "Expand";
    toolbar.appendChild(button);
    el.appendChild(toolbar);
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
  // Mermaid measures text in a temporary element. If the active font is
  // still loading, metrics are taken against a fallback and the rendered
  // labels end up clipped once the real font applies. Wait for fonts first
  // so the measured widths match the final painted text.
  if (typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.ready;
    } catch {
      /* ignore font-api failures and render anyway */
    }
  }
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
      // Inline pan/zoom (Cmd/Ctrl+wheel, drag, dblclick reset). The
      // expanded modal has its own React pan/zoom frame.
      if (!opts.expanded) attachInlineDiagramPanZoom(surface);
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
  onRendered,
}: {
  markdown: string;
  notePath: string;
  onRequestEdit?: (() => void) | null;
  onRendered?: (() => void) | null;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const mathRenderer = useStore((s) => s.mathRenderer);
  const looseMathDelimiters = useStore((s) => s.looseMathDelimiters);
  const rtlMode = useStore((s) => s.rtlMode);
  const vault = useStore((s) => s.vault);
  const notes = useStore((s) => s.notes);
  const folders = useStore((s) => s.folders);
  const vaultSettings = useStore((s) => s.vaultSettings);
  const databaseTargets = useMemo(
    () => listDatabaseLinkTargets(folders, vaultSettings),
    [folders, vaultSettings],
  );
  const assetFiles = useStore((s) => s.assetFiles);
  const customCodeLanguagesRevision = useStore((s) => s.customCodeLanguagesRevision);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const deleteAssetAction = useStore((s) => s.deleteAsset);
  const diagramTheme = useDiagramTheme();
  const selectNote = useStore((s) => s.selectNote);
  const openNoteInTab = useStore((s) => s.openNoteInTab);
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
  const canManageAssets =
    window.zen.getAppInfo().runtime === "desktop" &&
    workspaceMode !== "remote" &&
    typeof window.zen.renameAsset === "function" &&
    typeof window.zen.moveAsset === "function" &&
    typeof window.zen.duplicateAsset === "function";
  const canDeleteAssets =
    window.zen.getAppInfo().runtime === "desktop" &&
    workspaceMode !== "remote";

  // #transclusion: expand `![[Note]]` embeds into inline content before
  // rendering, so the reading view — and PDF export, which renders through this
  // same Preview — show a "master note" with its sub-notes inlined. Only note
  // targets expand (images/unknown are left for the normal pipeline), and only
  // when the note actually contains note-embeds.
  const resolveEmbedTarget = useMemo(
    () =>
      (target: string): { path: string; title: string } | null => {
        const n = resolveWikilinkTarget(notes, target);
        if (!n) return null;
        if (isExcalidrawPath(n.path) || isObsidianExcalidrawPath(n.path)) return null;
        return { path: n.path, title: n.title };
      },
    [notes],
  );
  const hasEmbeds = useMemo(
    () => hasNoteEmbeds(markdown, resolveEmbedTarget, notePath),
    [markdown, resolveEmbedTarget, notePath],
  );
  const [embedExpansion, setEmbedExpansion] = useState<{
    src: string;
    out: string;
  } | null>(null);
  const expandedForCurrent =
    embedExpansion?.src === markdown ? embedExpansion.out : null;
  useEffect(() => {
    if (!hasEmbeds || expandedForCurrent != null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void expandEmbeds(markdown, notePath, {
        resolve: resolveEmbedTarget,
        loadNote: async (path) => {
          try {
            return (await window.zen.readNote(path)).body ?? null;
          } catch {
            return null;
          }
        },
      }).then((out) => {
        if (!cancelled) setEmbedExpansion({ src: markdown, out });
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasEmbeds, expandedForCurrent, markdown, notePath, resolveEmbedTarget]);
  // Gate the PDF-ready signal (onRendered) until embeds resolve, so exports
  // capture the expanded document rather than the bare links.
  const embedsReady = !hasEmbeds || expandedForCurrent != null;
  const embedsReadyRef = useRef(embedsReady);
  embedsReadyRef.current = embedsReady;

  const html = useMemo(() => {
    // Point the pipeline at the active engine before rendering, so a toggle
    // takes effect on the very next render without an effect-ordering race.
    setMarkdownMathRenderer(mathRenderer);
    setMarkdownLooseMathDelimiters(looseMathDelimiters);
    return renderMarkdown(expandedForCurrent ?? markdown);
    // customCodeLanguagesRevision re-renders when a grammar is installed,
    // toggled, or removed; renderMarkdown keys its cache on it too.
  }, [
    expandedForCurrent,
    markdown,
    mathRenderer,
    looseMathDelimiters,
    customCodeLanguagesRevision,
  ]);
  const assetFilesKey = useMemo(
    () => assetFiles.map((asset) => asset.path).join("\n"),
    [assetFiles],
  );
  // Tag-driven Typst definitions for this note (#486). Empty unless the setting
  // is on and the note's tags match a preamble, so most notes pay one lookup.
  const typstPreamble = useStore((s) => selectTypstPreambleFor(s, notePath));
  const typstPreambleRef = useRef(typstPreamble);
  typstPreambleRef.current = typstPreamble;
  const notesRef = useRef(notes);
  const markdownRef = useRef(markdown);
  const notePathRef = useRef(notePath);
  const onRequestEditRef = useRef(onRequestEdit);
  const onRenderedRef = useRef(onRendered);
  const vaultRootRef = useRef(vault?.root ?? null);
  const pinnedAssetPathRef = useRef<string | null>(pinnedAssetPath);
  const pinnedRefVisibleRef = useRef(pinnedRefVisible);
  const togglePinnedRefVisibleRef = useRef(togglePinnedRefVisible);
  const selectNoteRef = useRef(selectNote);
  const openNoteInTabRef = useRef(openNoteInTab);
  const updateActiveBodyRef = useRef(updateActiveBody);
  const persistActiveRef = useRef(persistActive);
  // React roots for rendered Excalidraw embed placeholders — unmounted on
  // every re-render and on component teardown to avoid leaks.
  const excalidrawRootsRef = useRef<Root[]>([]);

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
    onRenderedRef.current = onRendered;
  }, [onRendered]);
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
    openNoteInTabRef.current = openNoteInTab;
  }, [openNoteInTab]);
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
      // A `[/]` task has no checkbox input, but its half-filled marker is
      // still a checkbox shape making a checkbox promise: clicking checks the
      // task off, matching the editor widget and the Tasks list. The
      // forwarded/cancelled markers stay inert records. (#599)
      const inProgressMarker = target.closest<HTMLElement>(
        ".zen-task-state-in-progress[data-task-index]",
      );
      if (inProgressMarker) {
        e.preventDefault();
        e.stopPropagation();
        const taskIndex = Number.parseInt(
          inProgressMarker.dataset.taskIndex ?? "-1",
          10,
        );
        if (!Number.isFinite(taskIndex) || taskIndex < 0) return;
        const nextMarkdown = toggleTaskAtIndex(
          markdownRef.current,
          taskIndex,
          true,
        );
        if (nextMarkdown === markdownRef.current) return;
        updateActiveBodyRef.current(nextMarkdown);
        void persistActiveRef.current();
        return;
      }
      const copyButton = target.closest<HTMLButtonElement>(
        CODE_COPY_BUTTON_SELECTOR,
      );
      if (copyButton) {
        e.preventDefault();
        e.stopPropagation();
        copyCodeBlockToClipboard(copyButton);
        return;
      }
      const foldButton = target.closest<HTMLButtonElement>(
        CODE_FOLD_BUTTON_SELECTOR,
      );
      if (foldButton) {
        e.preventDefault();
        e.stopPropagation();
        toggleCodeBlockFold(foldButton);
        return;
      }

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
        if (path) {
          // Scroll to the #heading or the ^block when the link carries one.
          // (#196, #601)
          void openWikilinkTarget(path, anchor.dataset.wikilink ?? "");
        } else if (anchor.dataset.databaseCsv) {
          void useStore.getState().openDatabase(anchor.dataset.databaseCsv);
        }
        return;
      }
      if (anchor.classList.contains("hashtag")) {
        e.preventDefault();
        const tag = anchor.getAttribute("data-tag");
        if (tag) void useStore.getState().openTagView(tag);
        return;
      }
      // A standard Markdown link to another note — `[text](path/to/Note.md)` —
      // navigates like a wikilink, resolved relative to this note. Checked
      // before the asset branch: `enhanceLocalAssetNodes` may have tagged a
      // relative link and rewritten its href, keeping the original in
      // `data-local-asset-href`. (#201)
      const linkHref =
        anchor.dataset.localAssetHref || anchor.getAttribute("href") || "";
      const internalNote = resolveInternalNoteHref(
        notePathRef.current,
        linkHref,
        notesRef.current,
      );
      if (internalNote) {
        e.preventDefault();
        // `#<anchor>` lets openWikilinkTarget decide heading vs block, so the
        // Obsidian form `Note.md#^id` reaches the block here too. (#601)
        if (internalNote.anchor)
          void openWikilinkTarget(internalNote.path, `#${internalNote.anchor}`);
        else void selectNoteRef.current(internalNote.path);
        return;
      }
      // An external web link — `[site](https://…)` or a bare `[site](google.com)`
      // a user typed without a scheme — opens in the browser. Checked before the
      // asset branch since a scheme-less domain looks like a relative path. (#201)
      const external = externalLinkUrl(linkHref);
      if (external) {
        e.preventDefault();
        window.open(external, "_blank");
        return;
      }
      const localAssetUrl = anchor.dataset.localAssetUrl;
      if (localAssetUrl) {
        e.preventDefault();
        const href =
          anchor.dataset.localAssetHref || anchor.getAttribute("href") || "";
        const vaultRoot = vaultRootRef.current;
        const vaultRel = vaultRoot
          ? resolveAssetVaultRelativePath(vaultRoot, notePathRef.current, href || localAssetUrl)
          : null;
        if (vaultRel) void openNoteInTabRef.current(assetTabPath(vaultRel));
        return;
      }
      // External links: let Electron's window-open handler send them to the OS browser.
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) {
        e.preventDefault();
        window.open(href, "_blank");
        return;
      }
      // In-page anchors — footnote refs / back-refs and heading links. The
      // browser's default hash navigation doesn't scroll an element that lives
      // inside the preview's own overflow:auto container, so resolve the target
      // and scroll it ourselves. This is what made footnotes feel dead in the
      // (split) preview, and it works both ways: ref → definition and the ↩
      // back-ref → reference (#69).
      if (href.startsWith("#") && href.length > 1) {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        const dest =
          root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ??
          root.querySelector<HTMLElement>(`[name="${CSS.escape(id)}"]`);
        if (dest) {
          dest.scrollIntoView({ behavior: "smooth", block: "center" });
          // Brief highlight so the jump is obvious in a long note.
          dest.style.transition = "background-color 700ms ease";
          dest.style.backgroundColor = "rgb(var(--z-accent) / 0.22)";
          window.setTimeout(() => {
            dest.style.backgroundColor = "";
          }, 900);
        }
        return;
      }
      // A link to a file outside the vault (`~/…`, `file://…`, an absolute path):
      // open it with the OS default app instead of silently doing nothing. (#424)
      if (externalFileLink(href)) {
        e.preventDefault();
        void openExternalFileLink(href);
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
      // Status-bar link preview (browser-style): show the target of whatever
      // link is under the pointer, wikilink or plain markdown link.
      const anyLink = target.closest("a") as HTMLAnchorElement | null;
      setHoveredLink(
        anyLink
          ? anyLink.dataset.wikilink ||
              anyLink.dataset.resolvedPath ||
              anyLink.getAttribute("href")
          : null,
      );
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

    const onMouseLeave = (): void => setHoveredLink(null);

    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mousemove", onMouseMove);
    root.addEventListener("mouseout", onMouseOut);
    root.addEventListener("mouseleave", onMouseLeave);
    root.addEventListener("change", onChange);
    root.addEventListener("contextmenu", onContextMenu);

    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mousemove", onMouseMove);
      root.removeEventListener("mouseout", onMouseOut);
      root.removeEventListener("mouseleave", onMouseLeave);
      root.removeEventListener("change", onChange);
      root.removeEventListener("contextmenu", onContextMenu);
      setHoveredLink(null);
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
        delete a.dataset.databaseCsv;
        return;
      }
      // `[[#heading]]` / `[[^block]]` (no note part) point inside THIS note:
      // resolve them to the note being previewed so the click scrolls in
      // place. (#291, #601)
      if (isSameFileHeadingLink(target) || isSameFileBlockLink(target)) {
        a.classList.remove("broken");
        a.dataset.resolvedPath = notePath;
        delete a.dataset.databaseCsv;
        return;
      }
      delete a.dataset.resolvedPath;
      // Not a note — a `.base` database link is still valid (#238).
      const db = resolveDatabaseWikilink(databaseTargets, target);
      if (db) {
        a.classList.remove("broken");
        a.dataset.databaseCsv = db.csvPath;
      } else {
        a.classList.add("broken");
        delete a.dataset.databaseCsv;
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
      onOpenAsset: (path) => {
        void openNoteInTabRef.current(assetTabPath(path));
      },
    });

    enhancePreviewHeadingFolds(stage);
    enhanceCodeBlockCopy(stage, { notePath });

    // The task index a click writes back with must count the way the markdown
    // parser counts: EVERY task line, including the states with no checkbox of
    // their own (`[/]`, `[-]`, `[>]`). Numbering the checkboxes alone made the
    // index drift by one for each such line above them, so in a note that
    // opened with a cancelled task, clicking the first real checkbox toggled
    // the cancelled line instead. Task items are in document order here, which
    // is line order. (#512)
    const taskItems = Array.from(
      stage.querySelectorAll<HTMLLIElement>("li.task-list-item"),
    );
    const today = todayIso();
    taskItems.forEach((li, idx) => {
      const input = li.querySelector<HTMLInputElement>(
        ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
      );
      if (input) {
        input.disabled = false;
        input.dataset.taskIndex = String(idx);
        input.setAttribute("role", "checkbox");
        input.classList.add("cursor-pointer");
        li.classList.toggle("task-self-done", input.checked);
      } else {
        // `[/]` renders a marker span instead of an input; make it a real
        // control that checks the task off (see onClick). `[-]`/`[>]` keep
        // their inert record markers. (#599)
        const marker = li.querySelector<HTMLElement>(
          ":scope > .zen-task-state-in-progress, :scope > p > .zen-task-state-in-progress",
        );
        if (marker) {
          marker.dataset.taskIndex = String(idx);
          marker.setAttribute("role", "checkbox");
          marker.setAttribute("aria-checked", "mixed");
          marker.setAttribute("aria-label", "Mark task done");
          marker.title = "In progress. Click to mark done.";
          marker.classList.add("cursor-pointer");
        }
      }
      // An item is still open unless its own checkbox is checked; the `[/]` and
      // `[>]` states have no checkbox and are open by definition, `[-]` is not.
      const closed = input?.checked === true || li.classList.contains("zen-task-cancelled");
      // Due chips are rendered date-neutral (the HTML is cached and outlives
      // "today"), so the overdue tint is decided here, at attach time, the
      // same rule the editor uses: past due and the task still open. (#479)
      li.querySelectorAll<HTMLElement>(":scope .zen-task-due[data-due]").forEach((chip) => {
        const due = chip.dataset.due ?? "";
        chip.classList.toggle("zen-task-due-overdue", !closed && due !== "" && due < today);
      });
      // Wrap the item's OWN inline text in a span, so state styling (strike/gray
      // for done and cancelled) targets just this line and never bleeds onto
      // nested sub-tasks. Loose items keep their <p>, which the CSS targets
      // directly; only bare-text (tight) items get the wrapper. The state marker
      // span stays outside it: it sits in the gutter and must not be struck
      // along with the text. (#512)
      if (!li.querySelector(":scope > .task-item-body")) {
        const own = Array.from(li.childNodes).filter((node) => {
          if (node === input) return false;
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (el.tagName === "UL" || el.tagName === "OL" || el.tagName === "P") return false;
            if (el.classList.contains("zen-task-state")) return false;
          }
          return true;
        });
        const hasText = own.some(
          (node) =>
            node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() !== "",
        );
        if (hasText && own.length > 0) {
          const body = document.createElement("span");
          body.className = "task-item-body";
          li.insertBefore(body, own[0]);
          for (const node of own) body.appendChild(node);
        }
      }
    });

    const applyRenderedDom = async (): Promise<void> => {
      try {
        await renderMermaidBlocks(stage, diagramTheme.mode);
      } catch {
        /* render errors are surfaced inline per block */
      }
      if (cancelled) return;
      // Attach to the live document BEFORE rendering diagrams. JSXGraph binds to
      // a real element via document.getElementById and sizes the board from the
      // laid-out container, so a detached buffer yields "HTML container element
      // not found" and zero-size boards (#68). Mermaid renders to inline SVG, so
      // it is safe to render in the detached buffer above.
      root.replaceChildren(...Array.from(stage.childNodes));
      await renderDiagrams(root, { themeKey: diagramTheme.key, expanded: false });
      if (cancelled) return;
      // Typst math (a no-op when the KaTeX renderer is active, since it emits no
      // `.zen-typst-math` placeholders). Recolored to currentColor, so a theme
      // switch needs no re-render.
      await renderTypstMath(root, typstPreambleRef.current);
      if (cancelled) return;
      renderEmbeds(root);
      renderBookmarks(root);
      renderExcalidrawEmbeds(root);
      requestAnimationFrame(() => {
        if (!cancelled && embedsReadyRef.current) onRenderedRef.current?.();
      });
    };

    const renderExcalidrawEmbeds = (container: HTMLElement): void => {
      // Unmount roots from the previous render before hydrating the new DOM.
      for (const r of excalidrawRootsRef.current) {
        try {
          r.unmount();
        } catch {
          /* node already gone */
        }
      }
      excalidrawRootsRef.current = [];
      const notePaths = notes.map((n) => n.path);
      container
        .querySelectorAll<HTMLElement>("[data-excalidraw-embed]")
        .forEach((host) => {
          const target = host.getAttribute("data-excalidraw-embed") || "";
          if (!target.trim()) return;
          const wAttr = host.getAttribute("data-embed-width");
          const hAttr = host.getAttribute("data-embed-height");
          const resolved = resolveExcalidrawEmbedPath(notePaths, target) ?? target;
          const r = createRoot(host);
          excalidrawRootsRef.current.push(r);
          r.render(
            <LazyExcalidrawPreview
              path={resolved}
              width={wAttr ? Number(wAttr) : undefined}
              height={hAttr ? Number(hAttr) : undefined}
              className="excalidraw-embed-preview"
              onClick={() => {
                // Open the drawing (isExcalidrawPath → Excalidraw editor). An
                // asset tab (zen://asset/…) would route to the generic asset
                // viewer and offer to download the file instead. (#360)
                void openNoteInTabRef.current(resolved);
              }}
            />,
          );
        });
    };

    void applyRenderedDom();

    return () => {
      cancelled = true;
      for (const r of excalidrawRootsRef.current) {
        try {
          r.unmount();
        } catch {
          /* node already gone */
        }
      }
      excalidrawRootsRef.current = [];
    };
  }, [
    assetFilesKey,
    diagramTheme.key,
    diagramTheme.mode,
    databaseTargets,
    html,
    notePath,
    notes,
    onRequestEdit,
    pinnedAssetPath,
    pinnedRefVisible,
    togglePinnedRefVisible,
    // Editing a note's tags, or the preamble note itself, changes the Typst
    // definitions its formulas compile against — re-render when it moves (#486).
    typstPreamble,
    vault?.root,
  ]);

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return [];
    const vaultRel = assetMenu.vaultRel;
    const asset = vaultRel ? assetFiles.find((entry) => entry.path === vaultRel) : null;
    const root = vault?.root ?? "";
    const sep = root.includes("\\") ? "\\" : "/";
    const abs =
      vaultRel && root
        ? [root.replace(/[\\/]+$/, ""), ...vaultRel.split("/").filter(Boolean)].join(
            sep,
          )
        : "";
    const currentDir = vaultRel?.split("/").slice(0, -1).join("/") ?? "";
    const items: ContextMenuItem[] = [
      {
        label: "Open",
        onSelect: async () => {
          if (vaultRel) await openNoteInTab(assetTabPath(vaultRel));
        },
        disabled: !vaultRel,
      },
      {
        label: "Open in New Tab",
        onSelect: async () => {
          if (vaultRel) await openNoteInTab(assetTabPath(vaultRel));
        },
        disabled: !vaultRel,
      },
    ];

    if (canManageAssets && vaultRel && asset) {
      items.push({
        label: "Rename…",
        onSelect: async () => {
          const next = await promptApp({
            title: "Rename asset",
            initialValue: asset.name,
            okLabel: "Rename",
            validate: (value) => {
              const clean = value.trim();
              if (!clean) return "Asset name is required";
              if (/[\\/]/.test(clean)) return "Use only a file name";
              if (/\.md$/i.test(clean)) return "Use note actions for markdown notes";
              return null;
            },
          });
          if (!next || next === asset.name) return;
          await window.zen.renameAsset(vaultRel, next);
          await refreshAssets();
        },
      });
      items.push({
        label: "Move…",
        onSelect: async () => {
          const target = await promptApp({
            title: "Move asset",
            description: "Enter a vault-relative folder path. Leave empty to move to the vault root.",
            initialValue: currentDir,
            placeholder: "media/screenshots",
            okLabel: "Move",
            allowEmptySubmit: true,
            validate: (value) => {
              const clean = value.trim();
              if (clean.includes("..")) return "Path cannot contain ..";
              if (clean.split("/").includes(".zennotes")) {
                return "Cannot move assets into internal ZenNotes files";
              }
              return null;
            },
          });
          if (target === null || target === currentDir) return;
          await window.zen.moveAsset(vaultRel, target);
          await refreshAssets();
        },
      });
      items.push({
        label: "Duplicate",
        onSelect: async () => {
          await window.zen.duplicateAsset(vaultRel);
          await refreshAssets();
        },
      });
    }

    items.push({
      label: "Copy as Embed",
      disabled: !vaultRel,
      onSelect: async () => {
        if (vaultRel) window.zen.clipboardWriteText(`![[${vaultRel}]]`);
      },
    });
    items.push({
      label: "Copy Path",
      disabled: !vaultRel,
      onSelect: async () => {
        if (vaultRel) window.zen.clipboardWriteText(vaultRel);
      },
    });
    items.push({
      label: workspaceMode === "remote" ? "Copy Server Path" : "Copy Absolute Path",
      disabled: !vaultRel || !abs,
      onSelect: async () => {
        if (abs) window.zen.clipboardWriteText(abs);
      },
    });
    const assetHref = assetMenu.href;
    const fragment = hrefFragment(assetHref) || null;
    items.push(
      {
        label: "Open as Reference (This Note)",
        disabled: !vaultRel,
        onSelect: async () => {
          if (vaultRel) {
            pinAssetReferenceForNote(notePath, vaultRel, fragment);
          }
        },
      },
      {
        label: "Open as Reference (Global)",
        disabled: !vaultRel,
        onSelect: async () => {
          if (vaultRel) pinAssetReference(vaultRel, fragment);
        },
      },
    );

    if (canRevealInFileManager && vaultRel) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await window.zen.revealNote(vaultRel);
        },
      });
    }

    if (canDeleteAssets && vaultRel && asset) {
      items.push({ kind: "separator" });
      items.push({
        label: "Delete Asset…",
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Delete ${asset.name}?`,
            description:
              "This removes the file from the vault. Notes that embed it will keep the link, but the media will no longer render.",
            confirmLabel: "Delete asset",
            danger: true,
          });
          if (!ok) return;
          await deleteAssetAction(vaultRel);
        },
      });
    }

    return items;
  }, [
    assetMenu,
    assetFiles,
    canManageAssets,
    canDeleteAssets,
    canRevealInFileManager,
    deleteAssetAction,
    notePath,
    openNoteInTab,
    pinAssetReference,
    pinAssetReferenceForNote,
    refreshAssets,
    vault?.root,
    workspaceMode,
  ]);
  const closeAssetMenu = useCallback(() => setAssetMenu(null), []);

  return (
    <>
      <article
        data-preview-content
        ref={ref}
        className="prose-zen py-8"
        dir={resolveNoteDirection(markdown, rtlMode)}
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
          diagramMode={diagramTheme.mode}
          themeKey={diagramTheme.key}
          onOpenInTab={() => {
            const path = diagramTabPath(expandedDiagram.kind, expandedDiagram.source);
            setExpandedDiagram(null);
            void openNoteInTab(path);
          }}
          onClose={() => setExpandedDiagram(null)}
        />
      )}
    </>
  );
});

function ExpandedDiagramModal({
  diagram,
  diagramMode,
  themeKey,
  onOpenInTab,
  onClose,
}: {
  diagram: ExpandedDiagram;
  diagramMode: "light" | "dark";
  themeKey: string;
  onOpenInTab: () => void;
  onClose: () => void;
}): JSX.Element {
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFullScreen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={[
        "fixed inset-0 z-popover flex bg-black/60 backdrop-blur-sm",
        fullScreen
          ? "items-start justify-center p-0"
          : "items-center justify-center p-4 md:p-6",
      ].join(" ")}
      onClick={onClose}
    >
      <DiagramPanZoomFrame
        diagram={diagram}
        diagramMode={diagramMode}
        themeKey={themeKey}
        variant="modal"
        title="Expanded diagram"
        fullScreen={fullScreen}
        onToggleFullScreen={() => setFullScreen((value) => !value)}
        onOpenInTab={onOpenInTab}
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}

export function DiagramTabView({
  diagram,
}: {
  diagram: DiagramTabPayload | null;
}): JSX.Element {
  const diagramTheme = useDiagramTheme();

  if (!diagram) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-100 px-6 text-sm text-ink-500">
        This temporary diagram tab is no longer available.
      </div>
    );
  }

  return (
    <DiagramPanZoomFrame
      diagram={diagram}
      diagramMode={diagramTheme.mode}
      themeKey={diagramTheme.key}
      variant="tab"
      title={diagramTitleFromKind(diagram.kind)}
    />
  );
}

function DiagramPanZoomFrame({
  diagram,
  diagramMode,
  themeKey,
  variant,
  title,
  fullScreen = false,
  onToggleFullScreen,
  onOpenInTab,
  onClose,
}: {
  diagram: ExpandedDiagram;
  diagramMode: "light" | "dark";
  themeKey: string;
  variant: "modal" | "tab";
  title: string;
  fullScreen?: boolean;
  onToggleFullScreen?: () => void;
  onOpenInTab?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [transform, setTransform] = useState<DiagramPanZoomState>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  const transformRef = useRef(transform);
  const fillViewport = fullScreen || variant === "tab";

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const centerDiagram = useCallback((): void => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const viewportRect = viewport.getBoundingClientRect();
    const contentWidth = content.offsetWidth || content.getBoundingClientRect().width;
    const contentHeight = content.offsetHeight || content.getBoundingClientRect().height;
    setTransform(
      fitDiagramToViewport(
        { width: viewportRect.width, height: viewportRect.height },
        { width: contentWidth, height: contentHeight },
      ),
    );
  }, []);

  const zoomFromCenter = useCallback(
    (direction: 1 | -1): void => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      setTransform((state) =>
        zoomDiagramAtPoint(state, stepDiagramZoom(state.zoom, direction), {
          x: rect.width / 2,
          y: rect.height / 2,
        }),
      );
    },
    [],
  );

  useEffect(() => {
    requestAnimationFrame(centerDiagram);
  }, [centerDiagram, fillViewport]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const scheduleCenter = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(centerDiagram);
    };
    const observer = new ResizeObserver(scheduleCenter);
    observer.observe(viewport);
    if (contentRef.current) observer.observe(contentRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [centerDiagram]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setTransform({ zoom: 1, pan: { x: 0, y: 0 } });
    host.innerHTML = "";
    const el = document.createElement("div");
    el.className = DIAGRAM_CLASS_BY_KIND[diagram.kind];
    el.setAttribute(DIAGRAM_SOURCE_ATTR_BY_KIND[diagram.kind], diagram.source);
    el.dataset.zenDiagramKind = diagram.kind;
    el.dataset.zenDiagramSource = diagram.source;
    el.dataset.zenDiagramExpanded = "true";
    host.appendChild(el);

    const render = async (): Promise<void> => {
      if (diagram.kind === "mermaid") {
        await renderMermaidBlocks(host, diagramMode, { expanded: true });
      } else {
        await renderDiagrams(host, { themeKey, expanded: true });
      }
      if (!cancelled) requestAnimationFrame(centerDiagram);
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [centerDiagram, diagram, diagramMode, themeKey]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>): void => {
      e.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setTransform((state) =>
        zoomDiagramAtPoint(state, zoomFromWheelDelta(state.zoom, e.deltaY), point),
      );
    },
    [],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const current = transformRef.current;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: current.pan.x,
      originY: current.pan.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const stopDragging = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    setTransform((state) => ({
      ...state,
      pan: {
        x: drag.originX + e.clientX - drag.startX,
        y: drag.originY + e.clientY - drag.startY,
      },
    }));
  }, []);

  const handleViewportKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const panStep = e.shiftKey ? 80 : 32;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomFromCenter(1);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomFromCenter(-1);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        centerDiagram();
        return;
      }
      const delta =
        e.key === "ArrowLeft"
          ? { x: panStep, y: 0 }
          : e.key === "ArrowRight"
            ? { x: -panStep, y: 0 }
            : e.key === "ArrowUp"
              ? { x: 0, y: panStep }
              : e.key === "ArrowDown"
                ? { x: 0, y: -panStep }
                : null;
      if (!delta) return;
      e.preventDefault();
      setTransform((state) => ({
        ...state,
        pan: { x: state.pan.x + delta.x, y: state.pan.y + delta.y },
      }));
    },
    [centerDiagram, zoomFromCenter],
  );

  return (
    <div
      className={[
        "flex overflow-hidden border border-paper-300/70 bg-paper-100",
        variant === "tab"
          ? "min-h-0 flex-1 flex-col rounded-none border-0 shadow-none"
          : fullScreen
            ? "zen-diagram-modal-shell-fullscreen flex-col rounded-none border-0 shadow-float"
            : "w-[min(1360px,96vw)] flex-col rounded-2xl shadow-float",
      ].join(" ")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-paper-300/60 px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-ink-900">
            {title}
          </div>
          <div className="text-xs uppercase tracking-wide text-ink-500">
            {diagram.kind}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => zoomFromCenter(-1)}
            className="zen-diagram-modal-control"
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={centerDiagram}
            className="zen-diagram-modal-zoom"
            aria-label="Reset zoom"
            title="Reset zoom"
          >
            {diagramZoomLabel(transform.zoom)}
          </button>
          <button
            type="button"
            onClick={() => zoomFromCenter(1)}
            className="zen-diagram-modal-control"
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          {onOpenInTab && (
            <button
              type="button"
              onClick={onOpenInTab}
              className="zen-diagram-modal-control"
              aria-label="Open diagram in tab"
              title="Open in tab"
            >
              <ArrowUpRightIcon className="h-4 w-4" />
            </button>
          )}
          {onToggleFullScreen && (
            <button
              type="button"
              onClick={onToggleFullScreen}
              className="zen-diagram-modal-control"
              aria-pressed={fullScreen}
              aria-label={fullScreen ? "Exit full screen" : "Open full screen"}
              title={fullScreen ? "Exit full screen" : "Full screen"}
            >
              {fullScreen ? (
                <MinimizeIcon className="h-4 w-4" />
              ) : (
                <MaximizeIcon className="h-4 w-4" />
              )}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="zen-diagram-modal-control"
              aria-label="Close expanded diagram"
              title="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div
        className={[
          "p-3 md:p-4",
          fillViewport ? "min-h-0 flex-1" : "",
        ].join(" ")}
      >
        <div
          ref={viewportRef}
          className={[
            "zen-diagram-pan-viewport",
            fillViewport ? "zen-diagram-pan-viewport-fill" : "",
          ].join(" ")}
          tabIndex={0}
          role="region"
          aria-label="Expanded diagram viewport"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onDoubleClick={centerDiagram}
          onKeyDown={handleViewportKeyDown}
        >
          <div
            ref={contentRef}
            className="zen-diagram-pan-content"
            style={{
              transform: `translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.zoom})`,
            }}
          >
            <div ref={hostRef} className="zen-diagram-modal-host" />
          </div>
        </div>
      </div>
    </div>
  );
}
