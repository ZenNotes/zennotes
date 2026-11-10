import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { VaultDirEntry } from './host'
import { MemoryVaultFileSystem } from './memory-fs'
import { vaultFileSystemContract, type VaultFileSystemContractHarness } from './vault-fs-contract'

const outage = () => Object.assign(new Error('Folder access is no longer granted.'), { code: 'ZN-PERMISSION' })

const memory: VaultFileSystemContractHarness<MemoryVaultFileSystem> = {
  async create() {
    const fs = new MemoryVaultFileSystem('ZenNotes/Test', 'memory://Test')
    await fs.init()
    return fs
  },
  async reopen(fs) {
    return new MemoryVaultFileSystem(fs.syncKey, fs.rootLabel)
  },
  breakStorage: (fs) => fs.breakStorage(outage()),
  restoreStorage: (fs) => fs.restoreStorage()
}

describe('the in-memory file system keeps the VaultFileSystem contract', () => {
  for (const contract of vaultFileSystemContract) {
    it(contract.name, () => contract.run(memory))
  }
})

/** An adapter that does what the contract exists to stop: it reads a failed
 *  listing as an empty folder and a failed stat or read as a missing file,
 *  and keys the vault on a per-launch path. */
class LenientFs extends MemoryVaultFileSystem {
  static launches = 0
  override async readdirStrict(relPath: string): Promise<VaultDirEntry[]> {
    try {
      return await super.readdirStrict(relPath)
    } catch {
      return []
    }
  }
  override async statVerified(relPath: string): Promise<'file' | 'directory' | null> {
    try {
      return await super.statVerified(relPath)
    } catch {
      return null
    }
  }
  override async readTextOrNull(relPath: string): Promise<string | null> {
    try {
      return await super.readText(relPath)
    } catch {
      return null
    }
  }
}

const lenient: VaultFileSystemContractHarness<LenientFs> = {
  async create() {
    return new LenientFs(`container-${(LenientFs.launches += 1)}/Test`)
  },
  async reopen() {
    return new LenientFs(`container-${(LenientFs.launches += 1)}/Test`)
  },
  breakStorage: (fs) => fs.breakStorage(outage()),
  restoreStorage: (fs) => fs.restoreStorage()
}

describe('an adapter that turns failures into [] or null fails the contract', () => {
  const failing = [
    'readdirStrict throws when storage fails, where readdir answers []',
    'readdirStrict throws for a folder that does not exist',
    'statVerified answers null only for a verified absence',
    'readTextOrNull answers null only for a missing file, and isNotFound tells the two apart',
    'syncKey is the same for the same vault after a relaunch'
  ]
  for (const name of failing) {
    it(name, async () => {
      const contract = vaultFileSystemContract.find((candidate) => candidate.name === name)
      assert.ok(contract, name)
      await assert.rejects(contract.run(lenient), /VaultFileSystem contract:/)
    })
  }
})
