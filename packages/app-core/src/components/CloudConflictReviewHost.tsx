import {
  closeCloudConflictReview,
  resolvableCloudConflictCount,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";
import { CloudConflictDialog } from "./CloudConflictDialog";

/**
 * Mounts the Cloud conflict queue for the whole app. It hung off the status bar
 * before, which zen mode hides: the command palette entry and the leader
 * binding open the queue from anywhere, so the dialog must not depend on the
 * status bar being on screen. The status bar now only asks for it.
 */
export function CloudConflictReviewHost(): JSX.Element | null {
  const open = useCloudSyncStatusStore((state) => state.conflictReviewOpen);
  const summary = useCloudSyncStatusStore((state) => state.lastSummary);
  const vaultName = useCloudSyncStatusStore((state) => state.vaultName);
  if (!open || summary === null) return null;
  if (resolvableCloudConflictCount(summary) === 0) return null;
  return (
    <CloudConflictDialog
      summary={summary}
      vaultName={vaultName ?? "Cloud vault"}
      onClose={closeCloudConflictReview}
    />
  );
}
