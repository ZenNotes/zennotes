import { useEffect, useState } from 'react'
import { ConfirmModal, type ConfirmOptions } from './ConfirmModal'

type ConfirmRequest = {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

let currentRequest: ConfirmRequest | null = null
const listeners = new Set<(request: ConfirmRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function confirmApp(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(currentRequest)

  useEffect(() => {
    listeners.add(setRequest)
    return () => {
      listeners.delete(setRequest)
    }
  }, [])

  if (!request) return null

  return (
    <ConfirmModal
      options={request.options}
      onConfirm={() => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(true))
        emit()
      }}
      onCancel={() => {
        const resolve = request.resolve
        currentRequest = null
        setRequest(null)
        queueMicrotask(() => resolve(false))
        emit()
      }}
    />
  )
}
