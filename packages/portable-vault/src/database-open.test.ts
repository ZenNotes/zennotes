import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { missingDatabaseAsNull } from './database-open'

const doc = { relPath: 'inbox/Board.base/data.csv' } as never

describe('Opening a database whose folder is gone', () => {
  it('answers null for a missing database, so core forgets it and closes its tab', async () => {
    const open = missingDatabaseAsNull(async (rel) => {
      throw new Error(`Database not found: ${rel}`)
    })
    assert.equal(await open('inbox/Projects/Untitled Kanban.base/data.csv'), null)
  })

  it('passes a database through, and every other failure still throws', async () => {
    assert.equal(await missingDatabaseAsNull(async () => doc)('x'), doc)
    const unreadable = missingDatabaseAsNull(async () => {
      throw new Error('EACCES: permission denied')
    })
    await assert.rejects(unreadable('x'), /permission denied/)
  })

  it('is what the bridge hands core', () => {
    // The phones' mobile-bridge.ts is this package's portable-bridge.ts.
    const bridge = readFileSync(new URL('./portable-bridge.ts', import.meta.url), 'utf8')
    assert.match(bridge, /openDatabase: openDatabaseOrThrow,/)
    assert.match(bridge, /const openDatabase = missingDatabaseAsNull\(openDatabaseOrThrow\)/)
  })

  it('reads the contract core and the shared ops keep', () => {
    // The phones read the published packages' dist output; in the monorepo the
    // same contract lives in the sibling packages' sources, so the patterns
    // match TypeScript source (no trailing semicolons, one-line throw).
    const pkg = (path: string): string =>
      readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    // The shared ops throw for an absent data.csv ...
    assert.match(pkg('shared-domain/src/database-ops.ts'), /if \(csvText === null\)\s+throw new Error\(`Database not found: \$\{rel\}`\)/)
    // ... core forgets a database the bridge answers null for, and toasts a
    // throw once, recording it so the grid does not ask again (core 2.81.0).
    const store = pkg('app-core/src/store.ts')
    assert.match(store, /if \(!doc\) \{[\s\S]{0,240}await get\(\)\.forgetDatabase\(csvPath\)/)
    assert.match(store, /const message = humanIpcError\(err, 'Could not open database'\)[\s\S]{0,240}databasesLoadError[\s\S]{0,240}\.addToast\(message, 'error'\)/)
    assert.match(pkg('bridge-contract/src/bridge.ts'), /openDatabase\(relPath: string\): Promise<DatabaseDoc \| null>/)
  })
})
