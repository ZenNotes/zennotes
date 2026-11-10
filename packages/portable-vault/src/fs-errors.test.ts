/** Ported from the Android app's src/bridge/fs-errors.test.ts. */
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { isNotFoundError } from './fs-errors'

it('accepts only stable native not-found errors as verified absence', () => {
  assert.equal(isNotFoundError({ code: 'OS-PLUG-FILE-0008' }), true)
  assert.equal(isNotFoundError({ code: 'ZN-SAF-NOT-FOUND' }), true)
})

it('does not turn permissions or transient storage failures into absence', () => {
  assert.equal(isNotFoundError({ message: "'stat' failed because file does not exist." }), false)
  assert.equal(isNotFoundError({ message: 'Folder access is no longer granted.' }), false)
  assert.equal(isNotFoundError({ message: 'stat failed: timeout reading provider' }), false)
  assert.equal(isNotFoundError(new Error('I/O failure')), false)
  assert.equal(isNotFoundError(null), false)
  assert.equal(isNotFoundError({ code: 404 }), false)
})
