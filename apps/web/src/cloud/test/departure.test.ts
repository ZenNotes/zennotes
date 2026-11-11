/**
 * One 401 DEVICE_REVOKED reaches two places: the host's transport, which
 * removes this browser, and app-core's refusal handling, which signs out. On a
 * shared computer both wipe and reload with a screen of their own, so the
 * person read "You signed out ... could not reach Cloud" instead of "This
 * browser was removed from your account" whenever the sign-out wrote last
 * (Safari, 2026-11-11). The first to commit owns the exit.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { claimRemoval, claimSignOut, removalUnderway, resetDepartureForTests } from '../departure'

describe('how a signed-in tab leaves', () => {
  beforeEach(() => {
    resetDepartureForTests()
  })

  it('lets nothing leave until something claims the exit', () => {
    assert.equal(removalUnderway(), false)
  })

  it('keeps a sign-out from the same refusal out of the removal\'s way', () => {
    // The transport hears DEVICE_REVOKED first and starts the removal.
    assert.equal(claimRemoval(), true)
    // App-core's refusal handling asks to sign out: it must not wipe again
    // or write its own screen over the removal's.
    assert.equal(removalUnderway(), true)
    assert.equal(claimSignOut(), false)
  })

  it('hands the exit to a removal that arrives while a sign-out is still pushing', () => {
    // A sign-out commits only once it stops pushing and asking, so a removal
    // in that window takes over.
    assert.equal(claimRemoval(), true)
    assert.equal(claimSignOut(), false)
    assert.equal(removalUnderway(), true)
  })

  it('treats a removal answer after the sign-out committed as the sign-out\'s own', () => {
    assert.equal(claimSignOut(), true)
    assert.equal(claimRemoval(), false)
    assert.equal(removalUnderway(), false)
  })

  it('starts one removal however many requests hear the answer', () => {
    assert.equal(claimRemoval(), true)
    assert.equal(claimRemoval(), false)
  })
})
