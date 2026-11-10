import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { decodeCloudSyncBase64, yieldToUi } from './cloud-sync-work'

describe('cloud sync cooperative work', () => {
  it('decodes exact bytes, including padding, whitespace and data URLs', async () => {
    for (const size of [0, 1, 2, 3, 49_151, 49_152, 49_153, 300_001]) {
      const expected = Buffer.alloc(size)
      for (let i = 0; i < size; i++) expected[i] = i % 256
      const base64 = expected.toString('base64')
      const result = await decodeCloudSyncBase64(`data:image/png;base64,\n${base64}\n`)
      assert.deepEqual(Buffer.from(result.bytes), expected)
      assert.equal(result.base64, base64)
    }
  })

  it('lets pending input run before a large attachment finishes decoding', async () => {
    const input = Buffer.alloc(8_100_000, 125).toString('base64')
    let inputProcessed = false
    const timer = setTimeout(() => { inputProcessed = true }, 0)
    try {
      const result = await decodeCloudSyncBase64(input)
      assert.equal(inputProcessed, true)
      assert.equal(result.bytes.length, 8_100_000)
      assert.equal(result.bytes.at(-1), 125)
    } finally {
      clearTimeout(timer)
    }
  })

  it('uses a real task boundary on older WebViews without scheduler.yield', async () => {
    let inputProcessed = false
    setTimeout(() => { inputProcessed = true }, 0)
    await yieldToUi()
    assert.equal(inputProcessed, true)
  })

  it('rejects malformed base64 instead of hashing damaged bytes', async () => {
    await assert.rejects(decodeCloudSyncBase64('AA!A'))
  })
})
