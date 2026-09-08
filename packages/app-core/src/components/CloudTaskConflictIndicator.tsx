import { cloudSyncPathKey } from "@zennotes/shared-domain/cloud-sync";
import { useCloudSyncStatusStore } from "../lib/cloud-auto-sync";

export function CloudTaskConflictIndicator({
  path,
}: {
  path: string;
}): JSX.Element | null {
  const pending = useCloudSyncStatusStore((state) =>
    (state.lastSummary?.pending_conflicts ?? []).some((conflict) =>
      [conflict.path, conflict.cloud_path].some(
        (candidate) =>
          candidate && cloudSyncPathKey(candidate) === cloudSyncPathKey(path),
      ),
    ),
  );
  if (!pending) return null;
  return (
    <span
      className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-ink-700"
      title="Tasks from your local note stay visible while its Cloud conflict is pending. Review sync changes to resolve it."
    >
      Conflict pending
    </span>
  );
}
