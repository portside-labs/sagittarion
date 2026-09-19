import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 40_000,
    hookTimeout: 40_000
  }
})
