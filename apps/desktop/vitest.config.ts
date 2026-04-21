import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../packages/shared-domain/src'),
      '@renderer': path.resolve(__dirname, '../../packages/app-core/src'),
      '@bridge-contract': path.resolve(__dirname, '../../packages/bridge-contract/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
