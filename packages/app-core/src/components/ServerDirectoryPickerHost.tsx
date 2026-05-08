import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getDirectoryPickerRequest,
  settleDirectoryPickerRequest,
  subscribeDirectoryPickerRequests,
  type DirectoryPickerRequest
} from '../lib/server-directory-picker-requests'

const ServerDirectoryPickerModal = lazy(async () => {
  const module = await import('./ServerDirectoryPickerModal')
  return { default: module.ServerDirectoryPickerModal }
})

export function ServerDirectoryPickerHost(): JSX.Element | null {
  const [request, setRequest] = useState<DirectoryPickerRequest | null>(getDirectoryPickerRequest)

  useEffect(() => {
    return subscribeDirectoryPickerRequests(setRequest)
  }, [])

  if (!request) return null

  return (
    <Suspense fallback={null}>
      <ServerDirectoryPickerModal
        options={request.options}
        onSubmit={async (path) => {
          if (request.onConfirm) {
            await request.onConfirm(path)
          }
          settleDirectoryPickerRequest(request, path)
        }}
        onCancel={() => settleDirectoryPickerRequest(request, null)}
      />
    </Suspense>
  )
}
