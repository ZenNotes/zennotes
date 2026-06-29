import { describe, expect, it } from 'vitest'
import {
  csvPathForFormDir,
  databaseCsvPathFor,
  databaseSchemaPathFor,
  databaseTitleFromTab,
  databaseTabPath,
  formDirContaining,
  formDirFromCsvPath,
  formTitleFromCsvPath,
  isDatabaseCsvPath,
  isDatabaseInternalPath,
  isFormDirName,
  pagesDirFromCsvPath
} from './databases'

describe('.base database paths', () => {
  it('recognizes a .base folder name', () => {
    expect(isFormDirName('Books.base')).toBe(true)
    expect(isFormDirName('a/b/Books.base')).toBe(true)
    expect(isFormDirName('Books')).toBe(false)
  })

  it('round-trips folder ⇄ data.csv path', () => {
    expect(csvPathForFormDir('a/Books.base')).toBe('a/Books.base/data.csv')
    expect(formDirFromCsvPath('a/Books.base/data.csv')).toBe('a/Books.base')
    expect(formDirFromCsvPath('a/Books.base/other.csv')).toBeNull()
    expect(formDirFromCsvPath('a/loose.csv')).toBeNull()
  })

  it('derives schema + pages paths', () => {
    expect(databaseSchemaPathFor('a/Books.base/data.csv')).toBe('a/Books.base/schema.json')
    expect(pagesDirFromCsvPath('a/Books.base/data.csv')).toBe('a/Books.base/pages')
    expect(databaseSchemaPathFor('a/loose.csv')).toBeNull()
  })

  it('derives the title from the folder name', () => {
    expect(formTitleFromCsvPath('inbox/Reading List.base/data.csv')).toBe('Reading List')
    expect(databaseTitleFromTab(databaseTabPath('inbox/Reading List.base/data.csv'))).toBe(
      'Reading List'
    )
    // Legacy loose csv keeps its basename title.
    expect(databaseTitleFromTab(databaseTabPath('inbox/Old.csv'))).toBe('Old')
  })

  it('finds the containing .base folder for nested files', () => {
    expect(formDirContaining('a/Books.base/pages/r.md')).toBe('a/Books.base')
    expect(formDirContaining('a/Books.base/schema.json')).toBe('a/Books.base')
    expect(formDirContaining('a/notes/r.md')).toBeNull()
  })

  it('treats .base internals as internal but pages as user-facing', () => {
    expect(isDatabaseInternalPath('a/Books.base/data.csv')).toBe(true)
    expect(isDatabaseInternalPath('a/Books.base/schema.json')).toBe(true)
    expect(isDatabaseInternalPath('a/Books.base/pages/record.md')).toBe(false)
    // Legacy.
    expect(isDatabaseInternalPath('a/Old.csv.base.json')).toBe(true)
  })

  it('classifies database data files (new + legacy), excluding loose CSV inside a .base', () => {
    expect(isDatabaseCsvPath('a/Books.base/data.csv')).toBe(true)
    expect(isDatabaseCsvPath('a/Old.csv')).toBe(true)
    expect(isDatabaseCsvPath('a/Books.base/extra.csv')).toBe(false)
  })

  it('normalizes any database file back to its data.csv identity', () => {
    expect(databaseCsvPathFor('a/Books.base/data.csv')).toBe('a/Books.base/data.csv')
    expect(databaseCsvPathFor('a/Books.base/schema.json')).toBe('a/Books.base/data.csv')
    expect(databaseCsvPathFor('a/Old.csv')).toBe('a/Old.csv')
    expect(databaseCsvPathFor('a/Old.csv.base.json')).toBe('a/Old.csv')
    expect(databaseCsvPathFor('a/notes/plain.md')).toBeNull()
  })
})
