import type { CloudSyncContent } from '@zennotes/bridge-contract/cloud-sync'

export const CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024

const uploadSources = new WeakMap<CloudSyncContent, string>()

export function rememberCloudSyncUploadSource(content: CloudSyncContent, absolutePath: string): CloudSyncContent {
  uploadSources.set(content, absolutePath)
  return content
}

export function cloudSyncUploadSource(content: CloudSyncContent): string | null {
  return uploadSources.get(content) ?? null
}
