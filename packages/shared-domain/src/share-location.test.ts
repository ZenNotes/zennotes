import { describe, expect, it } from 'vitest'
import { normalizeShareLocation, resolveShareLocation, shareLocationLabel } from './share-location'

describe('share location', () => {
  it('defaults to Quick Notes, also for an unknown or missing value', () => {
    expect(normalizeShareLocation(undefined)).toEqual({ mode: 'quick' })
    expect(normalizeShareLocation({ mode: 'active-note' })).toEqual({ mode: 'quick' })
    expect(resolveShareLocation(null)).toEqual({ folder: 'quick', subpath: '' })
  })

  it('files in the primary location, or a folder inside it', () => {
    expect(resolveShareLocation({ mode: 'primary' })).toEqual({ folder: 'inbox', subpath: '' })
    expect(resolveShareLocation({ mode: 'folder', folder: ' /Reading/Clippings/ ' })).toEqual({
      folder: 'inbox',
      subpath: 'Reading/Clippings'
    })
  })

  it('keeps folder mode while the folder is still empty, filing like primary', () => {
    expect(normalizeShareLocation({ mode: 'folder' })).toEqual({ mode: 'folder', folder: '' })
    expect(resolveShareLocation({ mode: 'folder', folder: '  ' })).toEqual({ folder: 'inbox', subpath: '' })
  })

  it('names the place for the share sheet', () => {
    expect(shareLocationLabel(undefined, 'inbox', 'Work')).toBe('Quick Notes')
    expect(shareLocationLabel({ mode: 'primary' }, 'inbox', 'Work')).toBe('Inbox')
    expect(shareLocationLabel({ mode: 'primary' }, 'root', 'Work')).toBe('Work')
    expect(shareLocationLabel({ mode: 'folder', folder: 'Clippings' }, 'inbox', 'Work')).toBe('Clippings')
  })
})
