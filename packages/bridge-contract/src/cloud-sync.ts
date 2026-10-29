export type CloudSyncItemKind = "text" | "binary";
export type CloudSyncContentEncoding = "utf8" | "base64" | "aes-gcm";

export interface CloudSyncContent {
  encoding: CloudSyncContentEncoding;
  data: string;
  sha256: string;
  byte_length: number;
  media_type: string;
}

export type CloudSyncContentMetadata = Omit<CloudSyncContent, 'data'>

/**
 * The ciphertext an end-to-end encrypted vault stores for a piece of content.
 * docs/specs/cloud-e2ee.md describes the format.
 */
export interface CloudSyncEncryptedContent {
  sha256: string
  byte_length: number
}

export interface CloudSyncContentReference extends CloudSyncContentMetadata {
  item_id: string
  revision: number
  /**
   * Set by the vault cipher for encrypted vaults: the metadata above describes
   * the plaintext, this describes the bytes the download actually returns.
   */
  encrypted?: CloudSyncEncryptedContent
}

export interface CloudSyncContentRequestOptions {
  contentMode?: 'references'
  maxInlineBytes?: number
  maxResponseBytes?: number
}

export interface CloudSyncDownloadInstruction {
  item_id: string
  revision: number
  content: CloudSyncContentMetadata
  download: {
    url: string
    method: 'GET'
    headers: Record<string, string>
    expires_at: string
  }
}

export interface CloudSyncDownloadResponse {
  data: CloudSyncDownloadInstruction
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
  /** Encrypted vaults only: the sealed item metadata (base64 ZNE1). */
  meta?: string;
}

export interface CloudSyncMoveMutation extends CloudSyncMutationBase {
  type: "move";
  path: string;
  /** Encrypted vaults only: the sealed item metadata for the new path. */
  meta?: string;
  /**
   * Client-side hints the sync engine attaches so an encrypted vault can seal
   * the new path's metadata. Never sent to the service.
   */
  kind?: CloudSyncItemKind;
  content_metadata?: CloudSyncContentMetadata;
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
  | "QUOTA_EXCEEDED"
  | "CAPACITY_EXCEEDED"
  | "FILE_SIZE_LIMIT_EXCEEDED";

export interface CloudSyncCapacityConflict {
  dimension: string;
  used: number;
  reserved: number;
  limit: number;
  projected: number;
  can_retry_after_reduction: boolean;
}

export interface CloudSyncConflict {
  operation_id: string;
  item_id: string;
  code: CloudSyncConflictCode;
  current_revision: number | null;
  current_path: string | null;
  /** Encrypted vaults: the sealed metadata behind `current_path`. */
  current_meta?: string | null;
  capacity?: CloudSyncCapacityConflict;
  /**
   * The vault-relative path of the file the rejected operation was about, as
   * this device knows it. The server answers with item ids only; the client
   * that sent the mutation fills this in, so "1 change could not be applied"
   * can name the file (a delete carries the path the item had here).
   */
  path?: string | null;
}

export interface CloudSyncMutationResponse {
  acknowledged: CloudSyncMutationAcknowledgement[];
  conflicts: CloudSyncConflict[];
  cursor: number;
}

export interface CloudSyncUploadRequest {
  operation_id: string;
  item_id: string;
  base_revision: number | null;
  path: string;
  kind: CloudSyncItemKind;
  content: Pick<
    CloudSyncContent,
    "encoding" | "sha256" | "byte_length" | "media_type"
  >;
  /** Encrypted vaults only: the sealed item metadata. */
  meta?: string;
}

export interface CloudSyncUploadInitiationResponse {
  data: {
    id: string;
    operation_id: string;
    status: "initiated" | "uploading";
    expected_bytes: number;
    expires_at: string;
    upload: {
      method: "PUT";
      url: string;
      headers: Record<string, string>;
    };
  };
}

export interface CloudSyncUploadCompletionResponse {
  data: {
    id: string;
    operation_id: string;
    status: "completed";
    result: CloudSyncMutationResponse;
  };
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
  content_ref?: CloudSyncContentReference
  /** Encrypted vaults: the sealed item metadata. */
  meta?: string | null;
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
  content_ref?: CloudSyncContentReference
  /** Encrypted vaults: sealed metadata for `path` and `previous_path`. */
  meta?: string | null;
  previous_meta?: string | null;
}

export interface CloudSyncChangeResponse {
  data: CloudSyncChange[];
  cursor: number;
  has_more: boolean;
}

export interface CloudSyncRevision {
  item_id: string;
  revision: number;
  path: string;
  kind: CloudSyncItemKind;
  deleted: boolean;
  content?: CloudSyncContent | null;
  content_ref?: CloudSyncContentReference
  /** Encrypted vaults: the sealed item metadata. */
  meta?: string | null;
}

export interface CloudSyncRevisionResponse {
  data: CloudSyncRevision;
}

/** How an end-to-end encrypted vault's key and name are sealed (docs/specs/cloud-e2ee.md). */
export interface CloudSyncVaultEncryption {
  scheme: "zne1";
  /** 32 lowercase hex characters, bound into the vault key's envelope. */
  key_id: string;
  key_version: number;
  /** The vault key sealed under the account key, base64 ZNE1. */
  vault_key_envelope: string;
  /** The real vault name, base64 ZNE1; `name` holds a placeholder. */
  name: string;
}

export interface CloudSyncVault {
  id: string;
  name: string;
  cursor: number;
  created_at: string;
  updated_at: string;
  /** Absent or null for a readable vault. Fixed when the vault is created. */
  encryption?: CloudSyncVaultEncryption | null;
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

/**
 * Why the newest automatic backup did not happen. The service clears it once
 * an automatic backup succeeds, and when automatic backups are turned off.
 */
export interface CloudBackupScheduleFailure {
  /** BACKUP_QUOTA_EXCEEDED names the plan limit in `details` (`limit`,
   *  `current`, `allowed`); AUTOMATIC_BACKUP_FAILED is a backup that failed. */
  code: string;
  /** The service's own English sentence. */
  message: string | null;
  details: Record<string, unknown> | null;
  occurred_at: string | null;
}

export interface CloudBackupSchedule {
  enabled: boolean;
  frequency: "daily";
  next_backup_at: string | null;
  last_backup_at: string | null;
  /** Absent from a service that predates it. */
  last_failure?: CloudBackupScheduleFailure | null;
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
  /** Encrypted vaults: the sealed item metadata; `path` is a path id. */
  meta?: string | null;
}

export interface CloudBackupSnapshotItemCollection {
  data: CloudBackupSnapshotItem[];
  /** The paginator's position. An answer without it is read as one page. */
  meta?: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

/** Which notes of a backup to list: a page, optionally of a path search. */
export interface CloudBackupItemsQuery {
  page?: number;
  search?: string;
}

/**
 * One page of a backup's notes. `total` counts what `search` matched, and
 * `search` is the trimmed text that was asked for ("" for the whole backup).
 * A service that predates search ignores it and pages through every note.
 */
export interface CloudBackupItemsPage {
  items: CloudBackupSnapshotItem[];
  page: number;
  lastPage: number;
  total: number;
  search: string;
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
  /** Encrypted vaults: the sealed item metadata; `path` is a path id. */
  meta?: string | null;
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
    markdown_items?: number;
    binary_items?: number;
    other_items?: number;
    metadata_items?: number;
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
  capabilities?: { content_references?: boolean; end_to_end_encryption?: boolean }
  /** Absent from a service without end-to-end encryption. */
  encryption?: { keyset: boolean }
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
  logo?: CloudPublishEncodedAsset | null;
}

/**
 * An attachment to publish, by its vault-relative path: the platform reads the
 * file itself (desktop main, the phone shells), so its bytes never cross the
 * bridge as base64.
 */
export interface CloudPublishAssetInput {
  ref: string;
  name: string;
  mime: string;
  path: string;
}

/** An attachment carried inside a one-request (multipart) publish. */
export interface CloudPublishEncodedAsset {
  ref: string;
  name: string;
  mime: string;
  base64: string;
}

/** What the server is told about each attachment before it is uploaded. */
export interface CloudPublishUploadAsset {
  ref: string;
  name: string;
  mime: string;
  byte_length: number;
  sha256: string;
}

export interface CloudPublishUploadRequest {
  /** The share a republish replaces; omitted for a new publish. */
  share_id?: number;
  assets: CloudPublishUploadAsset[];
}

export interface CloudPublishUploadTarget {
  ref: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
}

export interface CloudPublishUploadResponse {
  data: {
    id: string;
    expires_at: string;
    uploads: CloudPublishUploadTarget[];
  };
}

export interface CloudPublishedNoteCollection {
  data: CloudPublishedNote[];
}

export interface CloudVaultLink {
  base_url: string;
  vault_id: string;
  vault_name: string;
  linked_at: string;
  /**
   * Set while this local vault moves from a readable Cloud vault into a new
   * end-to-end encrypted one: the readable vault is retired once everything
   * has uploaded, and the field is then removed.
   */
  replaces_vault_id?: string;
}

export interface CloudSyncBootstrapConflict {
  code: "BOOTSTRAP_CONTENT_CONFLICT";
  item_id: string;
  path: string;
  local_sha256: string;
  remote_sha256: string;
}

export interface CloudSyncBootstrapConflictVersion {
  sha256: string;
  byte_length: number;
  media_type: string;
  /** UTF-8 contents for comparison. Binary and oversized files have no preview. */
  text: string | null;
}

export interface CloudSyncBootstrapConflictDetails {
  conflict: CloudSyncBootstrapConflict;
  kind: CloudSyncItemKind;
  local: CloudSyncBootstrapConflictVersion;
  cloud: CloudSyncBootstrapConflictVersion;
}

export type CloudSyncBootstrapConflictChoice =
  | "local"
  | "cloud"
  | "both"
  | "merged";

export interface CloudSyncBootstrapConflictResolution {
  conflict: CloudSyncBootstrapConflict;
  choice: CloudSyncBootstrapConflictChoice;
  /** Vault-relative destination for this device's version when keeping both. */
  keep_both_path?: string;
  /** Complete UTF-8 result when resolving a text conflict by merging. */
  merged_text?: string;
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
 * A file Cloud refused for its path (#1004), or one whose path is longer than
 * Cloud takes. It stays on this device and the rest of the vault keeps
 * syncing; sync offers it to Cloud again once a day, and at once under a new
 * name.
 */
export interface CloudSyncRefusedPath {
  path: string;
  /** Cloud's answer, for Details. */
  detail: string;
}

export type CloudSyncPendingConflictKind = "content" | "delete" | "move" | "path";

/** A durable conflict kept in private app storage, never as a vault note. */
export interface CloudSyncPendingConflict {
  id: string;
  item_id: string;
  path: string;
  cloud_path: string | null;
  kind: CloudSyncPendingConflictKind;
  can_merge: boolean;
  has_base: boolean;
}

export interface CloudSyncConflictVersion {
  path: string | null;
  revision: number | null;
  sha256: string | null;
  byte_length: number;
  media_type: string | null;
  text: string | null;
  deleted: boolean;
}

export interface CloudSyncMergeChange {
  id: string;
  base_text: string;
  local_text: string;
  cloud_text: string;
}

export type CloudSyncMergePart =
  | { type: "text"; text: string }
  | { type: "change"; change_id: string };

export interface CloudSyncPendingConflictDetails {
  conflict: CloudSyncPendingConflict;
  base: CloudSyncConflictVersion;
  local: CloudSyncConflictVersion;
  cloud: CloudSyncConflictVersion;
  suggested_text: string | null;
  draft_text: string | null;
  changes: CloudSyncMergeChange[];
  /** Ordered safe text and unresolved choices used to preview a combined note. */
  parts: CloudSyncMergePart[];
}

export type CloudSyncPendingConflictChoice =
  | "local"
  | "cloud"
  | "both"
  | "merged"
  | "changes";

export interface CloudSyncPendingConflictResolution {
  conflict_id: string;
  choice: CloudSyncPendingConflictChoice;
  expected_local_sha256: string | null;
  expected_cloud_revision: number | null;
  keep_both_path?: string;
  /** Vault-relative destination when content and location are resolved together. */
  resolved_path?: string;
  merged_text?: string;
  change_choices?: Record<string, "local" | "cloud" | "both">;
}

/**
 * Vault settings that differ between this device and the cloud. The local
 * settings stay in use; this is the pending question, and it survives
 * restarts because the cloud's copy is parked in the vault until answered.
 */
export interface CloudSyncSettingsConflict {
  path: string;
  cloud_path: string;
  /**
   * The parked cloud vault.json, parsed, so the app can show which settings
   * differ instead of asking for an all-or-nothing answer. Optional: hosts
   * that predate it, or a parked copy that is not valid JSON, leave it out and
   * the app falls back to the whole-file question.
   */
  cloud_settings?: Record<string, unknown>;
}

export type CloudSyncSettingsChoice = "local" | "cloud";

export interface CloudSyncRunSummary {
  cursor: number;
  pulled: number;
  pushed: number;
  conflicts: CloudSyncConflict[];
  bootstrap_conflicts: CloudSyncBootstrapConflict[];
  local_conflicts: CloudSyncLocalConflict[];
  /** Present on clients with the unified conflict resolver. */
  pending_conflicts?: CloudSyncPendingConflict[];
  /** Possible copies made by the pre-v2.44 conflict strategy. Never auto-deleted. */
  legacy_conflict_copies?: Array<{ path: string; original_path: string }>;
  /** Present on clients that set refused paths aside (v2.80 and later). */
  refused_paths?: CloudSyncRefusedPath[];
}
/** Desktop-wide sync handshake. Drafts must be durable before a run starts. */
export type CloudSyncWindowEvent =
  | { phase: 'prepare'; requestId: string }
  | {
      phase: 'finished'
      requestId: string
      summary: CloudSyncRunSummary | null
      error: string | null
    }

export interface CloudSyncWindowHandlers {
  prepare(): Promise<void>
  finished(summary: CloudSyncRunSummary | null, error: string | null): void
}

/** End-to-end encryption as the Settings page sees it for the signed-in account. */
export interface CloudEncryptionStatus {
  /** ZenNotes Cloud accepts encrypted vaults for this account and this app can open them. */
  available: boolean;
  /** The account has set up encryption. */
  keyset: boolean;
  /** This device holds the unlocked account key. */
  unlocked: boolean;
}

/** Recovery words to show and confirm before setup or a new recovery key takes effect. */
export interface CloudEncryptionRecoveryPrompt {
  setupId: string;
  recoveryWords: string[];
}

/** Either secret proves the person may change the account's encryption. */
export type CloudEncryptionSecretInput = { passphrase: string } | { recoveryWords: string };

/** Argon2id settings for the encryption passphrase, stored with the keyset. */
export interface CloudEncryptionKdf {
  algorithm: "argon2id";
  version: 19;
  memory_kib: number;
  iterations: number;
  parallelism: number;
  /** Base64 of 16 random bytes. */
  salt: string;
}

/**
 * An account's end-to-end encryption keyset: the account key sealed under the
 * passphrase and, separately, under the recovery key. The service never holds
 * either secret.
 */
export interface CloudEncryptionKeyset {
  format: 1;
  account_key_version: number;
  kdf: CloudEncryptionKdf;
  passphrase_envelope: string;
  recovery_envelope: string;
  revision: number;
  updated_at: string;
}

export interface CloudEncryptionKeysetResponse {
  data: CloudEncryptionKeyset;
}

export interface CloudEncryptionKeysetCreate {
  format: 1;
  account_key_version: number;
  kdf: CloudEncryptionKdf;
  passphrase_envelope: string;
  recovery_envelope: string;
}

/** A passphrase change replaces kdf and passphrase_envelope; a new recovery key replaces recovery_envelope. */
export interface CloudEncryptionKeysetUpdate {
  expected_revision: number;
  kdf?: CloudEncryptionKdf;
  passphrase_envelope?: string;
  recovery_envelope?: string;
}
