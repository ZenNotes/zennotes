// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canOpenCurrentVaultFolder,
  canOpenVaultFolders,
  fileManagerName,
  openVaultFolder
} from './vault-folder'
import { useToastStore } from './toast'

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => 'darwin',
      getAppInfo: () => ({ runtime: 'desktop' }),
      getCapabilities: () => ({ supportsLocalFilesystemPickers: true }),
      openVaultInFileManager: vi.fn().mockResolvedValue(undefined),
      ...overrides
    }
  })
}

describe('vault-folder', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    installZen()
  })

  it('names the file manager for the platform', () => {
    expect(fileManagerName()).toBe('Finder')
    installZen({ platformSync: () => 'win32' })
    expect(fileManagerName()).toBe('File Explorer')
    installZen({ platformSync: () => 'linux' })
    expect(fileManagerName()).toBe('File Manager')
  })

  it('is on for a desktop host with local folders', () => {
    expect(canOpenVaultFolders()).toBe(true)
  })

  it('is off for the web, a host without local pickers, or one without the call', () => {
    installZen({ getAppInfo: () => ({ runtime: 'web' }) })
    expect(canOpenVaultFolders()).toBe(false)
    installZen({ getCapabilities: () => ({ supportsLocalFilesystemPickers: false }) })
    expect(canOpenVaultFolders()).toBe(false)
    installZen({ openVaultInFileManager: undefined })
    expect(canOpenVaultFolders()).toBe(false)
  })

  it('offers the open vault only when it is on this machine', () => {
    const vault = { root: '/vaults/work', name: 'work' }
    expect(canOpenCurrentVaultFolder({ vault, workspaceMode: 'local' })).toBe(true)
    expect(canOpenCurrentVaultFolder({ vault, workspaceMode: 'remote' })).toBe(false)
    expect(canOpenCurrentVaultFolder({ vault: null, workspaceMode: 'local' })).toBe(false)
    expect(
      canOpenCurrentVaultFolder({ vault: { ...vault, temporary: true }, workspaceMode: 'local' })
    ).toBe(true)
  })

  it('asks the host for that vault and stays quiet when it opens', async () => {
    await openVaultFolder('/vaults/work')
    expect(window.zen.openVaultInFileManager).toHaveBeenCalledWith('/vaults/work')
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('says what went wrong, without the IPC wrapping', async () => {
    installZen({
      openVaultInFileManager: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'vault:open-in-file-manager': Error: This vault's folder is missing: /vaults/work"
          )
        )
    })
    await openVaultFolder('/vaults/work')
    const [toast] = useToastStore.getState().toasts
    expect(toast.type).toBe('error')
    expect(toast.message).toBe("This vault's folder is missing: /vaults/work")
  })
})
