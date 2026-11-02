import { NotionAbortError, NotionApiError } from './client'

/**
 * Talks to Notion's hosted service (mcp.notion.com), which is what lets one
 * sign-in reach a whole workspace: it reads whatever the person can read, with
 * no page-by-page sharing. The transport is plain JSON-RPC over HTTP, answered
 * as JSON or as a server-sent event.
 */

export const NOTION_MCP_BASE_URL = 'https://mcp.notion.com'

const MCP_PROTOCOL_VERSION = '2025-06-18'
/** Notion: "Every tool call counts toward" the standard API limits. */
const MIN_CALL_SPACING_MS = 340
const MAX_ATTEMPTS = 6
const MAX_RETRY_WAIT_MS = 60_000

export interface McpFetchResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<McpFetchResponse>

export interface NotionMcpOptions {
  fetch: McpFetch
  baseUrl?: string
  accessToken(): Promise<string>
  /** Called once after a 401: a fresh token, or null when sign-in is over. */
  refreshToken(): Promise<string | null>
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  spacingMs?: number
  clientVersion?: string
}

export interface NotionMcpTransport {
  callTool<T>(tool: string, args: Record<string, unknown>): Promise<T>
}

interface RpcResponse {
  id?: number
  result?: {
    isError?: boolean
    content?: Array<{ type: string; text?: string }>
    tools?: Array<{ name: string }>
    structuredContent?: unknown
  }
  error?: { code?: number; message?: string }
}

function parseRpcBody(text: string, id: number): RpcResponse | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as RpcResponse
  // A server-sent event stream: the answer is the `data:` line with our id.
  let found: RpcResponse | null = null
  for (const block of trimmed.split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    try {
      const message = JSON.parse(data) as RpcResponse
      if (message.id === id) found = message
    } catch {
      // A keep-alive or a partial frame.
    }
  }
  return found
}

export function createNotionMcpTransport(options: NotionMcpOptions): NotionMcpTransport {
  const endpoint = `${(options.baseUrl ?? NOTION_MCP_BASE_URL).replace(/\/+$/, '')}/mcp`
  const spacing = options.spacingMs ?? MIN_CALL_SPACING_MS
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) return reject(new NotionAbortError())
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new NotionAbortError())
        }
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        options.signal?.addEventListener('abort', onAbort, { once: true })
      }))

  let nextSlot = 0
  let nextId = 1
  let sessionId: string | null = null
  let toolNames: Map<string, string> | null = null
  let initializing: Promise<void> | null = null

  async function post(body: unknown, id: number | null): Promise<RpcResponse | null> {
    let refreshed = false
    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw new NotionAbortError()
      const wait = nextSlot - now()
      if (wait > 0) await sleep(wait)
      nextSlot = now() + spacing

      let response: McpFetchResponse
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await options.accessToken()}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            ...(sessionId ? { 'mcp-session-id': sessionId } : {})
          },
          body: JSON.stringify(body),
          signal: options.signal
        })
      } catch (error) {
        if (options.signal?.aborted) throw new NotionAbortError()
        if (attempt >= MAX_ATTEMPTS) throw error
        await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS))
        continue
      }

      if (response.status === 401) {
        if (!refreshed) {
          refreshed = true
          if (await options.refreshToken()) continue
        }
        throw new NotionApiError(401, 'unauthorized', 'Sign in to Notion again.')
      }
      if (response.status === 404 && sessionId) {
        // The server dropped the session. Start another and try once more.
        sessionId = null
        toolNames = null
        if (attempt < MAX_ATTEMPTS) {
          await initialize()
          continue
        }
      }
      if (response.status === 429 || response.status === 529 || response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          const header = Number(response.headers.get('retry-after'))
          const delay = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** (attempt - 1)
          await sleep(Math.min(delay, MAX_RETRY_WAIT_MS))
          continue
        }
      }
      if (response.status === 202 || response.status === 204) return null
      const text = await response.text()
      if (response.status < 200 || response.status >= 300) {
        throw new NotionApiError(response.status, 'unknown', `Notion answered ${response.status}.`)
      }
      const session = response.headers.get('mcp-session-id')
      if (session) sessionId = session
      if (id === null) return null
      return parseRpcBody(text, id)
    }
  }

  async function rpc(method: string, params: unknown): Promise<RpcResponse> {
    const id = nextId++
    const answer = await post({ jsonrpc: '2.0', id, method, params }, id)
    if (!answer) throw new NotionApiError(502, 'empty', 'Notion gave no answer.')
    if (answer.error) {
      throw new NotionApiError(400, String(answer.error.code ?? 'error'), answer.error.message ?? 'Notion refused.')
    }
    return answer
  }

  async function initialize(): Promise<void> {
    await rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ZenNotes', version: options.clientVersion ?? '0' }
    })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, null)
    const listed = await rpc('tools/list', {})
    const names = new Map<string, string>()
    for (const tool of listed.result?.tools ?? []) {
      // Notion prefixes its tools (`notion-fetch`) on some transports.
      names.set(tool.name, tool.name)
      names.set(tool.name.replace(/^notion-/, ''), tool.name)
    }
    toolNames = names
  }

  const ensureReady = async (): Promise<void> => {
    if (toolNames) return
    initializing ??= initialize().finally(() => {
      initializing = null
    })
    await initializing
  }

  return {
    async callTool<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      await ensureReady()
      const name = toolNames?.get(tool)
      if (!name) throw new NotionApiError(404, 'no_tool', `Notion doesn't offer "${tool}" on this connection.`)
      for (let attempt = 1; ; attempt++) {
        const answer = await rpc('tools/call', { name, arguments: args })
        const text = (answer.result?.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('')
        if (answer.result?.isError) {
          // Some limits come back as a tool error rather than a 429.
          if (/rate.?limit|too many requests|\b429\b/i.test(text) && attempt < MAX_ATTEMPTS) {
            await sleep(Math.min(2000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS))
            continue
          }
          const notFound = /not found|could not find|object_not_found|\b404\b/i.test(text)
          throw new NotionApiError(notFound ? 404 : 400, 'tool_error', text.slice(0, 300) || 'Notion refused.')
        }
        if (answer.result?.structuredContent !== undefined && !text) {
          return answer.result.structuredContent as T
        }
        try {
          return JSON.parse(text) as T
        } catch {
          return { text } as T
        }
      }
    }
  }
}
