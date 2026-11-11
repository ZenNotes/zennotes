/**
 * How a signed-in tab leaves: Cloud removed this browser, or someone signs
 * out (the person, or app-core after Cloud refused the sign-in).
 *
 * Both can start from one answer. A 401 DEVICE_REVOKED reaches the host's
 * transport, which removes this browser, and the request's caller, whose
 * refusal handling signs out. On a shared computer both wipe and reload with a
 * screen of their own, so whichever wrote last chose what the person read.
 * The first to commit owns the exit, and the other stands aside.
 *
 * A sign-out commits only once it is about to wipe, after its final push and
 * any question, so a removal heard before then still takes over. A removal
 * answer after that point is the sign-out's own: its revoke request can hear
 * it.
 */
type Departure = 'removed' | 'signed-out'

let departure: Departure | null = null

/** Cloud removed this browser. False when a sign-out already owns the exit. */
export function claimRemoval(): boolean {
  if (departure) return false
  departure = 'removed'
  return true
}

/** A sign-out is about to wipe. False when Cloud's removal owns the exit. */
export function claimSignOut(): boolean {
  if (departure === 'removed') return false
  departure = 'signed-out'
  return true
}

/** Cloud's removal is wiping this browser and will reload into its screen. */
export function removalUnderway(): boolean {
  return departure === 'removed'
}

export function resetDepartureForTests(): void {
  departure = null
}
