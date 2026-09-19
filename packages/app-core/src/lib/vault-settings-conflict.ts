import type { NoteFolder, VaultSettings } from "@shared/ipc";
import {
  diffVaultSettings,
  unknownVaultSettingsKeys,
  type VaultSettingsSection,
  type VaultSettingsSectionDifference,
} from "@zennotes/shared-domain/vault-settings-conflict";
import { DEFAULT_SYSTEM_FOLDER_LABELS } from "./system-folder-labels";
import { normalizeVaultSettings } from "./vault-layout";

/**
 * Words for the vault settings comparison the Cloud settings prompt shows.
 * The comparison itself is shared-domain's; this file only says what each
 * section, field and value is called on screen, in the vocabulary the
 * Settings window already uses for the same controls.
 */

export const VAULT_SETTINGS_SECTION_LABELS: Record<VaultSettingsSection, string> = {
  primaryNotesLocation: "Primary notes location",
  dailyNotes: "Daily notes",
  weeklyNotes: "Weekly notes",
  monthlyNotes: "Monthly notes",
  drawingsLocation: "New drawings location",
  databasesLocation: "New databases location",
  tasksLocation: "New tasks location",
  view: "View settings",
  folderIcons: "Folder icons",
  folderColors: "Folder colors",
  favorites: "Favorites",
  systemFolderPaths: "Built-in folder locations",
  tasks: "Tasks",
  typstPreambles: "Typst preambles",
  harper: "Harper dictionary",
};

export interface VaultSettingsConflictDescription {
  /** The cloud's copy read the way this device would read its own file. */
  cloud: VaultSettings;
  differences: VaultSettingsSectionDifference[];
  /** Top-level keys of the cloud's file this client has no setting for. */
  unknownKeys: string[];
}

/**
 * Compare this device's settings with the parked cloud copy. The copy is
 * normalized first, so only real differences are reported, not the defaults a
 * normalizer fills in. A copy silent on the primary notes location takes this
 * device's answer, which is what the desktop host does with such a file too
 * (it infers the location from the vault's layout, and this vault's layout is
 * what the local answer already describes).
 */
export function describeVaultSettingsConflict(
  local: VaultSettings,
  cloudRaw: Record<string, unknown>,
): VaultSettingsConflictDescription {
  const cloud = normalizeVaultSettings({
    ...(cloudRaw as Partial<VaultSettings>),
    primaryNotesLocation:
      (cloudRaw.primaryNotesLocation as VaultSettings["primaryNotesLocation"] | undefined) ??
      local.primaryNotesLocation,
  } as VaultSettings);
  return {
    cloud,
    differences: diffVaultSettings(local, cloud),
    unknownKeys: unknownVaultSettingsKeys(cloudRaw),
  };
}

const FIELD_LABELS: Record<string, string> = {
  enabled: "Enabled",
  directory: "Directory",
  titlePattern: "Title pattern",
  locale: "Locale",
  templateId: "Template",
  tasksDueOnNoteDate: "Tasks are due on the note's date",
  rolloverUnfinishedTasks: "Roll unfinished tasks over",
  mode: "Where",
  folder: "Folder",
  noteSortOrder: "Note sort order",
  assetSortOrder: "Asset sort order",
  groupByKind: "Group by kind",
  tasksViewMode: "Tasks view",
  kanbanGroupBy: "Board grouping",
  kanbanFolderRoot: "Board folder root",
  kanbanColumnTitles: "Column title",
  kanbanColumnOrder: "Column order",
  kanbanCardOrder: "Card order",
  kanbanStatuses: "Board statuses",
  autoReveal: "Reveal the active note",
  systemFolderLabels: "Label",
  unifiedSidebar: "Unified sidebar",
  excludedFolders: "Folders left out of Tasks",
  words: "Words",
  ignoredLints: "Ignored suggestions",
};

/**
 * What to call a differing leaf, given its path from the section root. The
 * section itself is not repeated: the caller shows it as the heading. Keys the
 * user typed (a folder path, a board name) are shown as they are.
 */
export function vaultSettingsFieldLabel(
  section: VaultSettingsSection,
  path: string[],
): string {
  const rest = path.slice(1);
  if (rest.length === 0) return VAULT_SETTINGS_SECTION_LABELS[section];
  if (section === "folderIcons" || section === "folderColors") {
    return formatFolderKey(rest.join("."));
  }
  if (section === "systemFolderPaths") {
    return `${folderLabel(rest[0])} folder`;
  }
  const [head, ...tail] = rest;
  const label = FIELD_LABELS[head] ?? humanize(head);
  if (tail.length === 0) return label;
  const detail =
    head === "systemFolderLabels" ? folderLabel(tail.join(".")) : tail.join(".");
  return `${label}: ${detail}`;
}

/**
 * A setting's value in words. Enumerations use the Settings window's labels;
 * lists name their first items; a missing value is "Not set" rather than a
 * blank cell, so the side without it still reads as an answer.
 */
export function formatVaultSettingsValue(
  section: VaultSettingsSection,
  path: string[],
  value: unknown,
): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return String(value);
  const leaf = path[path.length - 1];
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    if (section === "harper" && leaf === "ignoredLints") {
      return value.length === 1 ? "1 suggestion" : `${value.length} suggestions`;
    }
    const items = value.map((item) =>
      section === "favorites" ? formatFavorite(item) : String(item),
    );
    return listPreview(items);
  }
  if (typeof value !== "string") return JSON.stringify(value);
  if (section === "primaryNotesLocation") {
    return value === "root" ? "Vault root" : value === "inbox" ? "Inbox" : value;
  }
  if (leaf === "mode") return FILE_LOCATION_LABELS[value] ?? value;
  if (leaf === "locale" && value === "system") return "System";
  return value;
}

const FILE_LOCATION_LABELS: Record<string, string> = {
  primary: "Primary location",
  "active-note": "Active note's folder",
  folder: "Specific folder",
};

const LIST_PREVIEW_LENGTH = 4;

function listPreview(items: string[]): string {
  if (items.length <= LIST_PREVIEW_LENGTH) return items.join(", ");
  const rest = items.length - LIST_PREVIEW_LENGTH;
  return `${items.slice(0, LIST_PREVIEW_LENGTH).join(", ")} and ${rest} more`;
}

/** A favorite is a note path or a `folder:subpath` key (see VaultSettings). */
function formatFavorite(entry: unknown): string {
  if (typeof entry !== "string") return String(entry);
  return entry.includes(":") ? formatFolderKey(entry) : entry;
}

/** `inbox:Projects/Ideas` reads as `Inbox/Projects/Ideas`; a bare `inbox:` is the folder itself. */
function formatFolderKey(key: string): string {
  const separator = key.indexOf(":");
  if (separator === -1) return key;
  const folder = folderLabel(key.slice(0, separator));
  const subpath = key.slice(separator + 1);
  return subpath ? `${folder}/${subpath}` : folder;
}

function folderLabel(folder: string): string {
  return DEFAULT_SYSTEM_FOLDER_LABELS[folder as NoteFolder] ?? folder;
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
