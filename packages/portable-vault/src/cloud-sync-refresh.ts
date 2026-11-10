import type { PortableCloudSyncFileSystem } from '@zennotes/shared-domain/cloud-sync-portable-filesystem'

/** One host operation owns this tracker. Mark before writes: a native write
 * can change the disk before rejecting. A no-op sync must not rebuild every
 * editor surface, but partial failed pulls still need to become visible. */
export function trackCloudSyncChanges(
  fs: PortableCloudSyncFileSystem,
  refresh: () => Promise<void>,
  state = { changed: false }
) {
  const markChanged = () => { state.changed = true }
  return {
    markChanged,
    fs: {
      ...fs,
      writeText: async (path: string, value: string) => { markChanged(); await fs.writeText(path, value) },
      writeBase64: async (path: string, value: string) => { markChanged(); await fs.writeBase64(path, value) },
      deleteFile: async (path: string) => { markChanged(); await fs.deleteFile(path) },
      rename: async (from: string, to: string) => { markChanged(); await fs.rename(from, to) }
    },
    async refresh() {
      if (!state.changed) return
      state.changed = false
      try { await refresh() } catch (error) {
        state.changed = true
        throw error
      }
    }
  }
}
