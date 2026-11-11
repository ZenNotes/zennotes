/**
 * Whether the service worker may answer `/_vault/<vaultKey>/...` from OPFS.
 * The copy in OPFS is plain files, so the worker is the one place that can
 * keep them from a page that did not earn them:
 *
 * - a shared computer's copy is served only while its session is open in a
 *   tab (the next load of the app wipes a closed one, but a typed URL never
 *   loads the app);
 * - an end-to-end encrypted vault's files only while a live tab holds the
 *   vault unlocked, so "Lock when I close this tab" and Lock keep them in
 *   OPFS, out of reach.
 */
export interface VaultAccessFacts {
  sharedCopyClosed(): Promise<boolean>
  encrypted(vaultKey: string): Promise<boolean>
  /** A live tab owns the vault and holds its key now. */
  unlockedOwner(vaultKey: string): Promise<boolean>
}

export async function mayServeVaultFile(vaultKey: string, facts: VaultAccessFacts): Promise<boolean> {
  if (await facts.sharedCopyClosed()) return false
  if (await facts.encrypted(vaultKey)) return await facts.unlockedOwner(vaultKey)
  return true
}
