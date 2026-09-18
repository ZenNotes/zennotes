import type { CloudVaultLink } from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncApiClient } from './cloud-sync-api'

export const CLOUD_VAULT_REMOVED_MESSAGE =
  'This Cloud vault is no longer available. This device has been unlinked; your local notes are unchanged.'

export function isCloudResourceMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; status?: unknown; code?: unknown }
  return value.name === 'CloudServiceRequestError' && value.status === 404 && value.code === 'NOT_FOUND'
}

/** Item/revision 404s and paginated vault lists cannot prove a vault is gone. */
export async function confirmCloudVaultMissing(
  client: Pick<CloudSyncApiClient, 'manifest'>,
  vaultId: string,
  error: unknown
): Promise<boolean> {
  if (!isCloudResourceMissing(error)) return false
  try {
    await client.manifest(vaultId, { includeContent: false, perPage: 1 })
    return false
  } catch (confirmation) {
    return isCloudResourceMissing(confirmation)
  }
}

export function sameCloudVaultLink(current: CloudVaultLink | null, expected: CloudVaultLink): boolean {
  return current !== null && current.base_url === expected.base_url &&
    current.vault_id === expected.vault_id && current.linked_at === expected.linked_at
}
