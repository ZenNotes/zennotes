// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { atlasHoldsKeyboard, atlasRegionDirection } from './atlas'
import { SELF_KEYED_SURFACES } from './self-keyed-surfaces'

function keyboardEvent(
  options: Partial<KeyboardEvent> & { key: string; code: string; altGraph?: boolean }
): KeyboardEvent {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    getModifierState: (name: string) => name === 'AltGraph' && options.altGraph === true,
    ...options
  } as KeyboardEvent
}

describe('atlasRegionDirection (#657)', () => {
  it('claims Atlas before global Vim buffer prefixes consume its brackets', () => {
    const atlas = document.createElement('div')
    atlas.setAttribute('data-atlas-view', '')
    const canvas = document.createElement('canvas')
    atlas.append(canvas)

    expect(canvas.closest(SELF_KEYED_SURFACES)).toBe(atlas)
  })

  it('recognizes ordinary previous and next region keys', () => {
    expect(atlasRegionDirection(keyboardEvent({ key: '[', code: 'BracketLeft' }))).toBe(-1)
    expect(atlasRegionDirection(keyboardEvent({ key: ']', code: 'BracketRight' }))).toBe(1)
  })

  it('falls back to the physical bracket key for a dead Wayland event', () => {
    expect(atlasRegionDirection(keyboardEvent({ key: 'Dead', code: 'BracketLeft' }))).toBe(-1)
    expect(atlasRegionDirection(keyboardEvent({ key: 'Process', code: 'BracketRight' }))).toBe(1)
  })

  it('accepts brackets typed with AltGr on layouts that require it', () => {
    expect(
      atlasRegionDirection(
        keyboardEvent({
          key: '[',
          code: 'Digit8',
          ctrlKey: true,
          altKey: true,
          altGraph: true
        })
      )
    ).toBe(-1)
    expect(
      atlasRegionDirection(
        keyboardEvent({ key: ']', code: 'Digit9', ctrlKey: true, altKey: true })
      )
    ).toBe(1)
  })

  it('does not turn other modified or shifted keys into region navigation', () => {
    expect(
      atlasRegionDirection(keyboardEvent({ key: '[', code: 'BracketLeft', ctrlKey: true }))
    ).toBe(0)
    expect(
      atlasRegionDirection(keyboardEvent({ key: '{', code: 'BracketLeft', shiftKey: true }))
    ).toBe(0)
  })
})

describe('atlasHoldsKeyboard (#670)', () => {
  it('owns the keyboard straight after opening, before any click lands', () => {
    // openAtlasView blurs to <body> and marks the panel; no DOM focus yet.
    expect(atlasHoldsKeyboard('atlas', true)).toBe(true)
    expect(atlasHoldsKeyboard(null, true)).toBe(true)
  })

  it('yields once another panel has claimed the keyboard', () => {
    expect(atlasHoldsKeyboard('sidebar', true)).toBe(false)
    expect(atlasHoldsKeyboard('editor', true)).toBe(false)
  })

  it('never owns the keyboard while its tab is inactive', () => {
    expect(atlasHoldsKeyboard('atlas', false)).toBe(false)
    expect(atlasHoldsKeyboard(null, false)).toBe(false)
  })
})
