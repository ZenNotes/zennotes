import { lazy, Suspense, useEffect, useState } from 'react'
import {
  getDatePromptRequest,
  settleDatePromptRequest,
  subscribeDatePromptRequests,
  type DatePromptRequest
} from '../lib/date-prompt-requests'

const DatePickerModal = lazy(async () => {
  const module = await import('./DatePickerModal')
  return { default: module.DatePickerModal }
})

export function DatePickerHost(): JSX.Element | null {
  const [request, setRequest] = useState<DatePromptRequest | null>(getDatePromptRequest)

  useEffect(() => {
    return subscribeDatePromptRequests(setRequest)
  }, [])

  if (!request) return null

  return (
    <Suspense fallback={null}>
      <DatePickerModal
        options={request.options}
        onSubmit={(iso) => settleDatePromptRequest(request, iso)}
        onCancel={() => settleDatePromptRequest(request, null)}
      />
    </Suspense>
  )
}
