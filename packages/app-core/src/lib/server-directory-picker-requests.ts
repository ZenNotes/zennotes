import type { ServerDirectoryPickerOptions } from '../components/ServerDirectoryPickerModal'

export type DirectoryPickerRequest = {
  options: ServerDirectoryPickerOptions
  onConfirm?: (path: string) => Promise<void> | void
  resolve: (value: string | null) => void
}

let currentRequest: DirectoryPickerRequest | null = null
const listeners = new Set<(request: DirectoryPickerRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getDirectoryPickerRequest(): DirectoryPickerRequest | null {
  return currentRequest
}

export function subscribeDirectoryPickerRequests(
  listener: (request: DirectoryPickerRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function pickServerDirectoryApp(
  options: ServerDirectoryPickerOptions,
  onConfirm?: (path: string) => Promise<void> | void
): Promise<string | null> {
  return new Promise((resolve) => {
    currentRequest = { options, onConfirm, resolve }
    emit()
  })
}

export function settleDirectoryPickerRequest(
  request: DirectoryPickerRequest,
  value: string | null
): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
