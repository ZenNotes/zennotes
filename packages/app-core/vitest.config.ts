import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared-domain/src'),
      '@bridge-contract': path.resolve(__dirname, '../bridge-contract/src')
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
