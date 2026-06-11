import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isArchiveViewActive,
  isHelpViewActive,
  isQuickNotesViewActive,
  isTagsViewActive,
  isTasksViewActive,
  isTrashViewActive,
  useStore,
} from "../store";
import { confirmMoveToTrash } from "../lib/confirm-trash";
import { buildMoveNotePrompt, parseMoveNoteTarget } from "../lib/move-note";
import { extractTags } from "../lib/tags";
import type { AssetMeta, FolderEntry, FolderIconId, NoteFolder, NoteMeta } from "@shared/ipc";
import type { NoteSortOrder } from "../store";
import { isArchiveTabPath } from "@shared/archive";
import { isTrashTabPath } from "@shared/trash";
import { isQuickNotesTabPath } from "@shared/quick-notes";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronRightIcon,
  CheckSquareIcon,
  CloseIcon,
  DocumentIcon,
  ExpandAllIcon,
  FolderPlusIcon,
  NotePlusIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
  TargetIcon,
  TrashIcon,
} from "./icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ResizeHandle } from "./ResizeHandle";
import { VaultBadge } from "./VaultBadge";
import { confirmApp } from '../lib/confirm-requests'
import { promptApp } from '../lib/prompt-requests'
import { resolveQuickNoteTitle } from "../lib/quick-note-title";
import { recordRendererPerf } from "../lib/perf";
import {
  assetFolderSubpath,
  folderIconKey,
  isPrimaryNotesAtRoot,
  folderForVaultRelativePath,
  normalizeVaultSettings,
  noteFolderSubpath,
} from "../lib/vault-layout";
import {
  hasZenItem,
  readDragPayload,
  setDragPayload,
  type DragPayload,
} from "../lib/dnd";
import { resolveSystemFolderLabels } from "../lib/system-folder-labels";
import { assetTabPath } from "../lib/asset-tabs";
import {
  FolderGlyphIcon,
  resolveFolderIconId,
  resolveFolderIconOption,
} from "./FolderIcons";
import { FolderIconPickerModal } from "./FolderIconPickerModal";
import {
  getSidebarEdgePrefetchPaths,
  getSidebarEntryLimitIncludingIndex,
  getInitialSidebarEntryLimit,
  getNextSidebarEntryLimit,
  SIDEBAR_PROGRESSIVE_RENDER_THRESHOLD,
  SIDEBAR_PROGRESSIVE_SENTINEL_MARGIN_PX,
} from "../lib/sidebar-progressive";
import {
  getScrollTopForPreservedSidebarAnchor,
  isRecentSidebarPointerInteraction,
} from "../lib/sidebar-scroll";
import { buildVaultSwitcherEntries } from "../lib/vault-switcher";
import { appUpdateBadgeLabel, useAppUpdateState } from "../lib/app-update-state";

const ACTIVE_TAG_PARSE_DELAY_MS = 220;
const ACTIVE_TAG_PARSE_LARGE_BODY_CHARS = 120_000;
const ACTIVE_TAG_PARSE_LARGE_BODY_DELAY_MS = 900;

function escapeForAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function sidebarAnchorSelectorForElement(el: HTMLElement): string | null {
  const type = el.dataset.sidebarType;
  if (!type) return null;

  if (type === "folder") {
    const key = el.dataset.sidebarKey;
    if (!key) return null;
    return `[data-sidebar-type="folder"][data-sidebar-key="${escapeForAttr(key)}"]`;
  }

  if (type === "note" || type === "asset") {
    const path = el.dataset.sidebarPath;
    if (!path) return null;
    return `[data-sidebar-path="${escapeForAttr(path)}"]`;
  }

  if (type === "tag") {
    const tag = el.dataset.sidebarTag;
    if (!tag) return null;
    return `[data-sidebar-type="tag"][data-sidebar-tag="${escapeForAttr(tag)}"]`;
  }

  return `[data-sidebar-type="${escapeForAttr(type)}"]`;
}

function defaultNewNoteTarget(
  activeNote: NoteMeta | null,
  vaultSettings: ReturnType<typeof useStore.getState>["vaultSettings"],
): { folder: NoteFolder; subpath: string } {
  if (!activeNote) return { folder: "inbox", subpath: "" };
  return {
    folder: activeNote.folder,
    subpath: noteFolderSubpath(activeNote, vaultSettings),
  };
}

function remoteWorkspaceLabel(baseUrl: string | null): string {
  if (!baseUrl) return "Remote vault";
  try {
    const url = new URL(baseUrl);
    return url.host || "Remote vault";
  } catch {
    return baseUrl;
  }
}

function SidebarGlyph({
  active,
  rowActive,
  children,
}: {
  active: boolean;
  rowActive: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <span
      className={[
        "flex h-5 w-5 shrink-0 items-center justify-center transition-colors",
        active ? "text-white" : rowActive ? "text-accent" : "text-ink-500 group-hover:text-ink-800",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function SidebarSectionHeading({
  label,
  onDropPayload,
}: {
  label: string;
  onDropPayload?: (payload: DragPayload) => void | Promise<void>;
}): JSX.Element {
  const [dragHover, setDragHover] = useState(false);
  const droppable = !!onDropPayload;

  return (
    <div
      className={[
        "rounded-lg px-2 pb-2 pt-4 text-xs font-medium uppercase tracking-wide transition-colors",
        dragHover ? "bg-accent/10 text-accent" : "text-ink-500",
      ].join(" ")}
      onDragOver={
        droppable
          ? (e) => {
              if (!hasZenItem(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragHover(true);
            }
          : undefined
      }
      onDragLeave={
        droppable
          ? () => {
              setDragHover(false);
            }
          : undefined
      }
      onDrop={
        droppable
          ? (e) => {
              setDragHover(false);
              const payload = readDragPayload(e);
              if (!payload) return;
              e.preventDefault();
              void onDropPayload(payload);
            }
          : undefined
      }
    >
      {label}
    </div>
  );
}

function vaultRelativeFolderPath(
  folder: NoteFolder,
  subpath: string,
  vaultSettings: ReturnType<typeof useStore.getState>["vaultSettings"],
): string {
  if (folder === "inbox" && isPrimaryNotesAtRoot(vaultSettings)) return subpath;
  return subpath ? `${folder}/${subpath}` : folder;
}

type SidebarSelectionItem =
  | { kind: "note"; path: string }
  | { kind: "folder"; folder: NoteFolder; subpath: string };

function noteSelectionKey(path: string): string {
  return `note:${encodeURIComponent(path)}`;
}

function folderSelectionKey(folder: NoteFolder, subpath: string): string {
  return `folder:${folder}:${encodeURIComponent(subpath)}`;
}

function selectionKeyForItem(item: SidebarSelectionItem): string {
  return item.kind === "note"
    ? noteSelectionKey(item.path)
    : folderSelectionKey(item.folder, item.subpath);
}

function parseSelectionKey(key: string): SidebarSelectionItem | null {
  if (key.startsWith("note:")) {
    return { kind: "note", path: decodeURIComponent(key.slice("note:".length)) };
  }
  if (key.startsWith("folder:")) {
    const rest = key.slice("folder:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    const folder = rest.slice(0, sep) as NoteFolder;
    if (
      folder !== "inbox" &&
      folder !== "quick" &&
      folder !== "archive" &&
      folder !== "trash"
    ) {
      return null;
    }
    return {
      kind: "folder",
      folder,
      subpath: decodeURIComponent(rest.slice(sep + 1)),
    };
  }
  return null;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function selectionSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

function folderContainsFolder(
  parent: { folder: NoteFolder; subpath: string },
  child: { folder: NoteFolder; subpath: string },
): boolean {
  return (
    parent.folder === child.folder &&
    parent.subpath !== child.subpath &&
    !!parent.subpath &&
    child.subpath.startsWith(`${parent.subpath}/`)
  );
}

function compactFolderSelection(
  folders: Array<{ folder: NoteFolder; subpath: string }>,
): Array<{ folder: NoteFolder; subpath: string }> {
  return folders.filter(
    (candidate) =>
      !folders.some((other) => folderContainsFolder(other, candidate)),
  );
}

function noteIsInsideFolder(
  notePath: string,
  folder: { folder: NoteFolder; subpath: string },
  vaultSettings: ReturnType<typeof useStore.getState>["vaultSettings"],
): boolean {
  const rel = vaultRelativeFolderPath(folder.folder, folder.subpath, vaultSettings);
  return !!rel && (notePath === rel || notePath.startsWith(`${rel}/`));
}

function RootFolderDropTarget({
  children,
  onDropPayload,
}: {
  children: JSX.Element;
  onDropPayload: (payload: DragPayload) => void | Promise<void>;
}): JSX.Element {
  const [dragHover, setDragHover] = useState(false);

  return (
    <div
      className={[
        "min-h-8 rounded-lg transition-colors",
        dragHover ? "bg-accent/10 ring-1 ring-accent/25" : "",
      ].join(" ")}
      onDragOver={(e) => {
        if (e.target !== e.currentTarget || !hasZenItem(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragHover(true);
      }}
      onDragLeave={() => setDragHover(false)}
      onDrop={(e) => {
        setDragHover(false);
        if (e.target !== e.currentTarget) return;
        const payload = readDragPayload(e);
        if (!payload) return;
        e.preventDefault();
        void onDropPayload(payload);
      }}
    >
      {children}
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const vault = useStore((s) => s.vault);
  const notes = useStore((s) => s.notes);
  const allFolders = useStore((s) => s.folders);
  const hasAssetsDir = useStore((s) => s.hasAssetsDir);
  const focusedPanel = useStore((s) => s.focusedPanel);
  const sidebarCursorIndex = useStore((s) => s.sidebarCursorIndex);
  const activeNote = useStore((s) => s.activeNote);
  const activeDirty = useStore((s) => s.activeDirty);
  const vaultSettings = useStore((s) => s.vaultSettings);
  const view = useStore((s) => s.view);
  const assetFiles = useStore((s) => s.assetFiles);
  const setView = useStore((s) => s.setView);
  const openTasksView = useStore((s) => s.openTasksView);
  const tasksViewActive = useStore(isTasksViewActive);
  const openQuickNotesView = useStore((s) => s.openQuickNotesView);
  const quickNotesViewActive = useStore(isQuickNotesViewActive);
  const openHelpView = useStore((s) => s.openHelpView);
  const helpViewActive = useStore(isHelpViewActive);
  const openArchiveView = useStore((s) => s.openArchiveView);
  const archiveViewActive = useStore(isArchiveViewActive);
  const openTrashView = useStore((s) => s.openTrashView);
  const trashViewActive = useStore(isTrashViewActive);
  const openTagView = useStore((s) => s.openTagView);
  const selectedTags = useStore((s) => s.selectedTags);
  const tagsViewActive = useStore(isTagsViewActive);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const createDatabase = useStore((s) => s.createDatabase);
  const createNoteInChosenFolder = useStore((s) => s.createNoteInChosenFolder);
  const openTemplatePaletteForFolder = useStore((s) => s.openTemplatePaletteForFolder);
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle);
  const quickNoteTitlePrefix = useStore((s) => s.quickNoteTitlePrefix);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setFocusedPanel = useStore((s) => s.setFocusedPanel);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const appUpdateState = useAppUpdateState();
  const renameTag = useStore((s) => s.renameTag);
  const deleteTag = useStore((s) => s.deleteTag);
  const tagsCollapsed = useStore((s) => s.tagsCollapsed);
  const setTagsCollapsed = useStore((s) => s.setTagsCollapsed);
  const showSidebarChevrons = useStore((s) => s.showSidebarChevrons);
  const createFolderAction = useStore((s) => s.createFolder);
  const renameFolderAction = useStore((s) => s.renameFolder);
  const deleteFolderAction = useStore((s) => s.deleteFolder);
  const duplicateFolderAction = useStore((s) => s.duplicateFolder);
  const revealFolderAction = useStore((s) => s.revealFolder);
  const revealAssetsDir = useStore((s) => s.revealAssetsDir);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const deleteAssetAction = useStore((s) => s.deleteAsset);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const noteSortOrder = useStore((s) => s.noteSortOrder);
  const setNoteSortOrder = useStore((s) => s.setNoteSortOrder);
  const groupByKind = useStore((s) => s.groupByKind);
  const setGroupByKind = useStore((s) => s.setGroupByKind);
  const autoReveal = useStore((s) => s.autoReveal);
  const setAutoReveal = useStore((s) => s.setAutoReveal);
  const unifiedSidebar = useStore((s) => s.unifiedSidebar);
  const selectNote = useStore((s) => s.selectNote);
  const previewNote = useStore((s) => s.previewNote);
  const selectedPath = useStore((s) => s.selectedPath);
  const tabsEnabled = useStore((s) => s.tabsEnabled);
  const openNoteInTab = useStore((s) => s.openNoteInTab);
  const systemFolderLabels = useStore((s) => s.systemFolderLabels);
  const workspaceMode = useStore((s) => s.workspaceMode);
  const remoteWorkspaceInfo = useStore((s) => s.remoteWorkspaceInfo);
  const localVaults = useStore((s) => s.localVaults);
  const remoteWorkspaceProfiles = useStore((s) => s.remoteWorkspaceProfiles);
  const openVaultPicker = useStore((s) => s.openVaultPicker);
  const openLocalVault = useStore((s) => s.openLocalVault);
  const closeVault = useStore((s) => s.closeVault);
  const connectRemoteWorkspace = useStore((s) => s.connectRemoteWorkspace);
  const connectRemoteWorkspaceProfile = useStore(
    (s) => s.connectRemoteWorkspaceProfile,
  );
  const refreshLocalVaults = useStore((s) => s.refreshLocalVaults);
  const refreshRemoteWorkspaceProfiles = useStore(
    (s) => s.refreshRemoteWorkspaceProfiles,
  );
  const moveNoteAction = useStore((s) => s.moveNote);
  const renameNote = useStore((s) => s.renameNote);
  const setVaultSettings = useStore((s) => s.setVaultSettings);
  const canRevealInFileManager =
    window.zen.getAppInfo().runtime === "desktop" && workspaceMode !== "remote";
  const appUpdateBadge = appUpdateBadgeLabel(appUpdateState);
  const appUpdateSettingsTitle =
    appUpdateState?.phase === "downloaded"
      ? "Settings, update ready to install"
      : appUpdateState?.phase === "downloading"
        ? "Settings, update downloading"
        : appUpdateState?.phase === "available"
          ? "Settings, update available"
          : "Settings";
  const canSwitchLocalVaults =
    window.zen.getAppInfo().runtime === "desktop" &&
    window.zen.getCapabilities().supportsLocalFilesystemPickers;
  const canUseRemoteWorkspaces =
    window.zen.getAppInfo().runtime === "desktop" &&
    window.zen.getCapabilities().supportsRemoteWorkspace;
  const canSwitchVaults = canSwitchLocalVaults || canUseRemoteWorkspaces;
  const canCloseCurrentVault = canSwitchLocalVaults && workspaceMode !== "remote" && !!vault;
  const absolutePathLabel =
    workspaceMode === "remote" ? "Copy Server Path" : "Copy Absolute Path";
  const canManageAssetFiles =
    window.zen.getAppInfo().runtime === "desktop" &&
    workspaceMode !== "remote" &&
    typeof window.zen.renameAsset === "function" &&
    typeof window.zen.moveAsset === "function" &&
    typeof window.zen.duplicateAsset === "function";
  const canDeleteAssets =
    window.zen.getAppInfo().runtime === "desktop" &&
    workspaceMode !== "remote";
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels),
    [systemFolderLabels],
  );
  const openAssetInTab = useCallback(
    (path: string): void => {
      void openNoteInTab(assetTabPath(path));
    },
    [openNoteInTab],
  );
  const handleSelectNote = useCallback(
    (path: string): void => {
      // Single click opens a VS Code-style preview tab; without tabs there
      // is nothing to preview, so fall back to a plain open.
      if (tabsEnabled) void previewNote(path);
      else void selectNote(path);
    },
    [previewNote, selectNote, tabsEnabled],
  );
  const remoteLabel = useMemo(
    () => remoteWorkspaceLabel(remoteWorkspaceInfo?.baseUrl ?? null),
    [remoteWorkspaceInfo?.baseUrl],
  );
  const vaultSwitcherEntries = useMemo(
    () =>
      buildVaultSwitcherEntries({
        localVaults,
        remoteProfiles: remoteWorkspaceProfiles,
        currentVault: vault,
        workspaceMode,
        remoteWorkspaceInfo,
      }),
    [localVaults, remoteWorkspaceInfo, remoteWorkspaceProfiles, vault, workspaceMode],
  );
  const primaryNotesAtRoot = useMemo(
    () => isPrimaryNotesAtRoot(vaultSettings),
    [vaultSettings],
  );
  const [selectedSidebarKeys, setSelectedSidebarKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(
    null,
  );
  const selectedSidebarItems = useMemo(() => {
    const notePaths = new Set(notes.map((note) => note.path));
    const folderKeys = new Set(
      allFolders.map((folder) =>
        folderSelectionKey(folder.folder, folder.subpath),
      ),
    );
    const out: SidebarSelectionItem[] = [];
    for (const key of selectedSidebarKeys) {
      const item = parseSelectionKey(key);
      if (!item) continue;
      if (item.kind === "note" && notePaths.has(item.path)) out.push(item);
      if (item.kind === "folder" && folderKeys.has(key)) out.push(item);
    }
    return out;
  }, [allFolders, notes, selectedSidebarKeys]);
  const selectedFolderItems = useMemo(
    () =>
      compactFolderSelection(
        selectedSidebarItems
          .filter((item): item is Extract<SidebarSelectionItem, { kind: "folder" }> =>
            item.kind === "folder",
          )
          .map((item) => ({ folder: item.folder, subpath: item.subpath })),
      ),
    [selectedSidebarItems],
  );
  const selectedNoteMetas = useMemo(() => {
    const selectedPaths = new Set(
      selectedSidebarItems
        .filter((item): item is Extract<SidebarSelectionItem, { kind: "note" }> =>
          item.kind === "note",
        )
        .map((item) => item.path),
    );
    return notes.filter((note) => selectedPaths.has(note.path));
  }, [notes, selectedSidebarItems]);
  const selectedNoteMetasForAction = useMemo(
    () =>
      selectedNoteMetas.filter(
        (note) =>
          !selectedFolderItems.some((folder) =>
            noteIsInsideFolder(note.path, folder, vaultSettings),
          ),
      ),
    [selectedFolderItems, selectedNoteMetas, vaultSettings],
  );
  const selectedSidebarCount =
    selectedNoteMetas.length +
    selectedSidebarItems.filter((item) => item.kind === "folder").length;
  const selectionAnchorKeyRef = useRef(selectionAnchorKey);
  const selectedSidebarKeysRef = useRef(selectedSidebarKeys);
  const selectedSidebarItemsRef = useRef(selectedSidebarItems);
  const selectedSidebarCountRef = useRef(selectedSidebarCount);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const lastSidebarPointerAtRef = useRef(0);
  const pendingSidebarScrollAnchorRef = useRef<{
    selector: string;
    top: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    selectionAnchorKeyRef.current = selectionAnchorKey;
  }, [selectionAnchorKey]);

  useEffect(() => {
    selectedSidebarKeysRef.current = selectedSidebarKeys;
    selectedSidebarItemsRef.current = selectedSidebarItems;
    selectedSidebarCountRef.current = selectedSidebarCount;
  }, [selectedSidebarCount, selectedSidebarItems, selectedSidebarKeys]);

  const captureSidebarScrollAnchor = useCallback((target: EventTarget | null): void => {
    const scroller = sidebarScrollRef.current;
    const row =
      target instanceof HTMLElement
        ? (target.closest("[data-sidebar-idx]") as HTMLElement | null)
        : null;
    if (!scroller || !row || !scroller.contains(row)) return;
    const selector = sidebarAnchorSelectorForElement(row);
    if (!selector) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    pendingSidebarScrollAnchorRef.current = {
      selector,
      top: rowRect.top - scrollerRect.top,
      scrollTop: scroller.scrollTop,
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingSidebarScrollAnchorRef.current;
    if (!pending) return;
    pendingSidebarScrollAnchorRef.current = null;

    const scroller = sidebarScrollRef.current;
    const target = document.querySelector<HTMLElement>(pending.selector);
    if (!scroller || !target || !scroller.contains(target)) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    scroller.scrollTop = getScrollTopForPreservedSidebarAnchor({
      scrollTop: pending.scrollTop,
      anchorTop: pending.top,
      nextAnchorTop: targetRect.top - scrollerRect.top,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
  });

  useEffect(() => {
    const availableKeys = new Set<string>();
    for (const note of notes) availableKeys.add(noteSelectionKey(note.path));
    for (const folder of allFolders) {
      availableKeys.add(folderSelectionKey(folder.folder, folder.subpath));
    }
    setSelectedSidebarKeys((prev) => {
      const next = new Set([...prev].filter((key) => availableKeys.has(key)));
      return selectionSetsEqual(prev, next) ? prev : next;
    });
    setSelectionAnchorKey((prev) =>
      prev && !availableKeys.has(prev) ? null : prev,
    );
  }, [allFolders, notes]);

  const getSelectableSidebarKeys = useCallback((): string[] => {
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-sidebar-select-key]"),
    )
      .map((el) => el.dataset.sidebarSelectKey)
      .filter((key): key is string => !!key);
  }, []);

  const selectSidebarRange = useCallback(
    (anchorKey: string, nextKey: string): Set<string> => {
      const visibleKeys = getSelectableSidebarKeys();
      const anchorIdx = visibleKeys.indexOf(anchorKey);
      const nextIdx = visibleKeys.indexOf(nextKey);
      if (anchorIdx === -1 || nextIdx === -1) return new Set([nextKey]);
      const [start, end] =
        anchorIdx < nextIdx ? [anchorIdx, nextIdx] : [nextIdx, anchorIdx];
      return new Set(visibleKeys.slice(start, end + 1));
    },
    [getSelectableSidebarKeys],
  );

  const handleSidebarItemSelect = useCallback(
    (
      event: React.MouseEvent | React.KeyboardEvent,
      item: SidebarSelectionItem,
      primaryAction: () => void,
    ): void => {
      const key = selectionKeyForItem(item);
      if (event.shiftKey) {
        event.preventDefault();
        const anchor = selectionAnchorKeyRef.current ?? key;
        setSelectedSidebarKeys(selectSidebarRange(anchor, key));
        setSelectionAnchorKey(anchor);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        setSelectedSidebarKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setSelectionAnchorKey(key);
        return;
      }
      setSelectedSidebarKeys(new Set());
      setSelectionAnchorKey(key);
      primaryAction();
    },
    [selectSidebarRange],
  );

  const prepareContextSelection = useCallback(
    (item: SidebarSelectionItem): void => {
      const key = selectionKeyForItem(item);
      setSelectedSidebarKeys((prev) => {
        if (prev.has(key) && prev.size > 1) return prev;
        return new Set([key]);
      });
      setSelectionAnchorKey(key);
    },
    [],
  );

  const dragPayloadForItem = useCallback(
    (item: SidebarSelectionItem): DragPayload => {
      const key = selectionKeyForItem(item);
      const selectedKeys = selectedSidebarKeysRef.current;
      const selectedCount = selectedSidebarCountRef.current;
      if (selectedKeys.has(key) && selectedCount > 1) {
        return {
          kind: "multi",
          items: selectedSidebarItemsRef.current.map((selected) =>
            selected.kind === "note"
              ? { kind: "note", path: selected.path }
              : {
                  kind: "folder",
                  folder: selected.folder,
                  subpath: selected.subpath,
                },
          ),
        };
      }
      return item.kind === "note"
        ? { kind: "note", path: item.path }
        : { kind: "folder", folder: item.folder, subpath: item.subpath };
    },
    [],
  );

  /**
   * Handle a drag-drop onto a folder (top-level or subfolder). Both
   * notes and folders can be dropped — notes become members of the
   * target folder, folders get reparented.
   */
  const handleDropOnFolder = async (
    payload: DragPayload,
    targetFolder: NoteFolder,
    targetSubpath: string,
  ): Promise<void> => {
    const moveFolder = async (
      folder: NoteFolder,
      subpath: string,
    ): Promise<void> => {
      if (folder !== targetFolder) {
        throw new Error(
          "Folders can only be moved within the same top-level folder.",
        );
      }
      if (!subpath) return; // top-level folder can't be moved
      const leaf = subpath.split("/").slice(-1)[0];
      const nextSubpath = targetSubpath ? `${targetSubpath}/${leaf}` : leaf;
      if (nextSubpath === subpath) return;
      if ((nextSubpath + "/").startsWith(subpath + "/")) {
        throw new Error("Cannot move a folder into itself.");
      }
      await renameFolderAction(folder, subpath, nextSubpath);
    };

    if (payload.kind === "multi") {
      const folders = compactFolderSelection(
        payload.items
          .filter(
            (
              item,
            ): item is Extract<
              Extract<DragPayload, { kind: "multi" }>["items"][number],
              { kind: "folder" }
            > => item.kind === "folder",
          )
          .map((item) => ({ folder: item.folder, subpath: item.subpath })),
      );
      const notes = payload.items.filter(
        (
          item,
        ): item is Extract<
          Extract<DragPayload, { kind: "multi" }>["items"][number],
          { kind: "note" }
        > => item.kind === "note",
      );
      const notesToMove = notes.filter(
        (note) =>
          !folders.some((folder) =>
            noteIsInsideFolder(note.path, folder, vaultSettings),
          ),
      );

      try {
        for (const folder of folders) {
          await moveFolder(folder.folder, folder.subpath);
        }
        for (const note of notesToMove) {
          await moveNoteAction(note.path, targetFolder, targetSubpath);
        }
        setSelectedSidebarKeys(new Set());
        setSelectionAnchorKey(null);
      } catch (err) {
        window.alert((err as Error).message);
      }
      return;
    }

    if (payload.kind === "note") {
      // Skip if dropping back into the same container.
      const curParts = payload.path.split("/");
      const curSub = curParts.slice(1, -1).join("/");
      const curFolder = curParts[0] as NoteFolder;
      if (curFolder === targetFolder && curSub === targetSubpath) return;
      await moveNoteAction(payload.path, targetFolder, targetSubpath);
      return;
    }
    if (payload.kind === "asset") return;
    // Folder drop — cross-top-folder moves aren't supported (folders
    // can't move between inbox/archive/trash). Same-top-folder moves
    // reparent the subfolder.
    try {
      await moveFolder(payload.folder, payload.subpath);
    } catch (err) {
      window.alert((err as Error).message);
    }
  };

  const [tagMenu, setTagMenu] = useState<{
    x: number;
    y: number;
    tag: string;
  } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{
    x: number;
    y: number;
    folder: NoteFolder;
    subpath: string; // "" for top-level
  } | null>(null);
  // Right-click on the empty area of the notes tree → create at the vault root.
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  const [assetMenu, setAssetMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [folderIconPicker, setFolderIconPicker] = useState<{
    folder: NoteFolder;
    subpath: string;
    label: string;
  } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [vaultMenu, setVaultMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    if (canSwitchLocalVaults) void refreshLocalVaults();
    if (canUseRemoteWorkspaces) void refreshRemoteWorkspaceProfiles();
  }, [
    canSwitchLocalVaults,
    canUseRemoteWorkspaces,
    refreshLocalVaults,
    refreshRemoteWorkspaceProfiles,
  ]);

  const openVaultSwitcher = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      if (!canSwitchVaults) return;
      event.preventDefault();
      if (canSwitchLocalVaults) void refreshLocalVaults();
      if (canUseRemoteWorkspaces) void refreshRemoteWorkspaceProfiles();
      setVaultMenu({ x: event.clientX, y: event.clientY });
    },
    [
      canSwitchLocalVaults,
      canSwitchVaults,
      canUseRemoteWorkspaces,
      refreshLocalVaults,
      refreshRemoteWorkspaceProfiles,
    ],
  );

  const openFolderIconPicker = useCallback(
    (folder: NoteFolder, subpath: string, label: string) => {
      setFolderMenu(null);
      setFolderIconPicker({ folder, subpath, label });
    },
    [],
  );

  const saveFolderIcon = useCallback(
    async (folder: NoteFolder, subpath: string, iconId: FolderIconId) => {
      const key = folderIconKey(folder, subpath);
      const nextSettings = normalizeVaultSettings({
        ...vaultSettings,
        folderIcons: {
          ...vaultSettings.folderIcons,
          [key]: iconId,
        },
      });
      await setVaultSettings(nextSettings);
      setFolderIconPicker(null);
    },
    [setVaultSettings, vaultSettings],
  );

  const resetFolderIcon = useCallback(
    async (folder: NoteFolder, subpath: string) => {
      const key = folderIconKey(folder, subpath);
      if (!(key in vaultSettings.folderIcons)) return;
      const nextIcons = { ...vaultSettings.folderIcons };
      delete nextIcons[key];
      const nextSettings = normalizeVaultSettings({
        ...vaultSettings,
        folderIcons: nextIcons,
      });
      await setVaultSettings(nextSettings);
      setFolderIconPicker(null);
    },
    [setVaultSettings, vaultSettings],
  );
  const [noteMenu, setNoteMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const refreshNotes = useStore((s) => s.refreshNotes);
  const collapsedList = useStore((s) => s.collapsedFolders);
  const toggleCollapseAction = useStore((s) => s.toggleCollapseFolder);
  const setCollapsedFoldersAction = useStore((s) => s.setCollapsedFolders);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const toggleCollapse = useCallback(
    (key: string): void => {
      const startedAt = performance.now();
      const nextCollapsed = !collapsed.has(key);
      toggleCollapseAction(key);
      requestAnimationFrame(() => {
        recordRendererPerf("sidebar.toggle-folder", performance.now() - startedAt, {
          key,
          nextCollapsed,
        });
      });
    },
    [collapsed, toggleCollapseAction],
  );
  const setCollapsed = (next: Set<string>): void =>
    setCollapsedFoldersAction([...next]);

  // Build a folder tree per top-level (quick + inbox + archive). Uses
  // the folders index from main so empty subfolders still appear in
  // the tree alongside ones that have notes. Trash is rendered
  // separately.
  const trees = useMemo(() => {
    const startedAt = performance.now();
    const next = {
      quick: buildTree(
        notes.filter((n) => n.folder === "quick"),
        assetFiles.filter(
          (asset) => folderForVaultRelativePath(asset.path, vaultSettings) === "quick",
        ),
        "quick",
        allFolders.filter((f) => f.folder === "quick"),
        vaultSettings,
      ),
      inbox: buildTree(
        notes.filter((n) => n.folder === "inbox"),
        assetFiles.filter(
          (asset) => folderForVaultRelativePath(asset.path, vaultSettings) === "inbox",
        ),
        "inbox",
        allFolders.filter((f) => f.folder === "inbox"),
        vaultSettings,
      ),
      archive: buildTree(
        notes.filter((n) => n.folder === "archive"),
        assetFiles.filter(
          (asset) => folderForVaultRelativePath(asset.path, vaultSettings) === "archive",
        ),
        "archive",
        allFolders.filter((f) => f.folder === "archive"),
        vaultSettings,
      ),
      trash: buildTree(
        notes.filter((n) => n.folder === "trash"),
        assetFiles.filter(
          (asset) => folderForVaultRelativePath(asset.path, vaultSettings) === "trash",
        ),
        "trash",
        allFolders.filter((f) => f.folder === "trash"),
        vaultSettings,
      ),
    };
    // Daily/Weekly directories are surfaced in their own pinned, date-grouped
    // section above NOTES (see DateNotesNav), so drop them from the inbox tree
    // to avoid showing them twice.
    const ds = normalizeVaultSettings(vaultSettings);
    const hideSubpaths = new Set<string>();
    if (ds.dailyNotes.enabled) hideSubpaths.add(ds.dailyNotes.directory);
    if (ds.weeklyNotes.enabled) hideSubpaths.add(ds.weeklyNotes.directory);
    if (hideSubpaths.size) {
      next.inbox = {
        ...next.inbox,
        children: next.inbox.children.filter((c) => !hideSubpaths.has(c.subpath)),
      };
    }
    recordRendererPerf("sidebar.tree-build", performance.now() - startedAt, {
      notes: notes.length,
      folders: allFolders.length,
      assets: assetFiles.length,
    });
    return next;
  }, [notes, allFolders, assetFiles, vaultSettings]);

  // Daily/weekly notes grouped for the pinned date-nav: daily by year → month →
  // day, weekly by year → week, all newest-first.
  const dateNav = useMemo(() => {
    const s = normalizeVaultSettings(vaultSettings);
    const dailyDir = s.dailyNotes.directory;
    const weeklyDir = s.weeklyNotes.directory;
    const daily: { year: number; total: number; months: { month: number; notes: NoteMeta[] }[] }[] =
      [];
    const weekly: { year: number; notes: NoteMeta[] }[] = [];

    if (s.dailyNotes.enabled) {
      const byYear = new Map<number, Map<number, NoteMeta[]>>();
      for (const n of notes) {
        if (n.folder !== "inbox") continue;
        if (noteFolderSubpath(n, vaultSettings) !== dailyDir) continue;
        const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(n.title);
        if (!m) continue;
        const year = Number(m[1]);
        const month = Number(m[2]) - 1;
        let months = byYear.get(year);
        if (!months) byYear.set(year, (months = new Map()));
        (months.get(month) ?? months.set(month, []).get(month)!).push(n);
      }
      for (const [year, months] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
        let total = 0;
        const mlist = [...months.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([month, ns]) => {
            ns.sort((a, b) => b.title.localeCompare(a.title));
            total += ns.length;
            return { month, notes: ns };
          });
        daily.push({ year, total, months: mlist });
      }
    }

    if (s.weeklyNotes.enabled) {
      const byYear = new Map<number, NoteMeta[]>();
      for (const n of notes) {
        if (n.folder !== "inbox") continue;
        if (noteFolderSubpath(n, vaultSettings) !== weeklyDir) continue;
        if (!/^\d{4}-W\d{2}$/.test(n.title)) continue;
        const year = Number(n.title.slice(0, 4));
        (byYear.get(year) ?? byYear.set(year, []).get(year)!).push(n);
      }
      for (const [year, ns] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
        ns.sort((a, b) => b.title.localeCompare(a.title));
        weekly.push({ year, notes: ns });
      }
    }

    return {
      dailyEnabled: s.dailyNotes.enabled,
      weeklyEnabled: s.weeklyNotes.enabled,
      dailyDir,
      weeklyDir,
      dailyLabel: dailyDir.split("/").pop() || dailyDir,
      weeklyLabel: weeklyDir.split("/").pop() || weeklyDir,
      daily,
      weekly,
      dailyTotal: daily.reduce((sum, y) => sum + y.total, 0),
      weeklyTotal: weekly.reduce((sum, y) => sum + y.notes.length, 0),
    };
  }, [notes, vaultSettings]);

  // Local (session) expand state for the pinned date-nav, default all collapsed.
  const [dateNavExpanded, setDateNavExpanded] = useState<Set<string>>(() => new Set());
  const toggleDateNav = useCallback((key: string) => {
    setDateNavExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const treeSortComparator = useMemo<
    ((a: NoteMeta, b: NoteMeta) => number) | null
  >(() => {
    switch (noteSortOrder) {
      case "none":
        return null;
      case "updated-asc":
        return (a: NoteMeta, b: NoteMeta) => a.updatedAt - b.updatedAt;
      case "created-desc":
        return (a: NoteMeta, b: NoteMeta) => b.createdAt - a.createdAt;
      case "created-asc":
        return (a: NoteMeta, b: NoteMeta) => a.createdAt - b.createdAt;
      case "name-asc":
        return (a: NoteMeta, b: NoteMeta) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      case "name-desc":
        return (a: NoteMeta, b: NoteMeta) =>
          b.title.localeCompare(a.title, undefined, { sensitivity: "base" });
      case "updated-desc":
      default:
        return (a: NoteMeta, b: NoteMeta) => b.updatedAt - a.updatedAt;
    }
  }, [noteSortOrder]);

  /** All folder keys currently present in the tree, for expand/collapse-all. */
  const allFolderKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (folder: NoteFolder, node: TreeNode): void => {
      // Include the top-level root key too.
      for (const child of node.children) {
        keys.push(`${folder}:${child.subpath}`);
        walk(folder, child);
      }
    };
    keys.push("inbox:");
    walk("inbox", trees.inbox);
    return keys;
  }, [trees]);

  const collapseAll = (): void => setCollapsed(new Set(allFolderKeys));
  const expandAll = (): void => setCollapsed(new Set());

  /**
   * Auto-reveal: whenever the active note changes, expand every
   * ancestor folder so the note is visible in the sidebar tree.
   * Only runs when the `autoReveal` preference is on.
   *
   * We also scroll the active note into view. Without that, the toggle
   * can feel inert unless the note happens to live inside a currently
   * collapsed folder.
   */
  const activePath =
    selectedPath && !selectedPath.startsWith("zen://") ? selectedPath : null;
  useEffect(() => {
    if (!autoReveal || !activePath) return;
    const startedAt = performance.now();
    const parts = activePath.split("/");
    const folder = parts[0] as NoteFolder;
    // Collect every ancestor key we need to make sure is expanded.
    const ancestors: string[] = [`${folder}:`];
    let acc = "";
    for (let i = 1; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      ancestors.push(`${folder}:${acc}`);
    }
    const prev = new Set(useStore.getState().collapsedFolders);
    let changed = false;
    for (const key of ancestors) {
      if (prev.has(key)) {
        prev.delete(key);
        changed = true;
      }
    }
    if (changed) setCollapsedFoldersAction([...prev]);

    let raf1 = 0;
    let raf2 = 0;
    const reveal = (): void => {
      const noteEl = document.querySelector(
        `[data-sidebar-path="${escapeForAttr(activePath)}"]`,
      ) as HTMLElement | null;
      if (noteEl) {
        noteEl.scrollIntoView({ block: "nearest" });
        recordRendererPerf("sidebar.auto-reveal", performance.now() - startedAt, {
          path: activePath,
          revealed: "note",
        });
        return;
      }

      const parts = activePath.split("/");
      const folder = parts[0] as NoteFolder;
      for (let i = parts.length - 1; i >= 1; i--) {
        const subpath = parts.slice(1, i).join("/");
        const folderEl = document.querySelector(
          `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(subpath)}"]`,
        ) as HTMLElement | null;
        if (folderEl) {
          folderEl.scrollIntoView({ block: "nearest" });
          recordRendererPerf("sidebar.auto-reveal", performance.now() - startedAt, {
            path: activePath,
            revealed: "folder",
          });
          return;
        }
      }
      recordRendererPerf("sidebar.auto-reveal", performance.now() - startedAt, {
        path: activePath,
        revealed: "miss",
      });
    };
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(reveal);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [autoReveal, activePath, selectedPath, setCollapsedFoldersAction]);

  const [activeBodyTagSnapshot, setActiveBodyTagSnapshot] = useState<{
    path: string;
    tags: string[];
  } | null>(null);

  useEffect(() => {
    const path = activeNote?.path ?? null;
    const body = activeNote?.body ?? null;
    if (!path || body == null || !activeDirty) {
      setActiveBodyTagSnapshot((current) => (current === null ? current : null));
      return;
    }

    let cancelled = false;
    let idleId: number | null = null;
    const parse = (): void => {
      idleId = null;
      if (cancelled) return;
      const startedAt = performance.now();
      const tags = extractTags(body);
      if (cancelled) return;
      const indexedTags =
        useStore.getState().notes.find((note) => note.path === path)?.tags ?? [];
      if (sameStringSet(tags, indexedTags)) {
        setActiveBodyTagSnapshot((current) =>
          current?.path === path ? null : current,
        );
      } else {
        setActiveBodyTagSnapshot({ path, tags });
      }
      recordRendererPerf("sidebar.active-tags", performance.now() - startedAt, {
        path,
        chars: body.length,
        tags: tags.length,
      });
    };

    const delayMs =
      body.length >= ACTIVE_TAG_PARSE_LARGE_BODY_CHARS
        ? ACTIVE_TAG_PARSE_LARGE_BODY_DELAY_MS
        : ACTIVE_TAG_PARSE_DELAY_MS;
    const timeoutId = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(parse, { timeout: 1_000 });
        return;
      }
      parse();
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (
        idleId != null &&
        typeof window.cancelIdleCallback === "function"
      ) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [activeDirty, activeNote?.body, activeNote?.path]);

  // Aggregate hashtags across non-trash notes. The active note's live
  // body is parsed only while it has unsaved edits; clean notes use the
  // indexed tags from note metadata and never reparse large bodies on open.
  const tags = useMemo(() => {
    const startedAt = performance.now();
    const counter = new Map<string, number>();
    const liveActivePath = activeBodyTagSnapshot?.path ?? null;
    const liveActiveTags = activeBodyTagSnapshot?.tags ?? null;
    for (const n of notes) {
      if (n.folder === "trash") continue;
      const list =
        liveActivePath === n.path && liveActiveTags ? liveActiveTags : n.tags;
      for (const t of list) counter.set(t, (counter.get(t) ?? 0) + 1);
    }
    const next = [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    recordRendererPerf("sidebar.tags", performance.now() - startedAt, {
      notes: notes.length,
      tags: next.length,
    });
    return next;
  }, [activeBodyTagSnapshot, notes]);

  const bulkSelectionMenuItems = useMemo<ContextMenuItem[] | null>(() => {
    if (selectedSidebarCount <= 1) return null;
    const liveNotes = selectedNoteMetasForAction.filter(
      (note) => note.folder !== "trash",
    );
    const archivableNotes = selectedNoteMetasForAction.filter(
      (note) => note.folder === "inbox" || note.folder === "quick",
    );
    const archivedNotes = selectedNoteMetasForAction.filter(
      (note) => note.folder === "archive",
    );
    const trashedNotes = selectedNoteMetasForAction.filter(
      (note) => note.folder === "trash",
    );
    const rootMoveFolders = selectedFolderItems.filter(
      (folder) =>
        primaryNotesAtRoot && folder.folder === "inbox" && folder.subpath.includes("/"),
    );
    const paths = [
      ...selectedNoteMetas.map((note) => note.path),
      ...selectedFolderItems.map((folder) =>
        vaultRelativeFolderPath(folder.folder, folder.subpath, vaultSettings),
      ),
    ].filter(Boolean);

    const clearSelection = (): void => {
      setSelectedSidebarKeys(new Set());
      setSelectionAnchorKey(null);
    };
    const refreshAndClear = async (): Promise<void> => {
      await refreshNotes();
      clearSelection();
    };
    const selectedActiveNote = selectedNoteMetas.some(
      (note) => note.path === selectedPath,
    );

    const items: ContextMenuItem[] = [
      {
        label: `${selectedSidebarCount} selected`,
        disabled: true,
      },
    ];

    if (selectedNoteMetas.length > 0 && tabsEnabled) {
      items.push({
        label: `Open ${selectedNoteMetas.length} note${selectedNoteMetas.length === 1 ? "" : "s"} in Tabs`,
        onSelect: async () => {
          for (const note of selectedNoteMetas) {
            await openNoteInTab(note.path);
          }
        },
      });
    }

    if (liveNotes.length > 0) {
      items.push({
        label: `Move ${liveNotes.length} note${liveNotes.length === 1 ? "" : "s"}…`,
        onSelect: async () => {
          const target = await promptApp(
            buildMoveNotePrompt(
              { title: `${liveNotes.length} notes`, path: liveNotes[0]!.path },
              allFolders,
            ),
          );
          if (!target) return;
          const dest = parseMoveNoteTarget(target);
          for (const note of liveNotes) {
            await window.zen.moveNote(note.path, dest.folder, dest.subpath);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
    }

    if (archivableNotes.length > 0) {
      items.push({
        label: `Move ${archivableNotes.length} note${archivableNotes.length === 1 ? "" : "s"} to ${folderLabels.archive}`,
        icon: <ArchiveIcon />,
        onSelect: async () => {
          for (const note of archivableNotes) {
            await window.zen.archiveNote(note.path);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
    }

    if (archivedNotes.length > 0) {
      items.push({
        label: `Move ${archivedNotes.length} archived note${archivedNotes.length === 1 ? "" : "s"} to ${folderLabels.inbox}`,
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          for (const note of archivedNotes) {
            await window.zen.unarchiveNote(note.path);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
    }

    if (liveNotes.length > 0) {
      items.push({
        label: `Move ${liveNotes.length} note${liveNotes.length === 1 ? "" : "s"} to ${folderLabels.trash}`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Move ${liveNotes.length} note${liveNotes.length === 1 ? "" : "s"} to ${folderLabels.trash}?`,
            description: "You can restore them from Trash later.",
            confirmLabel: `Move to ${folderLabels.trash}`,
            danger: true,
          });
          if (!ok) return;
          for (const note of liveNotes) {
            await window.zen.moveToTrash(note.path);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
    }

    if (trashedNotes.length > 0) {
      items.push({
        label: `Restore ${trashedNotes.length} note${trashedNotes.length === 1 ? "" : "s"}`,
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          for (const note of trashedNotes) {
            await window.zen.restoreFromTrash(note.path);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
      items.push({
        label: `Delete ${trashedNotes.length} note${trashedNotes.length === 1 ? "" : "s"} permanently`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Delete ${trashedNotes.length} note${trashedNotes.length === 1 ? "" : "s"} permanently?`,
            description: "This cannot be undone.",
            confirmLabel: "Delete permanently",
            danger: true,
          });
          if (!ok) return;
          for (const note of trashedNotes) {
            await window.zen.deleteNote(note.path);
          }
          if (selectedActiveNote) await selectNote(null);
          await refreshAndClear();
        },
      });
    }

    if (rootMoveFolders.length > 0) {
      items.push({
        label: `Move ${rootMoveFolders.length} folder${rootMoveFolders.length === 1 ? "" : "s"} to vault root`,
        onSelect: async () => {
          try {
            for (const folder of rootMoveFolders) {
              const leaf = folder.subpath.split("/").slice(-1)[0];
              if (!leaf || leaf === folder.subpath) continue;
              await renameFolderAction(folder.folder, folder.subpath, leaf);
            }
            clearSelection();
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
    }

    if (selectedFolderItems.length > 0) {
      items.push({
        label: `Delete ${selectedFolderItems.length} folder${selectedFolderItems.length === 1 ? "" : "s"}…`,
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Delete ${selectedFolderItems.length} folder${selectedFolderItems.length === 1 ? "" : "s"} and everything inside?`,
            description: "This cannot be undone.",
            confirmLabel: "Delete folders",
            danger: true,
          });
          if (!ok) return;
          try {
            for (const folder of selectedFolderItems) {
              await deleteFolderAction(folder.folder, folder.subpath);
            }
            clearSelection();
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
    }

    if (paths.length > 0) {
      items.push({ kind: "separator" });
      items.push({
        label: "Copy Paths",
        onSelect: async () => {
          window.zen.clipboardWriteText(paths.join("\n"));
        },
      });
    }

    return items;
  }, [
    allFolders,
    deleteFolderAction,
    folderLabels.archive,
    folderLabels.inbox,
    folderLabels.trash,
    openNoteInTab,
    primaryNotesAtRoot,
    refreshNotes,
    renameFolderAction,
    selectNote,
    selectedFolderItems,
    selectedNoteMetas,
    selectedNoteMetasForAction,
    selectedPath,
    selectedSidebarCount,
    tabsEnabled,
    vaultSettings,
  ]);

  const folderMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!folderMenu) return [];
    const { folder, subpath } = folderMenu;
    if (
      bulkSelectionMenuItems &&
      selectedSidebarKeys.has(folderSelectionKey(folder, subpath))
    ) {
      return bulkSelectionMenuItems;
    }
    const isTop = subpath === "";
    const label = isTop ? folderLabels[folder] : subpath.split("/").slice(-1)[0];
    const trashCount = notes.filter((note) => note.folder === "trash").length;
    const iconKey = folderIconKey(folder, subpath);
    const hasCustomIcon = Object.prototype.hasOwnProperty.call(
      vaultSettings.folderIcons,
      iconKey,
    );
    const iconItems: ContextMenuItem[] = [
      {
        label: "Change icon…",
        onSelect: async () => {
          openFolderIconPicker(folder, subpath, label);
        },
      },
      {
        label: "Reset icon",
        disabled: !hasCustomIcon,
        onSelect: async () => {
          await resetFolderIcon(folder, subpath);
        },
      },
    ];

    if (folder === "trash" && isTop) {
      return [
        {
          label: `Empty ${folderLabels.trash}…`,
          icon: <TrashIcon />,
          danger: true,
          disabled: trashCount === 0,
          onSelect: async () => {
            const ok = await confirmApp({
              title: `Delete ${trashCount} trashed note${trashCount === 1 ? "" : "s"} permanently?`,
              description: "This cannot be undone.",
              confirmLabel: `Empty ${folderLabels.trash}`,
              danger: true,
            });
            if (!ok) return;
            await window.zen.emptyTrash();
            await refreshNotes();
            if (selectedPath?.startsWith("trash/")) await selectNote(null);
          },
        },
        { kind: "separator" },
        ...iconItems,
      ];
    }

    const items: ContextMenuItem[] = [
      {
        label: "New note",
        onSelect: async () => {
          await createAndOpen(folder, subpath);
        },
      },
      {
        label: "New from template",
        onSelect: () => {
          openTemplatePaletteForFolder(folder, subpath);
        },
      },
      {
        label: "New database",
        onSelect: async () => {
          await createDatabase(folder, subpath);
        },
      },
    ];
    if (folder === "quick" && isTop) {
      items.push({
        label: "Open as Tab",
        onSelect: async () => {
          await openQuickNotesView();
        },
      });
    }
    if (folder === "archive" && isTop) {
      items.push({
        label: "Open as Tab",
        onSelect: async () => {
          await openArchiveView();
        },
      });
    }
    // Quick Notes is a flat folder — no nested subfolders allowed.
    if (folder !== "quick") {
      items.push({
        label: "New folder",
        onSelect: async () => {
          const name = await promptApp({
            title: `New folder inside "${label}"`,
            placeholder: "Folder name",
            okLabel: "Create",
            validate: (v) => {
              if (v.includes("/")) return 'Folder name cannot contain "/"';
              return null;
            },
          });
          if (!name) return;
          const clean = name.trim().replace(/^\/+|\/+$/g, "");
          if (!clean) return;
          const nextSubpath = subpath ? `${subpath}/${clean}` : clean;
          try {
            await createFolderAction(folder, nextSubpath);
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
    }

    if (!isTop) {
      items.push({ kind: "separator" });
      items.push({
        label: "Duplicate",
        onSelect: async () => {
          try {
            await duplicateFolderAction(folder, subpath);
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
      if (primaryNotesAtRoot && folder === "inbox" && subpath.includes("/")) {
        items.push({
          label: "Move to vault root",
          onSelect: async () => {
            const leaf = subpath.split("/").slice(-1)[0];
            if (!leaf || leaf === subpath) return;
            try {
              await renameFolderAction(folder, subpath, leaf);
            } catch (err) {
              window.alert((err as Error).message);
            }
          },
        });
      }
    }

    items.push({ kind: "separator" });
    items.push(...iconItems);
    items.push({ kind: "separator" });
    if (canRevealInFileManager) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await revealFolderAction(folder, subpath);
        },
      });
      if (
        allFolders.some(
          (f) => f.folder === folder && f.subpath === subpath && f.isSymlink,
        )
      ) {
        items.push({
          label: "Reveal Original Location",
          icon: <ArrowUpRightIcon />,
          onSelect: async () => {
            await window.zen.revealFolderTarget(folder, subpath);
          },
        });
      }
    }
    items.push({
      label: "Copy Path",
      onSelect: async () => {
        // Vault-relative POSIX path (e.g. `inbox/Work/Research`).
        const rel = vaultRelativeFolderPath(folder, subpath, vaultSettings);
        window.zen.clipboardWriteText(rel);
      },
    });
    items.push({
      label: absolutePathLabel,
      onSelect: async () => {
        // Native OS path using the platform separator — ready for Finder
        // / Explorer / terminal use.
        const root = vault?.root ?? "";
        const sep = root.includes("\\") ? "\\" : "/";
        const rel = vaultRelativeFolderPath(folder, subpath, vaultSettings);
        const parts = rel.split("/").filter(Boolean);
        window.zen.clipboardWriteText(
          [root.replace(/[\\/]+$/, ""), ...parts].join(sep),
        );
      },
    });

    if (!isTop) {
      items.push({ kind: "separator" });
      items.push({
        label: "Rename…",
        onSelect: async () => {
          const leaf = subpath.split("/").slice(-1)[0];
          const next = await promptApp({
            title: "Rename folder",
            initialValue: leaf,
            okLabel: "Rename",
            validate: (v) => {
              if (v.includes("/")) return "Use only a leaf name";
              return null;
            },
          });
          if (!next) return;
          const clean = next.trim().replace(/^\/+|\/+$/g, "");
          if (!clean || clean === leaf) return;
          const parent = subpath.split("/").slice(0, -1).join("/");
          const nextSubpath = parent ? `${parent}/${clean}` : clean;
          try {
            await renameFolderAction(folder, subpath, nextSubpath);
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
      items.push({
        label: "Delete folder…",
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Delete "${subpath}" and everything inside it?`,
            description: "This cannot be undone.",
            confirmLabel: "Delete folder",
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteFolderAction(folder, subpath);
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      });
    }

    return items;
  }, [
    folderMenu,
    notes,
    allFolders,
    vault,
    createAndOpen,
    createDatabase,
    openTemplatePaletteForFolder,
    openArchiveView,
    openQuickNotesView,
    createFolderAction,
    renameFolderAction,
    deleteFolderAction,
    duplicateFolderAction,
    canRevealInFileManager,
    absolutePathLabel,
    revealFolderAction,
    refreshNotes,
    selectedPath,
    selectNote,
    vaultSettings.folderIcons,
    vaultSettings,
    primaryNotesAtRoot,
    openFolderIconPicker,
    resetFolderIcon,
    bulkSelectionMenuItems,
    selectedSidebarKeys,
  ]);

  // Items for the empty-area (vault root) context menu.
  const rootMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: "New note",
        onSelect: async () => {
          await createAndOpen("inbox", "");
        },
      },
      {
        label: "New from template",
        onSelect: () => {
          openTemplatePaletteForFolder("inbox", "");
        },
      },
      {
        label: "New database",
        onSelect: async () => {
          await createDatabase("inbox", "");
        },
      },
      {
        label: "New folder",
        onSelect: async () => {
          const name = await promptApp({
            title: "New folder at the vault root",
            placeholder: "Folder name",
            okLabel: "Create",
            validate: (v) => (v.includes("/") ? 'Folder name cannot contain "/"' : null),
          });
          const clean = name?.trim().replace(/^\/+|\/+$/g, "");
          if (!clean) return;
          try {
            await createFolderAction("inbox", clean);
          } catch (err) {
            window.alert((err as Error).message);
          }
        },
      },
    ],
    [createAndOpen, createDatabase, openTemplatePaletteForFolder, createFolderAction],
  );

  const noteMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!noteMenu) return [];
    const n = notes.find((note) => note.path === noteMenu.path);
    if (!n) return [];
    if (
      bulkSelectionMenuItems &&
      selectedSidebarKeys.has(noteSelectionKey(n.path))
    ) {
      return bulkSelectionMenuItems;
    }
    const items: ContextMenuItem[] = [
      {
        label: "Open",
        onSelect: async () => {
          await selectNote(n.path);
        },
      },
    ];
    if (tabsEnabled) {
      items.push({
        label: "Open in New Tab",
        onSelect: async () => {
          await openNoteInTab(n.path);
        },
      });
    }
    if (n.folder !== "trash") {
      items.push({
        label: "Rename…",
        onSelect: async () => {
          const next = await promptApp({
            title: "Rename note",
            initialValue: n.title,
            okLabel: "Rename",
            validate: (v) => {
              if (/[\\/]/.test(v)) return "Title cannot contain / or \\";
              return null;
            },
          });
          if (!next || next === n.title) return;
          await renameNote(n.path, next);
        },
      });
      items.push({
        label: "Move…",
        onSelect: async () => {
          const target = await promptApp(buildMoveNotePrompt(n, allFolders));
          if (!target) return;
          const dest = parseMoveNoteTarget(target);
          await moveNoteAction(n.path, dest.folder, dest.subpath);
        },
      });
      items.push({
        label: "Duplicate",
        onSelect: async () => {
          const meta = await window.zen.duplicateNote(n.path);
          await refreshNotes();
          await selectNote(meta.path);
        },
      });
    }
    items.push({
      label: "Copy as Wikilink",
      onSelect: async () => {
        window.zen.clipboardWriteText(`[[${n.title}]]`);
      },
    });
    items.push({
      label: "Copy Path",
      onSelect: async () => {
        // Vault-relative POSIX path (what wikilinks and IPC use).
        window.zen.clipboardWriteText(n.path);
      },
    });
    items.push({
      label: absolutePathLabel,
      onSelect: async () => {
        // Join with the platform separator so the result can be pasted
        // directly into Finder / Explorer / a terminal.
        const root = vault?.root ?? "";
        const sep = root.includes("\\") ? "\\" : "/";
        const segments = n.path.split("/").filter(Boolean);
        const abs = [root.replace(/[\\/]+$/, ""), ...segments].join(sep);
        window.zen.clipboardWriteText(abs);
      },
    });
    items.push({
      label: "Open in Floating Window",
      onSelect: async () => {
        await window.zen.openNoteWindow(n.path);
      },
    });
    if (canRevealInFileManager) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await window.zen.revealNote(n.path);
        },
      });
      if (n.isSymlink) {
        items.push({
          label: "Reveal Original Location",
          icon: <ArrowUpRightIcon />,
          onSelect: async () => {
            await window.zen.revealNoteTarget(n.path);
          },
        });
      }
    }
    items.push({ kind: "separator" });
    if (n.folder === "inbox" || n.folder === "quick") {
      items.push({
        label: folderLabels.archive,
        icon: <ArchiveIcon />,
        onSelect: async () => {
          await window.zen.archiveNote(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(null);
        },
      });
      items.push({
        label: `Move to ${folderLabels.trash}`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          if (!(await confirmMoveToTrash(n.title))) return;
          await window.zen.moveToTrash(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(null);
        },
      });
    } else if (n.folder === "archive") {
      items.push({
        label: `Move to ${folderLabels.inbox}`,
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          const meta = await window.zen.unarchiveNote(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(meta.path);
        },
      });
      items.push({
        label: `Move to ${folderLabels.trash}`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          if (!(await confirmMoveToTrash(n.title))) return;
          await window.zen.moveToTrash(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(null);
        },
      });
    } else {
      items.push({
        label: "Restore",
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          const meta = await window.zen.restoreFromTrash(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(meta.path);
        },
      });
      items.push({
        label: "Delete Permanently",
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          await window.zen.deleteNote(n.path);
          await refreshNotes();
          if (selectedPath === n.path) await selectNote(null);
        },
      });
    }
    return items;
  }, [
    noteMenu,
    notes,
    allFolders,
    selectNote,
    selectedPath,
    refreshNotes,
    renameNote,
    moveNoteAction,
    canRevealInFileManager,
    absolutePathLabel,
    tabsEnabled,
    openNoteInTab,
    bulkSelectionMenuItems,
    selectedSidebarKeys,
    folderLabels.archive,
    folderLabels.inbox,
    folderLabels.trash,
  ]);

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return [];
    const asset = assetFiles.find((entry) => entry.path === assetMenu.path);
    if (!asset) return [];

    const root = vault?.root ?? "";
    const sep = root.includes("\\") ? "\\" : "/";
    const abs = [root.replace(/[\\/]+$/, ""), ...asset.path.split("/").filter(Boolean)].join(
      sep,
    );
    const currentDir = asset.path.split("/").slice(0, -1).join("/");
    const openAsset = async (): Promise<void> => {
      await openNoteInTab(assetTabPath(asset.path));
    };

    const items: ContextMenuItem[] = [
      {
        label: "Open",
        onSelect: openAsset,
      },
      {
        label: "Open in New Tab",
        onSelect: openAsset,
      },
    ];

    if (canManageAssetFiles) {
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
          await window.zen.renameAsset(asset.path, next);
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
          await window.zen.moveAsset(asset.path, target);
          await refreshAssets();
        },
      });
      items.push({
        label: "Duplicate",
        onSelect: async () => {
          await window.zen.duplicateAsset(asset.path);
          await refreshAssets();
        },
      });
    }

    items.push({
      label: "Copy as Embed",
      onSelect: async () => {
        window.zen.clipboardWriteText(`![[${asset.path}]]`);
      },
    });
    items.push({
      label: "Copy Path",
      onSelect: async () => {
        window.zen.clipboardWriteText(asset.path);
      },
    });
    items.push({
      label: absolutePathLabel,
      onSelect: async () => {
        window.zen.clipboardWriteText(abs);
      },
    });

    if (canRevealInFileManager) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await window.zen.revealNote(asset.path);
        },
      });
    }

    if (canDeleteAssets) {
      items.push({ kind: "separator" });
      items.push({
        label: "Delete Asset…",
        icon: <TrashIcon />,
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
          await deleteAssetAction(asset.path);
        },
      });
    }

    return items;
  }, [
    assetMenu,
    assetFiles,
    canRevealInFileManager,
    canManageAssetFiles,
    canDeleteAssets,
    absolutePathLabel,
    vault,
    openNoteInTab,
    refreshAssets,
    deleteAssetAction,
  ]);

  const tagMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!tagMenu) return [];
    const tag = tagMenu.tag;
    return [
      {
        label: `Copy #${tag}`,
        onSelect: async () => {
          await navigator.clipboard.writeText(`#${tag}`);
        },
      },
      {
        label: "Rename tag…",
        onSelect: async () => {
          const next = await promptApp({
            title: `Rename #${tag}`,
            initialValue: tag,
            okLabel: "Rename",
            validate: (v) => {
              const clean = v.replace(/^#/, "").trim();
              if (!/^[a-zA-Z][\w\-/]*$/.test(clean)) {
                return "Tag must start with a letter and contain only letters, digits, -, _, or /";
              }
              return null;
            },
          });
          if (!next) return;
          const clean = next.replace(/^#/, "").trim();
          if (!clean || clean === tag) return;
          await renameTag(tag, clean);
        },
      },
      { kind: "separator" },
      {
        label: "Delete tag from all notes",
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `Remove #${tag} from every note that contains it?`,
            description: "The notes themselves are left intact.",
            confirmLabel: "Remove tag",
            danger: true,
          });
          if (!ok) return;
          await deleteTag(tag);
        },
      },
    ];
  }, [tagMenu, renameTag, deleteTag]);

  const vaultMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];

    if (vaultSwitcherEntries.length === 0) {
      items.push({
        label: "No vaults yet",
        disabled: true,
      });
    } else {
      for (const entry of vaultSwitcherEntries) {
        items.push({
          label: entry.name,
          hint: entry.current ? "Current" : entry.kind === "remote" ? "Remote" : undefined,
          icon: <VaultBadge name={entry.name} size={16} />,
          disabled: entry.current || (entry.kind === "remote" && !entry.id),
          onSelect: async () => {
            if (entry.kind === "local") {
              await openLocalVault(entry.root);
              return;
            }
            if (entry.id) await connectRemoteWorkspaceProfile(entry.id);
          },
        });
      }
    }

    items.push({ kind: "separator" });
    if (canCloseCurrentVault) {
      items.push({
        label: "Close Current Vault",
        icon: <CloseIcon className="h-4 w-4" />,
        onSelect: async () => {
          await closeVault();
        },
      });
    }
    if (canSwitchLocalVaults) {
      items.push({
        label: "Add Local Vault…",
        icon: <PlusIcon className="h-4 w-4" />,
        onSelect: async () => {
          await openVaultPicker();
        },
      });
    }
    if (canUseRemoteWorkspaces) {
      items.push({
        label: "Connect to Remote Vault…",
        icon: <ArrowUpRightIcon className="h-4 w-4" />,
        onSelect: async () => {
          await connectRemoteWorkspace();
        },
      });
    }
    if (canSwitchLocalVaults) {
      items.push({
        label: "Open Local Vault in New Window…",
        icon: <ArrowUpRightIcon className="h-4 w-4" />,
        onSelect: async () => {
          await window.zen.openVaultWindow();
          await refreshLocalVaults();
        },
      });
    }

    return items;
  }, [
    canCloseCurrentVault,
    canSwitchLocalVaults,
    canUseRemoteWorkspaces,
    closeVault,
    connectRemoteWorkspace,
    connectRemoteWorkspaceProfile,
    openLocalVault,
    openVaultPicker,
    refreshLocalVaults,
    vaultSwitcherEntries,
  ]);

  // A folder only shows the strong "selected" accent highlight when
  // the view matches AND no specific note is selected. Once the user
  // opens a note, the note row owns the selection visual and the
  // parent folders drop back to a neutral state.
  const isFolderActive = (folder: NoteFolder, subpath: string): boolean =>
    (folder === "quick" && subpath === "" && quickNotesViewActive) ||
    (!selectedPath &&
      view.kind === "folder" &&
      view.folder === folder &&
      view.subpath === subpath);

  const openFolderMenu = useCallback(
    (
      e: React.MouseEvent,
      folder: NoteFolder,
      subpath: string,
    ): void => {
      e.preventDefault();
      if (subpath) {
        prepareContextSelection({ kind: "folder", folder, subpath });
      } else {
        setSelectedSidebarKeys(new Set());
        setSelectionAnchorKey(null);
      }
      setFolderMenu({ x: e.clientX, y: e.clientY, folder, subpath });
    },
    [prepareContextSelection],
  );

  const openNoteMenu = useCallback(
    (e: React.MouseEvent, note: NoteMeta): void => {
      e.preventDefault();
      prepareContextSelection({ kind: "note", path: note.path });
      setNoteMenu({ x: e.clientX, y: e.clientY, path: note.path });
    },
    [prepareContextSelection],
  );

  const openAssetMenu = useCallback(
    (e: React.MouseEvent, asset: AssetMeta): void => {
      e.preventDefault();
      setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path });
    },
    [],
  );

  const isSidebarFocused = focusedPanel === "sidebar";
  // Mutable counter reset on each render — assigns sequential data-sidebar-idx to each item.
  const idxCounter = useRef<{ value: number }>({ value: 0 });
  idxCounter.current.value = 0;
  const vimCursor = isSidebarFocused ? sidebarCursorIndex : -1;
  const vaultHeaderIdx = canSwitchVaults ? idxCounter.current.value++ : -1;
  const vaultHeaderVimHighlight = vimCursor === vaultHeaderIdx;
  // VimNav clamps cursor position via Math.min/Math.max on each
  // keystroke using the actual DOM element count — no extra clamping needed.

  const syncSidebarCursorFromTarget = (target: EventTarget | null): void => {
    const el =
      target instanceof HTMLElement
        ? (target.closest("[data-sidebar-idx]") as HTMLElement | null)
        : null;
    const idx = Number(el?.dataset.sidebarIdx);
    if (Number.isFinite(idx)) {
      lastSidebarPointerAtRef.current = performance.now();
      captureSidebarScrollAnchor(target);
    }
    if (Number.isFinite(idx) && idx !== sidebarCursorIndex) {
      useStore.getState().setSidebarCursorIndex(idx);
    }
  };

  useEffect(() => {
    if (!isSidebarFocused) return;

    const findTarget = (): HTMLElement | null => {
      if (
        isRecentSidebarPointerInteraction(
          lastSidebarPointerAtRef.current,
          performance.now(),
        )
      ) {
        const cursorEl = document.querySelector<HTMLElement>(
          `[data-sidebar-idx="${sidebarCursorIndex}"]`,
        );
        if (cursorEl) return cursorEl;
      }

      if (tagsViewActive && selectedTags.length > 0) {
        // When the Tags view is active, reveal the first currently-
        // selected tag's chip. The user can hop between them with j/k
        // from there once this scroll brings it into view.
        return document.querySelector(
          `[data-sidebar-type="tag"][data-sidebar-tag="${escapeForAttr(selectedTags[0])}"]`,
        ) as HTMLElement | null;
      }

      if (trashViewActive) {
        return document.querySelector(
          '[data-sidebar-type="trash"]',
        ) as HTMLElement | null;
      }

      if (archiveViewActive) {
        return document.querySelector(
          '[data-sidebar-type="archive"]',
        ) as HTMLElement | null;
      }

      if (quickNotesViewActive) {
        return document.querySelector(
          '[data-sidebar-type="folder"][data-sidebar-folder="quick"][data-sidebar-subpath=""]',
        ) as HTMLElement | null;
      }

      if (selectedPath) {
        if (
          isArchiveTabPath(selectedPath) ||
          selectedPath.startsWith("archive/")
        ) {
          return document.querySelector(
            '[data-sidebar-type="archive"]',
          ) as HTMLElement | null;
        }
        if (isTrashTabPath(selectedPath) || selectedPath.startsWith("trash/")) {
          return document.querySelector(
            '[data-sidebar-type="trash"]',
          ) as HTMLElement | null;
        }
      }

      if (selectedPath && unifiedSidebar) {
        if (isQuickNotesTabPath(selectedPath)) {
          return document.querySelector(
            '[data-sidebar-type="folder"][data-sidebar-folder="quick"][data-sidebar-subpath=""]',
          ) as HTMLElement | null;
        }
        const noteEl = document.querySelector(
          `[data-sidebar-path="${escapeForAttr(selectedPath)}"]`,
        ) as HTMLElement | null;
        if (noteEl) return noteEl;

        const selectedMeta = notes.find((note) => note.path === selectedPath);
        const folder = selectedMeta?.folder ?? "inbox";
        const subpath = selectedMeta
          ? noteFolderSubpath(selectedMeta, vaultSettings)
          : "";
        const segments = subpath ? subpath.split("/") : [];
        for (let i = segments.length; i >= 0; i--) {
          const subpath = segments.slice(0, i).join("/");
          const folderEl = document.querySelector(
            `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(subpath)}"]`,
          ) as HTMLElement | null;
          if (folderEl) return folderEl;
        }
      }

      if (view.kind === "folder") {
        if (view.folder === "archive") {
          return document.querySelector(
            '[data-sidebar-type="archive"]',
          ) as HTMLElement | null;
        }
        if (view.folder === "trash") {
          return document.querySelector(
            '[data-sidebar-type="trash"]',
          ) as HTMLElement | null;
        }
        return document.querySelector(
          `[data-sidebar-type="folder"][data-sidebar-folder="${view.folder}"][data-sidebar-subpath="${escapeForAttr(view.subpath)}"]`,
        ) as HTMLElement | null;
      }

      return null;
    };

    const target = findTarget();
    if (!target) return;

    const idx = Number(target.dataset.sidebarIdx);
    if (Number.isFinite(idx) && idx !== sidebarCursorIndex) {
      useStore.getState().setSidebarCursorIndex(idx);
    }

    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "nearest" });
    });
  }, [
    archiveViewActive,
    isSidebarFocused,
    quickNotesViewActive,
    selectedPath,
    notes,
    vaultSettings,
    unifiedSidebar,
    view,
    tagsViewActive,
    selectedTags,
    trashViewActive,
  ]);

  return (
    <aside
      className={`glass-sidebar relative flex shrink-0 flex-col pt-3${isSidebarFocused ? " panel-focused" : ""}`}
      style={{ width: sidebarWidth }}
      onMouseDownCapture={(e) => {
        syncSidebarCursorFromTarget(e.target);
        setFocusedPanel("sidebar");
      }}
      onFocusCapture={() => setFocusedPanel("sidebar")}
    >
      {/* Vault header + top-right actions */}
      <div className="flex items-center justify-between px-3 pb-3">
        {canSwitchVaults ? (
          <button
            type="button"
            onClick={openVaultSwitcher}
            onContextMenu={openVaultSwitcher}
            className={[
              "group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-paper-200/70",
              vaultHeaderVimHighlight ? "vim-cursor" : "",
            ].join(" ")}
            title="Switch vault"
            aria-label="Switch vault"
            data-sidebar-idx={vaultHeaderIdx}
            data-sidebar-type="vault"
          >
            <VaultBadge name={vault?.name ?? "ZenNotes"} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-800">
                {vault?.name ?? "ZenNotes"}
              </div>
              {workspaceMode === "remote" && (
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
                  <span className="inline-flex items-center gap-1 rounded-full border border-paper-300/70 bg-paper-100/80 px-1.5 py-0.5 font-medium text-ink-700">
                    <ArrowUpRightIcon className="h-3 w-3" />
                    Remote
                  </span>
                  <span className="truncate">{remoteLabel}</span>
                </div>
              )}
            </div>
            <ChevronRightIcon className="h-3.5 w-3.5 rotate-90 text-ink-400 transition-colors group-hover:text-ink-700" />
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <VaultBadge name={vault?.name ?? "ZenNotes"} size={28} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink-800">
                {vault?.name ?? "ZenNotes"}
              </div>
              {workspaceMode === "remote" && (
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
                  <span className="inline-flex items-center gap-1 rounded-full border border-paper-300/70 bg-paper-100/80 px-1.5 py-0.5 font-medium text-ink-700">
                    <ArrowUpRightIcon className="h-3 w-3" />
                    Remote
                  </span>
                  <span className="truncate">{remoteLabel}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex items-center gap-0.5">
          <IconBtn
            title="New note (choose folder)"
            onClick={() => void createNoteInChosenFolder()}
          >
            <PlusIcon />
          </IconBtn>
          <IconBtn title="Hide sidebar (⌘1)" onClick={toggleSidebar}>
            <PanelLeftIcon />
          </IconBtn>
        </div>
      </div>

      {/* Search + toolbar on one row */}
      <div className="flex items-center gap-1 px-3">
        <button
          onClick={() => setSearchOpen(true)}
          className="group flex h-7 flex-1 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-ink-700 transition-colors hover:bg-paper-200/70 hover:text-ink-900"
          title="Search (⌘P)"
        >
          <SearchIcon />
          <span className="flex-1 truncate">Search</span>
          <kbd className="rounded bg-paper-200 px-1 py-0.5 text-2xs text-ink-500">
            ⌘P
          </kbd>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn
            title="New note (choose folder)"
            onClick={() => {
              const state = useStore.getState();
              const target = defaultNewNoteTarget(
                state.activeNote,
                state.vaultSettings,
              );
              // Prefill the picker with the current context (only the notes
              // area is pickable, so archive/quick fall back to the root).
              const initialPath = target.folder === "inbox" ? target.subpath : "";
              void createNoteInChosenFolder({ initialPath });
            }}
          >
            <NotePlusIcon />
          </IconBtn>
          <IconBtn
            title="New folder"
            onClick={async () => {
              const view = useStore.getState().view;
              // Quick Notes is intentionally flat — fall back to inbox
              // when the user is currently viewing it.
              const noFolders =
                view.kind === "folder" &&
                (view.folder === "trash" || view.folder === "quick");
              const parentFolder: NoteFolder =
                view.kind === "folder" && !noFolders ? view.folder : "inbox";
              const parentSub =
                view.kind === "folder" && !noFolders ? view.subpath : "";
              const name = await promptApp({
                title: "New folder",
                placeholder: "Folder name",
                okLabel: "Create",
                validate: (v) => {
                  if (v.includes("/")) return 'Folder name cannot contain "/"';
                  return null;
                },
              });
              if (!name) return;
              const clean = name.trim().replace(/^\/+|\/+$/g, "");
              if (!clean) return;
              const next = parentSub ? `${parentSub}/${clean}` : clean;
              try {
                await createFolderAction(parentFolder, next);
              } catch (err) {
                window.alert((err as Error).message);
              }
            }}
          >
            <FolderPlusIcon />
          </IconBtn>
          <IconBtn
            title={`Sort: ${sortOrderLabel(noteSortOrder)}${groupByKind ? ", Group by kind" : ""}`}
            onClick={(e) => setSortMenu({ x: e.clientX, y: e.clientY })}
            active={noteSortOrder !== "none"}
          >
            <SortIcon />
          </IconBtn>
          <IconBtn
            title={autoReveal ? "Auto-reveal: on" : "Auto-reveal: off"}
            onClick={() => setAutoReveal(!autoReveal)}
            active={autoReveal}
          >
            <TargetIcon />
          </IconBtn>
          <IconBtn
            title="Collapse all"
            onClick={() =>
              collapsed.size >= allFolderKeys.length
                ? expandAll()
                : collapseAll()
            }
          >
            <ExpandAllIcon />
          </IconBtn>
        </div>
      </div>

      {/* Main scrollable tree area */}
      <div
        ref={sidebarScrollRef}
        className="mt-3 min-h-0 flex-1 overflow-y-auto px-3"
        style={{ scrollbarGutter: "stable" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocusedPanel("editor");
        }}
        onContextMenu={(e) => {
          // Right-clicking the empty area (not a row) creates at the vault root.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setRootMenu({ x: e.clientX, y: e.clientY });
          }
        }}
      >
        <div
          className="flex min-h-full flex-col pb-2"
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              setRootMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <TaskSidebarRow
            active={tasksViewActive}
            onClick={() => void openTasksView()}
            sidebarIdx={idxCounter.current.value++}
            vimHighlight={vimCursor === idxCounter.current.value - 1}
            sidebarFocused={isSidebarFocused}
          />

          <FolderTreeRoot
            label={folderLabels.quick}
            icon={
              resolveFolderIconOption("quick", "", vaultSettings.folderIcons).icon
            }
            folder="quick"
            tree={trees.quick}
            vaultSettings={vaultSettings}
            isFolderActive={isFolderActive}
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            setView={setView}
            onContextMenu={openFolderMenu}
            showNotes={unifiedSidebar}
            selectedPath={selectedPath}
            vaultRoot={vault?.root ?? null}
            onSelectNote={handleSelectNote}
            onOpenAsset={openAssetInTab}
            onNoteContextMenu={openNoteMenu}
            onAssetContextMenu={openAssetMenu}
            sortComparator={treeSortComparator}
            onDropOnFolder={handleDropOnFolder}
            selectedKeys={selectedSidebarKeys}
            onSelectItem={handleSidebarItemSelect}
            dragPayloadForItem={dragPayloadForItem}
            idxCounter={idxCounter.current}
            vimCursor={vimCursor}
            sidebarFocused={isSidebarFocused}
            groupByKind={groupByKind}
            showSidebarChevrons={showSidebarChevrons}
            headerAction={
              <button
                type="button"
                title={`New note in ${folderLabels.quick} (⇧⌘N)`}
                aria-label={`New note in ${folderLabels.quick}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const title = resolveQuickNoteTitle(
                    notes,
                    quickNoteDateTitle,
                    quickNoteTitlePrefix ?? undefined,
                  );
                  void createAndOpen("quick", "", { title, focusTitle: true });
                }}
                className="mr-1 flex h-6 w-6 items-center justify-center rounded-md bg-current/0 text-current transition-colors hover:bg-current/15"
              >
                <PlusIcon width={16} height={16} strokeWidth={2.5} />
              </button>
            }
          />

          <DateNotesNav
            dateNav={dateNav}
            expanded={dateNavExpanded}
            onToggle={toggleDateNav}
            dailyIcon={<CalendarIcon />}
            weeklyIcon={<CalendarIcon />}
            isFolderActive={isFolderActive}
            selectedPath={selectedPath}
            selectedKeys={selectedSidebarKeys}
            sidebarFocused={isSidebarFocused}
            showSidebarChevrons={showSidebarChevrons}
            onSelectNote={handleSelectNote}
            onSelectItem={handleSidebarItemSelect}
            onNoteContextMenu={openNoteMenu}
            dragPayloadForItem={dragPayloadForItem}
            onRootContextMenu={(e, subpath) => openFolderMenu(e, "inbox", subpath)}
          />

          <div className="mt-1">
            <ArchiveSidebarRow
              label={folderLabels.archive}
              icon={resolveFolderIconOption("archive", "", vaultSettings.folderIcons).icon}
              count={countNotesInTree(trees.archive)}
              active={
                archiveViewActive ||
                (view.kind === "folder" && view.folder === "archive") ||
                !!selectedPath?.startsWith("archive/")
              }
              onClick={() => {
                void openArchiveView();
              }}
              onContextMenu={(e) => openFolderMenu(e, "archive", "")}
              sidebarIdx={idxCounter.current.value++}
              vimHighlight={vimCursor === idxCounter.current.value - 1}
              sidebarFocused={isSidebarFocused}
            />

            <TrashSidebarRow
              label={folderLabels.trash}
              icon={resolveFolderIconOption("trash", "", vaultSettings.folderIcons).icon}
              count={countNotesInTree(trees.trash)}
              active={trashViewActive || !!selectedPath?.startsWith("trash/")}
              onClick={() => {
                void openTrashView();
              }}
              onContextMenu={(e) => openFolderMenu(e, "trash", "")}
              sidebarIdx={idxCounter.current.value++}
              vimHighlight={vimCursor === idxCounter.current.value - 1}
              sidebarFocused={isSidebarFocused}
            />
          </div>

          <SidebarSectionHeading
            label="Notes"
            onDropPayload={
              primaryNotesAtRoot
                ? (payload) => handleDropOnFolder(payload, "inbox", "")
                : undefined
            }
          />

          {primaryNotesAtRoot ? (
            <RootFolderDropTarget
              onDropPayload={(payload) => handleDropOnFolder(payload, "inbox", "")}
            >
              <FolderTreeContents
                tree={trees.inbox}
                depth={0}
                folder="inbox"
                vaultSettings={vaultSettings}
                isFolderActive={isFolderActive}
                collapsed={collapsed}
                toggleCollapse={toggleCollapse}
                setView={setView}
                onContextMenu={openFolderMenu}
                showNotes={unifiedSidebar}
                selectedPath={selectedPath}
                vaultRoot={vault?.root ?? null}
                onSelectNote={handleSelectNote}
                onOpenAsset={openAssetInTab}
                onNoteContextMenu={openNoteMenu}
                onAssetContextMenu={openAssetMenu}
                sortComparator={treeSortComparator}
                onDropOnFolder={handleDropOnFolder}
                selectedKeys={selectedSidebarKeys}
                onSelectItem={handleSidebarItemSelect}
                dragPayloadForItem={dragPayloadForItem}
                idxCounter={idxCounter.current}
                vimCursor={vimCursor}
                sidebarFocused={isSidebarFocused}
                groupByKind={groupByKind}
                showSidebarChevrons={showSidebarChevrons}
              />
            </RootFolderDropTarget>
          ) : (
            <FolderTreeRoot
              label={folderLabels.inbox}
              icon={
                resolveFolderIconOption("inbox", "", vaultSettings.folderIcons).icon
              }
              folder="inbox"
              tree={trees.inbox}
              vaultSettings={vaultSettings}
              isFolderActive={isFolderActive}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              setView={setView}
              onContextMenu={openFolderMenu}
              showNotes={unifiedSidebar}
              selectedPath={selectedPath}
              vaultRoot={vault?.root ?? null}
              onSelectNote={handleSelectNote}
              onOpenAsset={openAssetInTab}
              onNoteContextMenu={openNoteMenu}
              onAssetContextMenu={openAssetMenu}
              sortComparator={treeSortComparator}
              onDropOnFolder={handleDropOnFolder}
              selectedKeys={selectedSidebarKeys}
              onSelectItem={handleSidebarItemSelect}
              dragPayloadForItem={dragPayloadForItem}
              idxCounter={idxCounter.current}
              vimCursor={vimCursor}
              sidebarFocused={isSidebarFocused}
              groupByKind={groupByKind}
              showSidebarChevrons={showSidebarChevrons}
            />
          )}

          {/* Tag pills — pushed to the bottom of the tree area, just above
              the footer, via mt-auto (the wrapper is min-h-full flex-col). */}
          {tags.length > 0 && (
            <div className="mt-auto pt-5">
              <button
                type="button"
                onClick={() => setTagsCollapsed(!tagsCollapsed)}
                title={tagsCollapsed ? "Show tags" : "Hide tags"}
                aria-expanded={!tagsCollapsed}
                className="flex w-full items-center gap-1 rounded px-2 pb-2 text-xs font-medium uppercase tracking-wide text-ink-500 transition-colors hover:text-ink-800"
              >
                {showSidebarChevrons && (
                  <span
                    aria-hidden
                    className="inline-block transition-transform"
                    style={{
                      transform: tagsCollapsed
                        ? "rotate(-90deg)"
                        : "rotate(0deg)",
                    }}
                  >
                    ▾
                  </span>
                )}
                <span>Tags</span>
                <span className="ml-1 text-ink-500 normal-case tracking-normal">
                  {tags.length}
                </span>
              </button>
              {!tagsCollapsed && (
                <div className="flex flex-wrap gap-1.5 px-1">
                  {tags.map(([tag, count]) => {
                    // Tag chips feed into a single vault-wide Tags tab. If the
                    // tab is already open, clicking a chip toggles that tag in
                    // the selection (narrower / wider result set). Otherwise
                    // opening one starts the selection with just this tag.
                    const active = tagsViewActive && selectedTags.includes(tag);
                    const tagIdx = idxCounter.current.value++;
                    const isVimHighlight = vimCursor === tagIdx;
                    return (
                      <button
                        key={tag}
                        onClick={() => {
                          void openTagView(tag);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setTagMenu({ x: e.clientX, y: e.clientY, tag });
                        }}
                        className={[
                          "rounded-full px-2.5 py-1 text-xs transition-colors",
                          active
                            ? isVimHighlight
                              ? "vim-cursor-on-active bg-accent text-white"
                              : isSidebarFocused
                                ? "text-accent"
                                : "bg-accent text-white"
                            : isVimHighlight
                              ? "vim-cursor"
                              : "bg-paper-200 text-ink-800 hover:bg-paper-300",
                        ].join(" ")}
                        data-sidebar-idx={tagIdx}
                        data-sidebar-type="tag"
                        data-sidebar-tag={tag}
                      >
                        #{tag}
                        <span
                          className={[
                            "ml-1 text-2xs",
                            active && !isSidebarFocused
                              ? "text-white/80"
                              : "text-ink-500",
                          ].join(" ")}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer — vault-level utilities. Kept deliberately small so the
       *  main tree area dominates; Help and Settings are also reachable
       *  from the command palette and (for Settings) ⌘,. Trash lives in
       *  the main tree above and opens its dedicated recovery view. */}
      <div
        className="mt-2 grid h-16 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3"
        style={{ borderTop: "1px solid var(--glass-stroke)" }}
      >
        {hasAssetsDir && canRevealInFileManager && (
          <SidebarFooterAction
            icon={<FolderGlyphIcon />}
            label="Files"
            count={assetFiles.length}
            onClick={() => void revealAssetsDir()}
            sidebarIdx={idxCounter.current.value++}
            vimHighlight={vimCursor === idxCounter.current.value - 1}
            sidebarFocused={isSidebarFocused}
            sidebarData={{ type: "assets" }}
          />
        )}
        {(!hasAssetsDir || !canRevealInFileManager) && <div />}
        <SidebarFooterAction
          icon={<DocumentIcon />}
          label="Help"
          active={helpViewActive}
          onClick={() => void openHelpView()}
          sidebarIdx={idxCounter.current.value++}
          vimHighlight={vimCursor === idxCounter.current.value - 1}
          sidebarFocused={isSidebarFocused}
          sidebarData={{ type: "help" }}
        />
        <SidebarFooterAction
          icon={<SettingsIcon />}
          label="Settings"
          title={appUpdateSettingsTitle}
          badgeLabel={appUpdateBadge ?? undefined}
          onClick={() => setSettingsOpen(true)}
          sidebarIdx={idxCounter.current.value++}
          vimHighlight={vimCursor === idxCounter.current.value - 1}
          sidebarFocused={isSidebarFocused}
          sidebarData={{ type: "settings" }}
        />
      </div>

      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          items={tagMenuItems}
          onClose={() => setTagMenu(null)}
        />
      )}
      {vaultMenu && (
        <ContextMenu
          x={vaultMenu.x}
          y={vaultMenu.y}
          items={vaultMenuItems}
          onClose={() => setVaultMenu(null)}
        />
      )}
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
        />
      )}
      {rootMenu && (
        <ContextMenu
          x={rootMenu.x}
          y={rootMenu.y}
          items={rootMenuItems}
          onClose={() => setRootMenu(null)}
        />
      )}
      {noteMenu && (
        <ContextMenu
          x={noteMenu.x}
          y={noteMenu.y}
          items={noteMenuItems}
          onClose={() => setNoteMenu(null)}
        />
      )}
      {assetMenu && (
        <ContextMenu
          x={assetMenu.x}
          y={assetMenu.y}
          items={assetMenuItems}
          onClose={() => setAssetMenu(null)}
        />
      )}
      {folderIconPicker && (
        <FolderIconPickerModal
          targetLabel={folderIconPicker.label}
          currentIconId={resolveFolderIconId(
            folderIconPicker.folder,
            folderIconPicker.subpath,
            vaultSettings.folderIcons,
          )}
          onSelect={(iconId) =>
            void saveFolderIcon(
              folderIconPicker.folder,
              folderIconPicker.subpath,
              iconId,
            )
          }
          onCancel={() => setFolderIconPicker(null)}
        />
      )}
      {sortMenu && (
        <ContextMenu
          x={sortMenu.x}
          y={sortMenu.y}
          items={[
            ...(
              [
                ["none", "No sorting"],
                ["updated-desc", "Modified (newest first)"],
                ["updated-asc", "Modified (oldest first)"],
                ["created-desc", "Created (newest first)"],
                ["created-asc", "Created (oldest first)"],
                ["name-asc", "Name (A → Z)"],
                ["name-desc", "Name (Z → A)"],
              ] as const
            ).map(([id, label]) => ({
              label: `${noteSortOrder === id ? "✓  " : "    "}${label}`,
              onSelect: () => setNoteSortOrder(id as NoteSortOrder),
            })),
            { kind: "separator" as const },
            {
              label: `${groupByKind ? "✓  " : "    "}Group by kind`,
              onSelect: () => setGroupByKind(!groupByKind),
            },
          ]}
          onClose={() => setSortMenu(null)}
        />
      )}

      <ResizeHandle
        getWidth={() => sidebarWidth}
        onResize={(next) => {
          if (next === 0) return;
          setSidebarWidth(next);
        }}
      />
    </aside>
  );
}

/* ---------- Folder tree data ---------- */

interface TreeNode {
  name: string;
  subpath: string;
  siblingOrder: number;
  notes: NoteMeta[];
  assets: AssetMeta[];
  children: TreeNode[];
  isSymlink?: boolean;
}

type TreeRenderEntry =
  | { type: "folder"; node: TreeNode }
  | { type: "note"; note: NoteMeta }
  | { type: "asset"; asset: AssetMeta };

function shouldProgressivelyRenderEntries(entries: TreeRenderEntry[]): boolean {
  return (
    entries.length > SIDEBAR_PROGRESSIVE_RENDER_THRESHOLD &&
    entries.every((entry) => entry.type !== "folder")
  );
}

function treeRenderEntryPath(entry: TreeRenderEntry): string | null {
  if (entry.type === "note") return entry.note.path;
  if (entry.type === "asset") return entry.asset.path;
  return null;
}

function sidebarVisiblePrefetchPaths(entries: TreeRenderEntry[]): string[] {
  return getSidebarEdgePrefetchPaths(
    entries.map((entry) => (entry.type === "note" ? entry.note.path : null)),
  );
}

function prefetchSidebarEdgeNotes(entries: TreeRenderEntry[], enabled: boolean): void {
  if (!enabled || entries.length === 0) return;
  const progressive = shouldProgressivelyRenderEntries(entries);
  const limit = getInitialSidebarEntryLimit(entries.length, progressive);
  const visibleEntries = progressive ? entries.slice(0, limit) : entries;
  const paths = sidebarVisiblePrefetchPaths(visibleEntries);
  if (paths.length === 0) return;
  void useStore.getState().prefetchNotes(paths);
}

function useSidebarVisibleNotePrefetch(
  entries: TreeRenderEntry[],
  enabled: boolean,
): void {
  const paths = useMemo(
    () => (enabled ? sidebarVisiblePrefetchPaths(entries) : []),
    [enabled, entries],
  );

  useLayoutEffect(() => {
    if (paths.length === 0) return;
    void useStore.getState().prefetchNotes(paths);
  }, [paths]);
}

function useProgressiveEntryLimit(
  total: number,
  enabled: boolean,
): [number, (node: HTMLDivElement | null) => void] {
  const initial = getInitialSidebarEntryLimit(total, enabled);
  const [limit, setLimit] = useState(initial);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    setLimit(getInitialSidebarEntryLimit(total, enabled));
  }, [enabled, total]);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const setSentinelRef = useCallback(
    (node: HTMLDivElement | null): void => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (!enabled || !node || limit >= total) return;
      if (typeof IntersectionObserver === "undefined") return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setLimit((current) => getNextSidebarEntryLimit(current, total));
        },
        {
          root: null,
          rootMargin: `${SIDEBAR_PROGRESSIVE_SENTINEL_MARGIN_PX}px 0px`,
        },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [enabled, limit, total],
  );

  return [enabled ? Math.min(limit, total) : total, setSentinelRef];
}

function buildTree(
  notes: NoteMeta[],
  assets: AssetMeta[],
  topFolder: NoteFolder,
  folders: FolderEntry[],
  vaultSettings: ReturnType<typeof useStore.getState>["vaultSettings"],
): TreeNode {
  const root: TreeNode = {
    name: topFolder,
    subpath: "",
    siblingOrder: -1,
    notes: [],
    assets: [],
    children: [],
  };
  const byPath = new Map<string, TreeNode>();
  byPath.set("", root);
  const folderOrder = new Map(
    folders.map((folder) => [folder.subpath, folder.siblingOrder] as const),
  );
  const symlinkBySubpath = new Map(
    folders.map((folder) => [folder.subpath, folder.isSymlink ?? false] as const),
  );

  const ensureFolder = (subpath: string): TreeNode => {
    const existing = byPath.get(subpath);
    if (existing) return existing;
    const segments = subpath.split("/");
    let parent = root;
    let acc = "";
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let node = byPath.get(acc);
      if (!node) {
        node = {
          name: seg,
          subpath: acc,
          siblingOrder: folderOrder.get(acc) ?? Number.MAX_SAFE_INTEGER,
          notes: [],
          assets: [],
          children: [],
          isSymlink: symlinkBySubpath.get(acc) ?? false,
        };
        byPath.set(acc, node);
        parent.children.push(node);
      }
      parent = node;
    }
    return parent;
  };

  // First pass: create nodes for every folder on disk (this is what
  // keeps empty folders visible in the tree).
  for (const f of folders) {
    if (!f.subpath) continue;
    ensureFolder(f.subpath);
  }

  // Second pass: place every note inside its parent folder node.
  for (const n of notes) {
    const parentSubpath = noteFolderSubpath(n, vaultSettings);
    if (!parentSubpath) {
      root.notes.push(n);
      continue;
    }
    const parent = ensureFolder(parentSubpath);
    parent.notes.push(n);
  }

  for (const asset of assets) {
    const parentSubpath = assetFolderSubpath(asset, vaultSettings);
    if (!parentSubpath) {
      root.assets.push(asset);
      continue;
    }
    const parent = ensureFolder(parentSubpath);
    parent.assets.push(asset);
  }
  return root;
}

function getTreeRenderEntries(
  node: TreeNode,
  showNotes: boolean,
  sortComparator: ((a: NoteMeta, b: NoteMeta) => number) | null,
  groupByKind: boolean,
): TreeRenderEntry[] {
  if (!showNotes) {
    return node.children.map((child) => ({ type: "folder", node: child }));
  }

  if (sortComparator || groupByKind) {
    return [
      ...node.children.map(
        (child) => ({ type: "folder", node: child }) as const,
      ),
      ...node.notes
        .slice()
        .sort(sortComparator ?? ((a, b) => a.siblingOrder - b.siblingOrder))
        .map((note) => ({ type: "note", note }) as const),
      ...node.assets
        .slice()
        .sort((a, b) => a.siblingOrder - b.siblingOrder)
        .map((asset) => ({ type: "asset", asset }) as const),
    ];
  }

  return [
    ...node.children.map((child) => ({
      type: "folder" as const,
      node: child,
      siblingOrder: child.siblingOrder,
    })),
    ...node.notes.map((note) => ({
      type: "note" as const,
      note,
      siblingOrder: note.siblingOrder,
    })),
    ...node.assets.map((asset) => ({
      type: "asset" as const,
      asset,
      siblingOrder: asset.siblingOrder,
    })),
  ]
    .sort((a, b) => a.siblingOrder - b.siblingOrder)
    .map(({ siblingOrder: _siblingOrder, ...entry }) => entry);
}

function countNotesInTree(node: TreeNode): number {
  return (
    node.notes.length +
    node.assets.length +
    node.children.reduce((s, c) => s + countNotesInTree(c), 0)
  );
}

/* ---------- Tree rendering ---------- */

/** Mutable counter threaded through tree rendering for sequential data-sidebar-idx attributes. */
interface IdxCounter {
  value: number;
}

interface TreeRenderProps {
  folder: NoteFolder;
  vaultSettings: ReturnType<typeof useStore.getState>["vaultSettings"];
  isFolderActive: (folder: NoteFolder, subpath: string) => boolean;
  collapsed: Set<string>;
  toggleCollapse: (key: string) => void;
  setView: (v: { kind: "folder"; folder: NoteFolder; subpath: string }) => void;
  onContextMenu: (
    e: React.MouseEvent,
    folder: NoteFolder,
    subpath: string,
  ) => void;
  showNotes: boolean;
  selectedPath: string | null;
  vaultRoot: string | null;
  onSelectNote: (path: string) => void;
  onOpenAsset: (path: string) => void;
  onNoteContextMenu: (e: React.MouseEvent, n: NoteMeta) => void;
  onAssetContextMenu: (e: React.MouseEvent, asset: AssetMeta) => void;
  sortComparator: ((a: NoteMeta, b: NoteMeta) => number) | null;
  onDropOnFolder: (
    payload: DragPayload,
    targetFolder: NoteFolder,
    targetSubpath: string,
  ) => void | Promise<void>;
  selectedKeys: Set<string>;
  onSelectItem: (
    event: React.MouseEvent | React.KeyboardEvent,
    item: SidebarSelectionItem,
    primaryAction: () => void,
  ) => void;
  dragPayloadForItem: (item: SidebarSelectionItem) => DragPayload;
  /** Sequential index counter for vim navigation data attributes. */
  idxCounter: IdxCounter;
  /** The highlighted cursor index when sidebar is vim-focused (-1 if not focused). */
  vimCursor: number;
  /** Whether the sidebar currently owns keyboard focus. */
  sidebarFocused: boolean;
  /** Finder-style folders-first rendering toggle. */
  groupByKind: boolean;
  /** Show disclosure arrows for collapsible folders and sections. */
  showSidebarChevrons: boolean;
}

function FolderTreeContents({
  folder,
  vaultSettings,
  tree,
  depth,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  vaultRoot,
  onSelectNote,
  onOpenAsset,
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  selectedKeys,
  onSelectItem,
  dragPayloadForItem,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
  showSidebarChevrons,
  isFolderActive,
}: {
  tree: TreeNode;
  depth: number;
} & TreeRenderProps): JSX.Element {
  const entries = useMemo(
    () => getTreeRenderEntries(tree, showNotes, sortComparator, groupByKind),
    [tree, showNotes, sortComparator, groupByKind],
  );
  const progressiveEligible = shouldProgressivelyRenderEntries(entries);
  const progressive = progressiveEligible && !sidebarFocused;
  const [visibleEntryLimit, progressiveSentinelRef] = useProgressiveEntryLimit(
    entries.length,
    progressive,
  );
  const selectedEntryIndex = useMemo(
    () =>
      selectedPath
        ? entries.findIndex((entry) => treeRenderEntryPath(entry) === selectedPath)
        : -1,
    [entries, selectedPath],
  );
  const effectiveEntryLimit = getSidebarEntryLimitIncludingIndex(
    visibleEntryLimit,
    entries.length,
    selectedEntryIndex,
  );
  const visibleEntries = useMemo(
    () => (progressive ? entries.slice(0, effectiveEntryLimit) : entries),
    [effectiveEntryLimit, entries, progressive],
  );
  useSidebarVisibleNotePrefetch(visibleEntries, showNotes);

  return (
    <>
      {visibleEntries.map((entry) => {
        if (entry.type === "folder") {
          return (
            <SubTree
              key={entry.node.subpath}
              node={entry.node}
              depth={depth}
              folder={folder}
              vaultSettings={vaultSettings}
              isFolderActive={isFolderActive}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              setView={setView}
              onContextMenu={onContextMenu}
              showNotes={showNotes}
              selectedPath={selectedPath}
              vaultRoot={vaultRoot}
              onSelectNote={onSelectNote}
              onOpenAsset={onOpenAsset}
              onNoteContextMenu={onNoteContextMenu}
              onAssetContextMenu={onAssetContextMenu}
              sortComparator={sortComparator}
              onDropOnFolder={onDropOnFolder}
              selectedKeys={selectedKeys}
              onSelectItem={onSelectItem}
              dragPayloadForItem={dragPayloadForItem}
              idxCounter={idxCounter}
              vimCursor={vimCursor}
              sidebarFocused={sidebarFocused}
              groupByKind={groupByKind}
              showSidebarChevrons={showSidebarChevrons}
            />
          );
        }

        if (entry.type === "asset") {
          const assetIdx = idxCounter.value++;
          return (
            <AssetLeaf
              key={entry.asset.path}
              asset={entry.asset}
              vaultRoot={vaultRoot}
              depth={depth}
              showSidebarChevrons={showSidebarChevrons}
              onOpen={() => onOpenAsset(entry.asset.path)}
              onContextMenu={(e) => onAssetContextMenu(e, entry.asset)}
              sidebarFocused={sidebarFocused}
              sidebarIdx={assetIdx}
              vimHighlight={vimCursor === assetIdx}
            />
          );
        }
        const n = entry.note;
        const noteIdx = idxCounter.value++;
        return (
          <NoteLeaf
            key={n.path}
            note={n}
            depth={depth}
            showSidebarChevrons={showSidebarChevrons}
            active={n.path === selectedPath}
            selected={selectedKeys.has(noteSelectionKey(n.path))}
            sidebarFocused={sidebarFocused}
            onSelectItem={onSelectItem}
            onSelectNote={onSelectNote}
            onContextMenuNote={onNoteContextMenu}
            dragPayloadForItem={dragPayloadForItem}
            sidebarIdx={noteIdx}
            vimHighlight={vimCursor === noteIdx}
          />
        );
      })}
      {progressive && effectiveEntryLimit < entries.length && (
        <div
          ref={progressiveSentinelRef}
          className="h-px shrink-0"
          aria-hidden="true"
        />
      )}
    </>
  );
}

function FolderTreeRoot({
  label,
  icon,
  folder,
  tree,
  vaultSettings,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  vaultRoot,
  onSelectNote,
  onOpenAsset,
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  selectedKeys,
  onSelectItem,
  dragPayloadForItem,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
  showSidebarChevrons,
  headerAction,
}: {
  label: string;
  icon: JSX.Element;
  tree: TreeNode;
  /** Optional inline action shown on the right of the header row,
   *  revealed on hover. Used to surface a quick "+" for Quick Notes. */
  headerAction?: JSX.Element;
} & TreeRenderProps): JSX.Element {
  const rootKey = `${folder}:`;
  const isCollapsed = collapsed.has(rootKey);
  const total = countNotesInTree(tree);
  const entries = useMemo(
    () => getTreeRenderEntries(tree, showNotes, sortComparator, groupByKind),
    [tree, showNotes, sortComparator, groupByKind],
  );
  const rootActive = isFolderActive(folder, "");
  const rootProgressive = shouldProgressivelyRenderEntries(entries);
  const rootPrefetchEntries = useMemo(
    () =>
      rootProgressive
        ? entries.slice(0, getInitialSidebarEntryLimit(entries.length, rootProgressive))
        : entries,
    [entries, rootProgressive],
  );
  useSidebarVisibleNotePrefetch(rootPrefetchEntries, showNotes && (rootActive || isCollapsed));
  const hasChildren = entries.length > 0;
  const [dragHover, setDragHover] = useState(false);
  const myIdx = idxCounter.value++;

  const handleSelect = (): void => {
    setView({ kind: "folder", folder, subpath: "" });
    // Click toggles the expand state on every folder row.
    if (hasChildren) {
      if (isCollapsed) prefetchSidebarEdgeNotes(entries, showNotes);
      toggleCollapse(rootKey);
    }
  };

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={icon}
        label={label}
        count={total}
        active={rootActive}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={0}
        onToggle={() => {
          if (isCollapsed) prefetchSidebarEdgeNotes(entries, showNotes);
          toggleCollapse(rootKey);
        }}
        onSelect={handleSelect}
        onContextMenu={(e) => onContextMenu(e, folder, "")}
        dropTarget={dragHover}
        onDragOver={(e) => {
          if (!hasZenItem(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragHover(true);
        }}
        onDragLeave={() => setDragHover(false)}
        onDrop={(e) => {
          setDragHover(false);
          const payload = readDragPayload(e);
          if (!payload) return;
          e.preventDefault();
          void onDropOnFolder(payload, folder, "");
        }}
        sidebarIdx={myIdx}
        vimHighlight={vimCursor === myIdx}
        sidebarFocused={sidebarFocused}
        sidebarData={{ type: "folder", folder, subpath: "", key: rootKey }}
        trailing={headerAction}
        reserveLeadingSlot={showSidebarChevrons && folder !== "quick"}
        showExpandChevron={showSidebarChevrons && folder !== "quick"}
      />
      {!isCollapsed && (
        <FolderTreeContents
          tree={tree}
          depth={1}
          folder={folder}
          vaultSettings={vaultSettings}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={onContextMenu}
          showNotes={showNotes}
          selectedPath={selectedPath}
          vaultRoot={vaultRoot}
          onSelectNote={onSelectNote}
          onOpenAsset={onOpenAsset}
          onNoteContextMenu={onNoteContextMenu}
          onAssetContextMenu={onAssetContextMenu}
          sortComparator={sortComparator}
          onDropOnFolder={onDropOnFolder}
          selectedKeys={selectedKeys}
          onSelectItem={onSelectItem}
          dragPayloadForItem={dragPayloadForItem}
          idxCounter={idxCounter}
          vimCursor={vimCursor}
          sidebarFocused={sidebarFocused}
          groupByKind={groupByKind}
          showSidebarChevrons={showSidebarChevrons}
        />
      )}
    </div>
  );
}

function SubTree({
  node,
  depth,
  folder,
  vaultSettings,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  vaultRoot,
  onSelectNote,
  onOpenAsset,
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  selectedKeys,
  onSelectItem,
  dragPayloadForItem,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
  showSidebarChevrons,
}: { node: TreeNode; depth: number } & TreeRenderProps): JSX.Element {
  const key = `${folder}:${node.subpath}`;
  const isCollapsed = collapsed.has(key);
  const iconOption = resolveFolderIconOption(
    folder,
    node.subpath,
    vaultSettings.folderIcons,
  );
  const entries = useMemo(
    () => getTreeRenderEntries(node, showNotes, sortComparator, groupByKind),
    [node, showNotes, sortComparator, groupByKind],
  );
  const progressiveEligible = shouldProgressivelyRenderEntries(entries);
  const progressive = progressiveEligible && !sidebarFocused;
  const [visibleEntryLimit, progressiveSentinelRef] = useProgressiveEntryLimit(
    entries.length,
    progressive,
  );
  const selectedEntryIndex = useMemo(
    () =>
      selectedPath
        ? entries.findIndex((entry) => treeRenderEntryPath(entry) === selectedPath)
        : -1,
    [entries, selectedPath],
  );
  const effectiveEntryLimit = getSidebarEntryLimitIncludingIndex(
    visibleEntryLimit,
    entries.length,
    selectedEntryIndex,
  );
  const visibleEntries = useMemo(
    () => (progressive ? entries.slice(0, effectiveEntryLimit) : entries),
    [effectiveEntryLimit, entries, progressive],
  );
  useSidebarVisibleNotePrefetch(visibleEntries, showNotes && !isCollapsed);
  const hasChildren = entries.length > 0;
  const [dragHover, setDragHover] = useState(false);
  const myIdx = idxCounter.value++;
  const selectionKey = folderSelectionKey(folder, node.subpath);

  const handleSelect = (
    e: React.MouseEvent | React.KeyboardEvent,
  ): void => {
    onSelectItem(e, { kind: "folder", folder, subpath: node.subpath }, () => {
      setView({ kind: "folder", folder, subpath: node.subpath });
      if (hasChildren) {
        if (isCollapsed) prefetchSidebarEdgeNotes(entries, showNotes);
        toggleCollapse(key);
      }
    });
  };

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={iconOption.id === "folder" ? <FolderGlyphIcon open={!isCollapsed && hasChildren} /> : iconOption.icon}
        label={node.name}
        isSymlink={node.isSymlink}
        count={countNotesInTree(node)}
        active={isFolderActive(folder, node.subpath)}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={depth}
        onToggle={() => {
          if (isCollapsed) prefetchSidebarEdgeNotes(entries, showNotes);
          toggleCollapse(key);
        }}
        onSelect={handleSelect}
        onContextMenu={(e) => onContextMenu(e, folder, node.subpath)}
        draggable
        onDragStart={(e) =>
          setDragPayload(
            e,
            dragPayloadForItem({ kind: "folder", folder, subpath: node.subpath }),
          )
        }
        dropTarget={dragHover}
        selected={selectedKeys.has(selectionKey)}
        onDragOver={(e) => {
          if (!hasZenItem(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragHover(true);
        }}
        onDragLeave={() => setDragHover(false)}
        onDrop={(e) => {
          setDragHover(false);
          const payload = readDragPayload(e);
          if (!payload) return;
          e.preventDefault();
          void onDropOnFolder(payload, folder, node.subpath);
        }}
        sidebarIdx={myIdx}
        vimHighlight={vimCursor === myIdx}
        sidebarFocused={sidebarFocused}
        sidebarData={{ type: "folder", folder, subpath: node.subpath, key }}
        selectionKey={selectionKey}
        reserveLeadingSlot={showSidebarChevrons}
        showExpandChevron={showSidebarChevrons}
      />
      {!isCollapsed && (
        <>
          {visibleEntries.map((entry) => {
            if (entry.type === "folder") {
              return (
                <SubTree
                  key={entry.node.subpath}
                  node={entry.node}
                  depth={depth + 1}
                  folder={folder}
                  vaultSettings={vaultSettings}
                  isFolderActive={isFolderActive}
                  collapsed={collapsed}
                  toggleCollapse={toggleCollapse}
                  setView={setView}
                  onContextMenu={onContextMenu}
                  showNotes={showNotes}
                  selectedPath={selectedPath}
                  vaultRoot={vaultRoot}
                  onSelectNote={onSelectNote}
                  onOpenAsset={onOpenAsset}
                  onNoteContextMenu={onNoteContextMenu}
                  onAssetContextMenu={onAssetContextMenu}
                  sortComparator={sortComparator}
                  onDropOnFolder={onDropOnFolder}
                  selectedKeys={selectedKeys}
                  onSelectItem={onSelectItem}
                  dragPayloadForItem={dragPayloadForItem}
                  idxCounter={idxCounter}
                  vimCursor={vimCursor}
                  sidebarFocused={sidebarFocused}
                  groupByKind={groupByKind}
                  showSidebarChevrons={showSidebarChevrons}
                />
              );
            }

            if (entry.type === "asset") {
              const assetIdx = idxCounter.value++;
              return (
                <AssetLeaf
                  key={entry.asset.path}
                  asset={entry.asset}
                  vaultRoot={vaultRoot}
                  depth={depth + 1}
                  showSidebarChevrons={showSidebarChevrons}
                  onOpen={() => onOpenAsset(entry.asset.path)}
                  onContextMenu={(e) => onAssetContextMenu(e, entry.asset)}
                  sidebarFocused={sidebarFocused}
                  sidebarIdx={assetIdx}
                  vimHighlight={vimCursor === assetIdx}
                />
              );
            }

            const n = entry.note;
            const noteIdx = idxCounter.value++;
            return (
              <NoteLeaf
                key={n.path}
                note={n}
                depth={depth + 1}
                showSidebarChevrons={showSidebarChevrons}
                active={n.path === selectedPath}
                selected={selectedKeys.has(noteSelectionKey(n.path))}
                sidebarFocused={sidebarFocused}
                onSelectItem={onSelectItem}
                onSelectNote={onSelectNote}
                onContextMenuNote={onNoteContextMenu}
                dragPayloadForItem={dragPayloadForItem}
                sidebarIdx={noteIdx}
                vimHighlight={vimCursor === noteIdx}
              />
            );
          })}
          {progressive && effectiveEntryLimit < entries.length && (
            <div
              ref={progressiveSentinelRef}
              className="h-px shrink-0"
              aria-hidden="true"
            />
          )}
        </>
      )}
    </div>
  );
}

interface NoteLeafProps {
  note: NoteMeta;
  depth: number;
  showSidebarChevrons: boolean;
  active: boolean;
  selected: boolean;
  sidebarFocused: boolean;
  onSelectItem: (
    event: React.MouseEvent | React.KeyboardEvent,
    item: SidebarSelectionItem,
    primaryAction: () => void,
  ) => void;
  onSelectNote: (path: string) => void;
  onContextMenuNote: (e: React.MouseEvent, note: NoteMeta) => void;
  dragPayloadForItem: (item: SidebarSelectionItem) => DragPayload;
  sidebarIdx?: number;
  vimHighlight?: boolean;
}

const NoteLeaf = memo(function NoteLeaf({
  note,
  depth,
  showSidebarChevrons,
  active,
  selected,
  sidebarFocused,
  onSelectItem,
  onSelectNote,
  onContextMenuNote,
  dragPayloadForItem,
  sidebarIdx,
  vimHighlight,
}: NoteLeafProps): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight);
  const selectionKey = noteSelectionKey(note.path);
  // Zustand actions are stable references, so pulling this here keeps the
  // memoized row cheap without threading another prop through the tree.
  const openNotePermanent = useStore((s) => s.selectNote);
  const handleSelect = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onSelectItem(event, { kind: "note", path: note.path }, () =>
        onSelectNote(note.path),
      );
    },
    [note.path, onSelectItem, onSelectNote],
  );
  const handleDoubleClick = useCallback(() => {
    // Double click keeps the note open as a permanent tab (VS Code-style).
    void openNotePermanent(note.path);
  }, [note.path, openNotePermanent]);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenuNote(event, note),
    [note, onContextMenuNote],
  );
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      setDragPayload(event, dragPayloadForItem({ kind: "note", path: note.path }));
    },
    [dragPayloadForItem, note.path],
  );

  return (
    <button
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
      className={[
        "group flex h-8 w-full items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : selected
            ? "bg-accent/[0.09] text-ink-900"
            : vimHighlight
              ? "vim-cursor"
              : "text-ink-700 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 + depth * 14 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "note",
            "data-sidebar-path": note.path,
            "data-sidebar-select-key": selectionKey,
          }
        : {})}
    >
      {showSidebarChevrons && <span className="h-5 w-5 shrink-0" />}
      <SidebarGlyph active={strongActive} rowActive={active || selected}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
          <path d="M14 3v6h6" />
        </svg>
      </SidebarGlyph>
      <span className="flex-1 truncate">{note.title}</span>
      {note.isSymlink && (
        <span
          aria-label="Symlinked note"
          title="Symlinked into this vault"
          className={[
            "shrink-0",
            active
              ? sidebarFocused && !vimHighlight
                ? "text-accent/70"
                : "text-white/70"
              : selected
                ? "text-accent/75"
                : "text-ink-500",
          ].join(" ")}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </span>
      )}
      {note.hasAttachments && (
        <span
          aria-label="Has embedded files"
          title="Has embedded files"
          className={[
            "shrink-0",
            active
              ? sidebarFocused && !vimHighlight
                ? "text-accent/70"
                : "text-white/70"
              : selected
                ? "text-accent/75"
              : "text-ink-500",
          ].join(" ")}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 1 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8L9.41 17.34a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
      )}
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active || selected} label="menu" keyLabel="m" />
      )}
    </button>
  );
}, areNoteLeafPropsEqual);

function areNoteLeafPropsEqual(prev: NoteLeafProps, next: NoteLeafProps): boolean {
  return (
    prev.note.path === next.note.path &&
    prev.note.title === next.note.title &&
    prev.note.hasAttachments === next.note.hasAttachments &&
    prev.note.isSymlink === next.note.isSymlink &&
    prev.depth === next.depth &&
    prev.showSidebarChevrons === next.showSidebarChevrons &&
    prev.active === next.active &&
    prev.selected === next.selected &&
    prev.sidebarFocused === next.sidebarFocused &&
    prev.sidebarIdx === next.sidebarIdx &&
    prev.vimHighlight === next.vimHighlight &&
    prev.onSelectItem === next.onSelectItem &&
    prev.onSelectNote === next.onSelectNote &&
    prev.onContextMenuNote === next.onContextMenuNote &&
    prev.dragPayloadForItem === next.dragPayloadForItem
  );
}

function AssetLeaf({
  asset,
  vaultRoot,
  depth,
  showSidebarChevrons,
  onOpen,
  onContextMenu,
  sidebarFocused,
  sidebarIdx,
  vimHighlight,
}: {
  asset: AssetMeta;
  vaultRoot: string | null;
  depth: number;
  showSidebarChevrons: boolean;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  sidebarFocused: boolean;
  sidebarIdx?: number;
  vimHighlight?: boolean;
}): JSX.Element {
  const extension = asset.name.includes(".")
    ? asset.name.split(".").pop()?.toUpperCase() ?? ""
    : "";
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      setDragPayload(event, { kind: "asset", path: asset.path });
    },
    [asset.path],
  );

  return (
    <button
      onClick={() => {
        onOpen();
      }}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={handleDragStart}
      className={[
        "group flex h-8 w-full items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        vimHighlight ? "vim-cursor" : "text-ink-700 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 + depth * 14 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "asset",
            "data-sidebar-path": asset.path,
          }
        : {})}
    >
      {showSidebarChevrons && <span className="h-5 w-5 shrink-0" />}
      <SidebarGlyph active={false} rowActive={false}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
          <path d="M14 3v6h6" />
        </svg>
      </SidebarGlyph>
      <span className="flex-1 truncate text-ink-700">{asset.name}</span>
      {extension && (
        <span
          className={[
            "shrink-0 pr-2 text-2xs uppercase tracking-wide",
            sidebarFocused && vimHighlight ? "text-ink-700" : "text-ink-500",
          ].join(" ")}
        >
          {extension}
        </span>
      )}
    </button>
  );
}

/* ---------- Row primitives ---------- */

function TreeRow({
  icon,
  label,
  count,
  active,
  expandable,
  collapsed,
  depth,
  onToggle,
  onSelect,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  dropTarget = false,
  selected = false,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData,
  selectionKey,
  trailing,
  isSymlink = false,
  reserveLeadingSlot = true,
  showExpandChevron = true,
}: {
  icon: JSX.Element;
  label: string;
  count?: number;
  active: boolean;
  expandable: boolean;
  collapsed: boolean;
  depth: number;
  onToggle: () => void;
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  dropTarget?: boolean;
  selected?: boolean;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
  sidebarData?: { type: string; folder: string; subpath: string; key: string };
  selectionKey?: string;
  /** Optional inline action(s) shown on the right edge, revealed on hover. */
  trailing?: JSX.Element;
  /** Show a symlink indicator when this row's directory entry is a link. */
  isSymlink?: boolean;
  /** Keep a blank chevron column for non-expandable rows when alignment matters. */
  reserveLeadingSlot?: boolean;
  /** Hide the chevron affordance while keeping row-click toggle behavior. */
  showExpandChevron?: boolean;
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(e);
        }
      }}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        "group flex h-8 w-full items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : dropTarget
            ? "bg-accent/20 text-ink-900 ring-1 ring-accent/60"
            : selected
              ? "bg-accent/[0.09] text-ink-900"
            : vimHighlight
              ? "vim-cursor"
              : "text-ink-800 hover:bg-paper-200/70",
      ].join(" ")}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": sidebarData?.type ?? "folder",
            "data-sidebar-folder": sidebarData?.folder,
            "data-sidebar-subpath": sidebarData?.subpath,
            "data-sidebar-key": sidebarData?.key,
            "data-sidebar-expandable": String(expandable),
            "data-sidebar-collapsed": String(collapsed),
            "data-sidebar-select-key": selectionKey,
          }
        : {})}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expandable && showExpandChevron ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          data-vim-hint-ignore
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
            strongActive
              ? "text-white/80 hover:bg-white/15"
              : "text-ink-500 hover:bg-paper-300/60",
          ].join(" ")}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      ) : reserveLeadingSlot ? (
        <span className="h-5 w-5 shrink-0" />
      ) : null}
      <SidebarGlyph active={strongActive} rowActive={active || selected}>
        {icon}
      </SidebarGlyph>
      <span className="flex-1 truncate">{label}</span>
      {isSymlink && (
        <span
          aria-label="Symlinked folder"
          title="Symlinked into this vault"
          className={[
            "shrink-0",
            strongActive ? "text-white/70" : selected ? "text-accent/75" : "text-ink-500",
          ].join(" ")}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7" />
            <path d="M7 7h10v10" />
          </svg>
        </span>
      )}
      {sidebarFocused && vimHighlight && (
        <RowKeyHint
          active={active || selected}
          keyLabel="m"
          compact={typeof count === "number" && count > 0}
        />
      )}
      {trailing && <span className="shrink-0">{trailing}</span>}
      {typeof count === "number" && count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : selected ? "text-accent/75" : "text-ink-500",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </div>
  );
}

// Top-level utility row. These align their icon center to the folder chevron
// rail, but do not reserve a full fake chevron slot.
function TaskSidebarRow({
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
}: {
  active: boolean;
  onClick: () => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={[
        "group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : vimHighlight
            ? "vim-cursor"
            : "text-ink-800 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "tasks",
          }
        : {})}
    >
      <SidebarGlyph active={strongActive} rowActive={active}>
        <CheckSquareIcon width={12} height={12} strokeWidth={2.15} />
      </SidebarGlyph>
      <span className="flex-1 truncate">Tasks</span>
    </div>
  );
}

function ArchiveSidebarRow({
  label,
  icon,
  count,
  active,
  onClick,
  onContextMenu,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
}: {
  label: string;
  icon: JSX.Element;
  count: number;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onContextMenu}
      className={[
        "group select-none flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : vimHighlight
            ? "vim-cursor"
            : "text-ink-800 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "archive",
          }
        : {
            "data-sidebar-type": "archive",
          })}
    >
      <SidebarGlyph active={strongActive} rowActive={active}>
        {icon}
      </SidebarGlyph>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} keyLabel="m" compact={count > 0} />
      )}
      {count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : "text-ink-500",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function TrashSidebarRow({
  label,
  icon,
  count,
  active,
  onClick,
  onContextMenu,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
}: {
  label: string;
  icon: JSX.Element;
  count: number;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onContextMenu}
      className={[
        "group select-none flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : vimHighlight
            ? "vim-cursor"
            : "text-ink-800 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "trash",
          }
        : {
            "data-sidebar-type": "trash",
          })}
    >
      <SidebarGlyph active={strongActive} rowActive={active}>
        {icon}
      </SidebarGlyph>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} keyLabel="m" compact={count > 0} />
      )}
      {count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : "text-ink-500",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function SidebarRow({
  icon,
  label,
  count,
  trailing,
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData,
}: {
  icon: JSX.Element;
  label: string;
  count?: number;
  trailing?: JSX.Element;
  active?: boolean;
  onClick: () => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
  sidebarData?: { type: string };
}): JSX.Element {
  const strongActive = !!active && (!sidebarFocused || !!vimHighlight);

  return (
    <button
      onClick={onClick}
      className={[
        "group flex h-8 items-center gap-2 rounded-lg px-2 text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : vimHighlight
            ? "vim-cursor"
            : "text-ink-800 hover:bg-paper-200/70",
      ].join(" ")}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": sidebarData?.type ?? "settings",
          }
        : {})}
    >
      <span
        className={
          strongActive ? "text-white" : "text-ink-500 group-hover:text-ink-800"
        }
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-left">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint
          active={!!active}
          keyLabel="m"
          compact={typeof count === "number" && count > 0}
        />
      )}
      {typeof count === "number" && count > 0 && (
        <span
          className={[
            "text-xs",
            strongActive ? "text-white/80" : "text-ink-500",
          ].join(" ")}
        >
          {count}
        </span>
      )}
      {trailing}
    </button>
  );
}

/** Compact labeled action used in the sidebar footer. Same vim-nav
 *  wiring as SidebarRow (sidebarIdx / sidebarData), but kept short so
 *  vault utilities stay legible without stealing space from the tree. */
function SidebarFooterAction({
  icon,
  label,
  title,
  count,
  badgeLabel,
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData,
}: {
  icon: JSX.Element;
  label: string;
  title?: string;
  count?: number;
  badgeLabel?: string;
  active?: boolean;
  onClick: () => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
  sidebarData?: { type: string };
}): JSX.Element {
  const strongActive = !!active && (!sidebarFocused || !!vimHighlight);
  const resolvedTitle = title ?? label;
  return (
    <button
      type="button"
      onClick={onClick}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      className={[
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium leading-none transition-colors whitespace-nowrap",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : vimHighlight
            ? "vim-cursor"
            : "text-ink-500 hover:bg-paper-200/70 hover:text-ink-900",
      ].join(" ")}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": sidebarData?.type ?? "settings",
          }
        : {})}
    >
      <span
        className={["shrink-0", strongActive ? "text-white" : ""].join(" ")}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {typeof count === "number" && (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-2xs",
            strongActive
              ? "bg-white/12 text-white/80"
              : "bg-paper-200/80 text-ink-500",
          ].join(" ")}
        >
          {count}
        </span>
      )}
      {badgeLabel && (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-2xs font-semibold",
            strongActive
              ? "bg-white/16 text-white"
              : "bg-accent/12 text-accent",
          ].join(" ")}
        >
          {badgeLabel}
        </span>
      )}
    </button>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: JSX.Element;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={[
        "group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-ink-500 hover:bg-paper-200 hover:text-ink-800",
      ].join(" ")}
    >
      <span className="pointer-events-none">{children}</span>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs font-medium text-ink-800 shadow-panel group-hover:block group-focus-visible:block">
        {title}
      </span>
    </button>
  );
}

interface DateNavData {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  dailyDir: string;
  weeklyDir: string;
  dailyLabel: string;
  weeklyLabel: string;
  daily: { year: number; total: number; months: { month: number; notes: NoteMeta[] }[] }[];
  weekly: { year: number; notes: NoteMeta[] }[];
  dailyTotal: number;
  weeklyTotal: number;
}

/**
 * Pinned, date-grouped navigator for daily/weekly notes, shown above the NOTES
 * section. Daily notes nest year → month → day, weekly notes year → week, all
 * newest-first and collapsed by default so the sidebar stays compact no matter
 * how many notes exist. Reuses TreeRow (group headers) and NoteLeaf (leaves).
 */
function DateNotesNav({
  dateNav,
  expanded,
  onToggle,
  dailyIcon,
  weeklyIcon,
  isFolderActive,
  selectedPath,
  selectedKeys,
  sidebarFocused,
  showSidebarChevrons,
  onSelectNote,
  onSelectItem,
  onNoteContextMenu,
  dragPayloadForItem,
  onRootContextMenu,
}: {
  dateNav: DateNavData;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  dailyIcon: JSX.Element;
  weeklyIcon: JSX.Element;
  isFolderActive: (folder: NoteFolder, subpath: string) => boolean;
  selectedPath: string | null;
  selectedKeys: Set<string>;
  sidebarFocused: boolean;
  showSidebarChevrons: boolean;
  onSelectNote: (path: string) => void;
  onSelectItem: (
    event: React.MouseEvent | React.KeyboardEvent,
    item: SidebarSelectionItem,
    primaryAction: () => void,
  ) => void;
  onNoteContextMenu: (e: React.MouseEvent, note: NoteMeta) => void;
  dragPayloadForItem: (item: SidebarSelectionItem) => DragPayload;
  onRootContextMenu?: (e: React.MouseEvent, subpath: string) => void;
}): JSX.Element | null {
  const rows: JSX.Element[] = [];
  const monthName = (year: number, month: number): string =>
    new Date(year, month, 1).toLocaleDateString(undefined, { month: "long" });
  const groupRow = (
    key: string,
    label: string,
    count: number,
    depth: number,
    onSelect: () => void,
    icon: JSX.Element,
    active: boolean,
    chevron: boolean,
    onContextMenu?: (e: React.MouseEvent) => void,
  ): JSX.Element => (
    <TreeRow
      key={key}
      icon={icon}
      label={label}
      count={count}
      active={active}
      expandable
      collapsed={!expanded.has(key)}
      depth={depth}
      onToggle={() => onToggle(key)}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      reserveLeadingSlot={chevron}
      showExpandChevron={chevron}
    />
  );
  const leaf = (note: NoteMeta, depth: number): JSX.Element => (
    <NoteLeaf
      key={note.path}
      note={note}
      depth={depth}
      showSidebarChevrons={showSidebarChevrons}
      active={note.path === selectedPath}
      selected={selectedKeys.has(noteSelectionKey(note.path))}
      sidebarFocused={sidebarFocused}
      onSelectItem={onSelectItem}
      onSelectNote={onSelectNote}
      onContextMenuNote={onNoteContextMenu}
      dragPayloadForItem={dragPayloadForItem}
    />
  );

  if (dateNav.dailyEnabled && dateNav.dailyTotal > 0) {
    rows.push(
      groupRow(
        "d",
        dateNav.dailyLabel,
        dateNav.dailyTotal,
        0,
        () => onToggle("d"),
        dailyIcon,
        isFolderActive("inbox", dateNav.dailyDir),
        false,
        onRootContextMenu ? (e) => onRootContextMenu(e, dateNav.dailyDir) : undefined,
      ),
    );
    if (expanded.has("d")) {
      for (const yg of dateNav.daily) {
        const yKey = `d:${yg.year}`;
        rows.push(
          groupRow(
            yKey,
            String(yg.year),
            yg.total,
            1,
            () => onToggle(yKey),
            <FolderGlyphIcon open={expanded.has(yKey)} />,
            false,
            showSidebarChevrons,
          ),
        );
        if (expanded.has(yKey)) {
          for (const mg of yg.months) {
            const mKey = `d:${yg.year}:${mg.month}`;
            rows.push(
              groupRow(
                mKey,
                monthName(yg.year, mg.month),
                mg.notes.length,
                2,
                () => onToggle(mKey),
                <FolderGlyphIcon open={expanded.has(mKey)} />,
                false,
                showSidebarChevrons,
              ),
            );
            if (expanded.has(mKey)) for (const n of mg.notes) rows.push(leaf(n, 3));
          }
        }
      }
    }
  }

  if (dateNav.weeklyEnabled && dateNav.weeklyTotal > 0) {
    rows.push(
      groupRow(
        "w",
        dateNav.weeklyLabel,
        dateNav.weeklyTotal,
        0,
        () => onToggle("w"),
        weeklyIcon,
        isFolderActive("inbox", dateNav.weeklyDir),
        false,
        onRootContextMenu ? (e) => onRootContextMenu(e, dateNav.weeklyDir) : undefined,
      ),
    );
    if (expanded.has("w")) {
      for (const yg of dateNav.weekly) {
        const yKey = `w:${yg.year}`;
        rows.push(
          groupRow(
            yKey,
            String(yg.year),
            yg.notes.length,
            1,
            () => onToggle(yKey),
            <FolderGlyphIcon open={expanded.has(yKey)} />,
            false,
            showSidebarChevrons,
          ),
        );
        if (expanded.has(yKey)) for (const n of yg.notes) rows.push(leaf(n, 2));
      }
    }
  }

  if (rows.length === 0) return null;
  return <div className="mt-1 flex flex-col">{rows}</div>;
}

function RowKeyHint({
  active,
  keyLabel,
  label,
  compact = false,
}: {
  active: boolean;
  keyLabel: string;
  label?: string;
  compact?: boolean;
}): JSX.Element {
  return (
    <span
      className={[
        "pointer-events-none shrink-0 rounded-md border px-1.5 py-0.5 text-2xs leading-none",
        active
          ? "border-white/25 bg-white/12 text-white/80"
          : "border-paper-300/70 bg-paper-100/75 text-ink-500",
      ].join(" ")}
    >
      <span className="font-mono text-2xs">{keyLabel}</span>
      {!compact && label ? <span className="ml-1">{label}</span> : null}
    </span>
  );
}

function sortOrderLabel(order: NoteSortOrder): string {
  switch (order) {
    case "none":
      return "No sorting";
    case "updated-desc":
      return "Modified (newest)";
    case "updated-asc":
      return "Modified (oldest)";
    case "created-desc":
      return "Created (newest)";
    case "created-asc":
      return "Created (oldest)";
    case "name-asc":
      return "Name (A → Z)";
    case "name-desc":
      return "Name (Z → A)";
  }
}
