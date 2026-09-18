// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { getCapabilities: () => ({}) }
  })
})

async function setup() {
  const { useStore } = await import('./store')
  const actions = await import('./lib/browse-actions')
  const prompts = await import('./lib/prompt-requests')
  const confirms = await import('./lib/confirm-requests')
  const create = vi.fn(async () => {})
  const rename = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  const createDatabase = vi.fn(async () => {})
  const renameDatabase = vi.fn(async () => {})
  useStore.setState({
    vault: { root: '/test', name: 'Test' },
    folders: ['Work', 'Work/Nested', 'People.base'].map((subpath) => ({
      folder: 'inbox',
      subpath,
      siblingOrder: 0
    })),
    createFolder: create,
    renameFolder: rename,
    deleteFolder: remove,
    createDatabase,
    renameDatabase
  })
  const host = { isCurrent: () => true }
  const answer = (value: string | null) => {
    const request = prompts.getPromptRequest()
    expect(request).not.toBeNull()
    prompts.settlePromptRequest(request!, value)
  }
  const confirm = (value: boolean) => {
    const request = confirms.getConfirmRequest()
    expect(request).not.toBeNull()
    confirms.settleConfirmRequest(request!, value)
  }
  return {
    useStore,
    ...actions,
    ...prompts,
    ...confirms,
    create,
    rename,
    remove,
    createDatabase,
    renameDatabase,
    host,
    answer,
    confirm
  }
}

describe('public Browse actions', () => {
  it('creates a trimmed child through the normal store action', async () => {
    const s = await setup()
    const result = s.requestCreateBrowseFolder(s.host, 'Work')
    expect(s.getPromptRequest()?.options.title).toBe('New folder in Work')
    s.answer('  Research  ')
    expect(await result).toBe('completed')
    expect(s.create).toHaveBeenCalledWith('inbox', 'Work/Research', expect.any(Function))
  })

  it('renames only the leaf and retains the parent', async () => {
    const s = await setup()
    const result = s.requestRenameBrowseFolder(s.host, 'Work/Nested')
    expect(s.getPromptRequest()?.options.initialValue).toBe('Nested')
    s.answer('Renamed')
    expect(await result).toBe('completed')
    expect(s.rename).toHaveBeenCalledWith(
      'inbox',
      'Work/Nested',
      'Work/Renamed',
      expect.any(Function)
    )
  })

  it('cancels names without writes and refuses invalid names at submission', async () => {
    const s = await setup()
    for (const value of [
      null,
      '',
      '   ',
      '../Elsewhere',
      'a/b',
      'a\\b',
      '.',
      '..',
      'New.base',
      'bad\0name'
    ]) {
      const result = s.requestCreateBrowseFolder(s.host)
      if (value?.trim()) expect(s.getPromptRequest()?.options.validate?.(value)).toBeTruthy()
      s.answer(value)
      expect(await result).toBe('cancelled')
    }
    const same = s.requestRenameBrowseFolder(s.host, 'Work')
    s.answer(' Work ')
    expect(await same).toBe('cancelled')
    expect(s.create).not.toHaveBeenCalled()
    expect(s.rename).not.toHaveBeenCalled()
  })

  it('requires confirmation for folder and database deletion with distinct explanations', async () => {
    const s = await setup()
    const cancelled = s.requestDeleteBrowseDirectory(s.host, 'Work')
    expect(s.getConfirmRequest()?.options).toMatchObject({
      danger: true,
      description: expect.stringContaining('Everything inside')
    })
    s.confirm(false)
    expect(await cancelled).toBe('cancelled')
    expect(s.remove).not.toHaveBeenCalled()
    const deleted = s.requestDeleteBrowseDirectory(s.host, 'People.base')
    expect(s.getConfirmRequest()?.options).toMatchObject({
      title: 'Delete "People"?',
      description: expect.stringContaining('All records')
    })
    s.confirm(true)
    expect(await deleted).toBe('completed')
    expect(s.remove).toHaveBeenCalledWith('inbox', 'People.base', expect.any(Function))
  })

  it('rejects roots, missing folders, database internals, and database renames', async () => {
    const s = await setup()
    for (const directory of ['', 'Missing', 'People.base/pages']) {
      expect(await s.requestDeleteBrowseDirectory(s.host, directory)).toBe('unavailable')
      expect(await s.requestRenameBrowseFolder(s.host, directory)).toBe('unavailable')
    }
    expect(await s.requestRenameBrowseFolder(s.host, 'People.base')).toBe('unavailable')
    expect(await s.requestCreateBrowseFolder(s.host, 'People.base')).toBe('unavailable')
    expect(s.getPromptRequest()).toBeNull()
    expect(s.getConfirmRequest()).toBeNull()
  })

  it.each(['vault', 'host', 'layout', 'missing'] as const)(
    'stops a pending action after a %s context change',
    async (kind) => {
      const s = await setup()
      let current = true
      const result = s.requestDeleteBrowseDirectory({ isCurrent: () => current }, 'Work')
      if (kind === 'vault') s.useStore.setState({ vault: { root: '/other', name: 'Other' } })
      if (kind === 'host') current = false
      if (kind === 'layout')
        s.useStore.setState({
          vaultSettings: {
            ...s.useStore.getState().vaultSettings,
            primaryNotesLocation: 'root'
          }
        })
      if (kind === 'missing') s.useStore.setState({ folders: [] })
      s.confirm(true)
      expect(await result).toBe('stale')
      expect(s.remove).not.toHaveBeenCalled()
    }
  )

  it('does not replace an existing dialog or start two Browse requests', async () => {
    const s = await setup()
    const first = s.requestCreateBrowseFolder(s.host)
    const original = s.getPromptRequest()
    expect(await s.requestDeleteBrowseDirectory(s.host, 'Work')).toBe('unavailable')
    expect(s.getPromptRequest()).toBe(original)
    s.answer(null)
    await first
    const other = s.promptApp({ title: 'Unrelated prompt' })
    expect(await s.requestCreateBrowseFolder(s.host)).toBe('unavailable')
    s.answer(null)
    await other
  })

  it('rejects host errors and releases the pending action', async () => {
    const s = await setup()
    s.create.mockRejectedValueOnce(new Error('Read-only vault'))
    const failed = s.requestCreateBrowseFolder(s.host)
    s.answer('New')
    await expect(failed).rejects.toThrow('Read-only vault')
    const next = s.requestCreateBrowseFolder(s.host)
    s.answer(null)
    expect(await next).toBe('cancelled')
  })
  it('creates an untitled database in the explicit Browse directory without a prompt', async () => {
    const s = await setup()
    expect(await s.createBrowseDatabase(s.host, 'Work')).toBe('completed')
    expect(s.createDatabase).toHaveBeenCalledWith('inbox', 'Work', undefined, expect.any(Function))
    expect(s.getPromptRequest()).toBeNull()
    expect(await s.createBrowseDatabase(s.host, 'People.base')).toBe('unavailable')
    expect(await s.createBrowseDatabase(s.host, 'Missing')).toBe('unavailable')
  })

  it.each([false, true])('renames a database with primary root mode %s', async (root) => {
    const s = await setup()
    s.useStore.setState({
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        primaryNotesLocation: root ? 'root' : 'inbox',
        systemFolderPaths: { inbox: 'My Notes' }
      }
    })
    const result = s.requestRenameBrowseDatabase(s.host, 'People.base')
    expect(s.getPromptRequest()?.options.initialValue).toBe('People')
    s.answer(' Customers ')
    expect(await result).toBe('completed')
    expect(s.renameDatabase).toHaveBeenCalledWith(
      root ? 'People.base/data.csv' : 'My Notes/People.base/data.csv',
      'Customers',
      expect.any(Function)
    )
  })

  it('cancels invalid database names and refuses folders or database internals', async () => {
    const s = await setup()
    for (const directory of ['', 'Work', 'People.base/pages'])
      expect(await s.requestRenameBrowseDatabase(s.host, directory)).toBe('unavailable')
    for (const title of [null, ' ', 'People', '.', '..', '.Hidden', '../Elsewhere', 'a\\b', 'bad\0name']) {
      const result = s.requestRenameBrowseDatabase(s.host, 'People.base')
      s.answer(title)
      expect(await result).toBe('cancelled')
    }
    expect(s.renameDatabase).not.toHaveBeenCalled()
  })

  it('stops a database rename when its host identity changes during the prompt', async () => {
    const s = await setup()
    let current = true
    const result = s.requestRenameBrowseDatabase({ isCurrent: () => current }, 'People.base')
    current = false
    s.answer('Customers')
    expect(await result).toBe('stale')
    expect(s.renameDatabase).not.toHaveBeenCalled()
  })

  it('propagates a database create failure and releases the action guard', async () => {
    const s = await setup()
    s.createDatabase.mockRejectedValueOnce(new Error('No space'))
    await expect(s.createBrowseDatabase(s.host)).rejects.toThrow('No space')
    expect(await s.createBrowseDatabase(s.host)).toBe('completed')
  })

  it('honors configured database placement when directory is omitted, and explicit root overrides it', async () => {
    const s = await setup()
    s.useStore.setState({
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        databasesLocation: { mode: 'folder', folder: 'Databases' }
      }
    })
    expect(await s.createBrowseDatabase(s.host)).toBe('completed')
    expect(s.createDatabase).toHaveBeenLastCalledWith(
      'inbox',
      'Databases',
      undefined,
      expect.any(Function)
    )
    expect(await s.createBrowseDatabase(s.host, '')).toBe('completed')
    expect(s.createDatabase).toHaveBeenLastCalledWith('inbox', '', undefined, expect.any(Function))
    s.useStore.setState({
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        databasesLocation: { mode: 'active-note' }
      },
      activeNote: { path: 'quick/Project/Note.md', folder: 'quick' } as never
    })
    expect(await s.createBrowseDatabase(s.host)).toBe('completed')
    expect(s.createDatabase).toHaveBeenLastCalledWith(
      'quick',
      'Project',
      undefined,
      expect.any(Function)
    )
  })
  it('retains legacy configured placement in an active database record folder', async () => {
    const s = await setup()
    s.useStore.setState({ vaultSettings: { ...s.useStore.getState().vaultSettings, databasesLocation: { mode: 'active-note' } }, activeNote: { path: 'inbox/People.base/Record.md', folder: 'inbox' } as never })
    expect(await s.createBrowseDatabase(s.host)).toBe('completed')
    expect(s.createDatabase).toHaveBeenLastCalledWith('inbox', 'People.base', undefined, expect.any(Function))
    expect(await s.createBrowseDatabase(s.host, 'People.base')).toBe('unavailable')
  })

  it('moves a folder to the top level and keeps its name', async () => {
    const s = await setup()
    const result = s.requestMoveBrowseDirectory(s.host, 'Work/Nested')
    const options = s.getPromptRequest()?.options
    expect(options?.title).toBe('Move "Nested" to…')
    // Empty on purpose: a prefilled path would filter the touch list down to
    // the folder it is already in.
    expect(options?.initialValue).toBeUndefined()
    s.answer(' inbox ')
    expect(await result).toBe('completed')
    expect(s.rename).toHaveBeenCalledWith('inbox', 'Work/Nested', 'Nested', expect.any(Function))
  })

  it('moves a database into a folder and keeps its .base suffix', async () => {
    const s = await setup()
    const result = s.requestMoveBrowseDirectory(s.host, 'People.base')
    expect(s.getPromptRequest()?.options.title).toBe('Move "People" to…')
    s.answer('inbox/Work/Nested')
    expect(await result).toBe('completed')
    expect(s.rename).toHaveBeenCalledWith(
      'inbox',
      'People.base',
      'Work/Nested/People.base',
      expect.any(Function)
    )
  })

  it('offers only real destinations: not itself, its children, databases, or archive', async () => {
    const s = await setup()
    s.useStore.setState({
      folders: [
        ...s.useStore.getState().folders,
        { folder: 'inbox', subpath: 'Home', siblingOrder: 0 },
        { folder: 'inbox', subpath: 'People.base/pages', siblingOrder: 0 },
        { folder: 'archive', subpath: 'Old', siblingOrder: 0 }
      ]
    })
    const result = s.requestMoveBrowseDirectory(s.host, 'Work')
    expect(s.getPromptRequest()?.options.suggestions?.map((row) => row.value)).toEqual([
      'inbox',
      'inbox/Home'
    ])
    s.answer(null)
    expect(await result).toBe('cancelled')
  })

  it('refuses impossible destinations at submission and never writes', async () => {
    const s = await setup()
    for (const value of [
      null,
      '',
      '   ',
      'Work',
      'archive',
      'inbox/Work/Nested',
      'inbox/Work/Nested/Deeper',
      'inbox/People.base',
      'inbox/People.base/pages',
      'inbox/Missing',
      'inbox/../Elsewhere',
      'inbox/.hidden',
      'inbox/bad\0name'
    ]) {
      const result = s.requestMoveBrowseDirectory(s.host, 'Work/Nested')
      if (value?.trim()) expect(s.getPromptRequest()?.options.validate?.(value)).toBeTruthy()
      s.answer(value)
      expect(await result).toBe('cancelled')
    }
    // Its current parent is a valid answer that changes nothing.
    const same = s.requestMoveBrowseDirectory(s.host, 'Work/Nested')
    expect(s.getPromptRequest()?.options.validate?.('inbox/Work')).toBeNull()
    s.answer('inbox/Work')
    expect(await same).toBe('cancelled')
    expect(s.rename).not.toHaveBeenCalled()
  })

  it('blocks a move onto an existing folder or database of the same name', async () => {
    const s = await setup()
    s.useStore.setState({
      folders: [
        ...s.useStore.getState().folders,
        { folder: 'inbox', subpath: 'Nested', siblingOrder: 0 },
        { folder: 'inbox', subpath: 'Work/People.base', siblingOrder: 0 }
      ]
    })
    const folder = s.requestMoveBrowseDirectory(s.host, 'Work/Nested')
    expect(s.getPromptRequest()?.options.validate?.('inbox')).toBe(
      '"Nested" already exists in that folder.'
    )
    s.answer('inbox')
    expect(await folder).toBe('cancelled')
    const database = s.requestMoveBrowseDirectory(s.host, 'People.base')
    expect(s.getPromptRequest()?.options.validate?.('inbox/Work')).toBe(
      '"People" already exists in that folder.'
    )
    s.answer('inbox/Work')
    expect(await database).toBe('cancelled')
    expect(s.rename).not.toHaveBeenCalled()
  })

  it('validates a move against the folders that exist at submission', async () => {
    const s = await setup()
    const result = s.requestMoveBrowseDirectory(s.host, 'People.base')
    s.useStore.setState({
      folders: s.useStore.getState().folders.filter((row) => row.subpath !== 'Work/Nested')
    })
    s.answer('inbox/Work/Nested')
    expect(await result).toBe('cancelled')
    expect(s.rename).not.toHaveBeenCalled()
  })

  it('cannot move the root, missing folders, or database internals', async () => {
    const s = await setup()
    for (const directory of ['', 'Missing', 'People.base/pages'])
      expect(await s.requestMoveBrowseDirectory(s.host, directory)).toBe('unavailable')
    expect(s.getPromptRequest()).toBeNull()
  })

  it.each(['host', 'missing'] as const)(
    'stops a move after a %s change during the prompt',
    async (kind) => {
      const s = await setup()
      let current = true
      const result = s.requestMoveBrowseDirectory({ isCurrent: () => current }, 'People.base')
      if (kind === 'host') current = false
      if (kind === 'missing')
        s.useStore.setState({
          folders: s.useStore.getState().folders.filter((row) => row.subpath !== 'People.base')
        })
      s.answer('inbox/Work')
      expect(await result).toBe('stale')
      expect(s.rename).not.toHaveBeenCalled()
    }
  )

  it('rejects a host refusal to move and releases the pending action', async () => {
    const s = await setup()
    s.rename.mockRejectedValueOnce(new Error('A folder already exists at "Work/People.base"'))
    const failed = s.requestMoveBrowseDirectory(s.host, 'People.base')
    s.answer('inbox/Work')
    await expect(failed).rejects.toThrow('already exists')
    const next = s.requestMoveBrowseDirectory(s.host, 'People.base')
    s.answer(null)
    expect(await next).toBe('cancelled')
  })

})
