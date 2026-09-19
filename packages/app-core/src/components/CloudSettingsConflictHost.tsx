import type { VaultSettings } from "@shared/ipc";
import {
  closeCloudSettingsConflictPrompt,
  resolveCloudSettingsConflictWithStatus,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";
import { useStore } from "../store";
import { CloudSettingsConflictDialog } from "./CloudSettingsConflictDialog";

/**
 * Mounts the vault settings prompt for the whole app, beside the file
 * conflict queue and for the same reason: sync raises the question from the
 * runtime, and the status bar, palette and leader binding reopen it, so it
 * cannot live inside Settings. The file queue takes the screen first when
 * both are pending; the settings prompt waits for it to close.
 */
export function CloudSettingsConflictHost(): JSX.Element | null {
  const conflict = useCloudSyncStatusStore((state) => state.settingsConflict);
  const open = useCloudSyncStatusStore((state) => state.settingsConflictPromptOpen);
  const fileReviewOpen = useCloudSyncStatusStore((state) => state.conflictReviewOpen);
  const vaultName = useCloudSyncStatusStore((state) => state.vaultName);
  const localSettings = useStore((state) => state.vaultSettings);
  if (conflict === null || !open || fileReviewOpen) return null;
  return (
    <CloudSettingsConflictDialog
      conflict={conflict}
      localSettings={localSettings}
      vaultName={vaultName ?? "Cloud vault"}
      onClose={closeCloudSettingsConflictPrompt}
      onResolve={(choice) => resolveCloudSettingsConflictWithStatus(choice)}
      onApply={applyMergedVaultSettings}
    />
  );
}

/**
 * A per-section answer is this device's settings with some sections taken
 * from the cloud. Saving them through the store gives them the same
 * validation and pattern history as an edit in Settings; only once that save
 * is on disk is the parked copy retired, as "keep this device's" (the merged
 * file is now this device's, and the next run uploads it).
 */
async function applyMergedVaultSettings(settings: VaultSettings): Promise<void> {
  const saved = await useStore.getState().setVaultSettings(settings);
  if (!saved) {
    throw new Error("The settings could not be saved. The cloud's copy is still waiting.");
  }
  await resolveCloudSettingsConflictWithStatus("local");
}
