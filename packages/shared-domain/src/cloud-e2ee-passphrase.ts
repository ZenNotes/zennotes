/**
 * The encryption passphrase rule, kept apart from the key code so a settings
 * screen can check a passphrase as it is typed without loading Argon2 or the
 * recovery word list.
 */
export const CLOUD_PASSPHRASE_MIN_LENGTH = 12

/**
 * Why a passphrase is refused, or null. Twelve characters is a floor, not a
 * target: the passphrase is the only thing between a stolen keyset and the
 * notes, and an attacker who holds the keyset can guess offline.
 */
export function cloudPassphraseProblem(passphrase: string): string | null {
  const normalized = passphrase.normalize('NFKC')
  if ([...normalized].length < CLOUD_PASSPHRASE_MIN_LENGTH) {
    return `Use at least ${CLOUD_PASSPHRASE_MIN_LENGTH} characters. Four or more unrelated words work well.`
  }
  if (new Set(normalized.toLowerCase()).size < 6) {
    return 'Use a passphrase with more variety; repeated characters are easy to guess.'
  }
  return null
}

/** The first-unlock notice in a browser (docs/specs/cloud-e2ee.md, Threat model). */
export const CLOUD_BROWSER_UNLOCK_NOTICE =
  'A browser downloads ZenNotes from the website each time it changes, so unlocking here trusts that website in a way the installed apps do not.'
