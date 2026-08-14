import { useCallback, useEffect, useState } from "react";
import type {
  CloudAccountStatus,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudPublishedNote,
  CloudServiceAccount,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudUsage,
  CloudVaultLink,
} from "@zennotes/bridge-contract/cloud-sync";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import { confirmApp } from "../lib/confirm-requests";
import {
  requestCloudAutoSync,
  syncCloudVaultWithStatus,
} from "../lib/cloud-auto-sync";
import { useToastStore } from "../lib/toast";
import { notifyPublishedNoteChanged } from "../lib/published-note-events";
import { Button } from "./ui/Button";

type CloudAction =
  | "connect"
  | "logout"
  | "link"
  | "unlink"
  | "sync"
  | "backup-create"
  | "backup-schedule"
  | "backup-browse"
  | "backup-note-restore"
  | "backup-download"
  | "backup-delete"
  | "backup-restore"
  | "backup-refresh"
  | "publish-refresh"
  | "publish-delete"
  | "settings-local"
  | "settings-cloud"
  | null;

export function CloudSettings({
  localVaultAvailable,
  localVaultName,
}: {
  localVaultAvailable: boolean;
  localVaultName: string;
}): JSX.Element {
  const [bridge] = useState(() => getZenBridge());
  const [status, setStatus] = useState<CloudAccountStatus | null>(null);
  const [serviceAccount, setServiceAccount] =
    useState<CloudServiceAccount | null>(null);
  const [cloudVaults, setCloudVaults] = useState<CloudSyncVault[]>([]);
  const [link, setLink] = useState<CloudVaultLink | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [newVaultName, setNewVaultName] = useState(localVaultName);
  const [summary, setSummary] = useState<CloudSyncRunSummary | null>(null);
  const [settingsConflict, setSettingsConflict] =
    useState<CloudSyncSettingsConflict | null>(null);
  const [backups, setBackups] = useState<CloudBackupSnapshot[]>([]);
  const [backupSchedule, setBackupSchedule] =
    useState<CloudBackupSchedule | null>(null);
  const [expandedBackupId, setExpandedBackupId] = useState<string | null>(null);
  const [backupItems, setBackupItems] = useState<CloudBackupSnapshotItem[]>([]);
  const [publishedNotes, setPublishedNotes] = useState<CloudPublishedNote[]>(
    [],
  );
  const [backupLabel, setBackupLabel] = useState("");
  const [restoreResult, setRestoreResult] =
    useState<CloudBackupRestoreResult | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [loadingPublishedNotes, setLoadingPublishedNotes] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [action, setAction] = useState<CloudAction>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(
    async (nextStatus?: CloudAccountStatus): Promise<void> => {
      const next = nextStatus ?? (await bridge.getCloudAccountStatus());
      setStatus(next);
      setError(null);

      if (next.state !== "connected") {
        setServiceAccount(null);
        setCloudVaults([]);
        setLink(null);
        setSummary(null);
        setBackups([]);
        setBackupSchedule(null);
        setExpandedBackupId(null);
        setBackupItems([]);
        setPublishedNotes([]);
        setRestoreResult(null);
        return;
      }

      setLoadingDetails(true);
      try {
        const account = await bridge.getCloudServiceAccount();
        setServiceAccount(account);

        if (!account.features.sync.active || !localVaultAvailable) {
          setCloudVaults([]);
          setLink(null);
          return;
        }

        const [availableVaults, currentLink] = await Promise.all([
          bridge.listCloudVaults(),
          bridge.getCloudVaultLink(),
        ]);
        setCloudVaults(availableVaults);
        setLink(currentLink);
        setSelectedVaultId((current) =>
          availableVaults.some((vault) => vault.id === current)
            ? current
            : (availableVaults[0]?.id ?? ""),
        );
      } catch (cause) {
        setError(errorMessage(cause, "Could not load ZenNotes Cloud."));
      } finally {
        setLoadingDetails(false);
      }
    },
    [bridge, localVaultAvailable],
  );

  useEffect(() => {
    void loadStatus().catch((cause) => {
      setError(errorMessage(cause, "Could not load ZenNotes Cloud."));
    });
    return bridge.onCloudAccountChange((next) => {
      void loadStatus(next);
    });
  }, [bridge, loadStatus]);

  const refreshServiceAccount = useCallback(async (): Promise<void> => {
    try {
      setServiceAccount(await bridge.getCloudServiceAccount());
    } catch {
      // Usage is supplementary; the next account refresh will retry it.
    }
  }, [bridge]);

  const backupIncluded = serviceAccount?.features.backup.active === true;
  const publishIncluded = serviceAccount?.features.publish.active === true;
  const connectedBaseUrl =
    status?.state === "connected" ? (status.account?.base_url ?? null) : null;
  const linkMismatch =
    link !== null &&
    connectedBaseUrl !== null &&
    link.base_url !== connectedBaseUrl;
  const activeLink = linkMismatch ? null : link;

  const loadPublishedNotes = useCallback(async (): Promise<void> => {
    if (!publishIncluded) {
      setPublishedNotes([]);
      return;
    }

    setLoadingPublishedNotes(true);
    try {
      setPublishedNotes(await bridge.listCloudPublishedNotes());
      await refreshServiceAccount();
    } catch (cause) {
      setError(errorMessage(cause, "Could not load published notes."));
    } finally {
      setLoadingPublishedNotes(false);
    }
  }, [bridge, publishIncluded, refreshServiceAccount]);

  useEffect(() => {
    void loadPublishedNotes();
  }, [loadPublishedNotes]);

  const loadBackups = useCallback(async (): Promise<void> => {
    if (!backupIncluded || !activeLink) {
      setBackups([]);
      setBackupSchedule(null);
      setExpandedBackupId(null);
      setBackupItems([]);
      return;
    }

    setLoadingBackups(true);
    try {
      const [nextBackups, nextSchedule] = await Promise.all([
        bridge.listCloudBackups(),
        bridge.getCloudBackupSchedule(),
      ]);
      setBackups(nextBackups);
      setBackupSchedule(nextSchedule);
      await refreshServiceAccount();
    } catch (cause) {
      setError(errorMessage(cause, "Could not load cloud backups."));
    } finally {
      setLoadingBackups(false);
    }
  }, [activeLink, backupIncluded, bridge, refreshServiceAccount]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  useEffect(() => {
    if (
      !backups.some(
        (backup) => backup.status === "pending" || backup.status === "building",
      )
    ) {
      return;
    }
    const timeout = window.setTimeout(() => void loadBackups(), 3_000);
    return () => window.clearTimeout(timeout);
  }, [backups, loadBackups]);

  const runAction = async (
    nextAction: Exclude<CloudAction, null>,
    operation: () => Promise<void>,
  ): Promise<void> => {
    setAction(nextAction);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(
        errorMessage(cause, "ZenNotes Cloud could not complete that action."),
      );
    } finally {
      setAction(null);
    }
  };

  const connect = (): Promise<void> =>
    runAction("connect", async () => {
      await bridge.connectCloudAccount();
      await loadStatus();
    });

  const logout = (): Promise<void> =>
    runAction("logout", async () => {
      await loadStatus(await bridge.logoutCloudAccount());
    });

  const linkSelectedVault = (): Promise<void> =>
    runAction("link", async () => {
      if (!selectedVaultId) return;
      setLink(await bridge.linkCloudVault(selectedVaultId));
      setSummary(null);
      requestCloudAutoSync("vault-link");
    });

  const createAndLinkVault = (): Promise<void> =>
    runAction("link", async () => {
      const name = newVaultName.trim();
      if (!name) throw new Error("Enter a name for the cloud vault.");
      const createdLink = await bridge.createAndLinkCloudVault(name);
      setLink(createdLink);
      setCloudVaults((current) => [
        ...current,
        {
          id: createdLink.vault_id,
          name: createdLink.vault_name,
          cursor: 0,
          created_at: createdLink.linked_at,
          updated_at: createdLink.linked_at,
        },
      ]);
      setSelectedVaultId(createdLink.vault_id);
      setSummary(null);
      requestCloudAutoSync("vault-link");
    });

  const unlinkVault = (): Promise<void> =>
    runAction("unlink", async () => {
      await bridge.unlinkCloudVault();
      setLink(null);
      setSummary(null);
      setBackups([]);
      setBackupSchedule(null);
      setExpandedBackupId(null);
      setBackupItems([]);
      setRestoreResult(null);
    });

  const loadSettingsConflict = useCallback(async (): Promise<void> => {
    try {
      setSettingsConflict(await bridge.getCloudSettingsConflict());
    } catch {
      // A host without the question (the web client) simply has none to ask.
      setSettingsConflict(null);
    }
  }, [bridge]);

  useEffect(() => {
    void loadSettingsConflict();
  }, [loadSettingsConflict]);

  const syncVault = (): Promise<void> =>
    runAction("sync", async () => {
      setSummary(await syncCloudVaultWithStatus(bridge, link?.vault_name));
      await loadSettingsConflict();
    });

  const resolveSettingsConflict = (
    choice: CloudSyncSettingsChoice,
  ): Promise<void> =>
    runAction(
      choice === "cloud" ? "settings-cloud" : "settings-local",
      async () => {
        await bridge.resolveCloudSettingsConflict(choice);
        await loadSettingsConflict();
      },
    );

  const createBackup = (): Promise<void> =>
    runAction("backup-create", async () => {
      const label = backupLabel.trim() || undefined;
      const created = await bridge.createCloudBackup(label);
      setBackups((current) => [
        created,
        ...current.filter((backup) => backup.id !== created.id),
      ]);
      setBackupLabel("");
      setRestoreResult(null);
      await refreshServiceAccount();
    });

  const refreshBackups = (): Promise<void> =>
    runAction("backup-refresh", loadBackups);

  const updateBackupSchedule = (enabled: boolean): Promise<void> =>
    runAction("backup-schedule", async () => {
      setBackupSchedule(await bridge.updateCloudBackupSchedule(enabled));
    });

  const browseBackup = (backup: CloudBackupSnapshot): Promise<void> => {
    if (expandedBackupId === backup.id) {
      setExpandedBackupId(null);
      setBackupItems([]);
      return Promise.resolve();
    }

    return runAction("backup-browse", async () => {
      setBackupItems(await bridge.listCloudBackupItems(backup.id));
      setExpandedBackupId(backup.id);
    });
  };

  const refreshPublishedNotes = (): Promise<void> =>
    runAction("publish-refresh", loadPublishedNotes);

  const copyPublishedLink = (note: CloudPublishedNote): void => {
    bridge.clipboardWriteText(note.url);
    useToastStore.getState().addToast("Public link copied.", "success");
  };

  const unpublishNote = async (note: CloudPublishedNote): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Unpublish ${note.title}?`,
      description:
        "The public link will stop working. Your local and synced note are not changed.",
      confirmLabel: "Unpublish",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("publish-delete", async () => {
      await bridge.unpublishCloudNote(note.id);
      setPublishedNotes((current) =>
        current.filter((candidate) => candidate.id !== note.id),
      );
      if (note.note_path) {
        notifyPublishedNoteChanged({ notePath: note.note_path, url: null });
      }
      await refreshServiceAccount();
    });
  };

  const deleteBackup = async (backup: CloudBackupSnapshot): Promise<void> => {
    const confirmed = await confirmApp({
      title: "Delete this cloud backup?",
      description:
        "This removes the recovery archive permanently. Your synced vault is not changed.",
      confirmLabel: "Delete backup",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("backup-delete", async () => {
      await bridge.deleteCloudBackup(backup.id);
      setBackups((current) =>
        current.filter((candidate) => candidate.id !== backup.id),
      );
      setRestoreResult(null);
      await refreshServiceAccount();
    });
  };

  const downloadBackup = (backup: CloudBackupSnapshot): Promise<void> =>
    runAction("backup-download", async () => {
      await bridge.downloadCloudBackup(backup.id);
    });

  const restoreBackup = async (backup: CloudBackupSnapshot): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Restore ${backup.label || "this backup"}?`,
      description:
        "ZenNotes will replace the linked cloud vault with this snapshot, then sync the restored contents to this device. Changes made after the backup may be removed.",
      confirmLabel: "Restore backup",
      danger: true,
    });
    if (!confirmed) return;

    await runAction("backup-restore", async () => {
      const result = await bridge.restoreCloudBackup(backup.id);
      setRestoreResult(result);
      if (result.sync) setSummary(result.sync);
      await loadBackups();
    });
  };

  const restoreBackupNote = async (
    backup: CloudBackupSnapshot,
    item: CloudBackupSnapshotItem,
  ): Promise<void> => {
    const confirmed = await confirmApp({
      title: `Restore ${item.path}?`,
      description:
        "This creates a new synced version of this note from the selected backup. Other notes are unchanged.",
      confirmLabel: "Restore note",
      danger: false,
    });
    if (!confirmed) return;

    await runAction("backup-note-restore", async () => {
      const result: CloudBackupNoteRestoreResult =
        await bridge.restoreCloudBackupNote(backup.id, item.id);
      setSummary(result.sync);
      useToastStore.getState().addToast(`${item.path} restored.`, "success");
      await loadBackups();
    });
  };

  if (status === null) {
    return <CloudLoadingState />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm leading-6 text-danger"
        >
          {error}
        </div>
      )}

      {status.state === "disconnected" && (
        <CloudDisconnected
          busy={action === "connect"}
          onConnect={() => void connect()}
        />
      )}

      {status.state === "connecting" && (
        <CloudConnecting
          busy={action === "logout"}
          onCancel={() => void logout()}
        />
      )}

      {status.state === "connected" && status.account && (
        <>
          <section
            data-settings-search-id="cloud-account"
            className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45"
          >
            <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink-900">
                  {status.account.user.name}
                </div>
                <div className="mt-1 truncate text-xs text-ink-500">
                  {status.account.user.email}
                </div>
                <div className="mt-1 truncate text-xs text-ink-400">
                  {status.account.device.name} · {status.account.base_url}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={action !== null}
                onClick={() => void logout()}
              >
                {action === "logout" ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </section>

          {loadingDetails && !serviceAccount ? (
            <CloudLoadingState compact />
          ) : serviceAccount ? (
            <>
              <CloudFeatureList account={serviceAccount} />
              <CloudUsageSummary account={serviceAccount} />
              <CloudVaultPanel
                action={action}
                cloudVaults={cloudVaults}
                currentBaseUrl={status.account.base_url}
                link={link}
                linkMismatch={linkMismatch}
                localVaultAvailable={localVaultAvailable}
                newVaultName={newVaultName}
                selectedVaultId={selectedVaultId}
                summary={summary}
                onCreateAndLink={() => void createAndLinkVault()}
                onLink={() => void linkSelectedVault()}
                onNewVaultNameChange={setNewVaultName}
                onSelectedVaultChange={setSelectedVaultId}
                onSync={() => void syncVault()}
                onUnlink={() => void unlinkVault()}
                onUseAnotherAccount={() => void logout()}
                settingsConflict={settingsConflict}
                onResolveSettingsConflict={(choice) =>
                  void resolveSettingsConflict(choice)
                }
                syncIncluded={serviceAccount.features.sync.active}
              />
              <CloudPublishedNotesPanel
                action={action}
                loading={loadingPublishedNotes}
                notes={publishedNotes}
                publishedBytes={serviceAccount.usage?.storage.publish_bytes}
                publishIncluded={publishIncluded}
                usage={serviceAccount.usage?.publish}
                onCopy={copyPublishedLink}
                onOpen={(note) => window.open(note.url, "_blank")}
                onRefresh={() => void refreshPublishedNotes()}
                onUnpublish={(note) => void unpublishNote(note)}
              />
              <CloudBackupPanel
                action={action}
                backupIncluded={backupIncluded}
                backupLabel={backupLabel}
                backupItems={backupItems}
                backups={backups}
                expandedBackupId={expandedBackupId}
                limits={serviceAccount.features.backup.limits}
                link={activeLink}
                loading={loadingBackups}
                restoreResult={restoreResult}
                schedule={backupSchedule}
                onBackupLabelChange={setBackupLabel}
                onCreate={() => void createBackup()}
                onBrowse={(backup) => void browseBackup(backup)}
                onDelete={(backup) => void deleteBackup(backup)}
                onDownload={(backup) => void downloadBackup(backup)}
                onRefresh={() => void refreshBackups()}
                onRestore={(backup) => void restoreBackup(backup)}
                onRestoreNote={(backup, item) =>
                  void restoreBackupNote(backup, item)
                }
                onScheduleChange={(enabled) =>
                  void updateBackupSchedule(enabled)
                }
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function CloudPublishedNotesPanel({
  action,
  loading,
  notes,
  publishedBytes,
  publishIncluded,
  usage,
  onCopy,
  onOpen,
  onRefresh,
  onUnpublish,
}: {
  action: CloudAction;
  loading: boolean;
  notes: CloudPublishedNote[];
  publishedBytes?: number;
  publishIncluded: boolean;
  usage?: CloudUsage["publish"];
  onCopy: (note: CloudPublishedNote) => void;
  onOpen: (note: CloudPublishedNote) => void;
  onRefresh: () => void;
  onUnpublish: (note: CloudPublishedNote) => void;
}): JSX.Element {
  if (!publishIncluded) {
    return (
      <CloudNotice>
        Publishing is not included in this subscription.
      </CloudNotice>
    );
  }

  return (
    <section
      data-settings-search-id="cloud-published-notes"
      aria-labelledby="cloud-published-notes-heading"
      className="space-y-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3
            id="cloud-published-notes-heading"
            className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
          >
            Published notes
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            {usage
              ? `${pluralize(usage.notes, "published note")} · ${pluralize(usage.assets, "asset")} using ${formatBytes(publishedBytes ?? 0)}.`
              : "Anyone with a link can view a published note until you unpublish it."}
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={action !== null || loading}
          onClick={onRefresh}
        >
          {action === "publish-refresh" || loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        {notes.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            {loading ? "Loading published notes…" : "No published notes yet."}
          </div>
        ) : (
          <div className="divide-y divide-paper-300/45">
            {notes.map((note) => (
              <div
                key={note.id}
                className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-900">
                    {note.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    {note.note_path && (
                      <span className="truncate">{note.note_path}</span>
                    )}
                    {note.updated_at && (
                      <span>
                        Updated {formatCloudVaultDate(note.updated_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onCopy(note)}
                  >
                    Copy link
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onOpen(note)}
                  >
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => onUnpublish(note)}
                  >
                    {action === "publish-delete"
                      ? "Unpublishing…"
                      : "Unpublish"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CloudDisconnected({
  busy,
  onConnect,
}: {
  busy: boolean;
  onConnect: () => void;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
      <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <h3 className="text-base font-semibold text-ink-900">
            Keep your vault available everywhere
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            Connect your ZenNotes account to sync this vault, create recoverable
            backups, and publish notes included in your plan.
          </p>
        </div>
        <Button variant="primary" size="md" disabled={busy} onClick={onConnect}>
          {busy ? "Opening browser…" : "Connect ZenNotes Cloud"}
        </Button>
      </div>
    </section>
  );
}

function CloudConnecting({
  busy,
  onCancel,
}: {
  busy: boolean;
  onCancel: () => void;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-3xl border border-accent/25 bg-accent/5">
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Finish signing in in your browser
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            Return to ZenNotes after approving this device. The request expires
            after five minutes.
          </p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {busy ? "Cancelling…" : "Cancel sign-in"}
        </Button>
      </div>
    </section>
  );
}

function CloudFeatureList({
  account,
}: {
  account: CloudServiceAccount;
}): JSX.Element {
  const features = [
    ["Sync", account.features.sync.active],
    ["Backup", account.features.backup.active],
    ["Publish", account.features.publish.active],
  ] as const;

  return (
    <section
      data-settings-search-id="cloud-plan"
      aria-labelledby="cloud-plan-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-plan-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          Current plan
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          Access is checked by the service on every request, independent of this
          device.
        </p>
      </div>
      <div className="grid gap-px overflow-hidden rounded-2xl border border-paper-300/60 bg-paper-300/60 sm:grid-cols-3">
        {features.map(([label, active]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 bg-paper-50 px-4 py-3"
          >
            <span className="text-sm font-medium text-ink-800">{label}</span>
            <span
              className={
                active
                  ? "text-xs font-medium text-accent"
                  : "text-xs text-ink-400"
              }
            >
              {active ? "Included" : "Not included"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CloudUsageSummary({
  account,
}: {
  account: CloudServiceAccount;
}): JSX.Element | null {
  const usage = account.usage;
  if (!usage) return null;

  const syncLimit = numericLimit(
    account.features.sync.limits,
    "max_storage_bytes",
  );
  const retentionDays = numericLimit(
    account.features.backup.limits,
    "retention_days",
  );
  const syncPercent =
    syncLimit && syncLimit > 0
      ? Math.min(100, (usage.storage.sync_bytes / syncLimit) * 100)
      : null;

  return (
    <section
      data-settings-search-id="cloud-usage"
      aria-labelledby="cloud-usage-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-usage-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          Cloud storage
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          {formatBytes(usage.storage.total_bytes)} stored across synced notes,
          backup archives, and published assets.
        </p>
      </div>

      <div className="grid gap-px overflow-hidden rounded-2xl border border-paper-300/60 bg-paper-300/60 sm:grid-cols-3">
        <CloudUsageCard
          label="Synced notes"
          value={
            syncLimit
              ? `${formatBytes(usage.storage.sync_bytes)} of ${formatBytes(syncLimit)}`
              : formatBytes(usage.storage.sync_bytes)
          }
          detail={`${pluralize(usage.sync.items, "synced note")} across ${pluralize(usage.sync.vaults, "vault")}`}
          percent={syncPercent}
        />
        <CloudUsageCard
          label="Backups"
          value={formatBytes(usage.storage.backup_bytes)}
          detail={`${pluralize(usage.backup.snapshots, "backup")}${retentionDays ? ` · ${retentionDays}-day retention` : ""}`}
        />
        <CloudUsageCard
          label="Publishing"
          value={formatBytes(usage.storage.publish_bytes)}
          detail={pluralize(usage.publish.notes, "published note")}
        />
      </div>
    </section>
  );
}

function CloudUsageCard({
  detail,
  label,
  percent,
  value,
}: {
  detail: string;
  label: string;
  percent?: number | null;
  value: string;
}): JSX.Element {
  return (
    <div className="bg-paper-50 px-4 py-4">
      <div className="text-xs font-medium text-ink-500">{label}</div>
      <div className="mt-1 text-base font-semibold text-ink-900">{value}</div>
      {percent !== null && percent !== undefined && (
        <div
          role="progressbar"
          aria-label={`${label} storage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="mt-3 h-1 overflow-hidden rounded-full bg-paper-300/65"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.max(percent, 0.5)}%` }}
          />
        </div>
      )}
      <div className="mt-2 text-xs leading-5 text-ink-500">{detail}</div>
    </div>
  );
}

function CloudVaultPanel({
  action,
  cloudVaults,
  currentBaseUrl,
  link,
  linkMismatch,
  localVaultAvailable,
  newVaultName,
  selectedVaultId,
  settingsConflict,
  summary,
  syncIncluded,
  onCreateAndLink,
  onLink,
  onNewVaultNameChange,
  onResolveSettingsConflict,
  onSelectedVaultChange,
  onSync,
  onUnlink,
  onUseAnotherAccount,
}: {
  action: CloudAction;
  cloudVaults: CloudSyncVault[];
  currentBaseUrl: string;
  link: CloudVaultLink | null;
  linkMismatch: boolean;
  localVaultAvailable: boolean;
  newVaultName: string;
  selectedVaultId: string;
  settingsConflict: CloudSyncSettingsConflict | null;
  summary: CloudSyncRunSummary | null;
  syncIncluded: boolean;
  onCreateAndLink: () => void;
  onLink: () => void;
  onNewVaultNameChange: (value: string) => void;
  onResolveSettingsConflict: (choice: CloudSyncSettingsChoice) => void;
  onSelectedVaultChange: (value: string) => void;
  onSync: () => void;
  onUnlink: () => void;
  onUseAnotherAccount: () => void;
}): JSX.Element {
  if (!syncIncluded) {
    return (
      <CloudNotice>Sync is not included in this subscription.</CloudNotice>
    );
  }
  if (!localVaultAvailable) {
    return (
      <CloudNotice>
        Save this folder as a local vault before linking it to ZenNotes Cloud.
      </CloudNotice>
    );
  }

  return (
    <section
      data-settings-search-id="cloud-vault"
      aria-labelledby="cloud-vault-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="cloud-vault-heading"
          className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
        >
          This vault
        </h3>
        <p className="mt-1 text-sm leading-6 text-ink-500">
          A local vault links to one cloud vault. Nothing syncs until you choose
          a destination.
        </p>
      </div>

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        {link && linkMismatch ? (
          <div className="divide-y divide-paper-300/45">
            <div role="status" className="space-y-4 bg-accent/5 px-5 py-5">
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-ink-900">
                  Move this vault to the current account
                </h4>
                <p className="text-sm leading-6 text-ink-600">
                  This vault was linked to{" "}
                  <span className="break-all font-mono text-xs text-ink-800">
                    {link.base_url}
                  </span>
                  . You’re now connected to{" "}
                  <span className="break-all font-mono text-xs text-ink-800">
                    {currentBaseUrl}
                  </span>
                  .
                </p>
                <p className="text-sm leading-6 text-ink-500">
                  Your local notes stay on this device. The old link is replaced
                  only after the new cloud vault is ready.
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={action !== null}
                onClick={onUseAnotherAccount}
              >
                {action === "logout" ? "Disconnecting…" : "Use another account"}
              </Button>
            </div>
            <CloudVaultDestinationOptions
              action={action}
              cloudVaults={cloudVaults}
              moving
              newVaultName={newVaultName}
              selectedVaultId={selectedVaultId}
              onCreateAndLink={onCreateAndLink}
              onLink={onLink}
              onNewVaultNameChange={onNewVaultNameChange}
              onSelectedVaultChange={onSelectedVaultChange}
            />
          </div>
        ) : link ? (
          <div className="space-y-4 px-5 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  Linked to {link.vault_name}
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  Syncs automatically on this device.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  disabled={action !== null}
                  onClick={onUnlink}
                >
                  {action === "unlink" ? "Unlinking…" : "Unlink"}
                </Button>
                <Button
                  variant="primary"
                  disabled={action !== null}
                  onClick={onSync}
                >
                  {action === "sync" ? "Syncing…" : "Sync now"}
                </Button>
              </div>
            </div>
            {settingsConflict && (
              <CloudSettingsConflictCard
                action={action}
                onResolve={onResolveSettingsConflict}
              />
            )}
            {summary && <CloudSyncSummary summary={summary} />}
          </div>
        ) : (
          <CloudVaultDestinationOptions
            action={action}
            cloudVaults={cloudVaults}
            moving={false}
            newVaultName={newVaultName}
            selectedVaultId={selectedVaultId}
            onCreateAndLink={onCreateAndLink}
            onLink={onLink}
            onNewVaultNameChange={onNewVaultNameChange}
            onSelectedVaultChange={onSelectedVaultChange}
          />
        )}
      </div>
    </section>
  );
}

function CloudVaultDestinationOptions({
  action,
  cloudVaults,
  moving,
  newVaultName,
  selectedVaultId,
  onCreateAndLink,
  onLink,
  onNewVaultNameChange,
  onSelectedVaultChange,
}: {
  action: CloudAction;
  cloudVaults: CloudSyncVault[];
  moving: boolean;
  newVaultName: string;
  selectedVaultId: string;
  onCreateAndLink: () => void;
  onLink: () => void;
  onNewVaultNameChange: (value: string) => void;
  onSelectedVaultChange: (value: string) => void;
}): JSX.Element {
  const selectedVault =
    cloudVaults.find((vault) => vault.id === selectedVaultId) ??
    cloudVaults[0] ??
    null;

  return (
    <div className="divide-y divide-paper-300/45">
      {cloudVaults.length > 0 && (
        <div className="space-y-4 px-5 py-5">
          <div>
            <h4 className="text-sm font-semibold text-ink-900">
              {moving
                ? "Move to an existing cloud vault"
                : "Continue with your cloud vault"}
            </h4>
            <p className="mt-1 text-sm leading-6 text-ink-500">
              {moving
                ? "Choose where this device should sync next."
                : "Open the same notes you use on your other devices."}
            </p>
          </div>

          {cloudVaults.length > 1 && (
            <select
              id="cloud-vault-select"
              aria-label="Cloud vault"
              value={selectedVaultId}
              disabled={action !== null}
              onChange={(event) => onSelectedVaultChange(event.target.value)}
              className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent disabled:opacity-50"
            >
              {cloudVaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))}
            </select>
          )}

          <div className="flex flex-col gap-4 rounded-2xl border border-paper-300/60 bg-paper-100/45 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink-900">
                {selectedVault?.name}
              </div>
              {selectedVault && (
                <div className="mt-1 text-xs text-ink-500">
                  Updated {formatCloudVaultDate(selectedVault.updated_at)}
                </div>
              )}
            </div>
            <Button
              variant="primary"
              disabled={!selectedVaultId || action !== null}
              onClick={onLink}
            >
              {action === "link"
                ? moving
                  ? "Moving…"
                  : "Opening…"
                : moving
                  ? "Move here"
                  : "Open on this device"}
            </Button>
          </div>

          {!moving && (
            <p className="text-xs leading-5 text-ink-500">
              Notes already on this device are merged safely. If the same note
              changed in both places, ZenNotes keeps a conflict copy for review.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3 px-5 py-5">
        <label
          htmlFor="new-cloud-vault-name"
          className="text-sm font-medium text-ink-800"
        >
          {cloudVaults.length > 0
            ? "Start a separate cloud vault"
            : "Create a new cloud vault"}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="new-cloud-vault-name"
            value={newVaultName}
            maxLength={120}
            disabled={action !== null}
            onChange={(event) => onNewVaultNameChange(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent disabled:opacity-50"
            placeholder="My notes"
          />
          <Button
            disabled={!newVaultName.trim() || action !== null}
            onClick={onCreateAndLink}
          >
            {action === "link"
              ? "Creating…"
              : moving
                ? "Create and move"
                : "Create and link"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CloudBackupPanel({
  action,
  backupIncluded,
  backupLabel,
  backupItems,
  backups,
  expandedBackupId,
  limits,
  link,
  loading,
  restoreResult,
  schedule,
  onBackupLabelChange,
  onBrowse,
  onCreate,
  onDelete,
  onDownload,
  onRefresh,
  onRestore,
  onRestoreNote,
  onScheduleChange,
}: {
  action: CloudAction;
  backupIncluded: boolean;
  backupLabel: string;
  backupItems: CloudBackupSnapshotItem[];
  backups: CloudBackupSnapshot[];
  expandedBackupId: string | null;
  limits: Record<string, unknown> | null;
  link: CloudVaultLink | null;
  loading: boolean;
  restoreResult: CloudBackupRestoreResult | null;
  schedule: CloudBackupSchedule | null;
  onBackupLabelChange: (value: string) => void;
  onBrowse: (backup: CloudBackupSnapshot) => void;
  onCreate: () => void;
  onDelete: (backup: CloudBackupSnapshot) => void;
  onDownload: (backup: CloudBackupSnapshot) => void;
  onRefresh: () => void;
  onRestore: (backup: CloudBackupSnapshot) => void;
  onRestoreNote: (
    backup: CloudBackupSnapshot,
    item: CloudBackupSnapshotItem,
  ) => void;
  onScheduleChange: (enabled: boolean) => void;
}): JSX.Element {
  const [noteSearch, setNoteSearch] = useState("");
  const [recoveryDate, setRecoveryDate] = useState("");

  useEffect(() => {
    setNoteSearch("");
  }, [expandedBackupId]);

  const normalizedNoteSearch = noteSearch.trim().toLowerCase();
  const filteredBackupItems = normalizedNoteSearch
    ? backupItems.filter((item) =>
        item.path.toLowerCase().includes(normalizedNoteSearch),
      )
    : backupItems;
  const latestRecoveryDate = localDateKey(new Date().toISOString());
  const recoveryDateIsFuture = recoveryDate > latestRecoveryDate;
  const recoverySelection = recoveryDateIsFuture
    ? {
        backups: [],
        notice: "Choose today or an earlier date.",
      }
    : selectBackupsForDate(backups, recoveryDate);

  if (!backupIncluded) {
    return (
      <CloudNotice>Backups are not included in this subscription.</CloudNotice>
    );
  }
  if (!link) {
    return (
      <CloudNotice>Link this vault before creating cloud backups.</CloudNotice>
    );
  }

  const maxSnapshots = numericLimit(limits, "max_snapshots");
  const maxSnapshotBytes = numericLimit(limits, "max_snapshot_bytes");
  const retentionDays = numericLimit(limits, "retention_days");
  const backupPolicy = [
    maxSnapshots ? `Up to ${maxSnapshots} backups per vault` : null,
    retentionDays ? `kept for ${retentionDays} days` : null,
    maxSnapshotBytes
      ? `${formatBytes(maxSnapshotBytes)} maximum per backup`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      data-settings-search-id="cloud-backups"
      aria-labelledby="cloud-backups-heading"
      className="space-y-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3
            id="cloud-backups-heading"
            className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500"
          >
            Backups
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            {backupPolicy || "Create a recovery point from the synced vault."}
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={action !== null || loading}
          onClick={onRefresh}
        >
          {action === "backup-refresh" || loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {restoreResult && <CloudRestoreResult result={restoreResult} />}

      <div className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45">
        <div className="flex items-center justify-between gap-4 border-b border-paper-300/45 px-5 py-5">
          <div>
            <div className="text-sm font-medium text-ink-900">
              Automatic daily backups
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              Creates a backup each day when this vault changed.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={schedule?.enabled ?? false}
            aria-label="Automatic daily backups"
            disabled={action !== null || schedule === null}
            onClick={() => onScheduleChange(!(schedule?.enabled ?? false))}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
              schedule?.enabled
                ? "border-accent bg-accent"
                : "border-paper-400 bg-paper-200"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-paper-50 shadow-sm transition-transform ${
                schedule?.enabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="border-b border-paper-300/45 px-5 py-5">
          <div className="mb-3">
            <div className="text-sm font-medium text-ink-900">
              Create a backup now
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              Add a label so this recovery point is easy to find later.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Backup label"
              value={backupLabel}
              maxLength={120}
              disabled={action !== null}
              onChange={(event) => onBackupLabelChange(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent disabled:opacity-50"
              placeholder="Before a major edit"
            />
            <Button disabled={action !== null} onClick={onCreate}>
              {action === "backup-create" ? "Creating…" : "Create backup"}
            </Button>
          </div>
        </div>

        {backups.length > 0 && (
          <div className="border-b border-paper-300/45 px-5 py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <label
                  htmlFor="cloud-backup-recovery-date"
                  className="text-sm font-medium text-ink-900"
                >
                  Restore from date
                </label>
                <p className="mt-1 text-xs leading-5 text-ink-500">
                  Choose a recovery date, then restore the vault or browse its
                  notes.
                </p>
              </div>
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <input
                  id="cloud-backup-recovery-date"
                  type="date"
                  aria-label="Restore from date"
                  value={recoveryDate}
                  max={latestRecoveryDate}
                  aria-invalid={recoveryDateIsFuture}
                  onChange={(event) => setRecoveryDate(event.target.value)}
                  className={`min-w-0 flex-1 rounded-lg border bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none sm:w-44 ${
                    recoveryDateIsFuture
                      ? "border-danger/60 focus:border-danger"
                      : "border-paper-300 focus:border-accent"
                  }`}
                />
                {recoveryDate && (
                  <Button variant="ghost" onClick={() => setRecoveryDate("")}>
                    Show all
                  </Button>
                )}
              </div>
            </div>
            {recoverySelection.notice && (
              <p
                role="status"
                className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${
                  recoveryDateIsFuture
                    ? "border-danger/35 bg-danger/10 text-danger"
                    : "border-paper-300/50 bg-paper-100/55 text-ink-600"
                }`}
              >
                {recoverySelection.notice}
              </p>
            )}
          </div>
        )}

        {backups.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            {loading ? "Loading backups…" : "No backups yet."}
          </div>
        ) : recoverySelection.backups.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-ink-500">
            Choose another date or show all backups.
          </div>
        ) : (
          <div className="divide-y divide-paper-300/45">
            {recoverySelection.backups.map((backup) => {
              const expanded = expandedBackupId === backup.id;

              return (
                <div key={backup.id}>
                  <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-900">
                          {backup.label ||
                            `Backup from ${formatBackupDate(backup.created_at)}`}
                        </span>
                        <span className="rounded-full bg-paper-200 px-2 py-0.5 text-[11px] font-medium text-ink-500">
                          {backup.trigger === "automatic"
                            ? "Automatic"
                            : "Manual"}
                        </span>
                        <CloudBackupStatus status={backup.status} />
                      </div>
                      <div className="mt-1 text-xs leading-5 text-ink-500">
                        {backup.item_count} items ·{" "}
                        {formatBytes(backup.total_bytes)} source
                        {backup.archive_bytes !== null && (
                          <> · {formatBytes(backup.archive_bytes)} archive</>
                        )}
                      </div>
                      <div className="text-xs leading-5 text-ink-400">
                        Created {formatBackupDate(backup.created_at)}
                        {backup.expires_at && (
                          <> · Expires {formatBackupDate(backup.expires_at)}</>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onBrowse(backup)}
                      >
                        {action === "backup-browse" && expanded
                          ? "Loading…"
                          : expanded
                            ? "Hide notes"
                            : "Browse notes"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onDownload(backup)}
                      >
                        {action === "backup-download"
                          ? "Saving…"
                          : "Save archive"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null || backup.status !== "ready"}
                        onClick={() => onRestore(backup)}
                      >
                        {action === "backup-restore" ? "Restoring…" : "Restore"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={action !== null}
                        onClick={() => onDelete(backup)}
                      >
                        {action === "backup-delete" ? "Deleting…" : "Delete"}
                      </Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-paper-300/45 bg-paper-100/35 px-5 py-4">
                      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-500">
                          Notes in this backup
                        </div>
                        {backupItems.length > 0 && (
                          <input
                            type="search"
                            aria-label="Search notes in this backup"
                            value={noteSearch}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) =>
                              setNoteSearch(event.target.value)
                            }
                            className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent sm:w-72"
                            placeholder="Search by name or path"
                          />
                        )}
                      </div>
                      {backupItems.length === 0 ? (
                        <div className="text-sm text-ink-500">
                          This backup contains no notes.
                        </div>
                      ) : filteredBackupItems.length === 0 ? (
                        <div className="rounded-xl border border-paper-300/50 bg-paper-50/70 px-4 py-8 text-center text-sm text-ink-500">
                          No notes match &quot;{noteSearch.trim()}&quot;.
                        </div>
                      ) : (
                        <div className="divide-y divide-paper-300/45 overflow-hidden rounded-xl border border-paper-300/50 bg-paper-50/70">
                          {filteredBackupItems.map((item) => (
                            <div
                              key={item.id}
                              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-ink-800">
                                  {item.path}
                                </div>
                                <div className="mt-0.5 text-xs text-ink-500">
                                  {formatBytes(item.byte_length)} · Revision{" "}
                                  {item.revision}
                                </div>
                              </div>
                              <Button
                                variant="secondary"
                                disabled={action !== null}
                                onClick={() => onRestoreNote(backup, item)}
                              >
                                {action === "backup-note-restore"
                                  ? "Restoring…"
                                  : "Restore note"}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function CloudBackupStatus({
  status,
}: {
  status: CloudBackupSnapshot["status"];
}): JSX.Element {
  const label =
    status === "ready" ? "Ready" : status === "failed" ? "Failed" : "Preparing";
  return (
    <span
      className={
        status === "ready"
          ? "rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
          : status === "failed"
            ? "rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger"
            : "rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
      }
    >
      {label}
    </span>
  );
}

function CloudRestoreResult({
  result,
}: {
  result: CloudBackupRestoreResult;
}): JSX.Element {
  if (result.restore.status === "completed") {
    return (
      <div
        role="status"
        className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-ink-700"
      >
        Restored {result.restore.restored_items} items and removed{" "}
        {result.restore.deleted_items} newer items. This vault is synced to
        cursor {result.sync?.cursor ?? result.restore.end_cursor}.
      </div>
    );
  }

  const message =
    result.restore.status === "conflict"
      ? "The cloud vault changed before restore began, so nothing was replaced. Refresh and try again."
      : result.restore.error?.message || "The backup could not be restored.";
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
    >
      {message}
    </div>
  );
}

function formatBackupDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function localDateKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function selectBackupsForDate(
  backups: CloudBackupSnapshot[],
  recoveryDate: string,
): { backups: CloudBackupSnapshot[]; notice: string | null } {
  if (!recoveryDate) return { backups, notice: null };

  const readyBackups = backups.filter((backup) => backup.status === "ready");
  const exactBackups = readyBackups.filter(
    (backup) => localDateKey(backup.created_at) === recoveryDate,
  );
  if (exactBackups.length > 0) {
    return { backups: exactBackups, notice: null };
  }

  const [year, month, day] = recoveryDate.split("-").map(Number);
  const endOfSelectedDay = new Date(year, month - 1, day + 1).getTime() - 1;
  const closestEarlierBackup = readyBackups
    .filter(
      (backup) => new Date(backup.created_at).getTime() <= endOfSelectedDay,
    )
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    )[0];

  if (!closestEarlierBackup) {
    return {
      backups: [],
      notice: "No backup is available on or before this date.",
    };
  }

  return {
    backups: [closestEarlierBackup],
    notice: `No backup was created on this date. Showing the closest earlier recovery point from ${formatBackupDate(closestEarlierBackup.created_at)}.`,
  };
}

function formatCloudVaultDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  const elapsedMs = Date.now() - date.getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return date.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  if (unitIndex === 0) return `${Math.round(bytes)} B`;
  return `${(bytes / 1024 ** unitIndex).toFixed(1)} ${units[unitIndex]}`;
}

function pluralize(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function numericLimit(
  limits: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = limits?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Vault settings that differ between this device and the cloud. Notes get a
 * conflict copy to compare side by side, but settings are a single answer, and
 * a copy of them inside a hidden folder is not something anyone can act on.
 * This device's settings stay in use until the question is answered, so doing
 * nothing keeps what is already working.
 */
function CloudSettingsConflictCard({
  action,
  onResolve,
}: {
  action: CloudAction;
  onResolve: (choice: CloudSyncSettingsChoice) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Vault settings differ from the cloud"
      className="rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-ink-700"
    >
      <div className="font-medium">Vault settings differ from the cloud</div>
      <div className="mt-1 text-xs leading-5 text-ink-500">
        Another device saved different settings for this vault: favorites,
        folder icons and colors, and where the built-in folders live. This
        device&rsquo;s settings are the ones in use.
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={action !== null}
          onClick={() => onResolve("local")}
        >
          {action === "settings-local" ? "Keeping…" : "Keep this device's"}
        </Button>
        <Button
          variant="ghost"
          disabled={action !== null}
          onClick={() => onResolve("cloud")}
        >
          {action === "settings-cloud" ? "Applying…" : "Use the cloud's"}
        </Button>
      </div>
    </div>
  );
}

function CloudSyncSummary({
  summary,
}: {
  summary: CloudSyncRunSummary;
}): JSX.Element {
  // A host on an older build sends no local_conflicts at all.
  const conflictCount =
    summary.conflicts.length +
    summary.bootstrap_conflicts.length +
    (summary.local_conflicts?.length ?? 0);
  return (
    <div
      role="status"
      className={
        conflictCount > 0
          ? "rounded-xl border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-ink-700"
          : "rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-ink-700"
      }
    >
      <div className="font-medium">
        {summary.pulled === 0 && summary.pushed === 0
          ? "Everything is up to date"
          : `Downloaded ${summary.pulled} · Uploaded ${summary.pushed}`}
      </div>
      <div className="mt-1 text-xs text-ink-500">
        {conflictCount === 0
          ? "All changes are synced."
          : `${conflictCount} conflict${conflictCount === 1 ? " needs" : "s need"} review.`}
      </div>
    </div>
  );
}

function CloudNotice({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-2xl border border-paper-300/60 bg-paper-50/45 px-5 py-4 text-sm leading-6 text-ink-500">
      {children}
    </div>
  );
}

function CloudLoadingState({
  compact = false,
}: {
  compact?: boolean;
}): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading ZenNotes Cloud"
      className={compact ? "space-y-2" : "space-y-3 py-2"}
    >
      <div className="h-4 w-40 animate-pulse rounded bg-paper-300/70" />
      <div className="h-14 animate-pulse rounded-2xl bg-paper-200/70" />
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;

  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();

  return message || fallback;
}
