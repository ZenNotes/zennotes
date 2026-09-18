import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { createCloudSyncClient } from './cloud-sync-client'

it('publishes an attachment when the committed response takes more than 30 seconds, then updates the same link', async () => {
  const attachment = Buffer.alloc(1_100_000, 73)
  const stored: { markdown: string; attachment: Buffer }[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = await new Request('http://localhost/shares', {
        method: 'POST',
        headers: { 'Content-Type': request.headers['content-type']! },
        body: Buffer.concat(chunks)
      }).formData()
      const payload = JSON.parse(form.get('payload') as string)
      const file = form.get('assets[]') as File
      stored.push({ markdown: payload.markdown, attachment: Buffer.from(await file.arrayBuffer()) })
      if (request.method === 'POST') await new Promise((resolve) => setTimeout(resolve, 31_000))
      response.writeHead(request.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 1, slug: 'test', url: 'http://localhost/s/test' }))
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as import('node:net').AddressInfo
  const client = createCloudSyncClient(`http://127.0.0.1:${address.port}`, 'test-only')
  const input = {
    note_path: 'Cloud test.md', title: 'Cloud test', markdown: 'Before ![](image.jpg)',
    assets: [{ ref: 'image.jpg', name: 'image.jpg', mime: 'image/jpeg', base64: attachment.toString('base64') }]
  }
  try {
    const created = await client.publishNote(input)
    const updated = await client.updatePublishedNote(created.id, { ...input, markdown: 'After ![](image.jpg)' })
    expect(updated.url).toBe(created.url)
    expect(stored.map((note) => note.markdown)).toEqual([input.markdown, 'After ![](image.jpg)'])
    expect(stored.every((note) => note.attachment.equals(attachment))).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 45_000)
