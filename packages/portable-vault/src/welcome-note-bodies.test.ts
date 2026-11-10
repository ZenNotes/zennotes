import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  WELCOME_NOTE_ANDROID_BODY,
  WELCOME_NOTE_ANDROID_TABLET_BODY,
  WELCOME_NOTE_BODY,
  WELCOME_NOTE_PATH,
  WELCOME_NOTE_TABLET_BODY,
  isUntouchedWelcomeSeed,
  sha256OfText,
  welcomeNoteBody
} from './welcome-note'

// Each shell seeds its own Welcome (iCloud and the iPad's Commands row on one,
// Android's storage, math and Ctrl+Shift+P on the other), and Cloud sync holds
// an untouched seed back from a vault's first link by its hash. A body whose
// hash is missing from the seed set would upload on every new device.
describe('the Welcome note on each platform', () => {
  const bodies = {
    'iPhone phone': WELCOME_NOTE_BODY,
    'iPhone tablet': WELCOME_NOTE_TABLET_BODY,
    'Android phone': WELCOME_NOTE_ANDROID_BODY,
    'Android tablet': WELCOME_NOTE_ANDROID_TABLET_BODY
  }

  it('is the seed the shell writes for each layout', () => {
    assert.equal(welcomeNoteBody(true, 'ios'), WELCOME_NOTE_BODY)
    assert.equal(welcomeNoteBody(false, 'ios'), WELCOME_NOTE_TABLET_BODY)
    assert.equal(welcomeNoteBody(true, 'android'), WELCOME_NOTE_ANDROID_BODY)
    assert.equal(welcomeNoteBody(false, 'android'), WELCOME_NOTE_ANDROID_TABLET_BODY)
  })

  for (const [name, body] of Object.entries(bodies)) {
    it(`reads as an untouched seed: ${name}`, async () => {
      assert.equal(isUntouchedWelcomeSeed(WELCOME_NOTE_PATH, await sha256OfText(body)), true)
    })
  }

  it('reads one edited character as the person\'s note', async () => {
    assert.equal(isUntouchedWelcomeSeed(WELCOME_NOTE_PATH, await sha256OfText(`${WELCOME_NOTE_ANDROID_BODY}x`)), false)
  })

  it('keeps Android\'s own wording: no iCloud, and its math section', () => {
    assert.doesNotMatch(WELCOME_NOTE_ANDROID_BODY, /iCloud/)
    assert.match(WELCOME_NOTE_ANDROID_BODY, /## Math that renders live/)
    assert.match(WELCOME_NOTE_ANDROID_TABLET_BODY, /Ctrl\+Shift\+P/)
    assert.match(WELCOME_NOTE_TABLET_BODY, /\*\*Commands\*\*/)
  })
})
