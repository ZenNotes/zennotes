import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

export const noteEditingSync = Annotation.define<boolean>();

type Target = { vault: object | null; path: string | null };
const locks = new WeakMap<object, Set<string | null>>();
const listeners = new Set<() => void>();
export function subscribeNoteEditingLocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifyLocks(): void { for (const listener of listeners) listener(); }
const contains = (scope: string | null, path: string | null) =>
  scope === null || (path !== null && (scope === path || (scope.endsWith("/") && path.startsWith(scope))));
const editors = new Map<
  EditorView,
  { target: () => Target; refresh: () => void }
>();

export function isNoteEditingLocked(
  vault: object | null,
  path: string | null,
): boolean {
  return !!(vault && path && [...(locks.get(vault) ?? [])].some(scope => contains(scope, path)));
}

/** Hold only for operations that leave no editable destination in the vault. */
export function lockNoteEditing(vault: object, path: string): () => void {
  return acquireEditingLock(vault, path);
}

/** Freeze every current and subsequently mounted editor in this vault. */
export function lockVaultEditing(vault: object): () => void {
  return acquireEditingLock(vault, null);
}

function acquireEditingLock(vault: object, path: string | null): () => void {
  for (const [view, editor] of editors) {
    const target = editor.target();
    if (target.vault === vault && target.path && contains(path, target.path) && view.composing)
      throw new Error("Finish entering text before changing this note or vault.");
  }
  const paths = locks.get(vault) ?? new Set<string | null>();
  if ([...paths].some(scope => contains(scope, path) || contains(path, scope))) throw new Error("This note is already being deleted.");
  paths.add(path);
  locks.set(vault, paths);
  notifyLocks();
  for (const editor of editors.values()) editor.refresh();
  return () => {
    paths.delete(path);
    notifyLocks();
    for (const editor of editors.values()) editor.refresh();
  };
}

export function refreshNoteEditingLock(view: EditorView): void {
  editors.get(view)?.refresh();
}

export function noteEditingLockExtension(target: () => Target): Extension {
  const compartment = new Compartment();
  const locked = () => {
    const { vault, path } = target();
    return isNoteEditingLocked(vault, path);
  };
  const configuration = () =>
    locked()
      ? Prec.highest([
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ])
      : [];
  return [
    compartment.of(configuration()),
    // Consult the live lock even before a view can apply its reconfiguration.
    EditorState.changeFilter.of(
      (transaction) =>
        transaction.annotation(noteEditingSync) === true || !locked(),
    ),
    ViewPlugin.define((view) => {
      let previous = locked();
      editors.set(view, {
        target,
        refresh: () => {
          const next = locked();
          if (next === previous) return;
          previous = next;
          view.dispatch({ effects: compartment.reconfigure(configuration()) });
        },
      });
      return {
        destroy: () => {
          editors.delete(view);
        },
      };
    }),
  ];
}
