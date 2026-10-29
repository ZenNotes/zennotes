import { describe, expect, it } from 'vitest'
import { databaseGridKeyAction } from './database-grid-keys'

// Every letter (and Vim symbol) the grid answers with Vim mode on.
const VIM_KEYS: Array<[string, string]> = [
  ['j', 'down'],
  ['k', 'up'],
  ['h', 'left'],
  ['l', 'right'],
  ['H', 'move-column-left'],
  ['L', 'move-column-right'],
  ['0', 'first-column'],
  ['^', 'first-column'],
  ['$', 'last-column'],
  ['G', 'last-row'],
  ['g', 'g'],
  ['d', 'd'],
  ['i', 'edit'],
  ['x', 'select'],
  ['o', 'open-page'],
  ['O', 'create-pages'],
  ['c', 'columns'],
  ['m', 'menu'],
  ['a', 'add-row']
]

// What stays with Vim mode off: the arrows, Enter, Space, Escape, the menu keys.
const UNIVERSAL_KEYS: Array<[{ key: string; shiftKey?: boolean }, string]> = [
  [{ key: 'ArrowDown' }, 'down'],
  [{ key: 'ArrowUp' }, 'up'],
  [{ key: 'ArrowLeft' }, 'left'],
  [{ key: 'ArrowRight' }, 'right'],
  [{ key: 'Enter' }, 'edit'],
  [{ key: ' ' }, 'space'],
  [{ key: 'Escape' }, 'escape'],
  [{ key: 'ContextMenu' }, 'menu'],
  [{ key: 'F10', shiftKey: true }, 'menu']
]

describe('databaseGridKeyAction: the grid keys and Vim mode', () => {
  it('answers every grid letter with Vim mode on', () => {
    for (const [key, action] of VIM_KEYS) {
      expect(databaseGridKeyAction({ key, shiftKey: key !== key.toLowerCase() }, true), key).toBe(action)
    }
  })

  it('answers no letter, digit or Vim symbol with Vim mode off', () => {
    for (const [key] of VIM_KEYS) {
      expect(databaseGridKeyAction({ key, shiftKey: key !== key.toLowerCase() }, false), key).toBeNull()
    }
    // Nor any other letter: typing never acts on the grid with Vim off.
    for (const key of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(databaseGridKeyAction({ key }, false), key).toBeNull()
    }
  })

  it('keeps the arrows, Enter, Space, Escape and the menu keys in both modes', () => {
    for (const vim of [true, false]) {
      for (const [event, action] of UNIVERSAL_KEYS) {
        expect(databaseGridKeyAction(event, vim), `${event.key} vim=${vim}`).toBe(action)
      }
    }
  })

  it('leaves F10 without Shift, and every chord, to the app', () => {
    expect(databaseGridKeyAction({ key: 'F10' }, true)).toBeNull()
    for (const vim of [true, false]) {
      expect(databaseGridKeyAction({ key: 'j', ctrlKey: true }, vim)).toBeNull()
      expect(databaseGridKeyAction({ key: 'ArrowDown', metaKey: true }, vim)).toBeNull()
      expect(databaseGridKeyAction({ key: 'Enter', altKey: true }, vim)).toBeNull()
    }
  })

  it('does not take Delete or Backspace (row deletion has no confirm of its own)', () => {
    for (const vim of [true, false]) {
      expect(databaseGridKeyAction({ key: 'Delete' }, vim)).toBeNull()
      expect(databaseGridKeyAction({ key: 'Backspace' }, vim)).toBeNull()
    }
  })

  it('never resolves a key named like an object property', () => {
    expect(databaseGridKeyAction({ key: 'constructor' }, true)).toBeNull()
    expect(databaseGridKeyAction({ key: 'toString' }, false)).toBeNull()
  })
})
