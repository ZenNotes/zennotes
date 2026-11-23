/**
 * Conditional note writes against a self-hosted server (#1108).
 *
 * A server that advertises `supportsConditionalNoteWrites` returns a note's
 * `sha256` with every read and write of it, and refuses a write that sends
 * that value back as `baseSha256` with 409 when the note changed in between.
 * Without it a client that reads a note, changes it and writes it back writes
 * over whatever another device saved during that round trip. Clients never
 * hash on their side: they echo the server's value, which names the bytes on
 * disk exactly, whatever JSON did to the body on the way. An older server
 * returns no hash, so nothing is sent and every write stays unconditional,
 * exactly as before.
 */

const NOTE_CHANGED_PHRASE = 'changed on the server since it was read'

/** Why a conditional write was refused, phrased for whoever reads it. */
export function noteChangedOnServerMessage(path: string): string {
  return `${path} ${NOTE_CHANGED_PHRASE}, so it was not saved over. Someone else saved it in the meantime.`
}

/**
 * Whether a failed write was refused because the note moved on the server.
 * Matches the HTTP status when the error still carries one, and the sentence
 * above when it crossed IPC, which keeps only the message.
 */
export function isNoteChangedOnServerError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 409) return true
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes(NOTE_CHANGED_PHRASE)
}

/** A base worth sending: a hex SHA-256, nothing else from a caller. */
export function validBaseSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value : undefined
}

export interface RewriteNoteIo<M> {
  read(): Promise<{ body: string; sha256?: string }>
  write(body: string, baseSha256: string | undefined): Promise<M>
}

/**
 * Read a note, change it, write it back on the version that was read. When
 * the server refuses because the note moved, read it again and apply the
 * change to the newer text, a few times at most: the change is a function of
 * the body (append a line, replace a word), so redoing it on the newer text is
 * what the caller asked for, and nobody's edit is written over. `edit`
 * returning null means there is nothing to write, and nothing is.
 */
export async function rewriteNoteOnServer<M>(
  io: RewriteNoteIo<M>,
  edit: (body: string) => string | null | Promise<string | null>,
  attempts = 3
): Promise<M | null> {
  for (let attempt = 1; ; attempt++) {
    const note = await io.read()
    const next = await edit(note.body)
    if (next === null) return null
    try {
      return await io.write(next, validBaseSha256(note.sha256))
    } catch (err) {
      if (attempt >= attempts || !isNoteChangedOnServerError(err)) throw err
    }
  }
}
