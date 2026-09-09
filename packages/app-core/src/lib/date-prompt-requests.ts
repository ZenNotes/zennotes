import type { DatePickerOptions } from '../components/DatePickerModal'

/**
 * The calendar counterpart of `promptApp`: any code with no React context
 * (a CodeMirror completion's `apply`, an ex command) can ask for a date and
 * await the ISO string, while `DatePickerHost` renders the modal. One request
 * at a time, like the text prompt: a second `promptDate` while one is open
 * replaces it on screen and the first promise stays pending until settled.
 */
export type DatePromptRequest = {
  options: DatePickerOptions
  resolve: (value: string | null) => void
}

let currentRequest: DatePromptRequest | null = null
const listeners = new Set<(request: DatePromptRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getDatePromptRequest(): DatePromptRequest | null {
  return currentRequest
}

export function subscribeDatePromptRequests(
  listener: (request: DatePromptRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Resolves with the picked `YYYY-MM-DD`, or null when the picker is dismissed. */
export function promptDate(options: DatePickerOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function settleDatePromptRequest(request: DatePromptRequest, value: string | null): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
