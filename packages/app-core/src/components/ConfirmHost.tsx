import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getConfirmRequest,
  settleConfirmRequest,
  subscribeConfirmRequests,
  type ConfirmRequest
} from '../lib/confirm-requests'

const ConfirmModal = lazy(async () => {
  const module = await import('./ConfirmModal')
  return { default: module.ConfirmModal }
})

export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(getConfirmRequest)

  useEffect(() => {
    return subscribeConfirmRequests(setRequest)
  }, [])

  if (!request) return null

  return (
    <Suspense fallback={null}>
      <ConfirmModal
        options={request.options}
        onConfirm={() => settleConfirmRequest(request, true)}
        onCancel={() => settleConfirmRequest(request, false)}
      />
    </Suspense>
  )
}
