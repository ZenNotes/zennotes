/** Host filesystem work runs only after pending writes drain and editing locks.
 * Each callback must finish its own partial rollback before rejecting. */
export interface LocalVaultRelocation {
  move: () => Promise<void>
  rollback: () => Promise<void>
  /** Omit when relocating a vault that is not open. Tokens belong to the host. */
  reopen?: { source: string; destination: string }
}
