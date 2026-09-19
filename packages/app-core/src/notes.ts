import { isWorkspaceTransitionPending } from './lib/workspace-transition';
import type { NoteMeta } from "@shared/ipc";
import { formDirContaining } from "@shared/databases";
import { useStore } from "./store";
import { confirmApp, getConfirmRequest } from "./lib/confirm-requests";
import { getPromptRequest, promptApp } from "./lib/prompt-requests";
import {
  buildMoveNotePrompt,
  parseMoveNoteTarget,
  validateMoveNoteTarget,
} from "./lib/move-note";
import { noteFolderSubpath } from "./lib/vault-layout";
import {
  confirmDeletePermanently,
  confirmMoveToTrash,
} from "./lib/confirm-trash";

export interface NoteActionHost {
  /** Capture the native vault token before opening the prompt and compare it here. */
  isCurrent(): boolean;
}

/** Operational errors reject. Dispatched work may complete in its original vault. */
export type NoteActionResult =
  | "completed"
  | "cancelled"
  | "stale"
  | "unavailable";

let pending = false;

function validateDestination(value: string): string | null {
  const error = validateMoveNoteTarget(value);
  if (error) return error;
  const { subpath } = parseMoveNoteTarget(value);
  if (
    /[\u0000-\u001f]/.test(value) ||
    subpath.split("/").some((part) => part.startsWith("."))
  )
    return "Choose a folder without hidden names or parent-directory segments.";
  if (formDirContaining(subpath))
    return "Database record folders are not move destinations.";
  return null;
}

function captureNoteActionContext(host: NoteActionHost): () => boolean {
  const state = useStore.getState();
  const vault = state.vault;
  const bridge = window.zen;
  const layout = (settings: typeof state.vaultSettings) =>
    JSON.stringify([settings.primaryNotesLocation, settings.systemFolderPaths]);
  const originalLayout = layout(state.vaultSettings);
  const isCurrent = () => {
    try {
      const current = useStore.getState();
      return (
        !isWorkspaceTransitionPending() &&
        current.vault === vault &&
        window.zen === bridge &&
        layout(current.vaultSettings) === originalLayout &&
        host.isCurrent()
      );
    } catch {
      return false;
    }
  };
  return isCurrent;
}

async function requestNoteAction(
  host: NoteActionHost,
  path: string,
  action: (
    state: ReturnType<typeof useStore.getState>,
    note: NoteMeta,
    isCurrent: () => boolean,
  ) => Promise<NoteActionResult>,
  allowed: (note: NoteMeta) => boolean = (note) => note.folder !== "trash",
): Promise<NoteActionResult> {
  if (
    pending ||
    getPromptRequest() ||
    getConfirmRequest() ||
    formDirContaining(path)
  )
    return "unavailable";
  const state = useStore.getState();
  const note = state.notes.find((note) => note.path === path);
  if (!state.vault || !note || !allowed(note)) return "unavailable";
  const isCurrent = captureNoteActionContext(host);
  if (!isCurrent()) return "unavailable";
  pending = true;
  try {
    return await action(state, note, isCurrent);
  } finally {
    pending = false;
  }
}

/** Prompt to move an ordinary note using logical inbox/archive folder names. */
export async function requestMoveNote(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestNoteAction(host, path, async (state, note, isCurrent) => {
    const subpath = noteFolderSubpath(note, state.vaultSettings);
    const initialValue =
      note.folder === "archive" || note.folder === "inbox"
        ? [note.folder, subpath].filter(Boolean).join("/")
        : "inbox";
    const target = await promptApp({
      ...buildMoveNotePrompt(
        note,
        state.folders.filter((folder) => !formDirContaining(folder.subpath)),
      ),
      initialValue,
      validate: validateDestination,
    });
    if (!target || validateDestination(target)) return "cancelled";
    if (
      !isCurrent() ||
      !useStore.getState().notes.some((note) => note.path === path)
    )
      return "stale";
    const destination = parseMoveNoteTarget(target);
    if (destination.folder === note.folder && destination.subpath === subpath)
      return "cancelled";
    await useStore
      .getState()
      .moveNote(path, destination.folder, destination.subpath, isCurrent);
    return isCurrent() ? "completed" : "stale";
  });
}

function validateTitle(value: string): string | null {
  if (!value.trim()) return "Enter a note title.";
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(value) || value.trim().startsWith("."))
    return "Choose a title without reserved filename characters, control characters, or a leading dot.";
  return null;
}

/** Rename a note and update inbound wikilinks, including cached editor buffers. */
export async function requestRenameNote(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestNoteAction(host, path, async (_state, note, isCurrent) => {
    const title = await promptApp({
      title: "Rename note",
      initialValue: note.title,
      okLabel: "Rename",
      validate: validateTitle,
    });
    if (title === null || validateTitle(title) || title.trim() === note.title)
      return "cancelled";
    if (
      !isCurrent() ||
      !useStore.getState().notes.some((note) => note.path === path)
    )
      return "stale";
    await useStore.getState().renameNote(path, title.trim(), isCurrent);
    return isCurrent() ? "completed" : "stale";
  });
}

async function requestLifecycle(
  host: NoteActionHost,
  path: string,
  action: "archive" | "trash" | "restore" | "delete",
): Promise<NoteActionResult> {
  const allowed = (note: NoteMeta) => {
    if (action === "restore")
      return note.folder === "archive" || note.folder === "trash";
    if (action === "delete") return note.folder === "trash";
    if (action === "archive")
      return note.folder === "inbox" || note.folder === "quick";
    return note.folder !== "trash";
  };
  return requestNoteAction(
    host,
    path,
    async (state, note, isCurrent) => {
      const confirmed =
        action === "archive"
          ? await state.confirmArchiveNotes([path])
          : action === "trash"
            ? await confirmMoveToTrash(
                note.title,
                state.vault?.temporary === true,
              )
            : action === "delete"
              ? await confirmDeletePermanently(note.title)
              : true;
      if (!confirmed) return "cancelled";
      const current = useStore
        .getState()
        .notes.find((note) => note.path === path);
      if (!isCurrent() || !current || !allowed(current)) return "stale";
      await useStore.getState().changeNoteLifecycle(path, action, isCurrent);
      return isCurrent() ? "completed" : "stale";
    },
    allowed,
  );
}

/** Save and archive a note, confirming when it contains unfinished tasks. */
export function requestArchiveNote(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestLifecycle(host, path, "archive");
}

/** Confirm and save before moving to vault Trash (system Trash in temporary sessions). */
export function requestTrashNote(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestLifecycle(host, path, "trash");
}

/** Restore an archived or trashed note to the configured primary notes location. */
export function restoreNote(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestLifecycle(host, path, "restore");
}

/** Confirm, save, and permanently delete a trashed note. */
export function requestDeleteNotePermanently(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestLifecycle(host, path, "delete");
}

/**
 * Add a note to the vault's Favorites, or take it out again: the sidebar
 * row's "Add to Favorites" for hosts without that menu. Favorites live in
 * vault.json, so the list travels with the vault and shows up on Home and in
 * the desktop sidebar. Trashed notes stay out, as on desktop. Reads go through
 * the shell snapshot's `favorites`. (#810)
 */
export function requestToggleNoteFavorite(
  host: NoteActionHost,
  path: string,
): Promise<NoteActionResult> {
  return requestNoteAction(host, path, async (state, _note, isCurrent) => {
    await state.toggleFavorite(path);
    return isCurrent() ? "completed" : "stale";
  });
}

export type NoteBatchAction = 'archive' | 'trash' | 'restore' | 'delete' | 'move'
export interface NoteBatchResult {
  readonly status: NoteActionResult
  /** Source paths confirmed complete before any stale transition. */
  readonly completed: readonly string[]
  /** A stale/failed current item may already have moved. Read the snapshot before retrying. */
  readonly unconfirmed: readonly string[]
}

export class NoteBatchError extends Error {
  readonly completed: readonly string[]
  readonly unconfirmed: readonly string[]
  constructor(completed: string[], unconfirmed: string[], readonly originalError: unknown) {
    super(`${completed.length} note actions completed. ${originalError instanceof Error ? originalError.message : String(originalError)}`)
    this.name = 'NoteBatchError'
    this.completed = Object.freeze([...completed])
    this.unconfirmed = Object.freeze([...unconfirmed])
  }
}

/** One confirmation, ordered saves, and immediate stop on failure or a stale host. */
export async function requestNoteBatch(
  host: NoteActionHost,
  requestedPaths: readonly string[],
  action: NoteBatchAction
): Promise<NoteBatchResult> {
  const paths = [...new Set(requestedPaths)]
  const completed: string[] = []
  const result = (status: NoteActionResult): NoteBatchResult => Object.freeze({
    status, completed: Object.freeze([...completed]), unconfirmed: Object.freeze(paths.slice(completed.length))
  })
  if (!paths.length || paths.some(path => formDirContaining(path))) return result('unavailable')
  const allowed = (note: NoteMeta) => action === 'restore'
    ? note.folder === 'archive' || note.folder === 'trash'
    : action === 'delete' ? note.folder === 'trash'
      : action === 'archive' ? note.folder === 'inbox' || note.folder === 'quick'
        : note.folder !== 'trash'
  try {
    const status = await requestNoteAction(host, paths[0], async (state, first, isCurrent) => {
      const valid = () => paths.every(path => {
        const note = useStore.getState().notes.find(note => note.path === path)
        return note && allowed(note)
      })
      if (!valid()) return 'unavailable'
      let destination: ReturnType<typeof parseMoveNoteTarget> | null = null
      if (action === 'move') {
        const target = await promptApp({
          ...buildMoveNotePrompt({ ...first, title: `${paths.length} notes` }, state.folders.filter(folder => !formDirContaining(folder.subpath))),
          initialValue: [first.folder === 'archive' ? 'archive' : 'inbox', noteFolderSubpath(first, state.vaultSettings)].filter(Boolean).join('/'),
          validate: validateDestination
        })
        if (!target || validateDestination(target)) return 'cancelled'
        destination = parseMoveNoteTarget(target)
      } else if (action === 'archive') {
        if (!(await state.confirmArchiveNotes(paths))) return 'cancelled'
      } else if (action !== 'restore') {
        const deleting = action === 'delete'
        if (!(await confirmApp({
          title: deleting ? `Delete ${paths.length} notes permanently?` : `Move ${paths.length} notes to Trash?`,
          description: deleting ? 'This cannot be undone.' : state.vault?.temporary
            ? 'Restore these files using your system file manager.' : 'You can restore these notes from the Trash view.',
          confirmLabel: deleting ? 'Delete permanently' : 'Move to Trash',
          danger: deleting
        }))) return 'cancelled'
      }
      if (!isCurrent() || !valid()) return 'stale'
      for (const path of paths) {
        const current = useStore.getState().notes.find(note => note.path === path)
        if (!isCurrent() || !current || !allowed(current)) return 'stale'
        if (destination) {
          if (destination.folder !== current.folder || destination.subpath !== noteFolderSubpath(current, state.vaultSettings))
            await useStore.getState().moveNote(path, destination.folder, destination.subpath, isCurrent)
        } else {
          await useStore.getState().changeNoteLifecycle(path, action as Exclude<NoteBatchAction, 'move'>, isCurrent)
        }
        if (!isCurrent()) return 'stale'
        completed.push(path)
      }
      return 'completed'
    }, allowed)
    return result(status)
  } catch (error) {
    throw new NoteBatchError(completed, paths.slice(completed.length), error)
  }
}


/** Permanently clear the configured Trash with one save/lock operation. */
export async function requestEmptyTrash(host: NoteActionHost): Promise<NoteActionResult> {
  if (pending || getPromptRequest() || getConfirmRequest() || !useStore.getState().vault) return 'unavailable'
  const isCurrent = captureNoteActionContext(host)
  if (!isCurrent()) return 'unavailable'
  pending = true
  try {
    if (!(await confirmApp({title:'Empty Trash permanently?',description:'All files in Trash will be deleted. This cannot be undone.',confirmLabel:'Empty trash',danger:true}))) return 'cancelled'
    if (!isCurrent()) return 'stale'
    await useStore.getState().emptyTrash(isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {pending=false}
}
