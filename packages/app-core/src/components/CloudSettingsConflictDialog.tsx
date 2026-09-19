import { useMemo, useRef, useState } from "react";
import type {
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
} from "@zennotes/bridge-contract/cloud-sync";
import type { VaultSettings } from "@shared/ipc";
import {
  mergeVaultSettings,
  type VaultSettingsSection,
  type VaultSettingsSectionDifference,
  type VaultSettingsSide,
} from "@zennotes/shared-domain/vault-settings-conflict";
import { humanIpcError } from "../lib/ipc-error";
import {
  describeVaultSettingsConflict,
  formatVaultSettingsValue,
  VAULT_SETTINGS_SECTION_LABELS,
  vaultSettingsFieldLabel,
} from "../lib/vault-settings-conflict";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

const TITLE_ID = "cloud-settings-conflict-dialog-title";

/** Rows shown per section before the rest is summed up, so a vault with a
 *  hundred folder icons still fits the screen. */
const FIELD_ROW_LIMIT = 6;

type Choices = Partial<Record<VaultSettingsSection, VaultSettingsSide>>;

/**
 * The vault settings question, asked with the differences on the table. Sync
 * parked the cloud's vault.json because both devices changed theirs; nothing
 * is applied until the user answers, and "Decide later" (or Escape) keeps it
 * that way: this device's settings stay in use and the question comes back
 * from the status bar, Settings, `Space r` or the palette.
 *
 * Each section that differs is answered on its own, because "my favorites and
 * their folder icons" is the usual want. All local is the plain "keep this
 * device's" answer; anything else is applied through the store, so the merged
 * settings pass the same validation and pattern bookkeeping as a settings edit.
 */
export function CloudSettingsConflictDialog({
  conflict,
  localSettings,
  vaultName,
  onClose,
  onResolve,
  onApply,
}: {
  conflict: CloudSyncSettingsConflict;
  localSettings: VaultSettings;
  vaultName: string;
  onClose: () => void;
  /** The whole-file answer the host already knows how to give. */
  onResolve: (choice: CloudSyncSettingsChoice) => Promise<void>;
  /** Save these as this device's settings, then retire the cloud's copy. */
  onApply: (settings: VaultSettings) => Promise<void>;
}): JSX.Element {
  const described = useMemo(
    () =>
      conflict.cloud_settings
        ? describeVaultSettingsConflict(localSettings, conflict.cloud_settings)
        : null,
    [conflict.cloud_settings, localSettings],
  );
  const differences = described?.differences ?? [];
  const [choices, setChoices] = useState<Choices>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  const sideOf = (section: VaultSettingsSection): VaultSettingsSide =>
    choices[section] ?? "local";
  const cloudCount = differences.filter((d) => sideOf(d.section) === "cloud").length;
  const allLocal = cloudCount === 0;
  const allCloud = differences.length > 0 && cloudCount === differences.length;

  const chooseAll = (side: VaultSettingsSide): void => {
    setChoices(Object.fromEntries(differences.map((d) => [d.section, side])) as Choices);
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(humanIpcError(cause, "The settings could not be applied. Nothing was changed."));
      setBusy(false);
    }
  };

  const decide = (): void => {
    if (described === null) {
      // The copy could not be read here; the answer stays whole-file.
      void run(() => onResolve("local"));
      return;
    }
    if (allLocal) {
      void run(() => onResolve("local"));
      return;
    }
    void run(() => onApply(mergeVaultSettings(localSettings, described.cloud, choices)));
  };

  const primaryLabel =
    described === null || allLocal
      ? "Keep this device's settings"
      : allCloud
        ? "Use the cloud's settings"
        : "Apply choices";

  return (
    <Modal
      size="lg"
      align="center"
      onClose={onClose}
      labelledBy={TITLE_ID}
      initialFocus={primary}
      className="max-h-[88vh]"
      // The existing guards (vim leader, editor focus, overlay detection) key
      // on the first marker; the second names this dialog for its own tests.
      data={{
        "data-cloud-conflict-dialog": "",
        "data-cloud-settings-conflict-dialog": "",
      }}
    >
      <Modal.Header
        title="Vault settings differ from the cloud"
        titleId={TITLE_ID}
        description={describeQuestion(vaultName, described, differences)}
      />
      <Modal.Body className="max-h-[60vh] overflow-y-auto">
        {differences.length > 0 && described !== null && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-ink-500">
                Pick a side for each setting, or for all of them at once.
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  disabled={busy || allLocal}
                  onClick={() => chooseAll("local")}
                >
                  This device for all
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || allCloud}
                  onClick={() => chooseAll("cloud")}
                >
                  Cloud for all
                </Button>
              </div>
            </div>
            <div className="space-y-3">
              {differences.map((difference) => (
                <SectionRow
                  key={difference.section}
                  difference={difference}
                  choice={sideOf(difference.section)}
                  disabled={busy}
                  onChoose={(side) =>
                    setChoices((current) => ({ ...current, [difference.section]: side }))
                  }
                />
              ))}
            </div>
          </>
        )}
        {described !== null && described.unknownKeys.length > 0 && (
          <div
            role="note"
            className={`rounded-xl border border-paper-300/60 bg-paper-50/45 p-3 text-xs leading-5 text-ink-500 ${differences.length > 0 ? "mt-3" : ""}`}
          >
            <div className="font-medium text-ink-700">Not used on this device</div>
            <div className="mt-1 font-mono text-ink-600">{described.unknownKeys.join(", ")}</div>
            <div className="mt-1">
              The cloud&rsquo;s file also carries these settings from another app or a
              newer version. This device has no such settings, so it cannot compare or
              choose them.
            </div>
          </div>
        )}
        {error && (
          <div role="alert" className="mt-3 text-sm text-danger">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer className="items-center">
        <div className="mr-auto text-xs text-ink-500">
          This device&rsquo;s settings stay in use until you decide.
        </div>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Decide later
        </Button>
        {described === null && (
          // Without a readable copy there is nothing to pick from, so the
          // whole-file alternative gets its own button.
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => onResolve("cloud"))}
          >
            Use the cloud's settings
          </Button>
        )}
        <Button ref={primary} variant="primary" disabled={busy} onClick={decide}>
          {busy ? "Applying…" : primaryLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function describeQuestion(
  vaultName: string,
  described: ReturnType<typeof describeVaultSettingsConflict> | null,
  differences: VaultSettingsSectionDifference[],
): string {
  if (described === null) {
    return `Another device saved different settings for ${vaultName}, and the cloud's copy could not be read on this device, so the two cannot be compared here. Keep this device's settings or take the cloud's as a whole.`;
  }
  if (differences.length === 0) {
    return `Another device saved settings for ${vaultName} that this device reads the same way as its own. Keep this device's settings to finish syncing.`;
  }
  const count = differences.length;
  return `Another device saved different settings for ${vaultName}. ${count === 1 ? "One setting differs" : `${count} settings differ`}; both versions are shown so you can keep this device's or take the cloud's for each.`;
}

function SectionRow({
  difference,
  choice,
  disabled,
  onChoose,
}: {
  difference: VaultSettingsSectionDifference;
  choice: VaultSettingsSide;
  disabled: boolean;
  onChoose: (side: VaultSettingsSide) => void;
}): JSX.Element {
  const label = VAULT_SETTINGS_SECTION_LABELS[difference.section];
  const shown = difference.fields.slice(0, FIELD_ROW_LIMIT);
  const hidden = difference.fields.length - shown.length;
  return (
    <section
      aria-label={label}
      className="rounded-xl border border-paper-300/60 bg-paper-50/45 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-ink-700">{label}</div>
        <div role="group" aria-label={`${label}: which to use`} className="flex gap-1.5">
          <ChoiceButton
            active={choice === "local"}
            disabled={disabled}
            onClick={() => onChoose("local")}
          >
            This device
          </ChoiceButton>
          <ChoiceButton
            active={choice === "cloud"}
            disabled={disabled}
            onClick={() => onChoose("cloud")}
          >
            Cloud
          </ChoiceButton>
        </div>
      </div>
      <table className="mt-2 w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
            <th scope="col" className="w-1/3 pb-1 text-left font-semibold">
              Setting
            </th>
            <th
              scope="col"
              className={`pb-1 text-left font-semibold ${choice === "local" ? "text-ink-700" : ""}`}
            >
              This device
            </th>
            <th
              scope="col"
              className={`pb-1 text-left font-semibold ${choice === "cloud" ? "text-ink-700" : ""}`}
            >
              Cloud
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((field) => (
            <tr key={field.path.join(".")} className="align-top">
              <td className="break-words py-1 pr-2 text-ink-600">
                {vaultSettingsFieldLabel(difference.section, field.path)}
              </td>
              <td
                className={`break-words py-1 pr-2 ${choice === "local" ? "text-ink-900" : "text-ink-500 line-through decoration-paper-300"}`}
              >
                {formatVaultSettingsValue(difference.section, field.path, field.local)}
              </td>
              <td
                className={`break-words py-1 ${choice === "cloud" ? "text-ink-900" : "text-ink-500 line-through decoration-paper-300"}`}
              >
                {formatVaultSettingsValue(difference.section, field.path, field.cloud)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <div className="mt-1 text-2xs text-ink-400">
          and {hidden} more {hidden === 1 ? "difference" : "differences"} in this section
        </div>
      )}
    </section>
  );
}

function ChoiceButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50",
        active
          ? "border-accent/50 bg-accent/10 text-ink-900"
          : "border-paper-300 bg-paper-100 text-ink-600 hover:bg-paper-200 hover:text-ink-900",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
