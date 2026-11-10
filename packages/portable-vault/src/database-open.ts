import type { DatabaseDoc } from '@zennotes/bridge-contract/databases'

/**
 * A database's tab can outlive its folder: deleted in a file manager, by sync
 * from another device, or by another app sharing the vault. The bridge
 * contract answers null for a missing database, as desktop's main process
 * does, and core then forgets the database and closes its tab.
 *
 * The shared database ops throw "Database not found" for it instead, and
 * core's grid toasted that error and asked again on its next render: one
 * relaunch with such a tab open stacked 780 "Database not found" toasts over
 * the app. Only that error becomes null; anything else (a file that cannot
 * be read, a schema that cannot be parsed) still throws.
 */
export function missingDatabaseAsNull(
  open: (relPath: string) => Promise<DatabaseDoc>
): (relPath: string) => Promise<DatabaseDoc | null> {
  return async (relPath) => {
    try {
      return await open(relPath)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Database not found')) return null
      throw err
    }
  }
}
