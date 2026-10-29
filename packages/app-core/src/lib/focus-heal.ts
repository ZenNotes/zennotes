/**
 * When the focus heal (App.tsx, #350) may re-grab the editor as the app
 * comes back to the front.
 *
 * The heal answers the window regaining focus and the page becoming visible
 * again: if the store says the editor was the last surface and the editor
 * lacks the DOM focus, it focuses it, because Chromium can let the editor
 * lose focus while idle and the keys then go nowhere. A host that opens
 * notes to read (a phone) also leaves the store naming the editor after a
 * note was opened to be read with the keyboard kept down, so the heal raised
 * the soft keyboard over that note on every return to the app.
 *
 * So the app notes, as it is left (the window's blur, the page going hidden,
 * pagehide), whether the editor held the focus. On the way back a host that
 * opens notes to read heals only for someone who was typing; one who was
 * reading keeps the keyboard down, and a fresh page, which left nothing,
 * counts as reading. Desktop heals as before.
 */
export interface FocusHealGate {
  /** One of the events that leave the app. Leaving fires several in a row,
   *  and any of them seeing the editor focused counts. */
  left(editorFocused: boolean): void
  /** One of the events that come back: whether the heal may focus the editor. */
  returned(opensNotesToRead: boolean): boolean
}

export function createFocusHealGate(): FocusHealGate {
  let away = false
  let typingWhenLeft = false
  return {
    left(editorFocused) {
      if (!away) {
        away = true
        typingWhenLeft = false
      }
      typingWhenLeft = typingWhenLeft || editorFocused
    },
    returned(opensNotesToRead) {
      away = false
      return !opensNotesToRead || typingWhenLeft
    }
  }
}
