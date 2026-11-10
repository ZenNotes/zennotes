import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { installRandomUUIDPolyfill, randomUUID } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('random UUIDs on iOS 15.0 to 15.3', () => {
  // Those WebViews have getRandomValues but no randomUUID.
  beforeEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(crypto, 'randomUUID')
  })

  it('makes version 4 UUIDs from getRandomValues', () => {
    const ids = new Set(Array.from({ length: 64 }, () => randomUUID()))
    assert.equal(ids.size, 64)
    for (const id of ids) assert.match(id, V4)
  })

  it('installs crypto.randomUUID for code that calls it directly', () => {
    installRandomUUIDPolyfill()
    assert.equal(typeof crypto.randomUUID, 'function')
    assert.match(crypto.randomUUID(), V4)
    assert.notEqual(crypto.randomUUID(), crypto.randomUUID())
  })
})

describe('a WebView with its own crypto.randomUUID', () => {
  it('keeps it', () => {
    const own = () => '00000000-0000-4000-8000-000000000000' as const
    const target = { randomUUID: own, getRandomValues: crypto.getRandomValues.bind(crypto) } as unknown as Crypto
    installRandomUUIDPolyfill(target)
    assert.equal(target.randomUUID, own)
  })
})
