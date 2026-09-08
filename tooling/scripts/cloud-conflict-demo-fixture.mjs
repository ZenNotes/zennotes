#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = Number(process.env.ZENNOTES_DEMO_CLOUD_PORT ?? 43183)
const vaultId = 'demo-vault'
const now = '2026-09-03T14:00:00.000Z'
const noteId = 'demo-weekend-trip'
const notePath = 'Plans/Weekend trip.md'

const baseText = `# Weekend trip

## Packing list

- Passport
- Phone charger
- Light jacket

## Plan

Leave Saturday at 8:00 AM.
Book the museum for 2:00 PM.
`

const otherDeviceText = `# Weekend trip

## Packing list

- Passport
- Phone charger
- Light jacket

## Plan

Leave Saturday at 8:00 AM.
Book the museum for 1:30 PM.
Reserve dinner at 7:00 PM.
`

let sequence = 1
let armed = false
/** @type {Map<string, { item_id: string, path: string, kind: "text" | "binary", revision: number, content: ReturnType<typeof textContent>, deleted: boolean }>} */
const items = new Map()
/** @type {Array<Record<string, unknown>>} */
const changes = []
/** @type {Map<string, Array<Record<string, unknown>>>} */
const revisions = new Map()

const initial = {
  item_id: noteId,
  path: notePath,
  kind: 'text',
  revision: 1,
  content: textContent(baseText),
  deleted: false
}
items.set(noteId, initial)
revisions.set(noteId, [revisionRecord(initial, 'upsert')])

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    const method = request.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/app/connect') {
      const callback = url.searchParams.get('callback_url')
      const state = url.searchParams.get('state')
      if (!callback || !state) return json(response, 400, { message: 'Missing callback.' })
      const destination = new URL(callback)
      destination.searchParams.set('code', 'demo123')
      destination.searchParams.set('state', state)
      response.writeHead(302, {
        Location: destination.toString(),
        'Cache-Control': 'no-store'
      })
      response.end()
      return
    }

    if (method === 'POST' && url.pathname === '/api/v1/app/exchange') {
      return json(response, 200, {
        token: 'demo-token',
        user: { name: 'Demo User', email: 'demo@zennotes.test' },
        device: { id: 'demo-desktop', name: 'This Mac', platform: 'desktop' }
      })
    }

    if (method === 'POST' && url.pathname === '/demo/arm') {
      if (!armed) {
        armed = true
        const previous = items.get(noteId)
        const next = {
          ...previous,
          path: notePath,
          revision: (previous?.revision ?? 1) + 1,
          content: textContent(otherDeviceText),
          deleted: false
        }
        sequence += 1
        items.set(noteId, next)
        revisions.get(noteId)?.push(revisionRecord(next, 'upsert'))
        changes.push(changeRecord(next, 'upsert', sequence, notePath))
      }
      return json(response, 200, { armed, cursor: sequence })
    }

    if (method === 'GET' && url.pathname === '/demo/status') {
      return json(response, 200, {
        armed,
        cursor: sequence,
        note: items.get(noteId),
        change_count: changes.length
      })
    }

    if (method === 'GET' && url.pathname === '/api/v1/account') {
      return json(response, 200, {
        data: {
          user: { name: 'Demo User', email: 'demo@zennotes.test' },
          device: {
            id: 'demo-desktop',
            name: 'This Mac',
            platform: 'desktop',
            app_version: '2.44.0'
          },
          features: {
            sync: { active: true, limits: null },
            backup: { active: false, limits: null },
            publish: { active: false, limits: null }
          },
          usage: {
            storage: {
              total_bytes: 0,
              sync_bytes: 0,
              backup_bytes: 0,
              publish_bytes: 0
            },
            sync: { vaults: 1, items: items.size },
            backup: { snapshots: 0, ready_snapshots: 0, latest_at: null },
            publish: { notes: 0, assets: 0, latest_at: null }
          }
        }
      })
    }

    if (method === 'GET' && url.pathname === '/api/v1/vaults') {
      return json(response, 200, { data: [vaultSummary()] })
    }

    if (method === 'GET' && url.pathname === '/api/v1/shares') {
      return json(response, 200, { data: [] })
    }

    if (method === 'POST' && url.pathname === '/api/v1/vaults') {
      return json(response, 201, { data: vaultSummary() })
    }

    if (method === 'GET' && url.pathname === `/api/v1/vaults/${vaultId}/manifest`) {
      const includeContent = url.searchParams.get('include_content') === 'true'
      const data = [...items.values()]
        .filter((item) => !item.deleted)
        .map((item) => ({
          item_id: item.item_id,
          path: item.path,
          kind: item.kind,
          revision: item.revision,
          sha256: item.content.sha256,
          byte_length: item.content.byte_length,
          media_type: item.content.media_type,
          ...(includeContent ? { content: item.content } : {})
        }))
      return json(response, 200, { data, cursor: sequence, next_page: null })
    }

    if (method === 'GET' && url.pathname === `/api/v1/vaults/${vaultId}/changes`) {
      const after = Number(url.searchParams.get('after') ?? 0)
      return json(response, 200, {
        data: changes.filter((change) => Number(change.sequence) > after),
        cursor: sequence,
        has_more: false
      })
    }

    const revisionMatch = new RegExp(
      `^/api/v1/vaults/${vaultId}/items/([^/]+)/revisions/(\\d+)$`
    ).exec(url.pathname)
    if (method === 'GET' && revisionMatch) {
      const itemId = decodeURIComponent(revisionMatch[1])
      const wanted = Number(revisionMatch[2])
      const history = revisions.get(itemId) ?? []
      const state = history.find((entry) => entry.revision === wanted)
      if (!state) return json(response, 404, { message: 'Revision not found.' })
      const content = [...history]
        .reverse()
        .find((entry) => entry.revision <= wanted && entry.type === 'upsert')?.content
      return json(response, 200, {
        data: {
          item_id: itemId,
          revision: wanted,
          path: state.path,
          kind: state.kind,
          deleted: state.type === 'delete',
          content: content ?? null
        }
      })
    }

    if (method === 'POST' && url.pathname === `/api/v1/vaults/${vaultId}/mutations`) {
      const body = await readJson(request)
      const acknowledged = []
      const conflicts = []
      for (const mutation of body.mutations ?? []) {
        const current = items.get(mutation.item_id)
        const expected = current?.deleted ? current.revision : (current?.revision ?? null)
        if (mutation.base_revision !== expected) {
          conflicts.push({
            operation_id: mutation.operation_id,
            item_id: mutation.item_id,
            code: current?.deleted ? 'ITEM_DELETED' : 'REVISION_CONFLICT',
            current_revision: current?.revision ?? null,
            current_path: current?.deleted ? null : (current?.path ?? null)
          })
          continue
        }

        const pathCollision =
          mutation.type !== 'delete'
            ? [...items.values()].find(
                (item) =>
                  !item.deleted &&
                  item.item_id !== mutation.item_id &&
                  item.path.toLocaleLowerCase() === mutation.path.toLocaleLowerCase()
              )
            : undefined
        if (pathCollision) {
          conflicts.push({
            operation_id: mutation.operation_id,
            item_id: mutation.item_id,
            code: 'PATH_CONFLICT',
            current_revision: current?.revision ?? null,
            current_path: pathCollision.path
          })
          continue
        }

        const revision = (current?.revision ?? 0) + 1
        sequence += 1
        const previousPath = current?.path ?? null
        const next = applyMutation(current, mutation, revision)
        items.set(mutation.item_id, next)
        const type = mutation.type
        const record = revisionRecord(next, type, previousPath)
        const history = revisions.get(mutation.item_id) ?? []
        history.push(record)
        revisions.set(mutation.item_id, history)
        changes.push(changeRecord(next, type, sequence, previousPath))
        acknowledged.push({
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          revision,
          sequence
        })
      }
      return json(response, 200, { acknowledged, conflicts, cursor: sequence })
    }

    json(response, 404, {
      message: `${method} ${url.pathname} is not part of the demo fixture.`
    })
  } catch (error) {
    json(response, 500, {
      message: error instanceof Error ? error.message : String(error)
    })
  }
})

server.listen(port, host, () => {
  process.stdout.write(`ZenNotes Cloud demo fixture: http://${host}:${port}\n`)
  process.stdout.write(`Base note: ${notePath}\n`)
  process.stdout.write(`Arm the other-device edit: curl -X POST http://${host}:${port}/demo/arm\n`)
})

function textContent(data) {
  return {
    encoding: 'utf8',
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
    byte_length: Buffer.byteLength(data),
    media_type: 'text/markdown'
  }
}

function vaultSummary() {
  return {
    id: vaultId,
    name: 'Demo Cloud Vault',
    cursor: sequence,
    created_at: now,
    updated_at: now
  }
}

function applyMutation(current, mutation, revision) {
  if (mutation.type === 'delete') {
    return {
      ...current,
      item_id: mutation.item_id,
      revision,
      deleted: true
    }
  }
  if (mutation.type === 'move') {
    return {
      ...current,
      item_id: mutation.item_id,
      path: mutation.path,
      revision,
      deleted: false
    }
  }
  return {
    item_id: mutation.item_id,
    path: mutation.path,
    kind: mutation.kind,
    revision,
    content: mutation.content,
    deleted: false
  }
}

function revisionRecord(item, type, previousPath = null) {
  return {
    item_id: item.item_id,
    revision: item.revision,
    type,
    path: item.path,
    previous_path: previousPath,
    kind: item.kind,
    content: type === 'upsert' ? item.content : undefined
  }
}

function changeRecord(item, type, changeSequence, previousPath = null) {
  return {
    sequence: changeSequence,
    item_id: item.item_id,
    type,
    path: type === 'delete' ? (previousPath ?? item.path) : item.path,
    previous_path: previousPath,
    revision: item.revision,
    ...(type === 'upsert' ? { content: item.content } : {})
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(body))
}
