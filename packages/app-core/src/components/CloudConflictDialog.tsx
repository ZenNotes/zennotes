import { useRef, useState } from "react";
import type { CloudSyncRunSummary } from "@zennotes/bridge-contract/cloud-sync";
import { CloudPendingConflictResolver } from "./CloudPendingConflictResolver";
import { Modal } from "./ui/Modal";

const TITLE_ID = "cloud-conflict-dialog-title";

export function CloudConflictDialog({
  summary,
  vaultName,
  onClose,
}: {
  summary: CloudSyncRunSummary;
  vaultName: string;
  onClose: () => void;
}): JSX.Element {
  const conflicts = summary.pending_conflicts ?? [];
  const [selectedId, setSelectedId] = useState(() => conflicts[0]?.id ?? "");
  const selected =
    conflicts.find((conflict) => conflict.id === selectedId) ?? conflicts[0];
  // Focus lands on the review area rather than on the first button, which is
  // "Finish later": the queue opens on the decision, not on the way out.
  const body = useRef<HTMLDivElement>(null);
  const selectNext = (nextSummary: CloudSyncRunSummary): void => {
    const nextPending = nextSummary.pending_conflicts?.[0];
    if (nextPending) {
      setSelectedId(nextPending.id);
      return;
    }
    onClose();
  };

  return (
    <Modal
      size="xl"
      align="center"
      onClose={onClose}
      // A waiting conflict is a decision, not a dismissible toast: only
      // "Finish later", which saves the draft first, leaves the queue.
      closeOnBackdrop={selected === undefined}
      closeOnEsc={selected === undefined}
      labelledBy={TITLE_ID}
      initialFocus={body}
      className="max-h-[88vh]"
      data={{ "data-cloud-conflict-dialog": "" }}
    >
      <Modal.Header
        title="Review sync changes"
        titleId={TITLE_ID}
        description={
          conflicts.length === 1
            ? "One file has changes from two devices. Compare both complete versions before choosing what to keep."
            : `${conflicts.length} files have changes from two devices. Review them one at a time; the next file stays available here.`
        }
      />
      <Modal.Body className="max-h-[72vh] overflow-y-auto">
        <div ref={body} tabIndex={-1} className="outline-none">
          {conflicts.length > 1 && (
            <div className="mb-3 rounded-xl border border-paper-300/60 bg-paper-50/45 p-3">
              <div className="text-xs font-medium text-ink-700">
                Files to resolve
              </div>
              <div
                className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto"
                aria-label="Unresolved Cloud conflicts"
              >
                {conflicts.map((conflict) => {
                  const active = conflict.id === selected?.id;
                  return (
                    <button
                      key={conflict.id}
                      type="button"
                      aria-pressed={active}
                      title={conflict.path}
                      onClick={() => setSelectedId(conflict.id)}
                      className={[
                        "max-w-full truncate rounded-lg border px-2.5 py-1.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                        active
                          ? "border-accent/40 bg-accent/10 text-ink-900"
                          : "border-paper-300/60 bg-paper-100 text-ink-600 hover:bg-paper-200/60 hover:text-ink-900",
                      ].join(" ")}
                    >
                      {conflict.path}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selected && (
            <CloudPendingConflictResolver
              key={selected.id}
              conflict={selected}
              vaultName={vaultName}
              onClose={onClose}
              onResolved={selectNext}
            />
          )}
        </div>
      </Modal.Body>
    </Modal>
  );
}
