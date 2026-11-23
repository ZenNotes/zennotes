import type { ConfirmOptions } from '../components/ConfirmModal'

export type ConfirmRequest = {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

let currentRequest: ConfirmRequest | null = null
const listeners = new Set<(request: ConfirmRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getConfirmRequest(): ConfirmRequest | null {
  return currentRequest
}

export function subscribeConfirmRequests(
  listener: (request: ConfirmRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function confirmApp(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export type NoticeOptions = Pick<ConfirmOptions, 'title' | 'description' | 'confirmLabel'>

/** Tells the user something in the app's own dialog and settles once it is
 *  dismissed. It stands where window.alert would: on Windows a native alert
 *  hands the window back without keyboard focus, and no text field takes
 *  typing again until the window is left and refocused (#1106). */
export function noticeApp(options: NoticeOptions): Promise<void> {
  return confirmApp({ ...options, notice: true }).then(() => undefined)
}

export function settleConfirmRequest(request: ConfirmRequest, value: boolean): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
