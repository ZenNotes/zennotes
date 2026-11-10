/**
 * A clip from a `zennotes://new` or `zennotes://daily` link (the web
 * clipper's handoff; contract in docs/web-clipper-link.md), as desktop main
 * hands it to the window that shows the target vault. Main has already
 * parsed and validated the link, checked the clipboard against the link's
 * hash, and picked this window because its vault is the one the link names.
 * The renderer writes it, because an open note's unsaved edits live there.
 */
export interface ClipApplyRequest {
  /** Local vault root this clip is for, or null for the connected server.
   *  A window whose vault changed since main picked it refuses the clip. */
  vaultRoot: string | null
  action: 'new' | 'daily'
  /** Folder inside the notes area; '' is its top level. `new` only. */
  folder: string
  /** Note name, unsanitized; null names the note from its first line. */
  name: string | null
  /** The note text; null for a link that only creates or opens a note. */
  text: string | null
  position: 'create' | 'append' | 'prepend'
  silent: boolean
}

/** A clip main refused before any window could take it (a malformed link, a
 *  clipboard that did not match, a vault that is not there), shown as a toast
 *  in the window the user is in. */
export interface ClipNotice {
  kind: 'error'
  message: string
}
