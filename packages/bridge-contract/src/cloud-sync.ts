export type CloudSyncItemKind = "text" | "binary";
export type CloudSyncContentEncoding = "utf8" | "base64" | "aes-gcm";

export interface CloudSyncContent {
  encoding: CloudSyncContentEncoding;
  data: string;
  sha256: string;
  byte_length: number;
  media_type: string;
}

interface CloudSyncMutationBase {
  operation_id: string;
  item_id: string;
  base_revision: number | null;
}

export interface CloudSyncUpsertMutation extends CloudSyncMutationBase {
  type: "upsert";
  path: string;
  kind: CloudSyncItemKind;
  content: CloudSyncContent;
}

export interface CloudSyncMoveMutation extends CloudSyncMutationBase {
  type: "move";
  path: string;
}

export interface CloudSyncDeleteMutation extends CloudSyncMutationBase {
  type: "delete";
}

export type CloudSyncMutation =
  | CloudSyncUpsertMutation
  | CloudSyncMoveMutation
  | CloudSyncDeleteMutation;

export interface CloudSyncMutationRequest {
  mutations: CloudSyncMutation[];
}

export interface CloudSyncMutationAcknowledgement {
  operation_id: string;
  item_id: string;
  revision: number;
  sequence: number;
}

export type CloudSyncConflictCode =
  | "REVISION_CONFLICT"
  | "PATH_CONFLICT"
  | "ITEM_DELETED"
  | "QUOTA_EXCEEDED";

export interface CloudSyncConflict {
  operation_id: string;
  item_id: string;
  code: CloudSyncConflictCode;
  current_revision: number | null;
  current_path: string | null;
}

export interface CloudSyncMutationResponse {
  acknowledged: CloudSyncMutationAcknowledgement[];
  conflicts: CloudSyncConflict[];
  cursor: number;
}

export interface CloudSyncManifestItem {
  item_id: string;
  path: string;
  kind: CloudSyncItemKind;
  revision: number;
  sha256: string;
  byte_length: number;
  media_type: string;
  content?: CloudSyncContent;
}

export interface CloudSyncManifestResponse {
  data: CloudSyncManifestItem[];
  cursor: number;
  next_page: number | null;
}

export interface CloudSyncChange {
  sequence: number;
  item_id: string;
  type: "upsert" | "move" | "delete";
  path: string;
  previous_path: string | null;
  revision: number;
  content?: CloudSyncContent;
}

export interface CloudSyncChangeResponse {
  data: CloudSyncChange[];
  cursor: number;
  has_more: boolean;
}

export interface CloudSyncVault {
  id: string;
  name: string;
  cursor: number;
  created_at: string;
  updated_at: string;
}

export interface CloudSyncVaultResponse {
  data: CloudSyncVault;
}

export interface CloudSyncVaultCollection {
  data: CloudSyncVault[];
}

export type CloudBackupStatus = "pending" | "building" | "ready" | "failed";
export type CloudBackupTrigger = "manual" | "automatic";

export interface CloudBackupSnapshot {
  id: string;
  label: string | null;
  trigger?: CloudBackupTrigger;
  status: CloudBackupStatus;
  cursor: number;
  item_count: number;
  total_bytes: number;
  archive_bytes: number | null;
  expires_at: string | null;
  created_at: string;
}

export interface CloudBackupSnapshotResponse {
  data: CloudBackupSnapshot;
}

export interface CloudBackupSnapshotCollection {
  data: CloudBackupSnapshot[];
}

export interface CloudBackupSchedule {
  enabled: boolean;
  frequency: "daily";
  next_backup_at: string | null;
  last_backup_at: string | null;
}

export interface CloudBackupScheduleResponse {
  data: CloudBackupSchedule;
}

export interface CloudBackupSnapshotItem {
  id: number;
  item_id: string;
  path: string;
  kind: string;
  byte_length: number;
  revision: number;
  content_hash: string | null;
  media_type: string | null;
}

export interface CloudBackupSnapshotItemCollection {
  data: CloudBackupSnapshotItem[];
}

export interface CloudBackupNoteRestoreRequest {
  idempotency_key: string;
  expected_cursor: number;
}

export interface CloudBackupNoteRestore {
  id: string;
  status: "completed" | "conflict";
  item_id: string;
  path: string;
  revision: number | null;
  cursor: number;
  error_code: string | null;
  created_at: string;
}

export interface CloudBackupNoteRestoreResponse {
  data: CloudBackupNoteRestore;
}

export interface CloudBackupNoteRestoreResult {
  restore: CloudBackupNoteRestore;
  sync: CloudSyncRunSummary;
}

export type CloudBackupRestoreStatus =
  | "pending"
  | "restoring"
  | "completed"
  | "conflict"
  | "failed";

export interface CloudBackupRestoreRequest {
  idempotency_key: string;
  expected_cursor: number;
  mode?: "replace";
}

export interface CloudBackupRestoreError {
  code: string;
  message: string | null;
}

export interface CloudBackupRestore {
  id: string;
  backup_id: string;
  mode: "replace";
  status: CloudBackupRestoreStatus;
  expected_cursor: number;
  start_cursor: number | null;
  end_cursor: number | null;
  restored_items: number;
  deleted_items: number;
  error: CloudBackupRestoreError | null;
  created_at: string;
  updated_at: string;
}

export interface CloudBackupRestoreResponse {
  data: CloudBackupRestore;
}

export interface CloudBackupRestoreResult {
  restore: CloudBackupRestore;
  sync: CloudSyncRunSummary | null;
}

export interface CloudAccountUser {
  name: string;
  email: string;
}

export interface CloudAccountDevice {
  id: string;
  name: string;
  platform: "desktop" | "ios" | "android";
  app_version?: string | null;
}

export interface CloudAccount {
  base_url: string;
  user: CloudAccountUser;
  device: CloudAccountDevice;
  connected_at: string;
}

export interface CloudAccountStatus {
  state: "disconnected" | "connecting" | "connected";
  account: CloudAccount | null;
}

export interface CloudAccountConnectResult {
  authorization_url: string;
  expires_at: string;
}

export type CloudFeature = "sync" | "backup" | "publish";

export interface CloudUsage {
  storage: {
    total_bytes: number;
    sync_bytes: number;
    backup_bytes: number;
    publish_bytes: number;
  };
  sync: {
    vaults: number;
    items: number;
  };
  backup: {
    snapshots: number;
    ready_snapshots: number;
    latest_at: string | null;
  };
  publish: {
    notes: number;
    assets: number;
    latest_at: string | null;
  };
}

export interface CloudServiceAccount {
  user: CloudAccountUser;
  device: CloudAccountDevice & { app_version: string | null };
  features: Record<
    CloudFeature,
    { active: boolean; limits: Record<string, unknown> | null }
  >;
  usage?: CloudUsage;
}

export interface CloudServiceAccountResponse {
  data: CloudServiceAccount;
}

export interface CloudPublishedNote {
  id: number;
  slug: string;
  url: string;
  title: string;
  note_path: string | null;
  appearance?: CloudPublishedNoteAppearance;
  created_at: string | null;
  updated_at: string | null;
}

export interface CloudPublishedNoteResult {
  id: number;
  slug: string;
  url: string;
}

export interface CloudPublishNoteInput {
  note_path: string;
  title: string;
  markdown: string;
  assets?: CloudPublishAssetInput[];
  appearance?: CloudPublishAppearanceInput;
}

export interface CloudPublishedNoteAppearance {
  theme: string;
  logo_url: string | null;
}

export interface CloudPublishAppearanceInput {
  theme: string;
  /** Omitted preserves the current logo, null removes it, and a file replaces it. */
  logo?: CloudPublishAssetInput | null;
}

export interface CloudPublishAssetInput {
  ref: string;
  name: string;
  mime: string;
  base64: string;
}

export interface CloudPublishedNoteCollection {
  data: CloudPublishedNote[];
}

export interface CloudVaultLink {
  base_url: string;
  vault_id: string;
  vault_name: string;
  linked_at: string;
}

export interface CloudSyncBootstrapConflict {
  code: "BOOTSTRAP_CONTENT_CONFLICT";
  item_id: string;
  path: string;
  local_sha256: string;
  remote_sha256: string;
}

/**
 * A remote change that could not be applied because the local file was not
 * what sync last agreed on. The local file is always kept; `conflict_copy_path`
 * is where the incoming version was parked, or null when the change was a
 * delete or a move and there was no incoming content to keep.
 */
export interface CloudSyncLocalConflict {
  code: "LOCAL_EDIT_CONFLICT" | "SETTINGS_CONFLICT";
  path: string;
  conflict_copy_path: string | null;
}

/**
 * Vault settings that differ between this device and the cloud. The local
 * settings stay in use; this is the pending question, and it survives
 * restarts because the cloud's copy is parked in the vault until answered.
 */
export interface CloudSyncSettingsConflict {
  path: string;
  cloud_path: string;
}

export type CloudSyncSettingsChoice = "local" | "cloud";

export interface CloudSyncRunSummary {
  cursor: number;
  pulled: number;
  pushed: number;
  conflicts: CloudSyncConflict[];
  bootstrap_conflicts: CloudSyncBootstrapConflict[];
  local_conflicts: CloudSyncLocalConflict[];
}
