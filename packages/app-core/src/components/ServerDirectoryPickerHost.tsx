import { useEffect, useState } from 'react'
import {
  ServerDirectoryPickerModal,
  type ServerDirectoryPickerOptions
} from './ServerDirectoryPickerModal'

type DirectoryPickerRequest = {
  options: ServerDirectoryPickerOptions
  resolve: (value: string | null) => void
}

let currentRequest: DirectoryPickerRequest | null = null
const listeners = new Set<(request: DirectoryPickerRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function pickServerDirectoryApp(
  options: ServerDirectoryPickerOptions
): Promise<string | null> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function ServerDirectoryPickerHost(): JSX.Element | null {
  const [request, setRequest] = useState<DirectoryPickerRequest | null>(currentRequest)

  useEffect(() => {
    listeners.add(setRequest)
    return () => {
      listeners.delete(setRequest)
    }
  }, [])

  if (!request) return null

  return (
    <ServerDirectoryPickerModal
      options={request.options}
      onSubmit={(path) => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(path))
        emit()
      }}
      onCancel={() => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(null))
        emit()
      }}
    />
  )
}
