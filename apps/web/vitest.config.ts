import { defineConfig } from 'vitest/config'
import { sharedAliases } from './vite.shared'

// Only the browser host (src/cloud) has tests; they run in Node over an
// in-memory OPFS (src/cloud/test/opfs-fake.ts) and fake-indexeddb.
export default defineConfig({
  resolve: { alias: sharedAliases },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
