import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { AssetMeta, FolderEntry, NoteFolder, NoteMeta } from "@shared/ipc";
import type { NoteSortOrder } from "../store";
import { isArchiveTabPath } from "@shared/archive";
import { isTrashTabPath } from "@shared/trash";
import { isQuickNotesTabPath } from "@shared/quick-notes";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckSquareIcon,
  DocumentIcon,
  ExpandAllIcon,
  FolderPlusIcon,
  InboxIcon,
  NotePlusIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
  TargetIcon,
  TrashIcon,
  ZapIcon,
} from "./icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ResizeHandle } from "./ResizeHandle";
import { VaultBadge } from "./VaultBadge";
import { usePrompt } from "./PromptModal";
import { confirmApp } from "./ConfirmHost";
import { resolveQuickNoteTitle } from "../lib/quick-note-title";
import { recordRendererPerf } from "../lib/perf";
import {
  assetFolderSubpath,
  isPrimaryNotesAtRoot,
  folderForVaultRelativePath,
  noteFolderSubpath,
} from "../lib/vault-layout";
import {
  hasZenItem,
  readDragPayload,
  setDragPayload,
  type DragPayload,
} from "../lib/dnd";
import { resolveSystemFolderLabels } from "../lib/system-folder-labels";

function escapeForAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
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

export function Sidebar(): JSX.Element {
  const vault = useStore((s) => s.vault);
  const notes = useStore((s) => s.notes);
  const allFolders = useStore((s) => s.folders);
  const hasAssetsDir = useStore((s) => s.hasAssetsDir);
  const focusedPanel = useStore((s) => s.focusedPanel);
  const sidebarCursorIndex = useStore((s) => s.sidebarCursorIndex);
  const activeNote = useStore((s) => s.activeNote);
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
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setFocusedPanel = useStore((s) => s.setFocusedPanel);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const renameTag = useStore((s) => s.renameTag);
  const deleteTag = useStore((s) => s.deleteTag);
  const tagsCollapsed = useStore((s) => s.tagsCollapsed);
  const setTagsCollapsed = useStore((s) => s.setTagsCollapsed);
  const createFolderAction = useStore((s) => s.createFolder);
  const renameFolderAction = useStore((s) => s.renameFolder);
  const deleteFolderAction = useStore((s) => s.deleteFolder);
  const duplicateFolderAction = useStore((s) => s.duplicateFolder);
  const revealFolderAction = useStore((s) => s.revealFolder);
  const revealAssetsDir = useStore((s) => s.revealAssetsDir);
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
  const selectedPath = useStore((s) => s.selectedPath);
  const tabsEnabled = useStore((s) => s.tabsEnabled);
  const openNoteInTab = useStore((s) => s.openNoteInTab);
  const systemFolderLabels = useStore((s) => s.systemFolderLabels);
  const workspaceMode = useStore((s) => s.workspaceMode);
  const remoteWorkspaceInfo = useStore((s) => s.remoteWorkspaceInfo);
  const moveNoteAction = useStore((s) => s.moveNote);
  const renameNote = useStore((s) => s.renameNote);
  const { prompt, modal: promptModal } = usePrompt();
  const canRevealInFileManager =
    window.zen.getAppInfo().runtime === "desktop" && workspaceMode !== "remote";
  const absolutePathLabel =
    workspaceMode === "remote" ? "Copy Server Path" : "Copy Absolute Path";
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels),
    [systemFolderLabels],
  );
  const remoteLabel = useMemo(
    () => remoteWorkspaceLabel(remoteWorkspaceInfo?.baseUrl ?? null),
    [remoteWorkspaceInfo?.baseUrl],
  );
  const primaryNotesAtRoot = useMemo(
    () => isPrimaryNotesAtRoot(vaultSettings),
    [vaultSettings],
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
    if (payload.kind === "note") {
      // Skip if dropping back into the same container.
      const curParts = payload.path.split("/");
      const curSub = curParts.slice(1, -1).join("/");
      const curFolder = curParts[0] as NoteFolder;
      if (curFolder === targetFolder && curSub === targetSubpath) return;
      await moveNoteAction(payload.path, targetFolder, targetSubpath);
      return;
    }
    // Folder drop — cross-top-folder moves aren't supported (folders
    // can't move between inbox/archive/trash). Same-top-folder moves
    // reparent the subfolder.
    if (payload.folder !== targetFolder) {
      window.alert(
        "Folders can only be moved within the same top-level folder.",
      );
      return;
    }
    if (!payload.subpath) return; // top-level folder can't be moved
    const leaf = payload.subpath.split("/").slice(-1)[0];
    const nextSubpath = targetSubpath ? `${targetSubpath}/${leaf}` : leaf;
    if (nextSubpath === payload.subpath) return;
    if ((nextSubpath + "/").startsWith(payload.subpath + "/")) {
      // Moving into self / descendant.
      return;
    }
    try {
      await renameFolderAction(payload.folder, payload.subpath, nextSubpath);
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
  const [assetMenu, setAssetMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(
    null,
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
  const trees = useMemo(
    () => ({
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
    }),
    [notes, allFolders, assetFiles, vaultSettings],
  );

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

  // Aggregate hashtags across non-trash notes, with the active note
  // re-computed from its live body.
  const tags = useMemo(() => {
    const counter = new Map<string, number>();
    for (const n of notes) {
      if (n.folder === "trash") continue;
      const isActive = activeNote && activeNote.path === n.path;
      const list = isActive ? extractTags(activeNote!.body) : n.tags;
      for (const t of list) counter.set(t, (counter.get(t) ?? 0) + 1);
    }
    return [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes, activeNote]);

  const folderMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!folderMenu) return [];
    const { folder, subpath } = folderMenu;
    const isTop = subpath === "";
    const label = isTop ? folderLabels[folder] : subpath.split("/").slice(-1)[0];
    const trashCount = notes.filter((note) => note.folder === "trash").length;

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
      ];
    }

    const items: ContextMenuItem[] = [
      {
        label: "New note",
        onSelect: async () => {
          await createAndOpen(folder, subpath);
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
          const name = await prompt({
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
    }

    items.push({ kind: "separator" });
    if (canRevealInFileManager) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await revealFolderAction(folder, subpath);
        },
      });
    }
    items.push({
      label: "Copy Path",
      onSelect: async () => {
        // Vault-relative POSIX path (e.g. `inbox/Work/Research`).
        const rel = subpath ? `${folder}/${subpath}` : folder;
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
        const parts = [
          root.replace(/[\\/]+$/, ""),
          folder,
          ...subpath.split("/").filter(Boolean),
        ];
        window.zen.clipboardWriteText(parts.join(sep));
      },
    });

    if (!isTop) {
      items.push({ kind: "separator" });
      items.push({
        label: "Rename…",
        onSelect: async () => {
          const leaf = subpath.split("/").slice(-1)[0];
          const next = await prompt({
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
    vault,
    createAndOpen,
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
    prompt,
  ]);

  const noteMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!noteMenu) return [];
    const n = notes.find((note) => note.path === noteMenu.path);
    if (!n) return [];
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
          const next = await prompt({
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
          const target = await prompt(buildMoveNotePrompt(n, allFolders));
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
    prompt,
    renameNote,
    moveNoteAction,
    canRevealInFileManager,
    absolutePathLabel,
    tabsEnabled,
    openNoteInTab,
  ]);

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return [];
    const asset = assetFiles.find((entry) => entry.path === assetMenu.path);
    if (!asset) return [];

    const url = vault?.root
      ? window.zen.resolveVaultAssetUrl(vault.root, asset.path)
      : null;
    const root = vault?.root ?? "";
    const sep = root.includes("\\") ? "\\" : "/";
    const abs = [root.replace(/[\\/]+$/, ""), ...asset.path.split("/").filter(Boolean)].join(
      sep,
    );

    const items: ContextMenuItem[] = [
      {
        label: "Open",
        onSelect: async () => {
          if (url) window.open(url, "_blank");
        },
      },
      {
        label: "Copy Path",
        onSelect: async () => {
          window.zen.clipboardWriteText(asset.path);
        },
      },
      {
        label: absolutePathLabel,
        onSelect: async () => {
          window.zen.clipboardWriteText(abs);
        },
      },
    ];

    if (canRevealInFileManager) {
      items.push({
        label: "Reveal in File Manager",
        onSelect: async () => {
          await window.zen.revealNote(asset.path);
        },
      });
    }

    return items;
  }, [assetMenu, assetFiles, canRevealInFileManager, absolutePathLabel, vault]);

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
          const next = await prompt({
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
  }, [tagMenu, renameTag, deleteTag, prompt]);

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

  const openFolderMenu = (
    e: React.MouseEvent,
    folder: NoteFolder,
    subpath: string,
  ): void => {
    e.preventDefault();
    setFolderMenu({ x: e.clientX, y: e.clientY, folder, subpath });
  };

  const isSidebarFocused = focusedPanel === "sidebar";
  // Mutable counter reset on each render — assigns sequential data-sidebar-idx to each item.
  const idxCounter = useRef<{ value: number }>({ value: 0 });
  idxCounter.current.value = 0;
  const vimCursor = isSidebarFocused ? sidebarCursorIndex : -1;
  // VimNav clamps cursor position via Math.min/Math.max on each
  // keystroke using the actual DOM element count — no extra clamping needed.

  const syncSidebarCursorFromTarget = (target: EventTarget | null): void => {
    const el =
      target instanceof HTMLElement
        ? (target.closest("[data-sidebar-idx]") as HTMLElement | null)
        : null;
    const idx = Number(el?.dataset.sidebarIdx);
    if (Number.isFinite(idx) && idx !== sidebarCursorIndex) {
      useStore.getState().setSidebarCursorIndex(idx);
    }
  };

  useEffect(() => {
    if (!isSidebarFocused) return;

    const findTarget = (): HTMLElement | null => {
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
        <div className="flex min-w-0 items-center gap-2">
          <VaultBadge name={vault?.name ?? "ZenNotes"} size={28} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink-800">
              {vault?.name ?? "ZenNotes"}
            </div>
            {workspaceMode === "remote" && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
                <span className="inline-flex items-center gap-1 rounded-full border border-paper-300/70 bg-paper-100/80 px-1.5 py-0.5 font-medium text-ink-700">
                  <ArrowUpRightIcon className="h-3 w-3" />
                  Remote
                </span>
                <span className="truncate">{remoteLabel}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn title="New note" onClick={() => void createAndOpen("inbox")}>
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
          <kbd className="rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-500">
            ⌘P
          </kbd>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn
            title="New note"
            onClick={() => {
              const state = useStore.getState();
              const target = defaultNewNoteTarget(
                state.activeNote,
                state.vaultSettings,
              );
              void createAndOpen(target.folder, target.subpath);
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
              const name = await prompt({
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
        className="mt-3 min-h-0 flex-1 overflow-y-auto px-3"
        style={{ scrollbarGutter: "stable" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocusedPanel("editor");
        }}
      >
        <div className="flex flex-col pb-2">
          <TaskSidebarRow
            active={tasksViewActive}
            onClick={() => void openTasksView()}
            sidebarIdx={idxCounter.current.value++}
            vimHighlight={vimCursor === idxCounter.current.value - 1}
            sidebarFocused={isSidebarFocused}
          />

          <FolderTreeRoot
            label={folderLabels.quick}
            icon={<ZapIcon />}
            folder="quick"
            tree={trees.quick}
            isFolderActive={isFolderActive}
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            setView={setView}
            onContextMenu={openFolderMenu}
            showNotes={unifiedSidebar}
            selectedPath={selectedPath}
            vaultRoot={vault?.root ?? null}
            onSelectNote={(p) => void selectNote(p)}
            onNoteContextMenu={(e, n) => {
              e.preventDefault();
              setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path });
            }}
            onAssetContextMenu={(e, asset) => {
              e.preventDefault();
              setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path });
            }}
            sortComparator={treeSortComparator}
            onDropOnFolder={handleDropOnFolder}
            idxCounter={idxCounter.current}
            vimCursor={vimCursor}
            sidebarFocused={isSidebarFocused}
            groupByKind={groupByKind}
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
                  );
                  void createAndOpen("quick", "", { title, focusTitle: true });
                }}
                className="mr-1 flex h-6 w-6 items-center justify-center rounded-md bg-current/0 text-current transition-colors hover:bg-current/15"
              >
                <PlusIcon width={16} height={16} strokeWidth={2.5} />
              </button>
            }
          />

          {primaryNotesAtRoot ? (
            <FolderTreeContents
              tree={trees.inbox}
              depth={0}
              folder="inbox"
              isFolderActive={isFolderActive}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              setView={setView}
              onContextMenu={openFolderMenu}
              showNotes={unifiedSidebar}
              selectedPath={selectedPath}
              vaultRoot={vault?.root ?? null}
              onSelectNote={(p) => void selectNote(p)}
              onNoteContextMenu={(e, n) => {
                e.preventDefault();
                setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path });
              }}
              onAssetContextMenu={(e, asset) => {
                e.preventDefault();
                setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path });
              }}
              sortComparator={treeSortComparator}
              onDropOnFolder={handleDropOnFolder}
              idxCounter={idxCounter.current}
              vimCursor={vimCursor}
              sidebarFocused={isSidebarFocused}
              groupByKind={groupByKind}
            />
          ) : (
            <FolderTreeRoot
              label={folderLabels.inbox}
              icon={<InboxIcon />}
              folder="inbox"
              tree={trees.inbox}
              isFolderActive={isFolderActive}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              setView={setView}
              onContextMenu={openFolderMenu}
              showNotes={unifiedSidebar}
              selectedPath={selectedPath}
              vaultRoot={vault?.root ?? null}
              onSelectNote={(p) => void selectNote(p)}
              onNoteContextMenu={(e, n) => {
                e.preventDefault();
                setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path });
              }}
              onAssetContextMenu={(e, asset) => {
                e.preventDefault();
                setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path });
              }}
              sortComparator={treeSortComparator}
              onDropOnFolder={handleDropOnFolder}
              idxCounter={idxCounter.current}
              vimCursor={vimCursor}
              sidebarFocused={isSidebarFocused}
              groupByKind={groupByKind}
            />
          )}

          {/* System folders (Archive / Trash) share the row height of
           *  every tree row above so the vertical rhythm stays uniform.
           *  A single 4px break separates them from the inbox tree so
           *  the eye can tell "this is a different section" \u2014 any
           *  more than that and they start to feel detached. */}
          <div className="mt-1">
            <ArchiveSidebarRow
              label={folderLabels.archive}
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

          {/* Tag pills */}
          {tags.length > 0 && (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => setTagsCollapsed(!tagsCollapsed)}
                title={tagsCollapsed ? "Show tags" : "Hide tags"}
                aria-expanded={!tagsCollapsed}
                className="flex w-full items-center gap-1 rounded px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-500 transition-colors hover:text-ink-800"
              >
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
                <span>Tags</span>
                <span className="ml-1 text-ink-400 normal-case tracking-normal">
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
                            "ml-1 text-[10px]",
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
            icon={<FolderIcon open={false} />}
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
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
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
      {promptModal}
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
}

type TreeRenderEntry =
  | { type: "folder"; node: TreeNode }
  | { type: "note"; note: NoteMeta }
  | { type: "asset"; asset: AssetMeta };

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
  onNoteContextMenu: (e: React.MouseEvent, n: NoteMeta) => void;
  onAssetContextMenu: (e: React.MouseEvent, asset: AssetMeta) => void;
  sortComparator: ((a: NoteMeta, b: NoteMeta) => number) | null;
  onDropOnFolder: (
    payload: DragPayload,
    targetFolder: NoteFolder,
    targetSubpath: string,
  ) => void | Promise<void>;
  /** Sequential index counter for vim navigation data attributes. */
  idxCounter: IdxCounter;
  /** The highlighted cursor index when sidebar is vim-focused (-1 if not focused). */
  vimCursor: number;
  /** Whether the sidebar currently owns keyboard focus. */
  sidebarFocused: boolean;
  /** Finder-style folders-first rendering toggle. */
  groupByKind: boolean;
}

function FolderTreeContents({
  folder,
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
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
  isFolderActive,
}: {
  tree: TreeNode;
  depth: number;
} & TreeRenderProps): JSX.Element {
  const entries = useMemo(
    () => getTreeRenderEntries(tree, showNotes, sortComparator, groupByKind),
    [tree, showNotes, sortComparator, groupByKind],
  );

  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "folder") {
          return (
            <SubTree
              key={entry.node.subpath}
              node={entry.node}
              depth={depth}
              folder={folder}
              isFolderActive={isFolderActive}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              setView={setView}
              onContextMenu={onContextMenu}
              showNotes={showNotes}
              selectedPath={selectedPath}
              vaultRoot={vaultRoot}
              onSelectNote={onSelectNote}
              onNoteContextMenu={onNoteContextMenu}
              onAssetContextMenu={onAssetContextMenu}
              sortComparator={sortComparator}
              onDropOnFolder={onDropOnFolder}
              idxCounter={idxCounter}
              vimCursor={vimCursor}
              sidebarFocused={sidebarFocused}
              groupByKind={groupByKind}
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
            active={n.path === selectedPath}
            sidebarFocused={sidebarFocused}
            onSelect={() => onSelectNote(n.path)}
            onContextMenu={(e) => onNoteContextMenu(e, n)}
            sidebarIdx={noteIdx}
            vimHighlight={vimCursor === noteIdx}
          />
        );
      })}
    </>
  );
}

function FolderTreeRoot({
  label,
  icon,
  folder,
  tree,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  vaultRoot,
  onSelectNote,
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
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
  const hasChildren = entries.length > 0;
  const [dragHover, setDragHover] = useState(false);
  const myIdx = idxCounter.value++;

  const handleSelect = (): void => {
    setView({ kind: "folder", folder, subpath: "" });
    // Click toggles the expand state on every folder row.
    if (hasChildren) toggleCollapse(rootKey);
  };

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={icon}
        label={label}
        count={total}
        active={isFolderActive(folder, "")}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={0}
        onToggle={() => toggleCollapse(rootKey)}
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
      />
      {!isCollapsed && (
        <FolderTreeContents
          tree={tree}
          depth={1}
          folder={folder}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={onContextMenu}
          showNotes={showNotes}
          selectedPath={selectedPath}
          vaultRoot={vaultRoot}
          onSelectNote={onSelectNote}
          onNoteContextMenu={onNoteContextMenu}
          onAssetContextMenu={onAssetContextMenu}
          sortComparator={sortComparator}
          onDropOnFolder={onDropOnFolder}
          idxCounter={idxCounter}
          vimCursor={vimCursor}
          sidebarFocused={sidebarFocused}
          groupByKind={groupByKind}
        />
      )}
    </div>
  );
}

function SubTree({
  node,
  depth,
  folder,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  vaultRoot,
  onSelectNote,
  onNoteContextMenu,
  onAssetContextMenu,
  sortComparator,
  onDropOnFolder,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
}: { node: TreeNode; depth: number } & TreeRenderProps): JSX.Element {
  const key = `${folder}:${node.subpath}`;
  const isCollapsed = collapsed.has(key);
  const entries = useMemo(
    () => getTreeRenderEntries(node, showNotes, sortComparator, groupByKind),
    [node, showNotes, sortComparator, groupByKind],
  );
  const hasChildren = entries.length > 0;
  const [dragHover, setDragHover] = useState(false);
  const myIdx = idxCounter.value++;

  const handleSelect = (): void => {
    setView({ kind: "folder", folder, subpath: node.subpath });
    if (hasChildren) toggleCollapse(key);
  };

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={<FolderIcon open={!isCollapsed && hasChildren} />}
        label={node.name}
        count={countNotesInTree(node)}
        active={isFolderActive(folder, node.subpath)}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={depth}
        onToggle={() => toggleCollapse(key)}
        onSelect={handleSelect}
        onContextMenu={(e) => onContextMenu(e, folder, node.subpath)}
        draggable
        onDragStart={(e) =>
          setDragPayload(e, { kind: "folder", folder, subpath: node.subpath })
        }
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
          void onDropOnFolder(payload, folder, node.subpath);
        }}
        sidebarIdx={myIdx}
        vimHighlight={vimCursor === myIdx}
        sidebarFocused={sidebarFocused}
        sidebarData={{ type: "folder", folder, subpath: node.subpath, key }}
      />
      {!isCollapsed && (
        <>
          {entries.map((entry) => {
            if (entry.type === "folder") {
              return (
                <SubTree
                  key={entry.node.subpath}
                  node={entry.node}
                  depth={depth + 1}
                  folder={folder}
                  isFolderActive={isFolderActive}
                  collapsed={collapsed}
                  toggleCollapse={toggleCollapse}
                  setView={setView}
                  onContextMenu={onContextMenu}
                  showNotes={showNotes}
                  selectedPath={selectedPath}
                  vaultRoot={vaultRoot}
                  onSelectNote={onSelectNote}
                  onNoteContextMenu={onNoteContextMenu}
                  onAssetContextMenu={onAssetContextMenu}
                  sortComparator={sortComparator}
                  onDropOnFolder={onDropOnFolder}
                  idxCounter={idxCounter}
                  vimCursor={vimCursor}
                  sidebarFocused={sidebarFocused}
                  groupByKind={groupByKind}
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
                active={n.path === selectedPath}
                sidebarFocused={sidebarFocused}
                onSelect={() => onSelectNote(n.path)}
                onContextMenu={(e) => onNoteContextMenu(e, n)}
                sidebarIdx={noteIdx}
                vimHighlight={vimCursor === noteIdx}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

function NoteLeaf({
  note,
  depth,
  active,
  sidebarFocused,
  onSelect,
  onContextMenu,
  sidebarIdx,
  vimHighlight,
}: {
  note: NoteMeta;
  depth: number;
  active: boolean;
  sidebarFocused: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  sidebarIdx?: number;
  vimHighlight?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => setDragPayload(e, { kind: "note", path: note.path })}
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
            : "text-ink-700 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 + depth * 14 + 20 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "note",
            "data-sidebar-path": note.path,
          }
        : {})}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={
          active
            ? sidebarFocused && !vimHighlight
              ? "text-accent/80"
              : "text-white/80"
            : "text-ink-400"
        }
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6" />
      </svg>
      <span className="flex-1 truncate">{note.title}</span>
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
              : "text-ink-400",
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
        <RowKeyHint active={active} label="menu" keyLabel="m" />
      )}
    </button>
  );
}

function AssetLeaf({
  asset,
  vaultRoot,
  depth,
  onContextMenu,
  sidebarFocused,
  sidebarIdx,
  vimHighlight,
}: {
  asset: AssetMeta;
  vaultRoot: string | null;
  depth: number;
  onContextMenu: (e: React.MouseEvent) => void;
  sidebarFocused: boolean;
  sidebarIdx?: number;
  vimHighlight?: boolean;
}): JSX.Element {
  const url = vaultRoot ? window.zen.resolveVaultAssetUrl(vaultRoot, asset.path) : null;
  const extension = asset.name.includes(".")
    ? asset.name.split(".").pop()?.toUpperCase() ?? ""
    : "";

  return (
    <button
      onClick={() => {
        if (url) window.open(url, "_blank");
      }}
      onContextMenu={onContextMenu}
      className={[
        "group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        vimHighlight ? "vim-cursor" : "text-ink-700 hover:bg-paper-200/70",
      ].join(" ")}
      style={{ paddingLeft: 4 + depth * 14 + 20 }}
      {...(sidebarIdx != null
        ? {
            "data-sidebar-idx": sidebarIdx,
            "data-sidebar-type": "asset",
            "data-sidebar-path": asset.path,
          }
        : {})}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-ink-400"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6" />
      </svg>
      <span className="flex-1 truncate text-ink-700">{asset.name}</span>
      {extension && (
        <span
          className={[
            "shrink-0 pr-2 text-[10px] uppercase tracking-wide",
            sidebarFocused && vimHighlight ? "text-ink-700" : "text-ink-400",
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
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData,
  trailing,
}: {
  icon: JSX.Element;
  label: string;
  count?: number;
  active: boolean;
  expandable: boolean;
  collapsed: boolean;
  depth: number;
  onToggle: () => void;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  dropTarget?: boolean;
  sidebarIdx?: number;
  vimHighlight?: boolean;
  sidebarFocused?: boolean;
  sidebarData?: { type: string; folder: string; subpath: string; key: string };
  /** Optional inline action(s) shown on the right edge, revealed on hover. */
  trailing?: JSX.Element;
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
          onSelect();
        }
      }}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        "group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none",
        active
          ? vimHighlight
            ? "vim-cursor-on-active bg-accent text-white"
            : sidebarFocused
              ? "text-accent"
              : "bg-accent text-white"
          : dropTarget
            ? "bg-accent/20 text-ink-900 ring-1 ring-accent/60"
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
          }
        : {})}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expandable ? (
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
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <span
        className={
          strongActive ? "text-white" : "text-ink-500 group-hover:text-ink-800"
        }
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint
          active={active}
          keyLabel="m"
          compact={typeof count === "number" && count > 0}
        />
      )}
      {trailing && <span className="shrink-0">{trailing}</span>}
      {typeof count === "number" && count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : "text-ink-400",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </div>
  );
}

// Shares TreeRow's padding + chevron-slot layout so "Tasks" lines up with
// Quick Notes / Inbox / Archive. No count, no expand button, no drag-and-
// drop — it's a plain top-level navigation entry.
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
      {/* Empty slot matches FolderTreeRoot's collapse-chevron column so the
          icon + label line up with Quick Notes / Inbox / Archive. */}
      <span className="h-5 w-5 shrink-0" />
      <span
        className={
          strongActive ? "text-white" : "text-ink-500 group-hover:text-ink-800"
        }
      >
        <CheckSquareIcon />
      </span>
      <span className="flex-1 truncate">Tasks</span>
    </div>
  );
}

function ArchiveSidebarRow({
  label,
  count,
  active,
  onClick,
  onContextMenu,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
}: {
  label: string;
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
      <span className="h-5 w-5 shrink-0" />
      <span
        className={
          strongActive ? "text-white" : "text-ink-500 group-hover:text-ink-800"
        }
      >
        <ArchiveIcon />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} keyLabel="m" compact={count > 0} />
      )}
      {count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : "text-ink-400",
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
  count,
  active,
  onClick,
  onContextMenu,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
}: {
  label: string;
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
      <span className="h-5 w-5 shrink-0" />
      <span
        className={
          strongActive ? "text-white" : "text-ink-500 group-hover:text-ink-800"
        }
      >
        <TrashIcon />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} keyLabel="m" compact={count > 0} />
      )}
      {count > 0 && (
        <span
          className={[
            "shrink-0 pr-2 text-xs",
            strongActive ? "text-white/80" : "text-ink-400",
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
            strongActive ? "text-white/80" : "text-ink-400",
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
  count,
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
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium leading-none transition-colors whitespace-nowrap",
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
            "rounded-full px-1.5 py-0.5 text-[10px]",
            strongActive
              ? "bg-white/12 text-white/80"
              : "bg-paper-200/80 text-ink-500",
          ].join(" ")}
        >
          {count}
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
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-[11px] font-medium text-ink-800 shadow-panel group-hover:block group-focus-visible:block">
        {title}
      </span>
    </button>
  );
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
        "pointer-events-none shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-none",
        active
          ? "border-white/25 bg-white/12 text-white/80"
          : "border-paper-300/70 bg-paper-100/75 text-ink-500",
      ].join(" ")}
    >
      <span className="font-mono text-[10px]">{keyLabel}</span>
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

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  // Simple folder glyph — filled when open, outlined when closed.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={open ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      fillOpacity={open ? 0.18 : 0}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
