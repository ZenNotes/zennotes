/**
 * HttpTransport over fetch. The phones pass CapacitorHttp through (native,
 * outside CORS); the browser is inside CORS and its CSP, so only the app's
 * own origin and the Cloud service answer it. The shape follows the
 * package's HttpTransportRequest: `dataType: 'file'` is a base64 body,
 * `'formData'` is CapacitorHttp's entry list rebuilt as a FormData.
 * Resolves with any HTTP answer, error statuses included; rejects only when
 * no answer came (offline, a stall past the timeout), which the Cloud client
 * may retry.
 */
import { base64ToBytes } from '@zennotes/portable-vault/base64'
import type {
  HttpTransport,
  HttpTransportFormEntry,
  HttpTransportRequest,
  HttpTransportResponse
} from '@zennotes/portable-vault/host'

function withParams(url: string, params: HttpTransportRequest['params']): string {
  if (!params) return url
  const target = new URL(url, location.href)
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(key, item)
  }
  return target.toString()
}

function formDataFrom(entries: HttpTransportFormEntry[]): FormData {
  const form = new FormData()
  for (const entry of entries) {
    if (entry.type === 'base64File') {
      form.append(
        entry.key,
        new Blob([new Uint8Array(base64ToBytes(entry.value))], { type: entry.contentType ?? 'application/octet-stream' }),
        entry.fileName ?? entry.key
      )
    } else {
      form.append(entry.key, entry.value)
    }
  }
  return form
}

function bodyOf(options: HttpTransportRequest, headers: Headers): BodyInit | undefined {
  const { data, dataType } = options
  if (data === undefined || data === null) return undefined
  if (dataType === 'file') return new Uint8Array(base64ToBytes(String(data)))
  if (dataType === 'formData') {
    // The browser writes the multipart boundary itself.
    headers.delete('content-type')
    return formDataFrom(data as HttpTransportFormEntry[])
  }
  if (typeof data === 'string') return data
  if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data as BodyInit
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return JSON.stringify(data)
}

async function readBody(response: Response, responseType: HttpTransportRequest['responseType']): Promise<unknown> {
  if (responseType === 'arraybuffer') return await response.arrayBuffer()
  if (responseType === 'blob') return await response.blob()
  const text = await response.text()
  if (responseType === 'text') return text
  const type = response.headers.get('content-type') ?? ''
  if (responseType === 'json' || type.includes('json')) {
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return text
    }
  }
  return text
}

export const fetchTransport: HttpTransport = {
  async request(options): Promise<HttpTransportResponse> {
    const headers = new Headers(options.headers ?? {})
    const controller = new AbortController()
    const timeout = Math.max(options.connectTimeout ?? 0, 0) + Math.max(options.readTimeout ?? 0, 0)
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null
    try {
      const response = await fetch(withParams(options.url, options.params), {
        method: options.method ?? 'GET',
        headers,
        body: bodyOf(options, headers),
        redirect: options.disableRedirects ? 'manual' : 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      })
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      return {
        status: response.status,
        headers: responseHeaders,
        data: await readBody(response, options.responseType),
        url: response.url
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  },
  // The browser has no native PUT and no sync fast path: in-memory bodies
  // go through `request`, like the iPhone's.
  putsInMemoryBodies: false
}
