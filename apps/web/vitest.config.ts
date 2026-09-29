import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'web',
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
