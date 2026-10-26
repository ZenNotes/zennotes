import { describe, expect, it } from 'vitest'
import { linkAnchorOffset, linkCreateDestination, linkPopoverTarget } from './link-popover'
import type { WikilinkReachContext } from './unresolved-links'

// The link popover edits the note a wikilink opens, or offers to create the
// note it names. Everything else a wikilink can reach keeps its own surface.

const context: WikilinkReachContext = {
  notes: [
    { path: 'inbox/Current.md', title: 'Current', folder: 'inbox' },
    { path: 'inbox/Doc.md', title: 'Doc', folder: 'inbox' },
    { path: 'trash/Gone.md', title: 'Gone', folder: 'trash' }
  ],
  databases: [{ csvPath: 'Budget.base/data.csv', title: 'Budget' }],
  assets: [{ path: 'assets/diagram.png' }]
}

const at = (target: string) => linkPopoverTarget(target, 'inbox/Current.md', context)

describe('linkPopoverTarget', () => {
  it('shows the note a link opens, whatever the anchor or alias spelling', () => {
    expect(at('Doc')).toEqual({ kind: 'note', path: 'inbox/Doc.md' })
    expect(at('doc#Heading')).toEqual({ kind: 'note', path: 'inbox/Doc.md' })
    expect(at('Doc^block')).toEqual({ kind: 'note', path: 'inbox/Doc.md' })
  })

  it('offers to create a note no one has written yet, a trashed one included', () => {
    expect(at('Garden Plan')).toEqual({ kind: 'missing' })
    expect(at('Gone')).toEqual({ kind: 'missing' })
  })

  it('stays out of links into the note being read', () => {
    expect(at('#Heading')).toBeNull()
    expect(at('^block')).toBeNull()
    expect(at('Current')).toBeNull()
  })

  it('stays out of databases, files and addresses outside the vault', () => {
    expect(at('Budget')).toBeNull()
    expect(at('assets/diagram.png')).toBeNull()
    expect(at('https://example.com')).toBeNull()
    expect(at('mailto:me@example.com')).toBeNull()
    expect(at('  ')).toBeNull()
  })
})

describe('linkAnchorOffset', () => {
  const body = '# Plan\n\nIntro.\n\n## Goals\n\nShip it. ^ship\n'

  it('lands a heading link on its heading and a block link on its block', () => {
    expect(linkAnchorOffset(body, 'Plan#Goals')).toBe(body.indexOf('## Goals'))
    expect(linkAnchorOffset(body, 'Plan#goals')).toBe(body.indexOf('## Goals'))
    expect(linkAnchorOffset(body, 'Plan^ship')).toBe(body.indexOf('Ship it.'))
  })

  it('opens at the top for a plain link or an anchor the note lost', () => {
    expect(linkAnchorOffset(body, 'Plan')).toBeNull()
    expect(linkAnchorOffset(body, 'Plan#Gone')).toBeNull()
  })
})

describe('linkCreateDestination', () => {
  it('names the folder creating the note would put it in', () => {
    expect(linkCreateDestination('Garden Plan')).toEqual({ folder: 'inbox', subpath: '' })
    expect(linkCreateDestination('projects/Plan#Goals')).toEqual({ folder: 'inbox', subpath: 'projects' })
    expect(linkCreateDestination('archive/Old idea')).toEqual({ folder: 'archive', subpath: '' })
  })

  it('has no destination for a name no file can carry', () => {
    expect(linkCreateDestination('what?')).toBeNull()
  })
})
