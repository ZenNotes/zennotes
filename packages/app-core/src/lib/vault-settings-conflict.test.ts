import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_SETTINGS, type VaultSettings } from "@shared/ipc";
import {
  describeVaultSettingsConflict,
  formatVaultSettingsValue,
  vaultSettingsFieldLabel,
} from "./vault-settings-conflict";
import { normalizeVaultSettings } from "./vault-layout";

function localSettings(overrides: Partial<VaultSettings> = {}): VaultSettings {
  return normalizeVaultSettings({
    ...DEFAULT_VAULT_SETTINGS,
    primaryNotesLocation: "root",
    favorites: ["Ideas.md", "inbox:Projects"],
    folderIcons: { "inbox:Projects": "bolt" },
    ...overrides,
  });
}

describe("describeVaultSettingsConflict", () => {
  it("reports only the sections whose values differ, with the leaf that differs", () => {
    const local = localSettings();
    const cloudRaw = {
      ...JSON.parse(JSON.stringify(local)),
      favorites: ["inbox:Projects", "Ideas.md"],
      folderIcons: { "inbox:Projects": "bolt", "inbox:Archive": "archive" },
    };
    const described = describeVaultSettingsConflict(local, cloudRaw);
    expect(described.differences.map((difference) => difference.section)).toEqual([
      "folderIcons",
      "favorites",
    ]);
    expect(described.differences[0].fields).toEqual([
      { path: ["folderIcons", "inbox:Archive"], local: undefined, cloud: "archive" },
    ]);
    expect(described.unknownKeys).toEqual([]);
  });

  it("finds nothing to ask about when the cloud's file is this device's file", () => {
    const local = localSettings({
      dailyNotes: { ...DEFAULT_VAULT_SETTINGS.dailyNotes, enabled: true, directory: "Journal" },
    });
    const described = describeVaultSettingsConflict(local, JSON.parse(JSON.stringify(local)));
    expect(described.differences).toEqual([]);
  });

  it("does not report a primary location the cloud's file never states", () => {
    const local = localSettings();
    const cloudRaw = JSON.parse(JSON.stringify(local)) as Record<string, unknown>;
    delete cloudRaw.primaryNotesLocation;
    const described = describeVaultSettingsConflict(local, cloudRaw);
    expect(described.cloud.primaryNotesLocation).toBe("root");
    expect(described.differences).toEqual([]);
  });

  it("names the keys another client wrote that this one has no setting for", () => {
    const local = localSettings();
    const cloudRaw = {
      ...JSON.parse(JSON.stringify(local)),
      widgets: { weather: true },
      accentColor: "teal",
    };
    const described = describeVaultSettingsConflict(local, cloudRaw);
    expect(described.unknownKeys).toEqual(["accentColor", "widgets"]);
    expect(described.differences).toEqual([]);
  });

  it("compares the cloud's raw values after normalizing them, not before", () => {
    const local = localSettings();
    const cloudRaw = {
      ...JSON.parse(JSON.stringify(local)),
      // An icon id this client does not know is dropped by the normalizer,
      // exactly as it would be when the file is read from disk.
      folderIcons: { "inbox:Projects": "bolt", "inbox:Later": "not-an-icon" },
    };
    expect(describeVaultSettingsConflict(local, cloudRaw).differences).toEqual([]);
  });
});

describe("vaultSettingsFieldLabel", () => {
  it("uses the Settings window's words for known fields", () => {
    expect(vaultSettingsFieldLabel("dailyNotes", ["dailyNotes", "tasksDueOnNoteDate"])).toBe(
      "Tasks are due on the note's date",
    );
    expect(vaultSettingsFieldLabel("primaryNotesLocation", ["primaryNotesLocation"])).toBe(
      "Primary notes location",
    );
  });

  it("reads folder keys as folder paths", () => {
    expect(vaultSettingsFieldLabel("folderIcons", ["folderIcons", "inbox:Projects/Ideas"])).toBe(
      "Inbox/Projects/Ideas",
    );
    expect(vaultSettingsFieldLabel("folderColors", ["folderColors", "quick:"])).toBe("Quick Notes");
    expect(vaultSettingsFieldLabel("systemFolderPaths", ["systemFolderPaths", "archive"])).toBe(
      "Archive folder",
    );
    expect(vaultSettingsFieldLabel("view", ["view", "systemFolderLabels", "trash"])).toBe(
      "Label: Trash",
    );
  });

  it("spells out a key it has no words for instead of hiding it", () => {
    expect(vaultSettingsFieldLabel("view", ["view", "showBreadcrumbs"])).toBe("Show breadcrumbs");
    expect(vaultSettingsFieldLabel("view", ["view", "kanbanColumnOrder", "status"])).toBe(
      "Column order: status",
    );
  });
});

describe("formatVaultSettingsValue", () => {
  it("translates enumerations and booleans", () => {
    expect(formatVaultSettingsValue("primaryNotesLocation", ["primaryNotesLocation"], "root")).toBe(
      "Vault root",
    );
    expect(
      formatVaultSettingsValue("drawingsLocation", ["drawingsLocation", "mode"], "active-note"),
    ).toBe("Active note's folder");
    expect(formatVaultSettingsValue("dailyNotes", ["dailyNotes", "enabled"], true)).toBe("On");
    expect(formatVaultSettingsValue("dailyNotes", ["dailyNotes", "locale"], "system")).toBe("System");
  });

  it("says when a side has no value at all", () => {
    expect(formatVaultSettingsValue("dailyNotes", ["dailyNotes", "templateId"], undefined)).toBe(
      "Not set",
    );
    expect(formatVaultSettingsValue("view", ["view", "kanbanFolderRoot"], "")).toBe("Not set");
    expect(formatVaultSettingsValue("favorites", ["favorites"], [])).toBe("None");
  });

  it("previews lists and counts ignored suggestions instead of printing hashes", () => {
    expect(
      formatVaultSettingsValue("favorites", ["favorites"], [
        "A.md",
        "inbox:Projects",
        "C.md",
        "D.md",
        "E.md",
        "F.md",
      ]),
    ).toBe("A.md, Inbox/Projects, C.md, D.md and 2 more");
    expect(
      formatVaultSettingsValue("harper", ["harper", "ignoredLints"], ["1", "2", "3"]),
    ).toBe("3 suggestions");
    expect(formatVaultSettingsValue("harper", ["harper", "words"], ["zennotes"])).toBe("zennotes");
  });
});
