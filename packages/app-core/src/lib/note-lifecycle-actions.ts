import {
  requestArchiveNote,
  requestNoteBatch,
  requestEmptyTrash,
  type NoteBatchAction,
  requestDeleteNotePermanently,
  requestTrashNote,
  restoreNote,
  type NoteActionResult,
} from "../notes";
import { humanIpcError } from "./ipc-error";
import { useToastStore } from "./toast";

/** Core UI uses the same guarded actions as an installed native host. */
export async function runNoteLifecycleAction(
  path: string,
  action: "archive" | "trash" | "restore" | "delete",
): Promise<NoteActionResult | "failed"> {
  const actions = {
    archive: requestArchiveNote,
    trash: requestTrashNote,
    restore: restoreNote,
    delete: requestDeleteNotePermanently,
  };
  try {
    // The public action captures the core vault, bridge, and folder layout.
    return await actions[action]({ isCurrent: () => true }, path);
  } catch (error) {
    useToastStore
      .getState()
      .addToast(
        humanIpcError(error, "Could not complete the note action."),
        "error",
      );
    return "failed";
  }
}


export async function runNoteBatchAction(paths: readonly string[], action: NoteBatchAction): Promise<boolean> {
  try {
    const result = await requestNoteBatch({isCurrent:()=>true}, paths, action)
    if (result.status === 'stale') useToastStore.getState().addToast('The workspace changed. Check completed note actions before retrying.', 'info')
    return result.status === 'completed'
  } catch (error) {
    useToastStore.getState().addToast(humanIpcError(error,'Some notes could not be changed.'),'error')
    return false
  }
}

export async function runEmptyTrash(): Promise<void> {
  try {await requestEmptyTrash({isCurrent:()=>true})}
  catch(error){useToastStore.getState().addToast(humanIpcError(error,'Could not empty Trash.'),'error')}
}
